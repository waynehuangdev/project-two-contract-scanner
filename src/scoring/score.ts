import type { Notice, ServiceArea } from '../types.ts';
import {
  buildUserPrompt,
  truncateDescription,
  band,
  SYSTEM_PROMPT,
  SCORE_SCHEMA,
} from './prompt.ts';
import {
  describeForPrompt,
  resolveTerms,
  GLOSSARY_SYSTEM_PROMPT,
  GLOSSARY_SCHEMA,
  type GlossaryStore,
} from './glossary.ts';

/**
 * Two-pass scoring, ONE call per notice for all three service areas.
 *
 *   Pass 1  read the notice; state what is being bought and what bars a bidder;
 *           score every area from those shared facts; flag unfamiliar names
 *   Lookup  resolve only the flagged terms, cached forever by term
 *   Pass 2  re-read with that context — ONLY when the lookup added something
 *
 * Scoring all areas together is not a cost optimisation that happens to be
 * cheaper. It is the fix for a real defect: three independent calls produced
 * three independent readings, and on one notice the model found "likely vendor
 * lock-in" in one area and "no named incumbent product" in another, on the same
 * text in the same run. Sharing the reading makes that impossible by
 * construction rather than by instruction.
 *
 * The saving is real too — a third of the calls — and it is what makes a cold
 * scan fit inside Cloudflare's 50-subrequest ceiling.
 */

export interface AreaVerdict {
  score: number;
  band: 'clear' | 'conditional' | 'no';
  justification: string;
}

export interface ScoreResult {
  noticeId: string;
  /** What is being bought, stated once. Every area verdict is consistent with this. */
  reading: string;
  /** What in the text bars an outside bidder. Shared across areas. */
  disqualifiers: string[];
  areas: Record<ServiceArea, AreaVerdict>;
  valueEstimate: number | null;
  unfamiliarTerms: string[];
  enriched: boolean;
  /** Per-area score before enrichment, kept when it moved. The visible payoff of the extra call. */
  scoresBeforeEnrichment?: Record<ServiceArea, number>;
  modelCalls: number;
}

/** Minimal model interface, so the Worker and the harness share one code path. */
export interface ModelClient {
  complete(args: {
    system: string;
    user: string;
    schema: unknown;
    maxTokens: number;
  }): Promise<Record<string, unknown>>;
}

// Larger than the single-area budget: one response now carries three
// justifications plus the shared reading.
const MAX_TOKENS_SCORE = 900;
const MAX_TOKENS_GLOSSARY = 700;

/** Cap on terms resolved per notice — a runaway flag list should not become a runaway bill. */
const MAX_TERMS_PER_NOTICE = 5;

const AREAS: ServiceArea[] = ['software-development', 'web-digital', 'data-analytics'];

export async function scoreNotice(
  notice: Notice,
  model: ModelClient,
  store: GlossaryStore,
  opts: { enrich?: boolean } = {},
): Promise<ScoreResult> {
  const enrich = opts.enrich !== false;
  const prepared: Notice = { ...notice, description: truncateDescription(notice.description) };
  let calls = 0;

  // --- pass 1 ---------------------------------------------------------------
  const first = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({ notice: prepared }),
    schema: SCORE_SCHEMA,
    maxTokens: MAX_TOKENS_SCORE,
  });
  calls++;
  const pass1 = coerce(first, notice.noticeId);

  const terms = enrich ? pass1.unfamiliarTerms.slice(0, MAX_TERMS_PER_NOTICE) : [];
  if (terms.length === 0) {
    return { ...pass1, enriched: false, modelCalls: calls };
  }

  // --- lookup ---------------------------------------------------------------
  let glossary: Record<string, string> = {};
  try {
    glossary = await resolveTerms(terms, store, async (missing) => {
      const res = await model.complete({
        system: GLOSSARY_SYSTEM_PROMPT,
        user: `Identify each term. Answer UNKNOWN where you are not confident.\n\n${missing.map((t) => `- ${t}`).join('\n')}`,
        schema: GLOSSARY_SCHEMA,
        maxTokens: MAX_TOKENS_GLOSSARY,
      });
      calls++;
      const defs = (res as { definitions?: Array<{ term?: unknown; meaning?: unknown }> }).definitions;
      if (!Array.isArray(defs)) return [];
      return defs
        .filter((d) => typeof d.term === 'string' && typeof d.meaning === 'string')
        .map((d) => ({ term: d.term as string, meaning: d.meaning as string }));
    });
  } catch {
    // Enrichment is an improvement, never a dependency. A failed lookup returns
    // pass 1 rather than failing the notice.
    return { ...pass1, enriched: false, modelCalls: calls };
  }

  if (Object.keys(glossary).length === 0) {
    return { ...pass1, enriched: false, modelCalls: calls };
  }

  // --- pass 2 ---------------------------------------------------------------
  const second = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({
      notice: prepared,
      glossary: Object.fromEntries(
        Object.entries(glossary).map(([term, meaning]) => [term, describeForPrompt(meaning)]),
      ),
    }),
    schema: SCORE_SCHEMA,
    maxTokens: MAX_TOKENS_SCORE,
  });
  calls++;
  const pass2 = coerce(second, notice.noticeId);

  const before = {} as Record<ServiceArea, number>;
  for (const a of AREAS) before[a] = pass1.areas[a].score;

  return { ...pass2, enriched: true, scoresBeforeEnrichment: before, modelCalls: calls };
}

/**
 * Coerce a model response into the result shape.
 *
 * Paranoid about `valueEstimate` specifically: nothing in the prompt supplies a
 * dollar figure, so any number there is an invention. A non-number becomes null
 * rather than being coerced into something plausible — `Number("about $2M")` is
 * NaN, and NaN in a table is a fabricated figure wearing a number's clothes.
 */
function coerce(
  raw: Record<string, unknown>,
  noticeId: string,
): Omit<ScoreResult, 'enriched' | 'modelCalls' | 'scoresBeforeEnrichment'> {
  const rawAreas = (raw.areas ?? {}) as Record<string, unknown>;
  const areas = {} as Record<ServiceArea, AreaVerdict>;

  for (const area of AREAS) {
    const entry = (rawAreas[area] ?? {}) as Record<string, unknown>;
    const s = entry.score;
    // Unscoreable means not surfaced, never surfaced by accident.
    const score =
      typeof s === 'number' && Number.isFinite(s) ? Math.max(0, Math.min(100, Math.round(s))) : 0;
    areas[area] = {
      score,
      band: band(score),
      justification:
        typeof entry.justification === 'string' && entry.justification.trim()
          ? entry.justification.trim()
          : 'No justification returned.',
    };
  }

  const value = raw.valueEstimate;
  const terms = raw.unfamiliarTerms;
  const disq = raw.disqualifiers;

  return {
    noticeId,
    reading: typeof raw.reading === 'string' ? raw.reading.trim() : '',
    disqualifiers: Array.isArray(disq)
      ? disq.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      : [],
    areas,
    valueEstimate: typeof value === 'number' && Number.isFinite(value) ? value : null,
    unfamiliarTerms: Array.isArray(terms)
      ? terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [],
  };
}
