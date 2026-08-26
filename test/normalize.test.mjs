/**
 * Normalizer tests.
 *
 * These exist to hold one line: absent stays absent. Every assertion below is
 * a fabrication the tool would otherwise ship — a due date that isn't real, a
 * dollar figure nobody stated, an award notice in a list of open opportunities.
 *
 *   node --experimental-strip-types --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeSamRecord, toIsoDate, toSamDate } from '../src/sources/samgov.ts';
import { applyHardFilters, isSmallBusinessSetAside } from '../src/lib/filter.ts';
import { trailingWindow } from '../src/lib/window.ts';
import { ALL_NAICS } from '../src/config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(readFileSync(join(root, 'fixtures/raw-sam-sample.json'), 'utf8'));
const byCase = (needle) => raw.find((r) => r._case.includes(needle));
const notices = raw.map(normalizeSamRecord).filter(Boolean);

test('drops award notices even when the ptype filter did not', () => {
  const award = normalizeSamRecord(byCase('AWARD NOTICE'));
  assert.equal(award, null);
  assert.ok(!notices.some((n) => n.noticeType.toLowerCase().includes('award')));
});

test('drops records with no usable id', () => {
  assert.equal(normalizeSamRecord(byCase('MISSING noticeId')), null);
});

test('a missing response deadline becomes null, not a date', () => {
  const n = normalizeSamRecord(byCase('NO RESPONSE DEADLINE'));
  assert.equal(n.dueDate, null);
});

test('an unparseable response deadline becomes null, not today', () => {
  const n = normalizeSamRecord(byCase('UNPARSEABLE DEADLINE'));
  assert.equal(n.dueDate, null);
});

test('whitespace-only fields are treated as absent', () => {
  const n = normalizeSamRecord(byCase('WHITESPACE-ONLY'));
  assert.equal(n.solicitationNumber, null);
  assert.equal(n.setAside, null);
});

test('valueEstimate is never synthesized — no notice arrives with a number', () => {
  // SAM.gov states no value on solicitations, and award.amount belongs to
  // records we refuse to show. Any non-null here means a figure was invented.
  assert.ok(notices.every((n) => n.valueEstimate === null));
});

test('description text is never populated by the search path', () => {
  // It costs a separate request. A non-null here would mean something silently
  // spent quota, or worse, made the text up.
  assert.ok(notices.every((n) => n.description === null));
  assert.ok(notices.every((n) => typeof n.descriptionUrl === 'string'));
});

test('amendments keep distinct ids but share a solicitation number', () => {
  const pair = notices.filter((n) => n.solicitationNumber === 'N0018926R00000009');
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0].noticeId, pair[1].noticeId);
});

test('agency is taken from the top of the hierarchy path', () => {
  const n = normalizeSamRecord(byCase('clean software development'));
  assert.equal(n.agency, 'HOMELAND SECURITY, DEPARTMENT OF');
});

test('every fixture NAICS code is one the config actually fetches', () => {
  // Guards against a fixture that quietly tests codes the scanner never asks for.
  for (const n of notices) {
    assert.ok(ALL_NAICS.includes(n.naics), `${n.naics} is not in ALL_NAICS`);
  }
});

test('hard filters keep the misfiled notices — that is the scorer\'s job, not the filter\'s', () => {
  // The hardware refresh, the staff-aug vehicle and the licence renewal are all
  // tagged 541511, so they MUST survive the WHERE clause and reach the model.
  // If the filter quietly dropped them the rejection line would be a lie.
  const matched = applyHardFilters(notices, { area: 'software-development', size: 'any', setAside: 'any' });
  const titles = matched.map((n) => n.title);
  assert.ok(titles.some((t) => t.includes('Workstation Refresh')));
  assert.ok(titles.some((t) => t.includes('Staff Augmentation')));
  assert.ok(titles.some((t) => t.includes('License Renewal')));
});

test('small-business filter excludes full-and-open notices', () => {
  const matched = applyHardFilters(notices, { area: 'cybersecurity', size: 'any', setAside: 'small-business' });
  assert.ok(!matched.some((n) => n.title.includes('Security Operations Center')));
});

test('a size band excludes everything, because no notice states a value', () => {
  // Documents the real behaviour rather than an aspiration: value-band filtering
  // over SAM.gov solicitations matches nothing until the scorer extracts figures
  // from description text. This is why 'Any' is the default, and it is the open
  // question the spec flagged.
  const matched = applyHardFilters(notices, { area: 'software-development', size: 'under-250k', setAside: 'any' });
  assert.equal(matched.length, 0);
});

test('set-aside matching covers the variants SAM.gov actually emits', () => {
  assert.ok(isSmallBusinessSetAside('Total Small Business Set-Aside (FAR 19.5)'));
  assert.ok(isSmallBusinessSetAside('8(a) Set-Aside (FAR 19.8)'));
  assert.ok(isSmallBusinessSetAside('Women-Owned Small Business (WOSB) Program Set-Aside'));
  assert.ok(isSmallBusinessSetAside('Service-Disabled Veteran-Owned Small Business (SDVOSB) Set-Aside'));
  assert.equal(isSmallBusinessSetAside(null), false);
});

test('date helpers round-trip into the format SAM.gov requires', () => {
  assert.equal(toIsoDate('2026-08-20 09:14:22-04'), '2026-08-20');
  assert.equal(toIsoDate('not a date'), null);
  assert.equal(toIsoDate(''), null);
  assert.equal(toSamDate('2026-08-20'), '08/20/2026');
});

test('the trailing window is 7 days inclusive', () => {
  const w = trailingWindow(new Date('2026-08-24T12:00:00Z'));
  assert.equal(w.to, '2026-08-24');
  assert.equal(w.from, '2026-08-18');
});
