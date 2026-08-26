/**
 * STEP ZERO — the cheapest possible test of the premise.
 *
 *   SAM_API_KEY=xxxx npm run step-zero
 *
 * Answers four questions, in descending order of how badly a wrong answer hurts:
 *
 *   1. WHAT IS THE REAL DAILY BUDGET?  api.data.gov returns X-RateLimit-Limit
 *      and X-RateLimit-Remaining on every response. The spec assumed 10/day
 *      from documentation; this reads the number off the wire instead. Every
 *      architectural decision downstream is a function of this integer.
 *
 *   2. IS THERE ENOUGH VOLUME?  totalRecords per NAICS code for the trailing
 *      7 days, with awards excluded. The spec's gate: under ~20 across all
 *      codes means widen the list; still thin after widening means the source
 *      is wrong and no amount of good scoring code fixes it.
 *
 *   3. CAN ONE REQUEST CARRY MULTIPLE NAICS CODES?  The documentation says
 *      ncode is a single 6-digit string. If that is right, N codes costs N
 *      requests and the "1-3 calls/day" figure in the spec is wrong. One
 *      request settles it — and being wrong in our favour would change the
 *      whole caching design, so it is worth the call.
 *
 *   4. WHAT DOES A DESCRIPTION COST?  The search endpoint returns a LINK to the
 *      description, not the text. Since the entire project rests on a model
 *      reading descriptions, the price of reading one is the number that
 *      decides whether this design is viable at all.
 *
 * Spends at most MAX_CALLS requests and refuses to start if that would exceed
 * what the key reports as remaining.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALL_NAICS, ALLOWED_PTYPES } from '../src/config.ts';
import { trailingWindow } from '../src/lib/window.ts';
import { toSamDate } from '../src/sources/samgov.ts';
import { resolveSearchUrl } from '../src/lib/endpoint.ts';

const MAX_CALLS = 9; // leave one in reserve; capture-fixture needs it
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const KEY = process.env.SAM_API_KEY;
if (!KEY) {
  console.error('SAM_API_KEY is not set.');
  console.error('  PowerShell:  $env:SAM_API_KEY="..." ; npm run step-zero');
  console.error('  bash:        SAM_API_KEY=... npm run step-zero');
  process.exit(1);
}

const win = trailingWindow();

// ---------------------------------------------------------------------------
// Q0 · which base URL answers?
//
// Ahead of everything else, because getting this wrong makes every other
// question return a 404 with an empty body — an error that says nothing about
// which of five possible causes it is.
// ---------------------------------------------------------------------------
console.log(`\nSTEP ZERO — window ${win.from} … ${win.to} (${MAX_CALLS} calls max)`);
console.log('\nQ0 · resolving the endpoint');
const probe = await resolveSearchUrl(KEY, [
  ['postedFrom', toSamDate(win.from)],
  ['postedTo', toSamDate(win.to)],
  ['ncode', '541511'],
  ['limit', '1'],
]);
for (const a of probe.attempts) console.log(`   ${a.status}  ${a.url}`);

if (!probe.resolved) {
  console.error('\n  Could not reach the search endpoint. Run `npm run probe` for a diagnosis.');
  if (probe.attempts.some((a) => a.bodyHead)) {
    console.error(`  Last response body: ${probe.attempts.at(-1).bodyHead}`);
  }
  process.exit(1);
}
const SEARCH_URL = probe.resolved;
writeFileSync(join(root, '.sam-endpoint'), SEARCH_URL + '\n');
console.log(`   → ${SEARCH_URL}\n`);
const log = [];
let calls = probe.attempts.length; // the resolution requests count against the budget too
let rateLimit = probe.attempts.at(-1)?.rateLimit ?? { limit: null, remaining: null };

async function call(label, params) {
  if (calls >= MAX_CALLS) throw new Error(`Call budget (${MAX_CALLS}) exhausted before: ${label}`);
  calls++;

  const url = new URL(SEARCH_URL);
  url.searchParams.set('api_key', KEY);
  url.searchParams.set('postedFrom', toSamDate(win.from));
  url.searchParams.set('postedTo', toSamDate(win.to));
  for (const [k, v] of params) url.searchParams.append(k, v);

  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  // The real budget, read off the wire rather than off a docs page.
  const limit = res.headers.get('x-ratelimit-limit');
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (limit) rateLimit = { limit: Number(limit), remaining: Number(remaining) };

  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* non-JSON error page */ }

  const entry = {
    label,
    status: res.status,
    totalRecords: json?.totalRecords ?? null,
    returned: json?.opportunitiesData?.length ?? null,
    rateLimit: { ...rateLimit },
    // Empty bodies are common on gateway errors, so record the status text and
    // content type too — otherwise a failure logs as a bare number and the
    // report is no more useful than the console output was.
    error: res.ok
      ? null
      : `${res.status} ${res.statusText} [${res.headers.get('content-type') ?? 'no content-type'}] ${body.slice(0, 300)}`.trim(),
  };
  log.push(entry);

  const budget = rateLimit.remaining !== null ? ` [${rateLimit.remaining}/${rateLimit.limit} left]` : '';
  console.log(
    `  ${String(calls).padStart(2)}. ${label.padEnd(38)} ${res.status}  ` +
    `total=${entry.totalRecords ?? '—'}${budget}`,
  );
  if (!res.ok) console.log(`      ${entry.error}`);

  return { res, json, body };
}

// ---------------------------------------------------------------------------
// Q3 first, deliberately. If one request CAN carry all 8 codes, questions 1 and
// 2 both get answered by that same request and the rest of the budget is free.
// ---------------------------------------------------------------------------
console.log('Q3 · does ncode accept multiple codes?');
const multi = await call('ncode=all 8, comma-separated', [
  ['ncode', ALL_NAICS.join(',')],
  ['limit', '1'],
  ...ALLOWED_PTYPES.map((t) => ['ptype', t]),
]);

const singleProbe = await call('ncode=541511 alone (baseline)', [
  ['ncode', '541511'],
  ['limit', '1'],
  ...ALLOWED_PTYPES.map((t) => ['ptype', t]),
]);

const multiWorks =
  multi.res.ok &&
  typeof multi.json?.totalRecords === 'number' &&
  typeof singleProbe.json?.totalRecords === 'number' &&
  multi.json.totalRecords > singleProbe.json.totalRecords;

console.log(
  multiWorks
    ? '\n  → MULTI-CODE WORKS. One request covers the whole pool; the spec\'s 1-3 calls/day holds.\n'
    : '\n  → SINGLE CODE ONLY (as documented). Budget one request per code.\n',
);

// ---------------------------------------------------------------------------
// Q2 · volume per code, awards excluded. Skipped when multi-code works, because
// the pooled total already answers it and the per-code split is a nicety.
// ---------------------------------------------------------------------------
const perCode = {};
if (multiWorks) {
  perCode['ALL'] = multi.json.totalRecords;
} else {
  console.log('Q2 · volume per NAICS code (awards excluded)');
  perCode['541511'] = singleProbe.json?.totalRecords ?? null;
  for (const code of ALL_NAICS) {
    if (code === '541511') continue;
    if (calls >= MAX_CALLS - 2) { // hold two back for Q4 and the fixture
      console.log(`      (stopping — ${MAX_CALLS - calls} calls held in reserve)`);
      break;
    }
    const r = await call(`ncode=${code}`, [
      ['ncode', code],
      ['limit', '1'],
      ...ALLOWED_PTYPES.map((t) => ['ptype', t]),
    ]);
    perCode[code] = r.json?.totalRecords ?? null;
  }
}

// ---------------------------------------------------------------------------
// Q4 · what does reading one notice actually cost?
// ---------------------------------------------------------------------------
console.log('\nQ4 · description fetch — does it work, and does it bill?');
let descriptionReport = { attempted: false };
const sample = await call('one full record (for the desc link)', [
  ['ncode', '541511'],
  ['limit', '1'],
  ...ALLOWED_PTYPES.map((t) => ['ptype', t]),
]);

const descUrl = sample.json?.opportunitiesData?.[0]?.description;
if (typeof descUrl === 'string' && descUrl.startsWith('http')) {
  const before = rateLimit.remaining;
  const u = new URL(descUrl);
  u.searchParams.set('api_key', KEY);
  const dres = await fetch(u, { headers: { Accept: 'application/json' } });
  const dbody = await dres.text();
  const after = dres.headers.get('x-ratelimit-remaining');

  descriptionReport = {
    attempted: true,
    ok: dres.ok,
    status: dres.status,
    bytes: dbody.length,
    looksLikeText: dbody.length > 200,
    remainingBefore: before,
    remainingAfter: after === null ? null : Number(after),
    // The number that decides the architecture: if this endpoint decrements the
    // same counter, reading 60 notices costs 60 of the daily budget and the
    // design has to change. If it does not, descriptions are effectively free.
    billedAgainstSameQuota: after !== null && before !== null ? Number(after) < before : 'unknown',
  };
  console.log(`      status=${dres.status} bytes=${dbody.length} ` +
    `remaining ${before} → ${after} (billed: ${descriptionReport.billedAgainstSameQuota})`);
  console.log(`      first 200 chars: ${dbody.slice(0, 200).replace(/\s+/g, ' ')}`);
} else {
  console.log('      no description link on the sample record');
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const totalVolume = multiWorks
  ? perCode['ALL']
  : Object.values(perCode).reduce((a, b) => a + (b ?? 0), 0);

const report = {
  ranAt: new Date().toISOString(),
  window: win,
  callsSpent: calls,
  rateLimit,
  multiCodeSupported: multiWorks,
  perCode,
  totalVolume,
  description: descriptionReport,
  log,
};
const out = join(root, `fixtures/step-zero-${win.to}.json`);
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

console.log('\n' + '─'.repeat(64));
console.log(`  Daily budget (from headers) : ${rateLimit.limit ?? 'not reported'}`);
console.log(`  Calls spent                 : ${calls}`);
console.log(`  Multi-code in one request   : ${multiWorks ? 'YES' : 'no'}`);
console.log(`  7-day volume (awards out)   : ${totalVolume}`);
console.log(`  Per-code                    : ${JSON.stringify(perCode)}`);
console.log('─'.repeat(64));

// The spec's gate, applied rather than described.
if (totalVolume === null || Number.isNaN(totalVolume)) {
  console.log('\n  VERDICT: inconclusive — check the errors above before building anything.');
} else if (totalVolume < 20) {
  console.log(`\n  VERDICT: THIN (${totalVolume} < 20). Widen the NAICS list and re-run tomorrow.`);
  console.log('  Do not start the scoring work on this. If it is still thin after');
  console.log('  widening, the source is wrong and the honest move is to say so.');
} else {
  console.log(`\n  VERDICT: VIABLE (${totalVolume} notices). Proceed to the cache layer.`);
}
console.log(`\n  Written to ${out}`);
console.log('  Paste the numbers into RETROSPECTIVE.md while they are in front of you.\n');
