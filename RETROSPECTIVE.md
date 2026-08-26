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

_(Decide, then record what you chose and why.)_

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
- _(add as you go)_

## Elapsed time vs. estimate

| Day | Planned | Actual | Notes |
|---|---|---|---|
| 1 | 2h | ~3h | Overran on two environmental false starts (wrong endpoint, quoted key), not on the build |
| 2 | 2h | | |
| 3 | 2h | | |
| 4 | 2h | | |

## Actual cost vs. estimate

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
