/**
 * Regenerate fixtures/hand-written.json from fixtures/raw-sam-sample.json.
 *
 * The normalized fixture is a build product, never hand-edited. If it were
 * maintained by hand it would drift from the normalizer and the tests would
 * start asserting a shape the real code no longer produces — which is the
 * exact failure mode fixtures are supposed to prevent.
 *
 *   node --experimental-strip-types scripts/build-fixture.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeSamRecord } from '../src/sources/samgov.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(readFileSync(join(root, 'fixtures/raw-sam-sample.json'), 'utf8'));

const normalized = raw.map(normalizeSamRecord).filter(Boolean);

writeFileSync(
  join(root, 'fixtures/hand-written.json'),
  JSON.stringify(normalized, null, 2) + '\n',
);

console.log(`${raw.length} raw records → ${normalized.length} notices (${raw.length - normalized.length} dropped)`);
