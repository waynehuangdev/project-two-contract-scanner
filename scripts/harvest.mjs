/**
 * HARVEST — step zero and the fixture capture in a single pass.
 *
 *   PowerShell:  $env:SAM_API_KEY="..." ; npm run harvest
 *   bash:        SAM_API_KEY=... npm run harvest
 *
 * Replaces the old step-zero + capture-fixture pair, which asked SAM.gov the
 * same questions twice. Two things forced the merge:
 *
 *   1. api.data.gov returns no X-RateLimit headers here, so there is no way to
 *      see how much budget is left. Every request has to be treated as
 *      possibly the last one, which means the irreplaceable artifact — the
 *      corpus of real notices — must be banked FIRST, not second.
 *
 *   2. Every step-zero question except the description cost can be answered
 *      from the harvested records offline. Counting notices per NAICS code in
 *      a local file is free; asking the API to count them costs a request from
 *      a budget of ten. There was never a reason to pay for it.
 *
 * So: one full-page request per NAICS code, saved as it goes, then all the
 * analysis locally. Partial results are written even if the quota runs out
 * mid-run — a 429 on code six still leaves five codes' worth of corpus on disk.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALL_NAICS, ALLOWED_PTYPES, SERVICE_AREAS } from '../src/config.ts';
import { trailingWindow } from '../src/lib/window.ts';
import { normalizeSamRecord, toSamDate } from '../src/sources/samgov.ts';
import { resolveSearchUrl } from '../src/lib/endpoint.ts';
import { loadApiKey, describeKey } from '../src/lib/apiKey.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = Number(process.env.HARVEST_BUDGET ?? 8);
const win = trailingWindow();

const { key: KEY, warnings, repaired } = loadApiKey(process.env.SAM_API_KEY);
if (!KEY) {
  console.error('\nSAM_API_KEY is not set.');
  console.error('  PowerShell:  $env:SAM_API_KEY="..." ; npm run harvest');
  console.error('  cmd.exe:     set SAM_API_KEY=...        (no quotes — cmd keeps them)');
  process.exitCode = 1;
} else {
  console.log(`\nHARVEST — window ${win.from} … ${win.to}, budget ${BUDGET} requests`);
  console.log(`Key: ${describeKey(KEY)}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  if (repaired) console.log('  → using the repaired value for this run.');

  // ---- resolve the endpoint (1 request) ----------------------------------
  const probe = await resolveSearchUrl(KEY, [
    ['postedFrom', toSamDate(win.from)],
    ['postedTo', toSamDate(win.to)],
    ['limit', '1'],
  ]);
  if (!probe.resolved) {
    console.error(`\n  Endpoint unreachable (${probe.attempts.map((a) => a.status).join(', ')}).`);
    console.error('  Run `npm run probe` for a diagnosis.');
    process.exitCode = 1;
  } else {
    const SEARCH_URL = probe.resolved;
    writeFileSync(join(root, '.sam-endpoint'), SEARCH_URL + '\n');
    console.log(`Endpoint: ${SEARCH_URL}\n`);

    const records = new Map();
    const perCode = {};
    let calls = probe.attempts.length;
    let stoppedEarly = null;

    const save = () => {
      writeFileSync(
        join(root, 'fixtures/notices-sample.json'),
        JSON.stringify([...records.values()], null, 2) + '\n',
      );
    };

    for (const code of ALL_NAICS) {
      if (calls >= BUDGET) {
        stoppedEarly = `budget (${BUDGET} requests) reached`;
        break;
      }

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

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log(`  ${code}  ${res.status} ${res.statusText} — stopping`);
        if (body) console.log(`        ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
        stoppedEarly = res.status === 429 ? 'daily quota exhausted' : `HTTP ${res.status}`;
        break; // never keep hammering a failing quota
      }

      const json = await res.json();
      const batch = json.opportunitiesData ?? [];
      for (const r of batch) if (r?.noticeId) records.set(r.noticeId, r);
      perCode[code] = { totalRecords: json.totalRecords ?? null, returned: batch.length };

      console.log(
        `  ${code}  ${String(batch.length).padStart(4)} records` +
        `  (total ${json.totalRecords ?? '?'})  unique so far: ${records.size}`,
      );

      save(); // after every code, so a 429 next iteration costs nothing already earned
    }

    save();

    // ---- analysis, entirely offline ---------------------------------------
    const raw = [...records.values()];
    const normalized = raw.map(normalizeSamRecord).filter(Boolean);
    const dropped = raw.length - normalized.length;

    const byArea = {};
    for (const [area, cfg] of Object.entries(SERVICE_AREAS)) {
      const codes = new Set(cfg.naics);
      byArea[area] = normalized.filter((n) => n.naics && codes.has(n.naics)).length;
    }

    const withDeadline = normalized.filter((n) => n.dueDate).length;
    const withSetAside = normalized.filter((n) => n.setAside).length;
    const withDescLink = normalized.filter((n) => n.descriptionUrl).length;
    const typeCounts = {};
    for (const n of normalized) typeCounts[n.noticeType] = (typeCounts[n.noticeType] ?? 0) + 1;

    const report = {
      ranAt: new Date().toISOString(),
      window: win,
      endpoint: SEARCH_URL,
      callsSpent: calls,
      stoppedEarly,
      codesQueried: Object.keys(perCode),
      perCode,
      rawRecords: raw.length,
      usableNotices: normalized.length,
      droppedByNormalizer: dropped,
      byServiceArea: byArea,
      noticeTypes: typeCounts,
      fieldCoverage: {
        dueDate: withDeadline,
        setAside: withSetAside,
        descriptionLink: withDescLink,
      },
    };
    writeFileSync(join(root, `fixtures/step-zero-${win.to}.json`), JSON.stringify(report, null, 2) + '\n');

    // ---- verdict ----------------------------------------------------------
    console.log('\n' + '─'.repeat(64));
    console.log(`  Requests spent          : ${calls}${stoppedEarly ? `  (stopped: ${stoppedEarly})` : ''}`);
    console.log(`  Codes queried           : ${Object.keys(perCode).length}/${ALL_NAICS.length}`);
    console.log(`  Unique raw records      : ${raw.length}`);
    console.log(`  Usable after normalizing: ${normalized.length}  (${dropped} dropped — awards, missing ids)`);
    console.log(`  Per service area        : ${JSON.stringify(byArea)}`);
    console.log(`  Notice types            : ${JSON.stringify(typeCounts)}`);
    console.log(`  With a stated deadline  : ${withDeadline}/${normalized.length}`);
    console.log(`  With a set-aside        : ${withSetAside}/${normalized.length}`);
    console.log(`  With a description link : ${withDescLink}/${normalized.length}`);
    console.log('─'.repeat(64));

    // The spec's gate, applied rather than described.
    if (normalized.length < 20) {
      console.log(`\n  VERDICT: THIN (${normalized.length} < 20).`);
      console.log('  Widen the NAICS list and re-run tomorrow. Do not start the scoring');
      console.log('  work on this — if it is still thin after widening, the source is');
      console.log('  wrong and the honest move is to say so rather than build over it.');
    } else {
      console.log(`\n  VERDICT: VIABLE (${normalized.length} usable notices).`);
      const thin = Object.entries(byArea).filter(([, n]) => n < 5);
      if (thin.length) {
        console.log(`  But these areas are thin: ${thin.map(([a, n]) => `${a}=${n}`).join(', ')}`);
        console.log('  A visitor picking one of those sees an almost-empty page. Widen');
        console.log('  their code lists before shipping, or the demo lands badly for them.');
      }
    }

    console.log(`\n  Corpus  → fixtures/notices-sample.json  (${raw.length} records)`);
    console.log(`  Report  → fixtures/step-zero-${win.to}.json`);
    console.log('\n  Paste the summary into RETROSPECTIVE.md while it is in front of you.\n');
  }
}

// No process.exit(): Node on Windows trips a libuv assertion when torn down
// with fetch keep-alive sockets open. exitCode lets the loop drain cleanly.
