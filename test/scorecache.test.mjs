/**
 * Score-cache tests.
 *
 * Two things matter here. One notice is read once and answers for every service
 * area — that is the whole point of the multi-area refactor. And a prompt change
 * must retire old entries, because a score cached under a prompt with a known
 * defect is worse than no score: nothing about it looks stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScoreCache, MAX_COLD_SCORES_PER_REQUEST } from '../src/scoring/cache.ts';
import { NOTICE_TTL_SECONDS } from '../src/lib/retention.ts';

function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const result = () => ({
  noticeId: 'n1',
  reading: 'A custom application build.',
  disqualifiers: [],
  areas: {
    'software-development': { score: 82, band: 'clear', justification: 'a' },
    'web-digital': { score: 40, band: 'no', justification: 'b' },
    'data-analytics': { score: 55, band: 'conditional', justification: 'c' },
  },
  valueEstimate: null,
  unfamiliarTerms: [],
  enriched: false,
  modelCalls: 1,
});

test('one cached entry answers for every service area', async () => {
  // The old cache was keyed by profile, so the same notice was read three
  // times and could disagree with itself. This is the structural fix.
  const cache = new ScoreCache(memoryKV());
  await cache.put('n1', result());
  const hit = await cache.get('n1');

  assert.equal(hit.areas['software-development'].score, 82);
  assert.equal(hit.areas['web-digital'].score, 40);
  assert.equal(hit.areas['data-analytics'].score, 55);
  assert.equal(hit.reading, 'A custom application build.');
});

test('the prompt version is in the key, so a prompt change retires old scores', async () => {
  const kv = memoryKV();
  await new ScoreCache(kv).put('n1', result());
  const [key] = [...kv.store.keys()];
  assert.match(key, /^score:v[\w-]+:n1$/, `key was ${key}`);
});

test('a corrupt entry reads as a miss, not a crash', async () => {
  const kv = memoryKV();
  const cache = new ScoreCache(kv);
  await cache.put('n1', result());
  const [key] = [...kv.store.keys()];
  await kv.put(key, 'not json');
  assert.equal(await cache.get('n1'), null);
});

test('a miss is null rather than a thrown error', async () => {
  assert.equal(await new ScoreCache(memoryKV()).get('nope'), null);
});

test('the cold-read cap leaves room under the 50-subrequest ceiling', () => {
  // 6 SAM.gov calls + 14 notices x up to 3 model calls = 48. Tight but inside.
  assert.ok(MAX_COLD_SCORES_PER_REQUEST * 3 + 6 <= 50);
});

test('score entries carry a 90-day expiry so the store cannot grow forever', async () => {
  // Without this the store gains ~100 entries a week indefinitely, for scores
  // nothing reads again once the notice leaves the 7-day window.
  const kv = memoryKV();
  const opts = [];
  const spy = { ...kv, async put(k, v, o) { opts.push(o); return kv.put(k, v, o); } };
  await new ScoreCache(spy).put('n1', result());

  assert.equal(opts.length, 1);
  assert.equal(opts[0]?.expirationTtl, NOTICE_TTL_SECONDS);
  assert.equal(NOTICE_TTL_SECONDS, 90 * 24 * 60 * 60);
});
