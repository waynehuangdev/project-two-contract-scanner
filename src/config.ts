import type { ServiceArea, SizeBand } from './types.ts';

/**
 * Service area → NAICS codes.
 *
 * Settled against the 2026-08-26 harvest and the hand-labelled set, not
 * guessed: two codes returned zero records, one was in the wrong area
 * entirely, and two whole areas turned out to belong to a different buyer.
 * See RETIRED_NAICS and RETIRED_AREAS for what went and why.
 *
 * NAICS filtering on SAM.gov is flat — there is no parent-code search — so
 * every 6-digit code is enumerated explicitly.
 */
export const SERVICE_AREAS: Record<ServiceArea, { label: string; naics: string[] }> = {
  'software-development': { label: 'Software development', naics: ['541511', '541519'] },
  'web-digital': { label: 'Web & digital', naics: ['541511', '541810', '518210'] },
  'data-analytics': { label: 'Data & analytics', naics: ['541512', '541618', '518210'] },
};

/**
 * Cut on Day 3, with the areas rather than the codes:
 *
 *   it-support    IT support & infrastructure  (541519, 811212)
 *   cybersecurity Cybersecurity                (541512, 541519)
 *
 * Not because they were noisy — because they belong to a different buyer. A
 * design/web/apps shop does not bid a dormitory Wi-Fi heat survey or a security
 * operations centre, and the hand-labelled set showed exactly that: `it-support`
 * passed 8 of 15 only under a "someone could do this work" reading, and
 * cybersecurity passed 0 of 15 outright.
 *
 * 541519 survives inside software-development on purpose. It is 60% of the
 * corpus and mostly hardware and licence renewals, which makes it the single
 * best demonstration of what the scoring step is for.
 */
export const RETIRED_AREAS = ['it-support', 'cybersecurity'] as const;

/**
 * Codes removed after the 2026-08-26 harvest, and why. Kept as a record so the
 * next person does not helpfully add them back:
 *
 *   541430 Graphic Design Services        — 0 records in the 7-day window
 *   541513 Computer Facilities Management — 0 records in the 7-day window
 *
 * Both were replaced rather than simply dropped, because the code count is a
 * hard budget line: `ncode` takes one code per request, so every code in the
 * union costs one request per refresh out of roughly ten a day.
 *
 *   518210 Data Processing, Hosting and Related Services
 *   811212 Computer and Office Machine Repair and Maintenance
 *
 * One week is thin evidence for calling a code dead. Both are worth re-checking
 * once the daily budget is better understood.
 *
 * Removed 2026-08-27, for a different and more embarrassing reason:
 *
 *   561621 Security Systems Services — this is *physical* security. Alarm and
 *   CCTV installation, not information security. It sat in the cybersecurity
 *   area on the strength of the word "security" in its title and nothing else.
 *
 * The hand-labelled set caught it: cybersecurity matched 86 of 107 notices and
 * scored 0 of 15 as worth reading. Federal infosec work is filed under
 * 541512/541519 with PSC DK/DH codes, so cybersecurity now relies on those two
 * codes plus the model actually reading the notice — which is the correct
 * division of labour anyway.
 *
 * And 811212 (Computer and Office Machine Repair) went with the it-support area
 * on Day 3 — see RETIRED_AREAS below.
 *
 * The union is now 6 codes, so a daily refresh costs 6 requests.
 */
export const RETIRED_NAICS = ['541430', '541513', '561621', '811212'] as const;

/**
 * The union of every code any area cares about — 6 distinct codes across 3 areas.
 *
 * This union is the fetch dimension, not the service area. `ncode` takes one
 * code per request, so the union size IS the daily request cost: 6 codes, 6
 * requests, one refresh a day, regardless of traffic.
 *
 * One pooled fetch with the areas derived from it in code is what makes that
 * work. Fetching per-area would pay twice for the overlaps — 541511 appears in
 * two areas and 518210 in two — for the same underlying notices.
 *
 * Adding a code is not free. It costs a request per refresh out of a budget
 * that api.data.gov declines to report.
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
 * The 2026-08-26 harvest returned 107 notices without them, so volume is not a
 * reason to reconsider.
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
