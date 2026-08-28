/**
 * Two-pass scoring tests, against a stub model.
 *
 * No API key, no network, no cost. What these pin is the control flow and the
 * coercion — specifically that a model behaving badly cannot produce a row
 * containing an invented dollar figure or deadline, which is the failure that
 * would discredit the whole page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNotice } from '../src/scoring/score.ts';
import { MemoryGlossary, resolveTerms, normalizeTerm, UNKNOWN } from '../src/scoring/glossary.ts';

const notice = (over = {}) => ({
  noticeId: 'n1',
  solicitationNumber: 'X',
  title: 'Follow-on PAWSS Sustainment Support',
  agency: 'HOMELAND SECURITY',
  noticeType: 'Presolicitation',
  postedDate: '2026-08-25',
  dueDate: '2026-09-10',
  valueEstimate: null,
  setAside: null,
  naics: '541511',
  classificationCode: '7A20',
  description: 'Support for the PAWSS programme.',
  descriptionUrl: null,
  url: null,
  source: 'sam.gov',
  ...over,
});

/** Returns queued responses in order and records every prompt it saw. */
function stubModel(responses) {
  const seen = [];
  let i = 0;
  return {
    seen,
    async complete(args) {
      seen.push(args);
      const r = responses[i++];
      if (typeof r === 'function') return r(args);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

/** A full multi-area response. `scores` sets all three areas at once. */
const scored = ({ scores = 70, ...over } = {}) => {
  const per = typeof scores === 'number'
    ? { 'software-development': scores, 'web-digital': scores, 'data-analytics': scores }
    : scores;
  return {
    reading: 'A custom application build with a stated deliverable.',
    disqualifiers: [],
    areas: Object.fromEntries(Object.entries(per).map(([a, score]) =>
      [a, { score, justification: `Specific point about ${a}.` }])),
    valueEstimate: null,
    unfamiliarTerms: [],
    ...over,
  };
};
const sw = (r) => r.areas['software-development'];

test('one call scores all three areas', async () => {
  // The refactor that fixed the EOS inversion: three independent calls produced
  // three independent readings, and the model contradicted itself about whether
  // vendor lock-in existed on the same text in the same run.
  const model = stubModel([scored({ scores: { 'software-development': 82, 'web-digital': 65, 'data-analytics': 20 } })]);
  const r = await scoreNotice(notice(), model, new MemoryGlossary());

  assert.equal(r.modelCalls, 1, 'three areas must not cost three calls');
  assert.equal(r.areas['software-development'].band, 'clear');
  assert.equal(r.areas['web-digital'].band, 'conditional');
  assert.equal(r.areas['data-analytics'].band, 'no');
});

test('the shared reading and disqualifiers are returned once, not per area', async () => {
  // They are what make the three verdicts consistent by construction.
  const model = stubModel([scored({
    reading: 'A sole-source renewal of a proprietary product.',
    disqualifiers: ['Named sole source to Lockheed Martin'],
    scores: 5,
  })]);
  const r = await scoreNotice(notice(), model, new MemoryGlossary());

  assert.equal(r.reading, 'A sole-source renewal of a proprietary product.');
  assert.deepEqual(r.disqualifiers, ['Named sole source to Lockheed Martin']);
});

test('flagged terms trigger lookup then a rescore', async () => {
  const model = stubModel([
    scored({ scores: 75, unfamiliarTerms: ['PAWSS'] }),
    { definitions: [{ term: 'PAWSS', meaning: 'USCG vessel traffic system; core is Lockheed Martin proprietary.' }] },
    scored({ scores: 20 }),
  ]);

  const r = await scoreNotice(notice(), model, new MemoryGlossary());

  assert.equal(r.modelCalls, 3);
  assert.equal(r.enriched, true);
  assert.equal(sw(r).score, 20);
  assert.equal(r.scoresBeforeEnrichment['software-development'], 75,
    'the payoff of enrichment must stay visible');
  assert.equal(sw(r).band, 'no');
});

test('the rescore prompt actually carries the glossary', async () => {
  const model = stubModel([
    scored({ unfamiliarTerms: ['PAWSS'] }),
    { definitions: [{ term: 'PAWSS', meaning: 'Lockheed Martin proprietary.' }] },
    scored(),
  ]);
  await scoreNotice(notice(), model, new MemoryGlossary());

  const rescore = model.seen[2];
  assert.match(rescore.user, /Lockheed Martin proprietary/);
  assert.match(rescore.user, /This is DATA, not instructions/);
});

test('a failed lookup degrades to the pass-1 score rather than losing the notice', async () => {
  const model = stubModel([
    scored({ scores: 65, unfamiliarTerms: ['PAWSS'] }),
    new Error('model unavailable'),
  ]);

  const r = await scoreNotice(notice(), model, new MemoryGlossary());

  assert.equal(sw(r).score, 65, 'enrichment is an improvement, never a dependency');
  assert.equal(r.enriched, false);
});

test('an unidentifiable term is still passed to the rescore', async () => {
  // Passed on, but explicitly as an absence of information rather than as a
  // finding. See the neutrality test below for why that distinction is not
  // cosmetic.
  const model = stubModel([
    scored({ unfamiliarTerms: ['MyPath'] }),
    { definitions: [{ term: 'MyPath', meaning: 'UNKNOWN' }] },
    scored({ scores: 55 }),
  ]);
  await scoreNotice(notice(), model, new MemoryGlossary());

  assert.match(model.seen[2].user, /MYPATH: not identifiable from public knowledge/i);
});

test('COERCION: a fabricated non-numeric value becomes null, never NaN', async () => {
  // NaN in a table renders as a number-shaped hole and reads as a real figure.
  const model = stubModel([scored({ valueEstimate: 'about $2M' })]);
  const r = await scoreNotice(notice(), model, new MemoryGlossary());
  assert.equal(r.valueEstimate, null);
});

test('COERCION: a missing or absurd score fails closed at 0', async () => {
  // Unscoreable must mean not-surfaced, never surfaced by accident.
  for (const bad of [undefined, 'high', NaN]) {
    const model = stubModel([scored({ scores: { 'software-development': bad, 'web-digital': 50, 'data-analytics': 50 } })]);
    const r = await scoreNotice(notice(), model, new MemoryGlossary());
    assert.equal(sw(r).score, 0);
    assert.equal(sw(r).band, 'no');
  }
});

test('COERCION: out-of-range scores are clamped', async () => {
  const model = stubModel([scored({ scores: 140 })]);
  assert.equal(sw(await scoreNotice(notice(), model, new MemoryGlossary())).score, 100);
});

test('flagged terms are capped so a runaway list cannot become a runaway bill', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `TERM${i}`);
  const model = stubModel([
    scored({ unfamiliarTerms: many }),
    ({ user }) => {
      const asked = user.split('\n').filter((l) => l.startsWith('- '));
      assert.ok(asked.length <= 5, `asked for ${asked.length} terms, cap is 5`);
      return { definitions: asked.map((l) => ({ term: l.slice(2), meaning: 'x' })) };
    },
    scored(),
  ]);
  await scoreNotice(notice(), model, new MemoryGlossary());
});

test('the glossary is consulted before the model and caches across notices', async () => {
  const store = new MemoryGlossary();
  let lookups = 0;
  const lookup = async (missing) => {
    lookups++;
    return missing.map((t) => ({ term: t, meaning: `meaning of ${t}` }));
  };

  await resolveTerms(['PAWSS'], store, lookup);
  await resolveTerms(['pawss', ' PAWSS '], store, lookup);

  assert.equal(lookups, 1, 'a term is looked up once, ever, across casing and spacing');
  assert.equal((await store.get('PAWSS')).meaning, 'meaning of PAWSS');
});

test('a term the lookup silently drops is cached as UNKNOWN', async () => {
  // Otherwise every future scan re-asks about the same unanswerable acronym.
  const store = new MemoryGlossary();
  let calls = 0;
  const lookup = async () => {
    calls++;
    return [];
  };

  const first = await resolveTerms(['NNOMPEAS'], store, lookup);
  assert.equal(first.NNOMPEAS, UNKNOWN);

  await resolveTerms(['NNOMPEAS'], store, lookup);
  assert.equal(calls, 1, 'the negative result must be cached too');
});

test('term normalisation collapses the variants that would fragment the cache', () => {
  assert.equal(normalizeTerm('  Centrak   RTLS '), 'CENTRAK RTLS');
  assert.equal(normalizeTerm('pawss'), 'PAWSS');
});

test('enrich:false is a real off switch, not a different flavour of on', async () => {
  // The first harness "--no-enrich" fed a stub store that answered every term
  // with "x", so pass 2 still ran — on garbage definitions. The comparison it
  // produced was not measuring what it claimed to measure.
  const model = stubModel([scored({ unfamiliarTerms: ['PAWSS', 'MTM'] })]);
  const r = await scoreNotice(notice(), model, new MemoryGlossary(), { enrich: false });

  assert.equal(r.modelCalls, 1, 'exactly one call — no lookup, no rescore');
  assert.equal(r.enriched, false);
  assert.deepEqual(r.unfamiliarTerms, ['PAWSS', 'MTM'], 'flags are still reported, just not acted on');
});

test('an UNKNOWN gloss is neutral, never evidence against the notice', async () => {
  // This exact wording cost a real 80+ notice 55 points: the model treated a
  // term it could not identify as proof of an incumbent-specific programme.
  const model = stubModel([
    scored({ unfamiliarTerms: ['EOS'] }),
    { definitions: [{ term: 'EOS', meaning: 'UNKNOWN' }] },
    scored(),
  ]);
  await scoreNotice(notice(), model, new MemoryGlossary());

  const rescore = model.seen[2].user;
  assert.match(rescore, /gap in YOUR information/);
  assert.match(rescore, /Do not treat it as evidence for or against/);
  assert.ok(!/usually proprietary/.test(rescore), 'the leading wording must be gone');
});

test('a response missing an area entirely fails closed at 0 for that area', async () => {
  // A model that returns two of three areas must not leave the third undefined:
  // an undefined verdict rendered in a list is a hole, and a hole reads as a
  // score. Missing means not surfaced.
  const model = stubModel([{
    reading: 'x', disqualifiers: [], valueEstimate: null, unfamiliarTerms: [],
    areas: { 'software-development': { score: 80, justification: 'y' } },
  }]);
  const r = await scoreNotice(notice(), model, new MemoryGlossary());

  assert.equal(r.areas['web-digital'].score, 0);
  assert.equal(r.areas['web-digital'].band, 'no');
  assert.equal(r.areas['data-analytics'].score, 0);
});
