/**
 * Score-cache tests.
 *
 * The key discipline matters more than it looks: a collision between two
 * profiles would show one visitor another visitor's judgements, silently and
 * plausibly enough that nobody would notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScoreCache, profileHash, MAX_COLD_SCORES_PER_REQUEST } from '../src/scoring/cache.ts';

function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const P = (over = {}) => ({ area: 'software-development', size: 'any', setAside: 'any', ...over });
const result = (score) => ({ noticeId: 'n1', score, band: 'no', justification: 'x', valueEstimate: null, unfamiliarTerms: [], enriched: false, modelCalls: 1 });

test('every distinct profile gets a distinct key', () => {
  const seen = new Map();
  for (const area of ['software-development', 'web-digital', 'data-analytics']) {
    for (const size of ['under-250k', '250k-1m', 'over-1m', 'any']) {
      for (const setAside of ['small-business', 'any']) {
        const h = profileHash({ area, size, setAside });
        assert.ok(!seen.has(h), `collision: ${seen.get(h)} vs ${area}/${size}/${setAside}`);
        seen.set(h, `${area}/${size}/${setAside}`);
      }
    }
  }
  assert.equal(seen.size, 24, 'the whole profile space is 24 combinations');
});

test('the hash is stable across calls', () => {
  assert.equal(profileHash(P()), profileHash(P()));
});

test('a different profile does not read another profile\'s score', async () => {
  const cache = new ScoreCache(memoryKV());
  await cache.put('n1', P(), result(90));
  assert.equal(await cache.get('n1', P({ area: 'web-digital' })), null);
  assert.equal((await cache.get('n1', P())).score, 90);
});

test('a corrupt entry reads as a miss, not a crash', async () => {
  const kv = memoryKV();
  await kv.put(`score:${profileHash(P())}:n1`, 'not json');
  assert.equal(await new ScoreCache(kv).get('n1', P()), null);
});

test('the cold-score cap leaves room under the 50-subrequest ceiling', () => {
  // 6 SAM.gov calls + 12 notices x up to 3 model calls = 42. Room to spare.
  assert.ok(MAX_COLD_SCORES_PER_REQUEST * 3 + 6 < 50);
});
