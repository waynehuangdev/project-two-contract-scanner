import { ALL_NAICS, DEFAULT_PROFILE, SERVICE_AREAS, SIZE_BANDS, WINDOW_DAYS } from './config.ts';
import { CallCounter, NoticeCache, resolvePool, type CachedPool, type PoolResult } from './lib/cache.ts';
import { applyHardFilters } from './lib/filter.ts';
import { trailingWindow } from './lib/window.ts';
import { SamGovAdapter, parseUiDescription } from './sources/samgov.ts';
import { scoreNotice, type ModelClient } from './scoring/score.ts';
import { ScoreCache, MAX_COLD_SCORES_PER_REQUEST } from './scoring/cache.ts';
import { KVGlossary } from './scoring/glossary.ts';
import { WORTH_READING_MIN } from './scoring/prompt.ts';
import { SAM_UI_OPPORTUNITY_URL } from './lib/endpoint.ts';
import { NOTICE_TTL_SECONDS } from './lib/retention.ts';
import type { Notice, Profile, ServiceArea, SetAsidePreference, SizeBand } from './types.ts';

export interface Env {
  SAM_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  NOTICES?: KVNamespace;
  SCORES?: KVNamespace;
  /** Bound but unused until the optional Day 4 rate limiting. */
  RATELIMIT?: KVNamespace;
}

/**
 * The Worker.
 *
 *   /api/health       diagnostics, including SAM.gov calls spent today
 *   /api/meta         service areas and defaults, so the page cannot drift
 *   /api/description  one notice's text, cached 90 days — the unmetered path
 *   /api/notices      hard-filtered pool, unscored
 *   /api/scan         the product: filtered, read, judged, ranked
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      const calls = env.NOTICES ? await new CallCounter(env.NOTICES).get() : null;
      return json({
        ok: true,
        stage: 'day-4',
        window: trailingWindow(),
        samKeyConfigured: Boolean(env.SAM_API_KEY),
        kvBound: Boolean(env.NOTICES),
        samCallsToday: calls,
      });
    }

    /**
     * Description text for one notice, cached for 90 days.
     *
     * Descriptions come from sam.gov's own UI host, which costs no SAM.gov
     * quota — the entire reason the project is viable. Verified reachable from
     * Cloudflare's edge with plain headers on 2026-08-27, after the same
     * request was refused from a laptop with ECONNRESET at the TLS layer. The
     * difference is the edge, not the headers, and no spoofing is involved.
     *
     * Cached by noticeId: a notice version's text never changes, and an
     * amendment arrives as a new noticeId, so this is spent once per notice.
     * The 90-day expiry is about store size rather than correctness — see
     * lib/retention.ts. The scanner only ever reads a trailing 7-day window,
     * so anything older is already unreachable.
     *
     * Also the primitive the offline scoring harness hydrates through, since a
     * laptop cannot reach the upstream directly.
     */
    if (url.pathname === '/api/description') {
      const noticeId = url.searchParams.get('noticeId');
      if (!noticeId || !/^[0-9a-f]{16,64}$/i.test(noticeId)) {
        return json({ error: 'noticeId must be a hex notice id' }, 400);
      }
      if (!env.NOTICES) return json({ error: 'KV not bound' }, 503);

      const key = `desc:${noticeId}`;
      const cached = await env.NOTICES.get(key);
      if (cached !== null) {
        return json({ noticeId, description: cached || null, cached: true });
      }

      const text = await fetchDescription(noticeId);
      if (text === null) {
        // Not cached. A transient upstream failure must not become a permanent
        // empty description — that would look like a thin notice forever.
        return json({ noticeId, description: null, cached: false, error: 'upstream unavailable' }, 502);
      }

      await env.NOTICES.put(key, text, { expirationTtl: NOTICE_TTL_SECONDS });
      return json({ noticeId, description: text, cached: false });
    }

    if (url.pathname === '/api/meta') {
      return json({
        areas: Object.entries(SERVICE_AREAS).map(([id, a]) => ({ id, label: a.label, naics: a.naics })),
        sizes: Object.entries(SIZE_BANDS).map(([id, b]) => ({ id, label: b.label })),
        defaults: DEFAULT_PROFILE,
        windowDays: WINDOW_DAYS,
      });
    }

    if (url.pathname === '/api/notices') {
      const profile = parseProfile(url.searchParams);
      const pool = await loadPool(env);

      // A cold cache that could not be filled is a failure, not a quiet week.
      // Say so with a 503 so the frontend can render its failure state and
      // monitoring can tell the difference.
      if (pool.error && pool.notices.length === 0) {
        return json({ profile, error: pool.error, matched: 0, worthReading: null, results: [] }, 503);
      }

      const matched = applyHardFilters(pool.notices, profile);

      return json({
        profile,
        window: trailingWindow(),
        // The rejection line's two numbers. `matched` is the boring half and is
        // real today; `worthReading` stays null until scoring exists rather
        // than being faked with a filter count.
        matched: matched.length,
        worthReading: null,
        asOf: pool.fetchedAt,
        stale: pool.stale,
        poolSize: pool.notices.length,
        results: matched,
      });
    }

    if (url.pathname === '/api/scan') {
      return scan(url, env);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * The scan: hard-filter, then judge the survivors.
 *
 * The two numbers in the response are the product. `matched` is the boring
 * half — a WHERE clause over NAICS, size and set-aside, no model involved.
 * `worthReading` is the judgement. The gap between them is the whole pitch,
 * and it is only honest if both are computed over the same complete set.
 *
 * Which is why `stillReading` exists. A cold profile cannot be fully scored in
 * one request — Cloudflare allows 50 subrequests and each notice costs one to
 * three model calls — so the response says how many are still unread rather
 * than quietly reporting a rejection line computed over a truncated set. A
 * wrong number stated confidently is worse than an honest partial one.
 */
async function scan(url: URL, env: Env): Promise<Response> {
  const profile = parseProfile(url.searchParams);
  const pool = await loadPool(env);

  if (pool.error && pool.notices.length === 0) {
    return json({ profile, error: pool.error, matched: 0, worthReading: null, results: [] }, 503);
  }

  const matched = applyHardFilters(pool.notices, profile);

  if (!env.ANTHROPIC_API_KEY || !env.SCORES || !env.NOTICES) {
    // No scoring available. Say so rather than returning unranked rows that
    // look like judged ones.
    return json({
      profile,
      window: trailingWindow(),
      matched: matched.length,
      worthReading: null,
      stillReading: matched.length,
      asOf: pool.fetchedAt,
      stale: pool.stale,
      error: 'Scoring is not configured on this deployment.',
      results: [],
    }, 503);
  }

  const scores = new ScoreCache(env.SCORES);
  const glossary = new KVGlossary(env.SCORES);
  const model = anthropicClient(env.ANTHROPIC_API_KEY);

  const scored: Array<{ notice: Notice; result: Awaited<ReturnType<typeof scoreNotice>> }> = [];
  const unscored: Notice[] = [];

  // Cached first, so a warm scan costs no model calls at all. The cache is keyed
  // by notice alone — one reading answers for every service area — so switching
  // area in the UI is free after the first visitor has warmed a notice.
  for (const notice of matched) {
    const hit = await scores.get(notice.noticeId);
    if (hit) scored.push({ notice, result: hit });
    else unscored.push(notice);
  }

  // Newest first: if only some can be read this request, read the ones a
  // visitor is most likely to care about.
  unscored.sort((a, b) => (a.postedDate < b.postedDate ? 1 : -1));
  const toScore = unscored.slice(0, MAX_COLD_SCORES_PER_REQUEST);

  // Read in parallel, in bounded batches.
  //
  // These were sequential, and a cold scan took over a minute — fourteen
  // notices at one to three model calls each, strictly one after another,
  // against a stated success criterion of five seconds. The calls are
  // independent; serialising them bought nothing.
  //
  // Bounded rather than unbounded because a burst of 40 simultaneous requests
  // to one API is how you discover its rate limit in production. Six at a time
  // turns ~60s into ~10s and stays polite.
  const CONCURRENCY = 6;
  for (let i = 0; i < toScore.length; i += CONCURRENCY) {
    const batch = toScore.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (notice) => {
        const description = await readDescription(notice, env);
        const result = await scoreNotice({ ...notice, description }, model, glossary);
        await scores.put(notice.noticeId, result);
        return { notice, result };
      }),
    );
    for (const outcome of settled) {
      // One notice failing must not fail the scan. It stays unread and gets
      // another chance on the next request.
      if (outcome.status === 'fulfilled') scored.push(outcome.value);
    }
  }

  // Every verdict below is read from the selected area of a shared reading.
  const verdict = (r: Awaited<ReturnType<typeof scoreNotice>>) => r.areas[profile.area];

  scored.sort((a, b) => verdict(b.result).score - verdict(a.result).score);
  const worthReading = scored.filter((s) => verdict(s.result).score >= WORTH_READING_MIN);

  return json({
    profile,
    window: trailingWindow(),
    matched: matched.length,
    worthReading: worthReading.length,
    stillReading: matched.length - scored.length,
    asOf: pool.fetchedAt,
    stale: pool.stale,
    results: scored.map(({ notice, result }) => ({
      noticeId: notice.noticeId,
      title: notice.title,
      agency: notice.agency,
      noticeType: notice.noticeType,
      dueDate: notice.dueDate,
      // From the scorer only when the text stated one. Never from the notice
      // record, which has no value field at all.
      valueEstimate: result.valueEstimate,
      setAside: notice.setAside,
      url: notice.url,
      score: verdict(result).score,
      band: verdict(result).band,
      justification: verdict(result).justification,
      // The shared reading, exposed because it is the same for every area and
      // is often the most useful line on the row — "a sole-source renewal of a
      // proprietary product" says more than any score.
      reading: result.reading,
      disqualifiers: result.disqualifiers,
    })),
  });
}

/** Description text, from the permanent KV cache or the unmetered upstream. */
async function readDescription(notice: Notice, env: Env): Promise<string | null> {
  if (!env.NOTICES) return notice.description;
  const key = `desc:${notice.noticeId}`;
  const cached = await env.NOTICES.get(key);
  if (cached !== null) return cached || null;

  const text = await fetchDescription(notice.noticeId);
  if (text !== null) await env.NOTICES.put(key, text, { expirationTtl: NOTICE_TTL_SECONDS });
  return text;
}

/** Anthropic Messages API with forced tool output. Shared shape with the harness. */
function anthropicClient(apiKey: string): ModelClient {
  return {
    async complete({ system, user, schema, maxTokens }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [{ name: 'record', description: 'Record the result.', input_schema: schema }],
          tool_choice: { type: 'tool', name: 'record' },
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}`);
      const json = (await res.json()) as { content?: Array<{ type: string; input?: unknown }> };
      const block = (json.content ?? []).find((c) => c.type === 'tool_use');
      if (!block?.input) throw new Error('no tool_use block');
      return block.input as Record<string, unknown>;
    },
  };
}

/**
 * Resolve the notice pool, preferring KV and falling back to the bundled
 * fixture when KV is not bound.
 *
 * The fixture path keeps `wrangler dev` useful with no KV namespace and no API
 * key, which is what makes the frontend work on Day 4 possible without
 * spending requests from a budget that reports nothing.
 */
async function loadPool(env: Env): Promise<PoolResult> {
  if (!env.NOTICES || !env.SAM_API_KEY) {
    const { default: fixture } = await import('../fixtures/hand-written.json', {
      with: { type: 'json' },
    });
    return {
      notices: fixture as Notice[],
      fetchedAt: null,
      stale: false,
      error: null,
    };
  }

  const cache = new NoticeCache(env.NOTICES);
  const counter = new CallCounter(env.NOTICES);

  return resolvePool(cache, async (): Promise<CachedPool> => {
    const window = trailingWindow();
    const adapter = new SamGovAdapter(env.SAM_API_KEY!);

    let spent = 0;
    const { notices } = await adapter.fetchWindow({
      window,
      // The union of every area's codes, fetched once. The five buckets are
      // derived from this pool in code — see lib/cache.ts for why.
      naicsCodes: ALL_NAICS,
      onCall: () => spent++,
    });

    // Record usage even though the fetch succeeded — the counter is the only
    // visibility we have into a budget the API refuses to report.
    await counter.add(spent);

    return { fetchedAt: new Date().toISOString(), window, notices };
  });
}

/**
 * Unknown values fall back to the default rather than 400-ing.
 *
 * This endpoint is public and linked from a portfolio site; a malformed query
 * string should render a sensible page, not an error. The set of valid values
 * is closed and small, so there is nothing to be strict about.
 */
function parseProfile(params: URLSearchParams): Profile {
  const area = params.get('area');
  const size = params.get('size');
  const setAside = params.get('setAside');

  return {
    area: area && area in SERVICE_AREAS ? (area as ServiceArea) : DEFAULT_PROFILE.area,
    size: size && size in SIZE_BANDS ? (size as SizeBand) : DEFAULT_PROFILE.size,
    setAside: setAside === 'small-business' ? ('small-business' as SetAsidePreference) : 'any',
  };
}

/**
 * Fetch one description from the sam.gov UI host.
 *
 * Returns null on any failure — the caller decides what a failure means, and
 * in every case so far the answer is "do not cache it".
 */
async function fetchDescription(noticeId: string): Promise<string | null> {
  const target = new URL(`${SAM_UI_OPPORTUNITY_URL}/${encodeURIComponent(noticeId)}`);
  target.searchParams.set('api_key', 'null');

  try {
    const res = await fetch(target, {
      headers: {
        Accept: '*/*',
        // Truthful. This endpoint accepts an honestly-identified client; if it
        // ever required a browser signature that would be a reason to stop
        // using it, not a header to change.
        'User-Agent': 'contract-scanner/0.1 (+https://waynehuang.dev)',
      },
    });
    if (!res.ok) return null;
    return parseUiDescription(await res.json());
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // No CORS header. The page is served by this same Worker, so it is
      // same-origin and does not need one. Leaving `*` here would let any site
      // call an endpoint that spends model tokens — a small abuse surface with
      // nothing to buy it.
    },
  });
}
