# Retrospective — Federal IT Contract Scanner

Started Day 1, as the plan requires. Project one's build detail was lost because
it was never written down as text; this file is the fix. Fill it in as you go —
Day 4 recall is not a reliable source of Day 1 numbers.

---

## Step zero — the real numbers

Ran 2026-08-26 (Day 1, after two false starts — see below). Window 08/20–08/26.
8 requests spent, 7 of 8 NAICS codes queried before the self-imposed budget cap.
`561621` (Security Systems Services) was never reached.

| Question | Expected | Actual |
|---|---|---|
| Daily request budget | 10 (public key) | **Unknown — api.data.gov sends no `X-RateLimit` headers on this endpoint.** No 429 after 10 requests in a day. |
| Working endpoint | `api.sam.gov/opportunities/v2/search` | **`api.sam.gov/prod/opportunities/v2/search`** — the form without `/prod/` 404s |
| 7-day volume, awards excluded | ≥ 20 to proceed | **59 usable notices** — viable |
| Does `ncode` accept multiple codes? | No | Untested — budget went to harvesting instead |
| Notices stating a response deadline | Few | **59/59.** Every one. |
| Notices carrying a set-aside | — | **51/59** |
| Notices with a description link | — | **59/59** (still one request each to read) |
| Notices stating an estimated value | Few | **0/59.** Value-band filtering is dead on arrival — see below. |

### Volume by code

| NAICS | Records | Note |
|---|---|---|
| 541519 Other Computer Related Services | **36** | 61% of the entire corpus |
| 541511 Custom Computer Programming | 9 | |
| 541512 Computer Systems Design | 9 | |
| 541810 Advertising Agencies | 4 | |
| 541618 Other Management Consulting | 1 | |
| 541430 Graphic Design | **0** | |
| 541513 Computer Facilities Management | **0** | |
| 561621 Security Systems Services | not queried | budget ran out |

Notice types: 32 Combined Synopsis/Solicitation, 23 Solicitation, 4 Presolicitation.
Zero awards reached the normalizer — the `ptype` filter works.

## What surprised us

**Day 1 (a) — the call arithmetic in the spec does not close.**

The spec assumed 1–3 SAM.gov calls/day. Two documented properties of the API
say otherwise, and both were found by reading the docs before writing the fetch
layer rather than by discovering them on Day 3:

1. **`ncode` takes one NAICS code per request.** There is no comma list and no
   parent-code search. The five service areas span 8 distinct codes, so simply
   populating the pool costs **8 requests** against a **10/day** public key.

2. **`description` is a URL, not text.** The search endpoint returns a link to
   the description; the text costs one additional request per notice. Scoring
   60 notices would cost ~60 requests.

Together: roughly **68 requests/day against a budget of 10.** The spec's core
premise — a model reads sixty notices and tells you which nine matter — does
not fit through the public key as designed.

This is exactly what step zero exists to surface, and finding it on Day 1
costs nothing. Finding it on Day 3, after building the scoring prompt, would
have cost the project.

### The options, recorded before choosing

| Option | Cost | What it does to the project |
|---|---|---|
| **A · Narrow the code list** to 3–4 codes | Free | Fewer areas, or areas that overlap more. Buys ~6 spare calls/day. Doesn't come close to solving descriptions. |
| **B · Hydrate descriptions lazily, cache forever** | Free | ~7 descriptions/day against ~60 notices/week. Roughly break-even over a week, but launch day shows almost no scored notices. |
| **C · Score from search-endpoint fields only** — title, NAICS, PSC, set-aside, agency | Free | Ships today. Weaker, but not nothing: reconciling a NAICS code against a PSC code against a title is real judgment, and PSC is assigned more carefully than NAICS. The demo claim narrows from "read the notice" to "caught the misfiling". |
| **D · Entity registration for a 1,000/day key** | 2–3 weeks | Fixes everything, misses the four-day window. Worth starting in parallel regardless — it costs nothing to have running. |
| **E · Public (non-API) SAM.gov endpoints** | Unknown | The SAM.gov web UI renders descriptions without an API key, so the data is reachable without spending quota. Unverified — the container this was investigated from cannot reach sam.gov. Test it on Day 2 before relying on it. |

**Leaning:** C as the shipping design with B layered on top, D started in the
background. C guarantees something ships in four days and keeps the model doing
defensible work; B upgrades individual notices to full-description scoring as
quota allows, so the tool visibly gets better over its first week; D removes the
constraint entirely if the project outlives the sprint. Confirm on Day 2 with
step-zero's actual numbers — particularly whether E works, which would change
the answer completely.

**DECIDED, Day 2: option E. It works.**

```
GET https://sam.gov/api/prod/opps/v2/opportunities/{noticeId}?api_key=null
```

Returns the full record including `description[0].body` — the actual text —
with no credential, on a different host from `api.sam.gov`, at no quota cost.
The literal string `null` is what SAM.gov's own web UI sends.

Found by giving up on guessing paths, loading an opportunity page in a browser
and reading its network calls. Two guessed URLs 404'd first; the network log
answered in one look. **Read what the client actually does before theorising
about what the server accepts** — that would have saved both guesses.

Consequences:

- The model reads full descriptions, as the spec intended. Options B and C are
  unnecessary; the demo claim stays "something read these notices" rather than
  narrowing to "something reconciled the metadata".
- The metered `api.sam.gov` description endpoint stays wired as a fallback, so
  if GSA changes this the tool degrades instead of dying.
- Descriptions are cached permanently by `noticeId` — a notice version's text
  never changes — and fetched sequentially. Public data on a public site, but
  "allowed" and "polite" are different standards.
- The daily SAM.gov budget now only has to cover **8 search requests**, one per
  NAICS code. That is the entire cost of a refresh.

**The honest tradeoff, for the README:** this endpoint is undocumented. It can
change without a changelog. `test/description.test.mjs` pins the response shape
against a real captured payload so a change fails loudly in tests rather than
quietly producing empty descriptions — which would look like a thin week rather
than a broken parser.

**Day 1 (b) — the corpus proves the spec's central claim, in detail.**

This is the finding that matters. 541519 "Other Computer Related Services" is
36 of 59 notices, and reading the titles, almost none of it is software work:

> GORE RF Cables · SMART M4 512GB Solid State Drives · Workstation Computers ·
> Cell Phone Repeater Removal and Replacement · UPS Preventive Maintenance and
> Battery Replacement · Weapons Storage System at Ft. MacArthur · Brand Name
> Cisco Switches · RedHat OS Service Contract · Atlassian Jira licences ·
> iHawk Annual Software Maintenance · New Patient Queuing Kiosk

Perhaps 6–8 of those 36 are real services work (National Provider Directory
data aggregation, ServiceNow SecOps implementation, Enterprise Service
Management deployment, the CNST NanoFab IT contract). The spec predicted
"62 notices matched your filters — 9 are actually software development work."
The live feed produced almost exactly that ratio without being asked to.

Even 541511 "Custom Computer Programming" — the purest code available — is
about half noise: it contains **medical** coding (PSC Q601), web-based
training, and an IFF transponder.

**PSC turns out to be the discriminating signal NAICS isn't.** `7xxx` codes
mean a product is being bought; `Dxxx` mean a service. Carrying
`classificationCode` was speculative on Day 1 and is now load-bearing: give
the model NAICS *and* PSC *and* the title, and the disagreement between them
is most of the judgment. It stays model input, never a hard filter — filtering
on it would steal the work that makes this project worth showing.

**Day 1 (c) — value-band filtering is dead. 0 of 59 notices state a value.**

Not "few" — none. The size control cannot filter on anything, so it either
comes out of the UI or ships as a documented no-op. This was flagged as an
open question in the spec; the answer is unambiguous.


---

## What got cut from the spec, and why

- **IP rate limiting** — moved to optional when the schedule went from 3 days ×
  3h to 4 days × 2h. The hard spend limit and the score cache carry most of the
  abuse protection; this is the belt to those braces.
- **NAICS 541430 (Graphic Design) and 541513 (Computer Facilities Management)** —
  0 records each in the harvest. Replaced with 518210 and 811212 rather than
  simply dropped, because `ncode` takes one code per request and the union size
  is now a hard budget line: 8 codes = 8 requests per refresh.
- **The contract-size control** — pending. 0 of 59 notices state a value and the
  documented schema has no solicitation pricing field at all (`award.amount`
  populates only on Award Notices, which are excluded at fetch; the 7 award
  objects in the corpus are empty shells, `{"awardee":{}}`). The field either
  comes out — dropping the profile space from 40 combinations to 10, warming the
  score cache 4× faster — or becomes real by having the scorer extract figures
  from description text, which depends on the description question above.
- **`scripts/step-zero.mjs` and `scripts/capture-fixture.mjs`** — superseded by
  `harvest.mjs`, still in the tree. Delete before the repo goes public; three
  scripts where one is current reads as indecision.

## Elapsed time vs. estimate

| Day | Planned | Actual | Notes |
|---|---|---|---|
| 1 | 2h | ~3h | Overran on two environmental false starts (wrong endpoint, quoted key), not on the build. Repo pushed to GitHub, private until Day 4. |
| 2 | 2h | ~2h | Descriptions, KV cache, deployed and verified |
| 3 | 2h | **~4h** | Ran double. Labelled set, prompt, enrichment, scan endpoint — plus four prompt defects and a lying harness to fix. Day 1 also ran over. The plan's one discipline was *cut scope rather than extend time* and it has now been broken twice; being ahead of schedule and having spent 2x the hours are the same fact from different ends. |
| 4 | 2h | | |

## Day 2 — what got built

- **Description hydration** via the unmetered UI endpoint, metered fallback intact,
  both parsers pure and tested against a real captured payload.
- **Notice cache** (`lib/cache.ts`): one pooled fetch of the 8-code union cached in
  KV, five service areas derived from it in code. 24h TTL, lazy refresh.
- **Stale-serve.** A failed refresh returns yesterday's notices flagged `stale`,
  never an empty list. With an unknown daily budget this is not an edge case —
  it is how a normal day ends. Rendering it as zero results would tell a visitor
  federal IT procurement paused, which is never true.
- **Two-layer single-flight.** The KV lock is approximate (eventually consistent
  reads let two isolates both see it unheld); an isolate-local in-flight promise
  is exact within one isolate. The first attempt had an `await` between checking
  and claiming the slot — a window wide enough for an entire burst to slip
  through. Caught by a test that asserted six concurrent visitors trigger one
  harvest, not six.
- **Call counter** in KV, per UTC day. Read-modify-write, so it can undercount
  under concurrency — acceptable, and it errs toward never inventing usage that
  did not happen. A Durable Object would be real infrastructure for a diagnostic.
- Deleted `step-zero.mjs` and `capture-fixture.mjs`, superseded by `harvest.mjs`.

**48 tests, no network and no API key required.**

### Deployed and verified — the definition-of-done claim, checked not asserted

Live at `contract-scanner.huauangdel.workers.dev`.

| Call | Result |
|---|---|
| Cold `/api/notices` | 107 notices pooled, `asOf` 2026-08-27T04:19:21Z, 8 SAM.gov requests |
| Warm `/api/notices?area=cybersecurity` | same `asOf`, same pool, instant |
| `samCallsToday` after both | **8** — unchanged by the warm call |

The second row is the pooled-fetch decision proving itself: a *different service
area* served from the same harvest at zero additional cost. Five areas, one
fetch, 8 requests a day regardless of traffic.

### The hard filter barely filters, and that is now measured rather than suspected

With 561621 and the two replacement codes finally queried, the pool is 107 and:

- `software-development` matches **50**
- `cybersecurity` matches **86** — 80% of the entire pool

The top cybersecurity result is *"Audio/Visual Equipment and Installation"*.

This is the Day 1 finding at full scale. The structured fields are a coarse net,
not a filter; essentially all of the discrimination has to come from the model.
Two consequences:

1. **The rejection line is not decoration, it is the product.** "86 matched your
   filters · 5 worth reading" is the honest description of what this tool does.
   Without scoring, the page would be a list of 86 mostly-irrelevant notices.
2. **Day 3 carries more weight than the plan assumed.** The scoring prompt is
   not improving a decent filter; it is the only thing standing between a
   visitor and 86 rows of audio-visual equipment.

## Still open after Day 2

**The contract-size control.** Free descriptions change the picture: the scorer
could extract a figure when the description states one. But the structured field
is empty on 100% of notices, and a filter that silently drops every unpriced
notice is worse than no filter. Recommendation: cut it as a *filter* (profile
space 40 → 10, score cache warms 4× faster) and have the scorer surface a value
when the text states one, for display only. Not yet implemented.

## Day 3 (a) — the hand-labelled set immediately caught two of my errors

Fifteen notices, labelled cold before any prompt existed. That ordering paid for
itself in the first five minutes.

### Correction: I overstated the PSC claim

Day 1 and Day 2 both recorded "PSC is the discriminating signal NAICS isn't",
with `7xxx` = a product being bought and `Dxxx` = a service. The labels break it:

| Notice | PSC | My heuristic said | Reality |
|---|---|---|---|
| Inventory Management Software | `7A20` | product | real software build, 15-week deliverable |
| IFF Transponder Software | `7A21` | product | software |
| Dorm Wi-Fi Heat Mapping Survey | `DA01` | IT service | an RF site survey — no software at all |

The `7A` series is *Business Application Software*; it is `70`/`72` that means
hardware. The direction was right and the granularity was wrong, and it was
asserted with far more confidence than one week of titles could support.

**PSC stays model input and does not become a rule in the prompt.** The general
lesson is the specific one: a pattern spotted across sixty titles in an
afternoon is a hypothesis, and writing it down twice in a retrospective does not
promote it to a finding.

### Correction: 561621 was never cybersecurity

`561621 Security Systems Services` is *physical* security — alarm and CCTV
installation. It went into the cybersecurity area on the strength of the word
"security" and nothing else.

The labels made it unmissable: cybersecurity matched **86 of 107** notices under
the hard filter and scored **0 of 15** as worth reading. Federal infosec work is
filed under 541512/541519 with PSC DK/DH codes.

Removed. The union drops to **7 codes**, so a daily refresh now costs 7 requests.

### The labels are more permissive than the product story

Twelve of fifteen notices passed on at least one area:

| area | Y | of 15 |
|---|---|---|
| it-support | 8 | 53% |
| software-development | 5 | 33% |
| web-digital | 2 | 13% |
| data-analytics | 2 | 13% |
| cybersecurity | 0 | 0% |

`it-support` was doing catch-all duty — A/V equipment installation, an RF site
survey and Lockheed-proprietary sustainment all marked Y under "supporting an
existing system". Defensible, but at 53% the rejection line reads
"86 matched · 45 worth reading", which is a filter rather than judgment.

**Decision: the bar is "would this agency actually bid?", not "could someone do
this work?"** A 15-person shop with no SAM registration, no clearance and no
incumbent relationship realistically bids on very few federal notices. That is
the honest standard and the one that produces a rejection line worth showing.

## Day 3 — what got built, and what measurement caught

Labelled set (`fixtures/labels.json`), scoring prompt, glossary enrichment,
score cache, `/api/scan`. 87 tests. **87% agreement on the labelled set, zero
invented figures across 39 rows.**

### The scorer found something neither of us had

The NOAA notice is a **sole source to Fathom Science, Inc.** under FAR 6.103-1.
It quotes the text: *"FATHOM SCIENCE INC. IS THE ONLY SOURCE CAPABLE"*, *"no
authorized partners or resellers"*, and correctly reads that the presolicitation
exists to give other firms 15 days to **object**, not to bid.

The hand label said "no" for a weaker reason — research-lab work. The scorer got
the same answer because the contract is legally unwinnable. Nothing in the title,
NAICS code or PSC code carries that. It is the best single piece of evidence the
project has that something read the notice, and it belongs in the README.

The same run found PAWSS restricted to Lockheed Martin, and the IFF notice to be
a Raytheon **licence purchase** rather than development work at all.

### Four prompt defects, each found by measurement rather than review

Every one was mine, and none would have been visible without the labelled set:

1. **The `statedDeadline` trap.** The prompt supplied the structured deadline,
   then asked for a deadline "only if the description states one — do not copy
   the field above". It got copied 43 times in one run. A field whose correct
   value is almost always null, sitting beside the same value in non-null form,
   is a trap of the prompt's own making. Deleted.
2. **The UNKNOWN gloss led the witness.** It read "an unidentifiable named
   system is usually proprietary, agency-internal, or has an incumbent". The
   model flagged the phrase *"designated airmen"*, got UNKNOWN back, and
   concluded that a term it could not find was evidence of an incumbent
   programme — turning a gap in its own knowledge into a fact about the
   opportunity, and costing a genuine 80+ notice 55 points.
3. **Universal boilerplate scored as negative.** Missing attachments, past
   performance questionnaires, standard FAR provisions, short response windows.
   All appear on nearly every solicitation, so penalising them penalises the
   feed uniformly — indistinguishable from not judging at all. This cost the
   cleanest notice in the set (Inventory Management Software) 55 points.
4. **The top band was unreachable. 39 rows, nothing above 72.** The bands were
   being read as a risk scale where any residual uncertainty capped the score.
   The instruction "score conservatively" made it worse: the model read it as
   licence to speculate downward — "suggests a rushed follow-on", "likely
   incumbent-held" — with no text supporting it. That is the same failure as
   inventing a dollar figure, pointed in a direction that felt safe.

### The harness lied, and that was the worst bug of the day

Description hydration failed, the failures were cached as `null`, and the
harness printed **85% agreement** on a run where every single justification
began *"No description text is available."* It measured the title and reported
a number that looked like a result.

It now aborts rather than reporting, and never caches a failure. A harness that
fails loudly is worth more than one that is usually right — the confident wrong
number would have sent the whole day's prompt work in the wrong direction.

### A pattern in my own work, recorded because it repeated

Three times I stated a hypothesis as a finding:

- **"PSC is the discriminating signal NAICS isn't."** Written into the
  retrospective twice on one week of titles. The labels broke it: PSC 7A20 and
  7A21 are business application software, not hardware.
- **"The endpoint is `api.sam.gov/opportunities/v2/search`."** Two guessed URLs
  404'd. Reading the browser's network log answered it in one look.
- **"The Worker will hit the same wall as the laptop."** sam.gov refuses this
  laptop at the TLS layer — 406, then ECONNRESET on every header set including
  a full browser signature — but answers Cloudflare's edge in 136ms with plain
  honest headers. A five-minute debug route saved Day 2's entire architecture
  from being discarded on my say-so.

The correction each time came from measuring something cheap. **When the answer
is observable, observe it.** Applying that earlier would have saved most of a
day across the three.

### A constraint worth designing around: 50 subrequests

Cloudflare's free tier caps subrequests per request. A scan spends up to 6 on
the SAM.gov refresh and each cold notice costs 1-3 model calls, so a cold
profile over ~45 notices cannot be scored in one request.

`/api/scan` therefore returns **three** numbers: `matched`, `worthReading`, and
`stillReading`. Truncating silently to 12 and reporting the rejection line over
those would look identical to a working product and be a lie — "45 matched · 3
worth reading" computed over 12 notices is simply a wrong number, and the
rejection line IS the product.

### The labelled set was revised once, deliberately

MyPath moved from `conditional` to `no` after the scorer read the description
more carefully than the fifteen-minute labelling pass had. Recorded in
`labels.json` with `revisedFrom` and the reasoning, not silently edited — a
quiet edit turns the labelled set into something that agrees with the model by
construction, which is the one thing it exists to prevent.

## Where Day 4 starts

1. **Re-run the harness** and read the justifications. The band recalibration is
   unverified; the question is whether good notices now reach 80+ without the
   bad ones following them up.
2. **Watch the RFS rows.** Same notice scored 72 / 25 / 72 across three areas
   where the labels said clear / conditional / no — nearly inverted on two. If
   that survives the recalibration it is instability, not calibration.
3. Settle the two provisional labels (#7 NNOMPEAS, #13 Marriage Data).
4. Frontend: three controls, scan on load, the rejection line, **an honest
   `stillReading` state**, designed empty and failure states, mobile-first.
5. Custom domain, definition-of-done checklist, README under 400 words.
6. Optional: IP rate limiting — `RATELIMIT` is already bound.

## Actual cost vs. estimate## Actual cost vs. estimate

Estimate: a few cents/month steady state, ~$0.06 to cold-score a 60-notice
bucket. Actual: _pending_.

## What I'd do differently

- **Read the API docs before writing the spec's cost model.** The "1–3 calls/day"
  figure was load-bearing for the whole architecture and it was wrong by more
  than an order of magnitude. Ten minutes of reading on the day the spec was
  written would have surfaced it.
- **Verify the endpoint with one curl before writing a client against it.** Two
  of Day 1's three failures were environmental, not logical: the documented URL
  without `/prod/` 404s, and `cmd.exe`'s `set VAR="..."` embeds the quotes in
  the value, producing a 40→42-character key that api.data.gov rejects as a
  bare 404 rather than a 403. Both presented identically. An hour went into
  re-reading correct documentation because a malformed credential and a dead
  endpoint are indistinguishable from the outside.
- **Make credentials announce their own malformation.** `loadApiKey` now
  reports shape problems before a request is spent. The first version of that
  check also flagged hyphens, which real keys contain — a false alarm on a
  working key is worse than no check, because it aims the search at the one
  thing that was fine.
- **Harvest before you measure.** Step zero and the fixture capture were two
  scripts asking the API overlapping questions. With no visible rate-limit
  headers, the corpus had to be banked first and every other question answered
  from it offline. Merging them into `harvest.mjs` cost 8 requests and answered
  more than the original plan's two passes would have.
