/**
 * Description-parsing tests.
 *
 * The payload below is a real response from
 * `sam.gov/api/prod/opps/v2/opportunities/{id}?api_key=null`, trimmed. That
 * endpoint is undocumented — GSA can change its shape without a changelog —
 * so this file is the tripwire. If the shape moves, these fail loudly here
 * rather than quietly producing empty descriptions in production, which would
 * look like "SAM.gov posted a thin week" rather than "our parser broke".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUiDescription, parseApiDescription } from '../src/sources/samgov.ts';

/** Real response, 2026-08-26, notice d76d575b…bee5. Trimmed to what we read. */
const REAL_UI_RESPONSE = {
  data2: {
    type: 'o',
    award: {},
    naics: [{ code: ['541511'], type: 'primary' }],
    title: 'Inventory Management Software',
    classificationCode: '7A20',
    solicitationNumber: 'W911QY-26-R-A024 ',
  },
  description: [
    {
      opportunityId: 'd76d575b2ec84c29a06cd06b52f0bee5',
      descriptionId: 'effa64ab065f42ee8e6406cb22220f3d',
      body:
        '<p>Inventory Software Management for DEVCOM-SC: Inventory Software Management ' +
        'Technology replacing legacy that goes beyond traditional Warehouse Management ' +
        'System to drive employee engagement and efficiency through the supply chain.</p>\n\n' +
        '<p>*<strong>8.24.26</strong>***Please see attached Past Performance Questionnaire ' +
        '(PPQ) uploaded 8.21.26 to be used in place of the Performance Risk Assessment ' +
        'Questionnaire (PRAQ) ,Per Section L.***</p>\n\n<p></p>\n<p></p>\n',
    },
  ],
  totalCount: 1,
};

test('extracts description text from the real UI payload', () => {
  const text = parseUiDescription(REAL_UI_RESPONSE);
  assert.ok(text, 'must find the description body');
  assert.match(text, /Inventory Software Management for DEVCOM-SC/);
  assert.match(text, /Past Performance Questionnaire/);
});

test('strips HTML but keeps the words', () => {
  const text = parseUiDescription(REAL_UI_RESPONSE);
  assert.ok(!text.includes('<p>'), 'no tags should survive');
  assert.ok(!text.includes('<strong>'));
  // The emphasised amendment date is content, not markup — it must survive.
  assert.match(text, /8\.24\.26/);
});

test('collapses the empty trailing paragraphs SAM.gov pads with', () => {
  const text = parseUiDescription(REAL_UI_RESPONSE);
  assert.ok(!/\n{3,}/.test(text), 'no runs of blank lines');
  assert.equal(text, text.trim(), 'no leading or trailing whitespace');
});

test('joins multiple description entries — amendments carry the news', () => {
  // On an amended notice the later entry is often the part that matters:
  // "deadline extended", "responses to questions posted".
  const text = parseUiDescription({
    description: [
      { body: '<p>Original scope of work.</p>' },
      { body: '<p>Amendment 0001: response deadline extended to 15 September.</p>' },
    ],
  });
  assert.match(text, /Original scope/);
  assert.match(text, /extended to 15 September/);
});

test('returns null rather than empty string on every degenerate shape', () => {
  // Null is meaningful downstream — it means "no description", which the UI
  // renders honestly. An empty string would read as a notice with a blank body.
  for (const bad of [
    null,
    undefined,
    {},
    'a string',
    42,
    { description: [] },
    { description: null },
    { description: [{}] },
    { description: [{ body: '' }] },
    { description: [{ body: '   ' }] },
    { description: [{ body: '<p></p>' }] },
    { description: [{ body: 123 }] },
  ]) {
    assert.equal(parseUiDescription(bad), null, `should be null for ${JSON.stringify(bad)}`);
  }
});

test('a shape change is caught, not silently swallowed', () => {
  // If GSA renames `description` or `body`, this is what fails first.
  assert.equal(parseUiDescription({ descriptions: [{ body: 'text' }] }), null);
  assert.equal(parseUiDescription({ description: [{ text: 'text' }] }), null);
});

test('metered fallback parses both documented response shapes', () => {
  assert.match(parseApiDescription('"<p>Bare JSON string.</p>"'), /Bare JSON string/);
  assert.match(parseApiDescription('{"description":"<p>Enveloped.</p>"}'), /Enveloped/);
  assert.match(parseApiDescription('<p>Not JSON at all.</p>'), /Not JSON at all/);
});

test('metered fallback returns null on empty input', () => {
  assert.equal(parseApiDescription(''), null);
  assert.equal(parseApiDescription('   '), null);
  assert.equal(parseApiDescription('{"description":null}'), null);
});
