import type { ServiceArea, SizeBand } from './types.ts';

/**
 * Service area → NAICS codes.
 *
 * Provisional. The spec is explicit that these are a starting point and get
 * adjusted against what step zero actually returns. Whatever survives that
 * check is the mapping that ships; record the change in RETROSPECTIVE.md.
 *
 * NAICS filtering on SAM.gov is flat — there is no parent-code search — so
 * every 6-digit code is enumerated explicitly.
 */
export const SERVICE_AREAS: Record<ServiceArea, { label: string; naics: string[] }> = {
  'software-development': { label: 'Software development', naics: ['541511', '541519'] },
  'web-digital': { label: 'Web & digital', naics: ['541511', '541810', '518210'] },
  'data-analytics': { label: 'Data & analytics', naics: ['541512', '541618', '518210'] },
  'it-support': { label: 'IT support & infrastructure', naics: ['541519', '811212'] },
  cybersecurity: { label: 'Cybersecurity', naics: ['541512', '541519', '561621'] },
};

/**
 * Codes removed after the 2026-08-26 harvest, and why. Kept as a record so the
 * next person does not helpfully add them back:
 *
 *   541430 Graphic Design Services        — 0 records in the 7-day window
 *   541513 Computer Facilities Management — 0 records in the 7-day window
 *
 * Both were replaced rather than simply dropped, because the code count is now
 * a hard budget line: `ncode` takes one code per request, so every code in the
 * union costs one request per refresh. Eight codes is what a ~10/day key
 * affords with a daily refresh. Adding a ninth means a longer TTL or dropping
 * another — this list is not free to extend.
 *
 *   518210 Data Processing, Hosting and Related Services
 *   811212 Computer and Office Machine Repair and Maintenance
 *
 * One week is thin evidence for calling a code dead. Both are worth re-checking
 * once the daily budget is better understood.
 */
export const RETIRED_NAICS = ['541430', '541513'] as const;

/**
 * The union of every code any area cares about — 8 distinct codes across 5 areas.
 *
 * This union is the fetch dimension, not the service area. One pooled fetch of
 * all 8 codes, with the five buckets derived in code afterwards, is what keeps
 * SAM.gov usage at 1-3 calls/day. Fetching per-area would mean 5 overlapping
 * fetches for the same underlying notices, and 541511/541512/541519 each appear
 * in two areas — so a per-area fetch pays for those codes twice.
 *
 * Whether one call can carry all 8 codes is the open question step zero answers.
 * See scripts/step-zero.mjs.
 */
export const ALL_NAICS: string[] = [
  ...new Set(Object.values(SERVICE_AREAS).flatMap((a) => a.naics)),
].sort();

/**
 * SAM.gov procurement type codes.
 *   o = Solicitation
 *   p = Presolicitation
 *   k = Combined Synopsis/Solicitation
 *   a = Award Notice        <- excluded, always
 *   r = Sources Sought, s = Special Notice, i = Intent to Bundle,
 *   u = Justification, g = Sale of Surplus Property
 *
 * Awards are excluded at fetch time and never exposed as a user control:
 * nobody wants a contract someone else already won, so it is not a preference.
 *
 * Sources Sought ('r') is deliberately NOT here. It is a real judgment call —
 * market research notices are genuinely early-stage lead flow and an agency
 * owner might want them — but they are not yet solicitations, and including
 * them would inflate the "matched" count with things nobody can bid on today.
 * Revisit if step zero shows the solicitation volume is thin.
 */
export const ALLOWED_PTYPES = ['o', 'p', 'k'] as const;

/** Contract size bands, applied to valueEstimate. Notices with no stated value only ever match 'any'. */
export const SIZE_BANDS: Record<SizeBand, { label: string; min: number | null; max: number | null }> = {
  'under-250k': { label: 'Under $250k', min: null, max: 250_000 },
  '250k-1m': { label: '$250k – $1M', min: 250_000, max: 1_000_000 },
  'over-1m': { label: 'Over $1M', min: 1_000_000, max: null },
  any: { label: 'Any', min: null, max: null },
};

/** Trailing window, in days. Fixed at 7 — the spec's answer to "no backfill". */
export const WINDOW_DAYS = 7;

/** Defaults so the page produces results on load with zero input. */
export const DEFAULT_PROFILE = {
  area: 'software-development' as ServiceArea,
  size: 'any' as SizeBand,
  setAside: 'any' as const,
};
