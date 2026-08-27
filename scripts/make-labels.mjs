/**
 * Generate a labelling worksheet from the harvested corpus.
 *
 *   npm run labels
 *
 * The point of labelling by hand BEFORE writing the scoring prompt is that
 * otherwise "the justifications look good to me" is unfalsifiable — you end up
 * grading the model against whatever it just told you. Fifteen judgements made
 * cold are the only fixed point Day 3 has.
 *
 * The sample deliberately spans PSC families rather than taking the first
 * fifteen records. A worksheet of fifteen obvious calls teaches nothing; the
 * value is in the notices where NAICS says one thing and PSC says another.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(join(root, 'fixtures/notices-sample.json'), 'utf8'));

/** PSC's first character is the tell: 7x buys a product, Dx buys an IT service. */
function family(psc) {
  if (!psc) return 'unclassified';
  if (/^[0-9]/.test(psc)) return 'product (7x/xxxx)';
  if (psc.startsWith('D')) return 'IT service (Dx)';
  if (psc.startsWith('R')) return 'professional service (Rx)';
  return `other (${psc[0]}x)`;
}

const groups = new Map();
for (const n of corpus) {
  const f = family(n.classificationCode);
  if (!groups.has(f)) groups.set(f, []);
  groups.get(f).push(n);
}

// Round-robin across families so the sample is mixed by construction.
const picked = [];
const families = [...groups.keys()].sort();
for (let i = 0; picked.length < 15; i++) {
  let progressed = false;
  for (const f of families) {
    const item = groups.get(f)[i];
    if (!item) continue;
    picked.push([f, item]);
    progressed = true;
    if (picked.length >= 15) break;
  }
  if (!progressed) break;
}

const AREAS = ['software-dev', 'web-digital', 'data-analytics', 'it-support', 'cybersecurity'];

const body = picked
  .map(([fam, n], i) => {
    const agency = (n.fullParentPathName || '').split('.')[0];
    return [
      `### ${i + 1}. ${n.title}`,
      '',
      `- **PSC** \`${n.classificationCode || '—'}\` — ${fam}`,
      `- **NAICS** \`${n.naicsCode}\` · **${n.type}**`,
      `- **Agency** ${agency}`,
      `- **Due** ${(n.responseDeadLine || '—').slice(0, 10)}`,
      `- [Open the notice and read the description](${n.uiLink})`,
      '',
      `| ${AREAS.join(' | ')} |`,
      `|${AREAS.map(() => '---').join('|')}|`,
      `|${AREAS.map(() => '   ').join('|')}|`,
      '',
      '_Why:_',
      '',
      '---',
      '',
    ].join('\n');
  })
  .join('\n');

const header = `# Labelling worksheet — ${picked.length} notices

Made **before** the model sees them. That ordering is the whole value: judged
afterwards, you would be grading the model against what it just told you.

For each notice mark **Y** or **N** per service area — would a 5–30 person
digital agency working in that area actually want to read this? Then one line
on why.

**The _why_ matters more than the Y/N.** It is the standard the model's
justifications get held against tomorrow, and "matches your service area" is a
failure rather than a justification — for you as much as for the model.

Ten to fifteen minutes. Don't agonise; mark genuine uncertainty as \`?\` and
move on. The unsure ones are data too — they are where the score threshold
gets decided.

Sample spans PSC families on purpose. Fifteen obvious calls would teach
nothing; the useful cases are where NAICS says one thing and PSC says another.

---

`;

writeFileSync(join(root, 'LABELS.md'), header + body);

const mix = picked.reduce((acc, [f]) => ({ ...acc, [f]: (acc[f] ?? 0) + 1 }), {});
console.log(`wrote LABELS.md — ${picked.length} notices from ${corpus.length}`);
console.log('family mix:', mix);
