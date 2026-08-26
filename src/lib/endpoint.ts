/**
 * Which base URL actually serves the v2 search endpoint.
 *
 * The GSA docs list this endpoint two ways — with and without a `/prod/`
 * segment — and the version without it returns a bare 404. The `/prod/` form
 * is also what SAM.gov itself emits inside every record's `description` link,
 * which is decent evidence for which one is real.
 *
 * Rather than pick one and hope, the scripts probe. A wrong base URL fails as
 * a 404 with an empty body, which looks exactly like a dozen other problems —
 * a bad key, an expired key, a malformed date — and the whole point of step
 * zero is that it answers questions instead of raising them.
 */
export const SAM_SEARCH_CANDIDATES = [
  'https://api.sam.gov/prod/opportunities/v2/search',
  'https://api.sam.gov/opportunities/v2/search',
] as const;

/** Default for the Worker. Update if the probe ever disagrees. */
export const SAM_SEARCH_URL: string = SAM_SEARCH_CANDIDATES[0];

/** The v1 description endpoint, for when a record carries no `description` link. */
export const SAM_DESC_URL = 'https://api.sam.gov/prod/opportunities/v1/noticedesc';

export interface ProbeOutcome {
  url: string;
  status: number;
  ok: boolean;
  totalRecords: number | null;
  rateLimit: { limit: number | null; remaining: number | null };
  bodyHead: string;
}

/**
 * Try each candidate with the cheapest possible valid request until one answers.
 *
 * Costs at most one request per candidate, and stops at the first success —
 * so on the happy path it costs exactly one. Non-404 failures (401, 403, 429)
 * stop the loop too: those mean the path was right and something else is
 * wrong, and retrying the other base URL would waste a request confirming it.
 */
export async function resolveSearchUrl(
  apiKey: string,
  params: Array<[string, string]>,
  candidates: readonly string[] = SAM_SEARCH_CANDIDATES,
): Promise<{ resolved: string | null; attempts: ProbeOutcome[] }> {
  const attempts: ProbeOutcome[] = [];

  for (const base of candidates) {
    const url = new URL(base);
    url.searchParams.set('api_key', apiKey);
    for (const [k, v] of params) url.searchParams.append(k, v);

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await res.text();
    let totalRecords: number | null = null;
    try {
      const j = JSON.parse(body) as { totalRecords?: number };
      totalRecords = typeof j.totalRecords === 'number' ? j.totalRecords : null;
    } catch {
      /* error pages are not JSON */
    }

    const limit = res.headers.get('x-ratelimit-limit');
    const remaining = res.headers.get('x-ratelimit-remaining');

    attempts.push({
      url: base,
      status: res.status,
      ok: res.ok,
      totalRecords,
      rateLimit: {
        limit: limit === null ? null : Number(limit),
        remaining: remaining === null ? null : Number(remaining),
      },
      // Never echo the URL back — it carries the api_key.
      bodyHead: body.slice(0, 300).replace(/\s+/g, ' '),
    });

    if (res.ok) return { resolved: base, attempts };
    if (res.status !== 404) return { resolved: null, attempts };
  }

  return { resolved: null, attempts };
}
