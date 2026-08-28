# Federal contract scanner

Reads the last seven days of federal IT contract opportunities and says which
are worth opening — with one line explaining why.

**The problem.** SAM.gov posts around a hundred federal IT notices a week, and
the NAICS codes on them are assigned by contracting officers and are frequently
wrong. In one week's corpus, 541519 "Other Computer Related Services" was 60% of
everything and contained RF cables, solid-state drives, a weapons storage
system, and several licence renewals. Filtering gets you sixty notices. Only
reading them finds the four worth an afternoon.

**The split.** Structured fields are hard constraints — service area maps to
NAICS, set-aside filters within it. A `WHERE` clause, no model. The model reads
each description and returns 0–100 with a justification that must cite something
specific from that notice.

Why that division earns its keep: a NOAA notice titled *Scalable Framework for
Coastal Ocean Modeling Emulation*, NAICS 541512, looks like a plausible data
engagement. Its description says NOAA intends to award sole-source to Fathom
Science Inc. under FAR 6.103-1, and that the presolicitation exists to let other
firms **object** within fifteen days — not bid. No code carries that fact.

**Fetching is separate from scoring**, because a public SAM.gov key allows about
ten requests a day. The trailing 7-day window is fetched once daily — six
requests, one per NAICS code, since `ncode` takes a single code — and cached.
Scoring runs against that cache and is itself cached per notice. Usage stays at
six requests a day under any load, checkable at `/api/health`.

**The tradeoff.** Descriptions cost a metered request each on the documented
API; sixty notices would be sixty requests against a budget of ten. They come
instead from sam.gov's own UI endpoint, which is unmetered and needs no
credential. That endpoint is undocumented and can change without warning. The
metered path stays wired as a fallback, and `test/description.test.mjs` pins the
response shape against a real captured payload, so a change fails loudly in
tests rather than quietly producing empty descriptions.

**Known limitation.** SAM.gov is federal prime only — no state, local or
education procurement, and bidding requires SAM registration. A small agency
will find real work here, but not all of it is realistically winnable. Adding a
local source is the obvious next step; the adapter layer is already shaped for it.

```bash
npm install
npm test          # 94 tests, no network and no API key
npm run dev       # serves the fixture, spends nothing
npm run score     # scores against the hand-labelled set in fixtures/labels.json
```
