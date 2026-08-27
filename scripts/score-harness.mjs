/**
 * OFFLINE SCORING HARNESS — the loop the whole project's quality runs through.
 *
 *   PowerShell:  $env:ANTHROPIC_API_KEY="sk-ant-..." ; npm run score
 *   bash:        ANTHROPIC_API_KEY=sk-ant-... npm run score
 *
 * Scores the hand-labelled notices and reports agreement against
 * fixtures/labels.json. No Worker, no KV, no SAM.gov API key — iteration speed
 * on the prompt is worth more than architectural purity, and a slow feedback
 * loop is precisely how a prompt ends up under-cooked.
 *
 * Descriptions come from the unmetered sam.gov UI endpoint and are cached to
 * .cache/descriptions.json, so a rerun costs nothing but model tokens.
 *
 * Options:
 *   --area=software-development   score one area only (default: every area the labels cover)
 *   --no-enrich                   skip the glossary pass entirely, to measure what it buys
 *   --allow-missing-descriptions  score anyway when hydration failed (rarely what you want)
 *   --limit=N                     only the first N labelled notices, for cheap iteration
 *   --show=all|misses             which rows to print in full (default: misses)
 *
 * WORKER_URL overrides the deployed Worker the descriptions are hydrated through.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scoreNotice } from '../src/scoring/score.ts';
import { MemoryGlossary } from '../src/scoring/glossary.ts';
import { normalizeSamRecord } from '../src/sources/samgov.ts';
/**
 * Descriptions are hydrated THROUGH THE DEPLOYED WORKER, not directly.
 *
 * sam.gov's UI host refuses this laptop at the TLS layer — HTTP 406, then
 * ECONNRESET on every header set including a full browser signature. The same
 * request from Cloudflare's edge returns 200 in 136ms with plain, honest
 * headers. The difference is the network, not the headers, and the response to
 * that is to fetch from where it works rather than to impersonate a browser
 * until the refusal stops.
 *
 * Side benefit: the Worker caches every description permanently in KV, so the
 * harness warms production's cache as it runs.
 */
const WORKER = process.env.WORKER_URL ?? 'https://contract-scanner.huauangdel.workers.dev';
import { band } from '../src/scoring/prompt.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('\nANTHROPIC_API_KEY is not set.');
  console.error('  PowerShell:  $env:ANTHROPIC_API_KEY="sk-ant-..." ; npm run score');
  console.error('  cmd.exe:     set ANTHROPIC_API_KEY=sk-ant-...      (no quotes)');
  process.exitCode = 1;
} else {
  await main();
}

async function main() {
  const labels = JSON.parse(readFileSync(join(root, 'fixtures/labels.json'), 'utf8'));
  const corpus = JSON.parse(readFileSync(join(root, 'fixtures/notices-sample.json'), 'utf8'));
  const byId = new Map(corpus.map((r) => [r.noticeId, r]));

  // ---- descriptions, cached ------------------------------------------------
  const cacheDir = join(root, '.cache');
  const cachePath = join(cacheDir, 'descriptions.json');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const descCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

  let fetched = 0;
  let failed = 0;
  const failures = [];
  for (const label of labels.labels) {
    if (typeof descCache[label.noticeId] === 'string' && descCache[label.noticeId].length) continue;
    const url = new URL(`${WORKER}/api/description`);
    url.searchParams.set('noticeId', label.noticeId);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        failures.push(`${label.noticeId} HTTP ${res.status} ${payload.error ?? ''}`.trim());
        failed++;
        continue; // NOT cached — a transient failure must not become permanent
      }
      const text = payload.description;
      if (typeof text !== 'string' || !text.length) {
        failures.push(`${label.noticeId} empty description`);
        failed++;
        continue;
      }
      descCache[label.noticeId] = text;
      fetched++;
    } catch (err) {
      failures.push(`${label.noticeId} ${err.message}`);
      failed++;
    }
    process.stdout.write(`\r  hydrating descriptions… ${fetched} ok, ${failed} failed`);
  }
  if (fetched) writeFileSync(cachePath, JSON.stringify(descCache, null, 2));

  const haveText = labels.labels.filter((l) => typeof descCache[l.noticeId] === 'string' && descCache[l.noticeId].length).length;
  console.log(`\r  descriptions: ${haveText}/${labels.labels.length} available          `);

  // A run without descriptions measures the title, not the scorer. The previous
  // version cached the failures as null and printed a confident 85% anyway —
  // the single worst thing a harness can do. Fail loudly instead.
  if (haveText < labels.labels.length) {
    console.error('\n  ABORTING — descriptions are missing for ' + (labels.labels.length - haveText) + ' notice(s).');
    for (const f of failures.slice(0, 8)) console.error(`    ${f}`);
    console.error('\n  Scoring without description text measures the title and the NAICS code,');
    console.error('  which is not what this prompt is for. Any agreement number from such a');
    console.error('  run would be meaningless.');
    console.error('\n  Override with --allow-missing-descriptions if you genuinely want that.');
    if (!args['allow-missing-descriptions']) {
      process.exitCode = 1;
      return;
    }
  }

  // ---- score ---------------------------------------------------------------
  const model = anthropic(KEY);
  const glossary = new MemoryGlossary();
  const enrich = !args['no-enrich'];
  const areas = args.area ? [args.area] : ['software-development', 'web-digital', 'data-analytics'];

  const plan = args.limit ? Number(args.limit) : labels.labels.length;
  console.log(`\nScoring ${plan} notices × ${areas.length} area(s)` +
    `${enrich ? '' : '  [enrichment OFF]'}\n`);

  const rows = [];
  let totalCalls = 0;

  const subset = args.limit ? labels.labels.slice(0, Number(args.limit)) : labels.labels;
  for (const label of subset) {
    const raw = byId.get(label.noticeId);
    if (!raw) {
      console.log(`  !! ${label.noticeId} not in corpus — reharvest and retry`);
      continue;
    }
    const notice = { ...normalizeSamRecord(raw), description: descCache[label.noticeId] ?? null };

    for (const area of areas) {
      const expected = label.expected?.[area];
      if (!expected) continue;

      const r = await scoreNotice(notice, area, model, glossary, { enrich });
      totalCalls += r.modelCalls;

      rows.push({
        title: label.title,
        area,
        expected,
        got: r.band,
        score: r.score,
        hit: r.band === expected,
        justification: r.justification,
        terms: r.unfamiliarTerms,
        enriched: r.enriched,
        before: r.scoreBeforeEnrichment,
        provisional: Boolean(label.provisional),
        // Only valueEstimate now. statedDeadline was removed from the schema
        // after it produced 43 false alarms in one run by copying a field the
        // prompt itself supplied. Nothing supplies a dollar figure, so a number
        // here is a genuine invention.
        fabricated: r.valueEstimate !== null ? ['valueEstimate'] : [],
        note: label.note,
      });
      process.stdout.write(`\r  scored ${rows.length}…`);
    }
  }
  console.log('\r                         ');

  report(rows, totalCalls, enrich);
}

function report(rows, totalCalls, enrich) {
  const graded = rows.filter((r) => !r.provisional);
  const hits = graded.filter((r) => r.hit).length;
  const pct = graded.length ? Math.round((hits / graded.length) * 100) : 0;

  console.log('─'.repeat(78));
  console.log(`  AGREEMENT WITH THE LABELLED SET: ${hits}/${graded.length}  (${pct}%)`);
  if (rows.length !== graded.length) {
    console.log(`  (${rows.length - graded.length} provisional labels excluded from the score)`);
  }
  console.log(`  Model calls: ${totalCalls}   Enrichment: ${enrich ? 'on' : 'off'}`);

  // The one that is never acceptable.
  const fabs = rows.filter((r) => r.fabricated.length);
  if (fabs.length) {
    console.log(`\n  !!! FABRICATION — ${fabs.length} row(s) returned a figure or deadline:`);
    for (const f of fabs) console.log(`      ${f.fabricated.join(', ')} — ${f.title.slice(0, 60)}`);
    console.log('      Every one of these must be null unless the description states it.');
  } else {
    console.log('  No invented figures or deadlines.');
  }

  const moved = rows.filter((r) => r.enriched && r.before !== undefined && band(r.before) !== r.got);
  if (moved.length) {
    console.log(`\n  Enrichment changed the band on ${moved.length} row(s):`);
    for (const m of moved) {
      console.log(`      ${m.before} → ${m.score}  (${band(m.before)} → ${m.got})  ${m.title.slice(0, 50)}`);
    }
  }
  console.log('─'.repeat(78));

  const show = args.show === 'all' ? rows : rows.filter((r) => !r.hit || r.provisional);
  if (show.length) {
    console.log(args.show === 'all' ? '\nALL ROWS\n' : '\nDISAGREEMENTS AND PROVISIONALS\n');
    for (const r of show) {
      const mark = r.provisional ? '?' : r.hit ? '✓' : '✗';
      console.log(`${mark} [${r.area}] ${r.title.slice(0, 62)}`);
      console.log(`    expected ${r.expected}   got ${r.got} (${r.score})`);
      console.log(`    model: ${r.justification}`);
      if (r.terms.length) console.log(`    flagged: ${r.terms.join(', ')}`);
      if (r.note) console.log(`    yours:  ${r.note.slice(0, 150)}`);
      console.log();
    }
  }

  console.log('Read the justifications, not just the percentage. A row that agrees for');
  console.log('the wrong reason is worse than one that disagrees for a good one.\n');
}

/** Anthropic Messages API with forced tool output. */
function anthropic(apiKey) {
  return {
    async complete({ system, user, schema, maxTokens }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [{ name: 'record', description: 'Record the result.', input_schema: schema }],
          tool_choice: { type: 'tool', name: 'record' },
        }),
      });

      if (!res.ok) {
        throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const json = await res.json();
      const block = (json.content ?? []).find((c) => c.type === 'tool_use');
      if (!block) throw new Error('no tool_use block in response');
      return block.input;
    },
  };
}
