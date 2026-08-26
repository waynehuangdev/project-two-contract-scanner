import { DEFAULT_PROFILE, SERVICE_AREAS, SIZE_BANDS } from './config.ts';
import { applyHardFilters } from './lib/filter.ts';
import { trailingWindow } from './lib/window.ts';
import type { Notice, Profile, ServiceArea, SetAsidePreference, SizeBand } from './types.ts';

export interface Env {
  SAM_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  // Day 2 bindings.
  NOTICES?: KVNamespace;
  SCORES?: KVNamespace;
}

/**
 * Day 1 Worker.
 *
 * Deployed early on purpose: the point tonight is that deployment is a solved,
 * boring problem long before the last night, not that the endpoint does
 * anything interesting yet. It serves fixture data through the real filter
 * path, so the hard-constraint layer is exercised end to end without spending
 * a single SAM.gov request.
 *
 * Day 2 replaces `loadNotices` with the KV-cached fetch. Nothing else moves.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        stage: 'day-1',
        window: trailingWindow(),
        samKeyConfigured: Boolean(env.SAM_API_KEY),
      });
    }

    if (url.pathname === '/api/meta') {
      return json({
        areas: Object.entries(SERVICE_AREAS).map(([id, a]) => ({ id, label: a.label, naics: a.naics })),
        sizes: Object.entries(SIZE_BANDS).map(([id, b]) => ({ id, label: b.label })),
        defaults: DEFAULT_PROFILE,
      });
    }

    if (url.pathname === '/api/notices') {
      const profile = parseProfile(url.searchParams);
      const all = await loadNotices();
      const matched = applyHardFilters(all, profile);

      return json({
        profile,
        window: trailingWindow(),
        // `matched` is half the rejection line. The other half arrives on Day 3
        // when scoring exists; until then the shape is already correct so the
        // frontend never has to be rewritten around it.
        matched: matched.length,
        worthReading: null,
        source: 'fixture',
        results: matched,
      });
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Day 1: the hand-written fixture, inlined at build time.
 * Day 2: KV bucket with lazy TTL refresh, falling back to stale-with-a-flag.
 */
async function loadNotices(): Promise<Notice[]> {
  const { default: fixture } = await import('../fixtures/hand-written.json', {
    with: { type: 'json' },
  });
  return fixture as Notice[];
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
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
