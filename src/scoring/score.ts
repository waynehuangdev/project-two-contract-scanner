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
 * Two-pass scoring.
 *
 *   Pass 1  score the notice; the model flags any named system it is not
 *           confident about
 *   Lookup  resolve only those terms, cached forever by term
 *   Pass 2  re-score with that context — ONLY when the lookup actually added
 *           something
 *
 * The second pass is conditional on purpose. Most notices flag nothing, and
 * for those the cost is exactly one call. Rescoring unconditionally would
 * double the bill to re-derive an identical answer.
 */

export interface ScoreResult {
  noticeId: string;
  score: number;
  band: 'clear' | 'conditional' | 'no';
  justification: string;
  valueEstimate: number | null;
  unfamiliarTerms: string[];
  /** True when a glossary lookup changed the inputs and the notice was scored twice. */
  enriched: boolean;
  /** Pass 1's score, kept when enrichment moved it. The visible payoff of the extra call. */
  scoreBeforeEnrichment?: number;
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

const MAX_TOKENS_SCORE = 400;
const MAX_TOKENS_GLOSSARY = 700;

/** Cap on terms resolved per notice — a runaway flag list should not become a runaway bill. */
const MAX_TERMS_PER_NOTICE = 5;

export async function scoreNotice(
  notice: Notice,
  area: ServiceArea,
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
    user: buildUserPrompt({ notice: prepared, area }),
    schema: SCORE_SCHEMA,
    maxTokens: MAX_TOKENS_SCORE,
  });
  calls++;
  const pass1 = coerce(first, notice.noticeId);

  const terms = enrich ? pass1.unfamiliarTerms.slice(0, MAX_TERMS_PER_NOTICE) : [];
  if (terms.length === 0) {
    return { ...pass1, band: band(pass1.score), enriched: false, modelCalls: calls };
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
    // pass 1 rather than failing the notice — a slightly worse score beats a
    // hole in the results.
    return { ...pass1, band: band(pass1.score), enriched: false, modelCalls: calls };
  }

  if (Object.keys(glossary).length === 0) {
    return { ...pass1, band: band(pass1.score), enriched: false, modelCalls: calls };
  }

  // --- pass 2 ---------------------------------------------------------------
  const second = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt({
      notice: prepared,
      area,
      glossary: Object.fromEntries(
        Object.entries(glossary).map(([term, meaning]) => [term, describeForPrompt(meaning)]),
      ),
    }),
    schema: SCORE_SCHEMA,
    maxTokens: MAX_TOKENS_SCORE,
  });
  calls++;
  const pass2 = coerce(second, notice.noticeId);

  return {
    ...pass2,
    band: band(pass2.score),
    enriched: true,
    scoreBeforeEnrichment: pass1.score,
    modelCalls: calls,
  };
}

/**
 * Coerce a model response into the result shape.
 *
 * Deliberately paranoid about the two fields the prompt forbids inventing. A
 * value or deadline that arrives as a non-number or non-string becomes null
 * rather than being coerced into something plausible — `Number("about $2M")`
 * is NaN, and NaN rendered in a table is how a fabricated figure reaches a
 * reader wearing a number's clothes.
 */
function coerce(
  raw: Record<string, unknown>,
  noticeId: string,
): Omit<ScoreResult, 'band' | 'enriched' | 'modelCalls'> {
  const scoreRaw = raw.score;
  const score =
    typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)
      ? Math.max(0, Math.min(100, Math.round(scoreRaw)))
      : 0; // unscoreable means not surfaced, never surfaced-by-accident

  const value = raw.valueEstimate;
  const terms = raw.unfamiliarTerms;

  return {
    noticeId,
    score,
    justification:
      typeof raw.justification === 'string' && raw.justification.trim()
        ? raw.justification.trim()
        : 'No justification returned.',
    valueEstimate: typeof value === 'number' && Number.isFinite(value) ? value : null,
    unfamiliarTerms: Array.isArray(terms)
      ? terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : [],
  };
}
