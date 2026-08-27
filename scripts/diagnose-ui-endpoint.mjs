/**
 * Why does the sam.gov UI endpoint refuse us?
 *
 *   npm run diagnose
 *
 * No API key, no cost. Tries the same request under several header sets and
 * reports which the server accepts.
 *
 * This exists because the answer decides something architectural, not cosmetic.
 * Day 2 chose the unmetered UI endpoint over the documented metered one, and
 * that choice only holds if a SERVER can call it. If the endpoint turns out to
 * serve browsers and refuse programmatic clients, then:
 *
 *   - the Cloudflare Worker will be refused in production exactly as this
 *     script is, and
 *   - the honest response is to fall back to the documented metered endpoint
 *     and re-open the request-budget problem — NOT to impersonate a browser
 *     until the refusal stops.
 *
 * So the variants below are ordered from most to least defensible, and the
 * first one that works is the answer. A plain `Accept: * / *` succeeding means
 * this was ordinary content negotiation and we simply asked wrongly. Only a
 * spoofed browser UA succeeding means the server is deliberately excluding
 * non-browsers, and that is a finding to respect rather than route around.
 */
import { SAM_UI_OPPORTUNITY_URL } from '../src/lib/endpoint.ts';
import { parseUiDescription } from '../src/sources/samgov.ts';

const NOTICE = process.env.DIAG_NOTICE_ID ?? 'd76d575b2ec84c29a06cd06b52f0bee5';

const VARIANTS = [
  {
    name: 'A · Node defaults, no headers at all',
    headers: {},
    verdict: 'The endpoint is simply open. Nothing to work around.',
  },
  {
    name: 'B · Accept: */*  (what curl sends)',
    headers: { Accept: '*/*' },
    verdict: 'Ordinary content negotiation. We asked for application/json and it declined; */* is the honest fix.',
  },
  {
    name: 'C · Accept: application/json  (what we sent, and what got 406)',
    headers: { Accept: 'application/json' },
    verdict: 'Baseline — expected to fail.',
  },
  {
    name: 'D · Accept: */* + an honest identifying UA',
    headers: {
      Accept: '*/*',
      'User-Agent': 'contract-scanner/0.1 (+https://waynehuang.dev)',
    },
    verdict: 'Fine. Identifying yourself truthfully is good practice, not evasion.',
  },
  {
    name: 'E · Full browser header set',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    },
    verdict:
      'ONLY THIS WORKED — the server is excluding non-browser clients on purpose. See the note printed below.',
  },
];

console.log(`\nDiagnosing ${SAM_UI_OPPORTUNITY_URL}/${NOTICE}\n`);

let firstWorking = null;

for (const v of VARIANTS) {
  const url = new URL(`${SAM_UI_OPPORTUNITY_URL}/${NOTICE}`);
  url.searchParams.set('api_key', 'null');

  try {
    const res = await fetch(url, { headers: v.headers });
    const body = await res.text();
    let desc = null;
    try {
      desc = parseUiDescription(JSON.parse(body));
    } catch {
      /* not JSON */
    }
    const ok = res.ok && Boolean(desc);
    console.log(
      `  ${ok ? 'OK  ' : '    '}${String(res.status).padEnd(4)} ${v.name}` +
        (desc ? `  → ${desc.length} chars of description` : ''),
    );
    if (!res.ok && body) console.log(`         ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
    if (ok && !firstWorking) firstWorking = v;
  } catch (err) {
    console.log(`  ERR      ${v.name}  → ${err.message}`);
    if (err.cause?.message) console.log(`         cause: ${err.cause.message}`);
  }
}

console.log();
if (!firstWorking) {
  console.log('  Nothing worked. The unmetered path is not usable from a server at all.');
  console.log('  Fall back to the documented metered endpoint and re-open the budget question.');
  process.exitCode = 1;
} else {
  console.log(`  First working variant: ${firstWorking.name}`);
  console.log(`  ${firstWorking.verdict}`);
  if (firstWorking.name.startsWith('E')) {
    console.log();
    console.log('  Read this before wiring it in.');
    console.log('  If only a spoofed browser signature is accepted, the operator is deliberately');
    console.log('  keeping non-browser clients out. Spoofing works, but it means building on an');
    console.log('  endpoint whose owner has signalled it is not for this — brittle by design and');
    console.log('  a bad thing to defend in a README an engineer is reading.');
    console.log();
    console.log('  The documented metered endpoint is the supported path. It costs a request per');
    console.log('  notice, which re-opens the budget problem honestly rather than hiding it.');
  }
}
console.log();
