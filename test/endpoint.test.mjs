/**
 * Endpoint resolver tests, against a local stub rather than SAM.gov.
 *
 * Written after the real thing 404'd eight times in a row and the report said
 * only "404" with an empty body. The resolver's job is to make that failure
 * legible: try the alternative, stop when the answer is "the path is fine and
 * something else is wrong", and never spend a request confirming what a
 * previous response already proved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolveSearchUrl } from '../src/lib/endpoint.ts';

/** Spin a server whose response depends on the path. Returns [baseUrls, close]. */
async function stub(routes) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const r = routes[path];
    if (!r) return res.writeHead(404).end();
    res.writeHead(r.status, r.headers ?? { 'content-type': 'application/json' });
    res.end(r.body ?? '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return [
    (p) => `http://127.0.0.1:${port}${p}`,
    () => new Promise((r) => server.close(r)),
  ];
}

test('falls through a 404 to the next candidate', async () => {
  const [url, close] = await stub({
    '/bad': { status: 404 },
    '/good': { status: 200, body: JSON.stringify({ totalRecords: 42 }) },
  });
  try {
    const { resolved, attempts } = await resolveSearchUrl('k', [], [url('/bad'), url('/good')]);
    assert.equal(resolved, url('/good'));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].totalRecords, 42);
  } finally {
    await close();
  }
});

test('stops on the first candidate when it works — no wasted request', async () => {
  const [url, close] = await stub({
    '/good': { status: 200, body: JSON.stringify({ totalRecords: 1 }) },
    '/never': { status: 200, body: '{}' },
  });
  try {
    const { resolved, attempts } = await resolveSearchUrl('k', [], [url('/good'), url('/never')]);
    assert.equal(resolved, url('/good'));
    assert.equal(attempts.length, 1, 'must not probe the second candidate');
  } finally {
    await close();
  }
});

test('a 403 stops the loop — the path was right, the key was not', async () => {
  // Trying the other base URL here would burn a request to learn nothing:
  // the gateway answered, so the path exists.
  const [url, close] = await stub({
    '/a': { status: 403, body: '{"error":"invalid api key"}' },
    '/b': { status: 200, body: '{"totalRecords":9}' },
  });
  try {
    const { resolved, attempts } = await resolveSearchUrl('bad', [], [url('/a'), url('/b')]);
    assert.equal(resolved, null);
    assert.equal(attempts.length, 1);
    assert.match(attempts[0].bodyHead, /invalid api key/);
  } finally {
    await close();
  }
});

test('reports the rate-limit headers when the gateway sends them', async () => {
  const [url, close] = await stub({
    '/good': {
      status: 200,
      body: '{"totalRecords":5}',
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '7',
      },
    },
  });
  try {
    const { attempts } = await resolveSearchUrl('k', [], [url('/good')]);
    assert.deepEqual(attempts[0].rateLimit, { limit: 10, remaining: 7 });
  } finally {
    await close();
  }
});

test('never echoes the api_key back in the recorded outcome', async () => {
  // The report file gets pasted into chat and committed to a retrospective.
  const [url, close] = await stub({ '/good': { status: 200, body: '{"totalRecords":1}' } });
  try {
    const { attempts } = await resolveSearchUrl('SUPERSECRET', [], [url('/good')]);
    const dumped = JSON.stringify(attempts);
    assert.ok(!dumped.includes('SUPERSECRET'));
  } finally {
    await close();
  }
});
