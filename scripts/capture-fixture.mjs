/**
 * Capture a page of REAL notices and save the raw JSON.
 *
 *   SAM_API_KEY=xxxx npm run capture-fixture
 *
 * Run this once, immediately after step zero, and treat the output as
 * precious. It is the offline corpus every subsequent day works against:
 * without it, each prompt experiment on Day 3 costs a request from a budget
 * measured in single digits, and iterating on the scoring prompt — the thing
 * that decides whether this project is any good — becomes impossible.
 *
 * Spends one request per code, up to the budget below.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALL_NAICS, ALLOWED_PTYPES } from '../src/config.ts';
import { trailingWindow } from '../src/lib/window.ts';
import { toSamDate } from '../src/sources/samgov.ts';
import { SAM_SEARCH_URL } from '../src/lib/endpoint.ts';

const MAX_CALLS = Number(process.env.CAPTURE_BUDGET ?? 3);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.SAM_API_KEY;
if (!KEY) {
  console.error('SAM_API_KEY is not set.');
  process.exit(1);
}

// Reuse whatever step zero resolved rather than re-probing — probing costs a
// request, and this script should never spend one rediscovering a known fact.
let SEARCH_URL = SAM_SEARCH_URL;
try {
  SEARCH_URL = readFileSync(join(root, '.sam-endpoint'), 'utf8').trim() || SAM_SEARCH_URL;
} catch {
  console.log('  (no .sam-endpoint — run step-zero first. Falling back to the default URL.)');
}

const win = trailingWindow();
const records = new Map();
let calls = 0;

for (const code of ALL_NAICS) {
  if (calls >= MAX_CALLS) break;

  const url = new URL(SEARCH_URL);
  url.searchParams.set('api_key', KEY);
  url.searchParams.set('postedFrom', toSamDate(win.from));
  url.searchParams.set('postedTo', toSamDate(win.to));
  url.searchParams.set('ncode', code);
  url.searchParams.set('limit', '1000');
  url.searchParams.set('offset', '0');
  for (const t of ALLOWED_PTYPES) url.searchParams.append('ptype', t);

  calls++;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (!res.ok) {
    console.error(`  ncode=${code} → ${res.status}. Stopping so the rest of the budget survives.`);
    break;
  }

  const json = await res.json();
  for (const r of json.opportunitiesData ?? []) {
    if (r?.noticeId) records.set(r.noticeId, r);
  }
  console.log(`  ncode=${code}  +${json.opportunitiesData?.length ?? 0}  ` +
    `(unique so far: ${records.size})  [${remaining ?? '?'} left]`);
}

const out = join(root, 'fixtures/notices-sample.json');
writeFileSync(out, JSON.stringify([...records.values()], null, 2) + '\n');
console.log(`\n  ${records.size} unique notices → ${out}  (${calls} calls spent)`);
console.log('  Gitignored on purpose: large, and it churns daily.\n');
