/**
 * Find the base URL that actually answers, and confirm the key works.
 *
 *   PowerShell:  $env:SAM_API_KEY="..." ; npm run probe
 *   bash:        SAM_API_KEY=... npm run probe
 *   cmd.exe:     set SAM_API_KEY=...          <- NO QUOTES. cmd keeps them.
 *
 * Costs one request on the happy path, two at worst. Run this before step zero
 * whenever something looks wrong — it separates "wrong URL" from "wrong key"
 * from "out of quota", which all present as an unhelpful error otherwise.
 */
import { resolveSearchUrl, SAM_SEARCH_CANDIDATES } from '../src/lib/endpoint.ts';
import { loadApiKey, describeKey } from '../src/lib/apiKey.ts';
import { trailingWindow } from '../src/lib/window.ts';
import { toSamDate } from '../src/sources/samgov.ts';

const { key: KEY, warnings, repaired } = loadApiKey(process.env.SAM_API_KEY);

if (!KEY) {
  console.error('\nSAM_API_KEY is not set.');
  console.error('  PowerShell:  $env:SAM_API_KEY="..." ; npm run probe');
  console.error('  bash:        SAM_API_KEY=... npm run probe');
  console.error('  cmd.exe:     set SAM_API_KEY=...        (no quotes — cmd keeps them)');
  process.exitCode = 1;
} else {
  console.log(`\nKey loaded: ${describeKey(KEY)}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  if (repaired) console.log('  → using the repaired value for this run; fix how you set it to make it stick.');
  console.log(`\nTrying ${SAM_SEARCH_CANDIDATES.length} candidate URLs, cheapest possible request.\n`);

  const win = trailingWindow();
  const { resolved, attempts } = await resolveSearchUrl(KEY, [
    ['postedFrom', toSamDate(win.from)],
    ['postedTo', toSamDate(win.to)],
    ['limit', '1'],
  ]);

  for (const a of attempts) {
    console.log(`  ${a.status}  ${a.url}`);
    if (a.rateLimit.limit !== null) {
      console.log(`        quota: ${a.rateLimit.remaining}/${a.rateLimit.limit} remaining today`);
    }
    if (!a.ok && a.bodyHead) console.log(`        body: ${a.bodyHead}`);
    if (a.ok) console.log(`        totalRecords in the last 7 days (all NAICS): ${a.totalRecords}`);
  }

  console.log();
  if (resolved) {
    console.log(`  WORKS: ${resolved}`);
    const last = attempts.at(-1);
    if (last?.rateLimit.limit != null) {
      console.log(`  Daily budget is ${last.rateLimit.limit}, ${last.rateLimit.remaining} left.`);
    } else {
      console.log('  No X-RateLimit headers returned — budget has to be inferred by watching for a 429.');
    }
    console.log('\n  Next: npm run step-zero\n');
  } else {
    const statuses = attempts.map((a) => a.status);
    console.log(`  NOTHING WORKED (${statuses.join(', ')}).`);

    if (statuses.every((s) => s === 404)) {
      // Both documented URLs 404ing almost never means both moved. On
      // api.data.gov a key it cannot parse fails at the routing layer and
      // comes back as a bare 404 — indistinguishable from a dead endpoint
      // unless you already know to look.
      console.log('\n  Both documented URLs 404. The most common cause is not the path:');
      console.log('  a malformed api_key is rejected before routing and returns 404, not 403.');
      console.log('\n  Check, in this order:');
      console.log(`    1. Key shape — should be exactly 40 alphanumeric characters (yours: ${KEY.length}).`);
      console.log('       cmd.exe `set SAM_API_KEY="abc"` stores the quotes. Use no quotes there,');
      console.log('       or PowerShell, where $env:SAM_API_KEY="abc" does the right thing.');
      console.log('    2. Key is active — SAM.gov → Account Details. A key generated but never');
      console.log('       revealed, or one since regenerated, will not work.');
      console.log('    3. Endpoint moved — https://open.gsa.gov/api/get-opportunities-public-api/');
    } else if (statuses.includes(403) || statuses.includes(401)) {
      console.log('  The path is right and the key was rejected. Regenerate it in');
      console.log('  SAM.gov → Account Details, and copy it before navigating away.');
    } else if (statuses.includes(429)) {
      console.log('  Path and key are fine — the daily quota is spent. Try again tomorrow.');
    }
    console.log();
    process.exitCode = 1;
  }
}

// Deliberately no process.exit(). Node on Windows trips a libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`) when the process is torn down with
// fetch's keep-alive sockets still open. Setting exitCode lets the loop drain
// and exit cleanly with the same status.
