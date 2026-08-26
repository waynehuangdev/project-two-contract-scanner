/**
 * API-key sanitizing tests.
 *
 * Written after a 42-character key — a 40-character key wrapped in the quotes
 * cmd.exe keeps from `set VAR="..."` — produced a bare 404 from api.data.gov
 * and sent an hour into checking endpoint documentation that was correct all
 * along. The lesson encoded here: a malformed credential must announce itself
 * before it becomes an unrelated-looking HTTP error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApiKey, describeKey } from '../src/lib/apiKey.ts';

const GOOD = 'a'.repeat(39) + '4';

test('strips the quotes cmd.exe leaves on the value', () => {
  const r = loadApiKey(`"${GOOD}"`);
  assert.equal(r.key, GOOD);
  assert.ok(r.repaired);
  assert.match(r.warnings.join(' '), /cmd\.exe/);
});

test('strips single quotes too', () => {
  assert.equal(loadApiKey(`'${GOOD}'`).key, GOOD);
});

test('leaves a clean key untouched and unwarned', () => {
  const r = loadApiKey(GOOD);
  assert.equal(r.key, GOOD);
  assert.equal(r.repaired, false);
  assert.deepEqual(r.warnings, []);
});

test('warns on the wrong length', () => {
  assert.match(loadApiKey('abc').warnings.join(' '), /expected 40 characters, got 3/);
});

test('warns on characters that cannot appear in a key', () => {
  // The failure mode that started this: quotes survive into the request.
  assert.match(loadApiKey('a'.repeat(38) + '="').warnings.join(' '), /unexpected characters/);
});

test('accepts hyphens and underscores without complaint', () => {
  // Real api.data.gov keys contain them. Flagging a working key is worse than
  // not checking: it points the search at the one thing that was already fine.
  const withDash = 'a'.repeat(20) + '-' + 'b'.repeat(9) + '_' + 'c'.repeat(9);
  const r = loadApiKey(withDash);
  assert.equal(r.key.length, 40);
  assert.deepEqual(r.warnings, [], 'a valid 40-char key must produce no warnings');
});

test('treats unset and blank alike', () => {
  assert.equal(loadApiKey(undefined).key, null);
  assert.equal(loadApiKey('   ').key, null);
});

test('describeKey never reveals a usable portion of the key', () => {
  const d = describeKey(GOOD);
  assert.ok(!d.includes(GOOD.slice(0, 10)));
  assert.match(d, /40 chars/);
});
