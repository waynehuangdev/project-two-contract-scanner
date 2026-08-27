import type { Notice } from '../types.ts';

/**
 * The notice cache.
 *
 * The spec described five buckets, one per service area. The harvest showed
 * why that would be wrong here: `ncode` takes one code per request, the five
 * areas share codes (541519 alone appears in three of them), and fetching per
 * area would pay for 541511, 541512 and 541519 twice over. So one pooled fetch
 * of the eight-code union is cached, and the five buckets are derived from it
 * in code — free, exact, and a third of the requests.
 *
 * Everything here is shaped by one fact: the daily request budget is unknown.
 * api.data.gov returns no `X-RateLimit` headers on this endpoint, so we cannot
 * ask how much is left. That makes a failed refresh not an edge case but the
 * expected end state of any given day, and it is why `stale` is a first-class
 * return value rather than an error.
 */

const POOL_KEY = 'pool:v1';
const LOCK_KEY = 'pool:refreshing';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** A lock this old is assumed to belong to a dead request, not a live one. */
const LOCK_TTL_SECONDS = 120;

export interface CachedPool {
  /** ISO timestamp of the fetch that produced these notices. */
  fetchedAt: string;
  /** The window the notices were fetched for. */
  window: { from: string; to: string };
  notices: Notice[];
}

export interface PoolResult {
  notices: Notice[];
  fetchedAt: string | null;
  /**
   * True when the data is past its TTL and a refresh did not succeed.
   *
   * The UI must distinguish this from a quiet week. Rendering stale data as
   * fresh is dishonest; rendering it as zero results is worse — it tells the
   * visitor federal IT procurement paused, which is never true.
   */
  stale: boolean;
  /** Set when there is nothing to show at all — cold cache and a failed fetch. */
  error: string | null;
}

export class NoticeCache {
  private readonly kv: KVNamespace;
  private readonly ttlMs: number;

  constructor(kv: KVNamespace, ttlMs: number = DEFAULT_TTL_MS) {
    this.kv = kv;
    this.ttlMs = ttlMs;
  }

  async read(): Promise<CachedPool | null> {
    const raw = await this.kv.get(POOL_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedPool;
    } catch {
      // Corrupt entry: treat as absent rather than throwing. A cache is an
      // optimisation, and an optimisation should never be able to take the
      // service down.
      return null;
    }
  }

  async write(pool: CachedPool): Promise<void> {
    // No KV expiration is set on purpose. Freshness is decided by `fetchedAt`
    // against the TTL, not by the entry vanishing — because an entry that
    // vanishes takes the stale-serve fallback with it, and stale data is the
    // difference between a degraded page and a broken one.
    await this.kv.put(POOL_KEY, JSON.stringify(pool));
  }

  isFresh(pool: CachedPool, now: Date = new Date()): boolean {
    const age = now.getTime() - Date.parse(pool.fetchedAt);
    return Number.isFinite(age) && age >= 0 && age < this.ttlMs;
  }

  /**
   * Best-effort single-flight guard.
   *
   * KV is eventually consistent, so this cannot guarantee one refresh — two
   * isolates can both read an unheld lock before either writes. It is the
   * cross-isolate half of the guard; `inFlight` below is the exact half, and
   * neither substitutes for the other. Together they take a cold-start burst
   * from one harvest per request down to roughly one.
   */
  async tryLock(): Promise<boolean> {
    const held = await this.kv.get(LOCK_KEY);
    if (held) return false;
    await this.kv.put(LOCK_KEY, '1', { expirationTtl: LOCK_TTL_SECONDS });
    return true;
  }

  async releaseLock(): Promise<void> {
    await this.kv.delete(LOCK_KEY);
  }
}

/**
 * Isolate-local single-flight.
 *
 * The KV lock below cannot actually prevent a stampede: KV is eventually
 * consistent, so N concurrent requests can all read "no lock" before any of
 * them writes one. This map can, for the case that matters most — a burst of
 * requests landing on the *same* isolate, which is exactly what happens when a
 * link is posted and traffic arrives all at once.
 *
 * The two layers do different jobs and neither replaces the other: this one is
 * exact but only within one isolate; the KV lock is approximate but spans all
 * of them. Together they take a cold-start burst from "one harvest per
 * request" to "roughly one harvest".
 */
let inFlight: Promise<CachedPool> | null = null;

export function __resetInFlight(): void {
  inFlight = null; // test seam; never called in production
}

/** Thrown inside the refresh attempt when another isolate already holds the lock. */
class LockHeld extends Error {}

/**
 * Resolve the pool: serve fresh, refresh lazily when stale, and fall back to
 * stale data rather than emptiness when a refresh cannot happen.
 *
 * `refresh` is injected rather than imported so this whole decision tree is
 * testable against an in-memory KV and a stub fetcher — no network, no key.
 * The branch that matters most (expired cache, failed refresh, serve stale) is
 * precisely the one hardest to reproduce against the real API.
 */
export async function resolvePool(
  cache: NoticeCache,
  refresh: () => Promise<CachedPool>,
  now: Date = new Date(),
): Promise<PoolResult> {
  const existing = await cache.read();

  if (existing && cache.isFresh(existing, now)) {
    return { notices: existing.notices, fetchedAt: existing.fetchedAt, stale: false, error: null };
  }

  // Stale or cold. If this isolate is already refreshing, join that work
  // instead of starting a second harvest.
  if (inFlight) {
    if (existing) {
      // Stale data now beats fresh data later. A visitor should never wait on
      // an eight-request harvest to see notices that are still this week's.
      return { notices: existing.notices, fetchedAt: existing.fetchedAt, stale: true, error: null };
    }
    return await joinInFlight(inFlight);
  }

  // Claim the slot SYNCHRONOUSLY. There must be no `await` between the check
  // above and this assignment: an await here is a window in which every
  // request in a burst sees `inFlight === null` and starts its own harvest,
  // which is the exact stampede this exists to prevent. The lock acquisition
  // therefore happens inside the promise, not before it.
  const attempt = (async () => {
    if (!(await cache.tryLock())) throw new LockHeld();
    try {
      const fresh = await refresh();
      await cache.write(fresh);
      return fresh;
    } finally {
      await cache.releaseLock();
    }
  })();
  inFlight = attempt;

  try {
    const fresh = await attempt;
    return { notices: fresh.notices, fetchedAt: fresh.fetchedAt, stale: false, error: null };
  } catch (err) {
    if (existing) {
      // The branch that matters. Quota exhausted, SAM.gov down, a shape change,
      // or another isolate mid-refresh — either way yesterday's notices are
      // still true and still useful.
      return { notices: existing.notices, fetchedAt: existing.fetchedAt, stale: true, error: null };
    }
    if (err instanceof LockHeld) {
      return { notices: [], fetchedAt: null, stale: false, error: 'Refreshing — try again in a moment.' };
    }
    // Cold cache and no way to fill it. The designed failure state, and it must
    // never be dressed up as "no opportunities this week".
    return { notices: [], fetchedAt: null, stale: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Clear unconditionally: a rejected promise left here would wedge every
    // later request in this isolate behind a failure that already happened.
    inFlight = null;
  }
}

async function joinInFlight(p: Promise<CachedPool>): Promise<PoolResult> {
  try {
    const fresh = await p;
    return { notices: fresh.notices, fetchedAt: fresh.fetchedAt, stale: false, error: null };
  } catch (err) {
    if (err instanceof LockHeld) {
      return { notices: [], fetchedAt: null, stale: false, error: 'Refreshing — try again in a moment.' };
    }
    return { notices: [], fetchedAt: null, stale: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Count SAM.gov requests we spend, per UTC day.
 *
 * The only visibility available into a budget that reports nothing. Also the
 * evidence for the definition-of-done claim that usage stays at or under three
 * requests a day under load — a claim that should be checkable rather than
 * asserted.
 */
export class CallCounter {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  private key(now: Date): string {
    return `sam_calls:${now.toISOString().slice(0, 10)}`;
  }

  async get(now: Date = new Date()): Promise<number> {
    const v = await this.kv.get(this.key(now));
    return v ? Number(v) || 0 : 0;
  }

  /**
   * Increment by `n`.
   *
   * Read-modify-write, which races under concurrency and can undercount. That
   * is acceptable here and the alternative is not: a Durable Object for exact
   * counting would be real infrastructure for a diagnostic. Undercounting is
   * also the safe direction — it never invents usage that did not happen.
   */
  async add(n: number, now: Date = new Date()): Promise<number> {
    const key = this.key(now);
    const next = (await this.get(now)) + n;
    // 8 days: long enough to see a week's pattern, short enough to stay tidy.
    await this.kv.put(key, String(next), { expirationTtl: 8 * 24 * 60 * 60 });
    return next;
  }
}
