/**
 * The term glossary.
 *
 * Procurement notices are dense with named systems — PAWSS, NNOMPEAS, MyPath,
 * Centrak RTLS — and the nature of the named thing usually decides the score.
 * PAWSS looks like a real software opportunity until you learn its core is
 * Lockheed Martin proprietary, at which point it is effectively pre-awarded.
 *
 * Keyed by TERM, not by notice. A term is looked up once, ever, and reused
 * across every notice that mentions it and every scan that follows. The corpus
 * holds maybe forty distinct system names in a week and most recur, so the cost
 * decays to nothing — the same economics as the score cache, and the only
 * reason enrichment is affordable at all.
 *
 * ## Where the definitions come from, and why that is deliberate
 *
 * The model's own knowledge, not a web search. That is a real limitation and it
 * is chosen with open eyes:
 *
 *   - No fetching means no open-web text entering a scoring prompt, so the
 *     injection surface stays exactly where it was. The spec rejected freetext
 *     profiles over this risk; importing arbitrary pages would be strictly
 *     worse than the thing it rejected.
 *   - The lookup is instructed to answer UNKNOWN rather than guess, and unknown
 *     is recorded as a real answer. For MyPath(R) — trademarked, no public
 *     documentation — the honest answer IS unknown.
 *
 * An early version of this file argued that "not publicly documented" was
 * itself signal — that an unlookupable system implies proprietary or
 * incumbent-built, so an UNKNOWN should push the score down. Measurement
 * killed that idea: see describeForPrompt below. An unknown is an absence of
 * information about the world, not information about the opportunity, and
 * dressing it up as evidence cost a genuinely good notice 55 points.
 *
 * Web lookup is the obvious upgrade. It needs the injection work done properly
 * first.
 */

export const UNKNOWN = 'UNKNOWN' as const;

export interface GlossaryEntry {
  /** A short factual gloss, or UNKNOWN when the term could not be identified. */
  meaning: string;
  /** When it was resolved. Entries never expire — a system's nature does not change. */
  resolvedAt: string;
}

export interface GlossaryStore {
  get(term: string): Promise<GlossaryEntry | null>;
  put(term: string, entry: GlossaryEntry): Promise<void>;
}

/** Terms are normalised so "PAWSS", "pawss" and " PAWSS " share one entry. */
export function normalizeTerm(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toUpperCase();
}

export class KVGlossary implements GlossaryStore {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get(term: string): Promise<GlossaryEntry | null> {
    const raw = await this.kv.get(`glossary:${normalizeTerm(term)}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GlossaryEntry;
    } catch {
      return null;
    }
  }

  async put(term: string, entry: GlossaryEntry): Promise<void> {
    await this.kv.put(`glossary:${normalizeTerm(term)}`, JSON.stringify(entry));
  }
}

/** In-memory store, for the offline harness and for tests. */
export class MemoryGlossary implements GlossaryStore {
  readonly entries = new Map<string, GlossaryEntry>();

  async get(term: string): Promise<GlossaryEntry | null> {
    return this.entries.get(normalizeTerm(term)) ?? null;
  }

  async put(term: string, entry: GlossaryEntry): Promise<void> {
    this.entries.set(normalizeTerm(term), entry);
  }
}

export const GLOSSARY_SYSTEM_PROMPT = `You identify named systems, programmes, products and acronyms that appear in US federal contract opportunities.

For each term you are given, answer in ONE sentence covering:
- what kind of thing it is (software product, federal programme, hardware, standard, contract vehicle, agency)
- who owns or operates it, if a specific vendor or agency owns it
- whether it is proprietary to one vendor

If you are not confident the term refers to a specific real thing, answer exactly: UNKNOWN

Answering UNKNOWN is correct and useful. A confident invention here corrupts a downstream scoring decision and is far worse than admitting the gap. Many of these are obscure agency-internal systems with no public documentation — UNKNOWN is the expected answer for those, not a failure.

Do not speculate from the acronym's expansion alone. "It probably stands for..." is a guess, and a guess is UNKNOWN.`;

export const GLOSSARY_SCHEMA = {
  type: 'object',
  properties: {
    definitions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          meaning: {
            type: 'string',
            description: 'One factual sentence, or exactly "UNKNOWN" if not confidently identifiable.',
          },
        },
        required: ['term', 'meaning'],
      },
    },
  },
  required: ['definitions'],
} as const;

/**
 * Resolve terms, consulting the store first and the model only for misses.
 *
 * `lookup` is injected so this is testable with a stub and so the Worker and
 * the offline harness can share one implementation. Returns a plain
 * term → meaning map ready for the scoring prompt, with UNKNOWN entries
 * included — stating the gap explicitly beats silence, which the model would
 * otherwise fill with an assumption. What it must NOT do is imply a direction;
 * see describeForPrompt.
 */
export async function resolveTerms(
  terms: string[],
  store: GlossaryStore,
  lookup: (missing: string[]) => Promise<Array<{ term: string; meaning: string }>>,
  now: () => string = () => new Date().toISOString(),
): Promise<Record<string, string>> {
  const wanted = [...new Set(terms.map(normalizeTerm))].filter(Boolean);
  if (wanted.length === 0) return {};

  const out: Record<string, string> = {};
  const missing: string[] = [];

  for (const term of wanted) {
    const hit = await store.get(term);
    if (hit) out[term] = hit.meaning;
    else missing.push(term);
  }

  if (missing.length > 0) {
    const found = await lookup(missing);
    const stamp = now();
    for (const { term, meaning } of found) {
      const key = normalizeTerm(term);
      const value = meaning.trim() || UNKNOWN;
      await store.put(key, { meaning: value, resolvedAt: stamp });
      out[key] = value;
    }
    // A term the lookup silently dropped is cached as UNKNOWN too. Otherwise
    // every future scan re-asks about the same unanswerable acronym forever.
    for (const term of missing) {
      if (!(term in out)) {
        await store.put(term, { meaning: UNKNOWN, resolvedAt: stamp });
        out[term] = UNKNOWN;
      }
    }
  }

  return out;
}

/**
 * Human-readable gloss for the scoring prompt.
 *
 * The UNKNOWN wording used to read: "an unidentifiable named system is usually
 * proprietary, agency-internal, or has an incumbent who built it." That was a
 * mistake, and a measurable one. On the EOS Web-Based Training notice the model
 * flagged the phrase "designated airmen", the lookup returned UNKNOWN, and the
 * model then reasoned that a term it could not find was "evidence of an
 * incumbent-specific programme" — turning a gap in ITS knowledge into a fact
 * about the opportunity, and dropping a genuine 80+ fit to 25.
 *
 * An unknown is an absence of information. It is not evidence in either
 * direction, and the gloss now says exactly that.
 */
export function describeForPrompt(meaning: string): string {
  return meaning === UNKNOWN
    ? 'not identifiable from public knowledge. This is a gap in YOUR information, not a fact about the opportunity. Do not treat it as evidence for or against — score the notice on what its text actually says.'
    : meaning;
}
