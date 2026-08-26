import { ALLOWED_PTYPES } from '../config.ts';
import type { DateWindow, Notice } from '../types.ts';
import { SourceError, type FetchResult, type SourceAdapter } from './adapter.ts';
import { SAM_SEARCH_URL } from '../lib/endpoint.ts';

const PAGE_SIZE = 1000; // documented maximum
const MAX_PAGES_PER_CODE = 2; // a 7-day window per NAICS code will not exceed this

/**
 * The raw record shape, as documented. Every field optional — this is untrusted
 * input from someone else's API and the normalizer is where it becomes safe.
 */
interface SamRecord {
  noticeId?: string;
  title?: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  postedDate?: string;
  type?: string;
  baseType?: string;
  typeOfSetAsideDescription?: string;
  typeOfSetAside?: string;
  responseDeadLine?: string;
  naicsCode?: string;
  classificationCode?: string;
  description?: string; // a URL, not text — see hydrateDescription
  uiLink?: string;
  award?: { amount?: string | number } | null;
}

/**
 * SAM.gov Get Opportunities (public API).
 *
 * Two documented properties of this API drive everything below, and both cost
 * more than the spec assumed:
 *
 *   1. `ncode` takes ONE NAICS code per request. There is no comma list and no
 *      parent-code search. N codes therefore means N requests, minimum.
 *   2. The `description` field is a LINK, not text. Reading a notice costs an
 *      extra request per notice.
 *
 * Against a 10-request/day public key that arithmetic does not close, so
 * description hydration is deliberately a separate method with its own cache
 * and its own budget rather than something fetchWindow does implicitly. Making
 * the expensive thing explicit is the point: the caller has to decide how many
 * notices are worth reading today, because that decision cannot be hidden.
 */
export class SamGovAdapter implements SourceAdapter {
  readonly id = 'sam.gov' as const;

  // Plain field rather than a TypeScript parameter property: parameter
  // properties are erasable-syntax violations, and keeping the whole src tree
  // erasable is what lets `node --experimental-strip-types` run the real
  // modules in tests with no build step in between.
  private readonly apiKey: string;
  private readonly searchUrl: string;

  // searchUrl is injectable so the endpoint the probe resolved can be passed
  // in, and so tests can point at a local stub without patching global fetch.
  constructor(apiKey: string, searchUrl: string = SAM_SEARCH_URL) {
    this.apiKey = apiKey;
    this.searchUrl = searchUrl;
  }

  async fetchWindow({
    window,
    naicsCodes,
    onCall,
  }: {
    window: DateWindow;
    naicsCodes: string[];
    onCall?: () => void;
  }): Promise<FetchResult> {
    const seen = new Map<string, Notice>();
    let callsSpent = 0;
    let truncated = false;

    // One request per code, sequentially. Sequential rather than parallel on
    // purpose: if the daily quota runs out mid-fetch we want the codes we did
    // get, not five simultaneous 429s.
    for (const code of naicsCodes) {
      for (let page = 0; page < MAX_PAGES_PER_CODE; page++) {
        const url = new URL(this.searchUrl);
        url.searchParams.set('api_key', this.apiKey);
        url.searchParams.set('postedFrom', toSamDate(window.from));
        url.searchParams.set('postedTo', toSamDate(window.to));
        url.searchParams.set('ncode', code);
        url.searchParams.set('limit', String(PAGE_SIZE));
        url.searchParams.set('offset', String(page));
        // ptype IS multi-valued (collectionFormat: multi) — repeat the param.
        // Awards are excluded here, at fetch time, and never surface as a user control.
        for (const t of ALLOWED_PTYPES) url.searchParams.append('ptype', t);

        onCall?.();
        callsSpent++;

        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new SourceError(
            `SAM.gov search failed for ncode=${code}: ${res.status} ${body.slice(0, 200)}`,
            this.id,
            res.status,
          );
        }

        const json = (await res.json()) as { totalRecords?: number; opportunitiesData?: SamRecord[] };
        const batch = json.opportunitiesData ?? [];

        for (const raw of batch) {
          const notice = normalizeSamRecord(raw);
          // Dedupe on noticeId. Codes overlap across service areas and a notice
          // can carry a code we asked for twice, so collisions are normal, not errors.
          if (notice && !seen.has(notice.noticeId)) seen.set(notice.noticeId, notice);
        }

        if (batch.length < PAGE_SIZE) break;
        if (page === MAX_PAGES_PER_CODE - 1) truncated = true;
      }
    }

    return { notices: [...seen.values()], callsSpent, truncated };
  }

  /**
   * Fetch the description text for one notice. ONE REQUEST AGAINST THE DAILY QUOTA.
   *
   * Never call this in a loop over a whole bucket without metering it. The
   * caller owns the budget; this method just spends what it is told to.
   */
  async hydrateDescription(notice: Notice, onCall?: () => void): Promise<string | null> {
    if (!notice.descriptionUrl) return null;

    const url = new URL(notice.descriptionUrl);
    url.searchParams.set('api_key', this.apiKey);

    onCall?.();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null; // a missing description is a thin notice, not a failed scan

    const text = await res.text();
    // The endpoint has been observed returning both a bare string and a JSON
    // envelope. Accept either; return null rather than guessing on anything else.
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === 'string') return stripHtml(parsed);
      if (parsed && typeof parsed === 'object' && 'description' in parsed) {
        const d = (parsed as { description?: unknown }).description;
        return typeof d === 'string' ? stripHtml(d) : null;
      }
      return null;
    } catch {
      return text.trim() ? stripHtml(text) : null;
    }
  }
}

/**
 * Raw SAM record → internal Notice, or null if the record is unusable.
 *
 * The rule this function exists to enforce: absent means null. Not 0, not '',
 * not 'Not specified'. Every synthesized default here would become a confident
 * fabrication three layers later, in a UI row that claims a contract is worth
 * $0 or due today.
 */
export function normalizeSamRecord(raw: SamRecord): Notice | null {
  const noticeId = nonEmpty(raw.noticeId);
  const title = nonEmpty(raw.title);
  const postedDate = toIsoDate(raw.postedDate);
  // No id, no title, or no posted date means we cannot dedupe it, display it,
  // or place it in the window. Drop it rather than inventing any of the three.
  if (!noticeId || !title || !postedDate) return null;

  // Belt and braces on the award exclusion. The `ptype` request parameter is
  // the primary control, but it is a filter we ask someone else to apply, and
  // an award notice leaking into results is the single most embarrassing
  // failure this tool could have — the entire pitch is "stop reading noise".
  // Cheap to check here, and unlike the request parameter it is testable offline.
  const typeLabel = (nonEmpty(raw.type) ?? nonEmpty(raw.baseType) ?? '').toLowerCase();
  if (typeLabel.includes('award')) return null;

  return {
    noticeId,
    solicitationNumber: nonEmpty(raw.solicitationNumber),
    title,
    agency: nonEmpty(raw.fullParentPathName)?.split('.')[0]?.trim() ?? null,
    noticeType: nonEmpty(raw.type) ?? nonEmpty(raw.baseType) ?? 'Unknown',
    postedDate,
    dueDate: toIsoDate(raw.responseDeadLine),
    // SAM.gov states no estimated value on solicitations. `award.amount` exists
    // only on award notices, which are excluded at fetch — so reading it here
    // would import a figure from exactly the records we refuse to show.
    // Value therefore stays null unless the scoring step extracts one from the
    // description text, and the UI must be able to render "not stated".
    valueEstimate: null,
    setAside: nonEmpty(raw.typeOfSetAsideDescription) ?? nonEmpty(raw.typeOfSetAside),
    naics: nonEmpty(raw.naicsCode),
    classificationCode: nonEmpty(raw.classificationCode),
    description: null, // hydrated separately; see hydrateDescription
    descriptionUrl: nonEmpty(raw.description),
    url: nonEmpty(raw.uiLink),
    source: 'sam.gov',
  };
}

/** Trim, then treat blank as absent. SAM.gov uses '' and '   ' interchangeably with omission. */
function nonEmpty(v: string | undefined | null): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

/** SAM.gov dates arrive in several shapes. Anything unparseable becomes null, never today's date. */
export function toIsoDate(v: string | undefined | null): string | null {
  const s = nonEmpty(v);
  if (!s) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** postedFrom / postedTo are required and must be MM/DD/YYYY. */
export function toSamDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) throw new Error(`Expected ISO date, got: ${iso}`);
  return `${m}/${d}/${y}`;
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
