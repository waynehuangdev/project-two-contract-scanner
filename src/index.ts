import { ALL_NAICS, DEFAULT_PROFILE, SERVICE_AREAS, SIZE_BANDS, WINDOW_DAYS } from './config.ts';
import { CallCounter, NoticeCache, resolvePool, type CachedPool, type PoolResult } from './lib/cache.ts';
import { applyHardFilters } from './lib/filter.ts';
import { trailingWindow } from './lib/window.ts';
import { SamGovAdapter } from './sources/samgov.ts';
import type { Notice, Profile, ServiceArea, SetAsidePreference, SizeBand } from './types.ts';

export interface Env {
  SAM_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  NOTICES?: KVNamespace;
  SCORES?: KVNamespace;
}

/**
 * Day 2 Worker: cached fetch, no scoring yet.
 *
 * The response shape already carries `worthReading` and `stale` even though
 * nothing sets `worthReading` until Day 3. Getting the shape right now means
 * the frontend is written once against its final contract rather than
 * retrofitted around a field that appeared late.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      const calls = env.NOTICES ? await new CallCounter(env.NOTICES).get() : null;
      return json({
        ok: true,
        stage: 'day-2',
        window: trailingWindow(),
        samKeyConfigured: Boolean(env.SAM_API_KEY),
        kvBound: Boolean(env.NOTICES),
        samCallsToday: calls,
      });
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

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The frontend is served from Pages, a different origin from the Worker.
      'access-control-allow-origin': '*',
    },
  });
}
