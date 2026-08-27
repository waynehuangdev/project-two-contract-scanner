/**
 * Cache tests, against an in-memory KV.
 *
 * The branch worth the most here is the one hardest to reproduce live: TTL
 * expired, refresh fails, serve stale anyway. On an unknown daily budget that
 * is not an edge case — it is how most days will end. Getting it wrong means
 * the page tells a visitor federal IT procurement went quiet, which is never
 * true and is the single most damaging thing this tool could say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoticeCache, CallCounter, resolvePool, __resetInFlight } from '../src/lib/cache.ts';
import { beforeEach } from 'node:test';

// The in-flight guard is module state — reset it so tests do not leak into
// each other. Production never calls this.
beforeEach(() => __resetInFlight());

/** Minimal KVNamespace stand-in. Enough surface for what cache.ts actually uses. */
function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(k) {
      const e = store.get(k);
      if (!e) return null;
      if (e.expiresAt && Date.now() > e.expiresAt) {
        store.delete(k);
        return null;
      }
      return e.value;
    },
    async put(k, value, opts) {
      store.set(k, {
        value,
        expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null,
      });
    },
    async delete(k) {
      store.delete(k);
    },
  };
}

const notice = (id) => ({ noticeId: id, title: `Notice ${id}`, naics: '541511' });
const pool = (at, ids) => ({
  fetchedAt: at,
  window: { from: '2026-08-20', to: '2026-08-26' },
  notices: ids.map(notice),
});

const T0 = new Date('2026-08-26T12:00:00Z');
const T_PLUS_1H = new Date('2026-08-26T13:00:00Z');
const T_PLUS_30H = new Date('2026-08-27T18:00:00Z');

test('a fresh pool is served without refreshing', async () => {
  const cache = new NoticeCache(memoryKV());
  await cache.write(pool(T0.toISOString(), ['a', 'b']));

  let refreshed = false;
  const r = await resolvePool(cache, async () => { refreshed = true; return pool(T_PLUS_1H.toISOString(), ['x']); }, T_PLUS_1H);

  assert.equal(refreshed, false, 'must not spend requests on fresh data');
  assert.equal(r.notices.length, 2);
  assert.equal(r.stale, false);
});

test('an expired pool triggers exactly one refresh', async () => {
  const cache = new NoticeCache(memoryKV());
  await cache.write(pool(T0.toISOString(), ['a']));

  let calls = 0;
  const r = await resolvePool(cache, async () => { calls++; return pool(T_PLUS_30H.toISOString(), ['x', 'y']); }, T_PLUS_30H);

  assert.equal(calls, 1);
  assert.equal(r.notices.length, 2);
  assert.equal(r.stale, false);
});

test('THE IMPORTANT ONE: expired + failed refresh serves stale, never empty', async () => {
  const cache = new NoticeCache(memoryKV());
  await cache.write(pool(T0.toISOString(), ['a', 'b', 'c']));

  const r = await resolvePool(cache, async () => { throw new Error('429 quota exhausted'); }, T_PLUS_30H);

  assert.equal(r.notices.length, 3, 'yesterday\'s notices are still this week\'s notices');
  assert.equal(r.stale, true, 'and the page must be told they are stale');
  assert.equal(r.error, null, 'a served-stale response is degraded, not failed');
  assert.equal(r.fetchedAt, T0.toISOString(), 'the timestamp must reflect the real fetch');
});

test('a failed refresh does not overwrite good data with nothing', async () => {
  const cache = new NoticeCache(memoryKV());
  await cache.write(pool(T0.toISOString(), ['a', 'b']));
  await resolvePool(cache, async () => { throw new Error('down'); }, T_PLUS_30H);

  const still = await cache.read();
  assert.equal(still.notices.length, 2);
});

test('cold cache + failed fetch reports an error — not a quiet week', async () => {
  const cache = new NoticeCache(memoryKV());
  const r = await resolvePool(cache, async () => { throw new Error('SAM.gov unreachable'); }, T0);

  assert.equal(r.notices.length, 0);
  assert.equal(r.stale, false);
  assert.match(r.error, /unreachable/, 'the failure state must be distinguishable from emptiness');
});

test('a concurrent burst triggers one harvest, not one per visitor', async () => {
  const kv = memoryKV();
  const cache = new NoticeCache(kv);
  await cache.write(pool(T0.toISOString(), ['a']));

  let inFlight = 0;
  let maxConcurrent = 0;
  const slowRefresh = async () => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return pool(T_PLUS_30H.toISOString(), ['x']);
  };

  const results = await Promise.all(
    Array.from({ length: 6 }, () => resolvePool(cache, slowRefresh, T_PLUS_30H)),
  );

  // The isolate-local guard is what makes this exact. The KV lock alone
  // cannot: eventually-consistent reads let all six see an unheld lock.
  assert.equal(maxConcurrent, 1, 'six visitors must not trigger six harvests');
  // The five that lost the race get stale data rather than a wait or an error.
  assert.ok(results.every((r) => r.notices.length > 0), 'nobody gets an empty page');
});

test('a corrupt cache entry is treated as absent, not fatal', async () => {
  const kv = memoryKV();
  await kv.put('pool:v1', '{ this is not json');
  const cache = new NoticeCache(kv);
  assert.equal(await cache.read(), null);
});

test('a future or unparseable fetchedAt counts as not fresh', async () => {
  const cache = new NoticeCache(memoryKV());
  assert.equal(cache.isFresh({ fetchedAt: 'not a date', notices: [] }, T0), false);
  assert.equal(cache.isFresh({ fetchedAt: T_PLUS_30H.toISOString(), notices: [] }, T0), false);
});

test('call counter accumulates per UTC day and rolls over', async () => {
  const counter = new CallCounter(memoryKV());
  await counter.add(8, T0);
  await counter.add(1, T_PLUS_1H);
  assert.equal(await counter.get(T0), 9, 'same UTC day accumulates');
  assert.equal(await counter.get(T_PLUS_30H), 0, 'the next day starts clean');
});

test('a cold-cache burst still yields one harvest, and all six get the result', async () => {
  // No stale data to fall back on, so the losers must join the in-flight
  // refresh rather than each starting their own or erroring out.
  const cache = new NoticeCache(memoryKV());
  let calls = 0;
  const refresh = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return pool(T0.toISOString(), ['a', 'b']);
  };

  const results = await Promise.all(
    Array.from({ length: 6 }, () => resolvePool(cache, refresh, T0)),
  );

  assert.equal(calls, 1, 'a cold start under load must not multiply requests');
  assert.ok(results.every((r) => r.notices.length === 2 && !r.error));
});

test('a failed in-flight refresh does not wedge later requests', async () => {
  const cache = new NoticeCache(memoryKV());
  await resolvePool(cache, async () => { throw new Error('boom'); }, T0);
  // If inFlight were left set, this would hang or reuse the rejection forever.
  const r = await resolvePool(cache, async () => pool(T0.toISOString(), ['a']), T0);
  assert.equal(r.notices.length, 1);
});
