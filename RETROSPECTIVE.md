# Retrospective — Federal IT Contract Scanner

Started Day 1, as the plan requires. Project one's build detail was lost because
it was never written down as text; this file is the fix. Fill it in as you go —
Day 4 recall is not a reliable source of Day 1 numbers.

---

## Step zero — the real numbers

**Not yet run.** The API key was not obtained on Day 1, so step zero moves to
the top of Day 2. `npm run step-zero` writes its raw output to
`fixtures/step-zero-<date>.json`; paste the summary here when it does.

| Question | Expected | Actual |
|---|---|---|
| Daily request budget (from `X-RateLimit-Limit`) | 10 (public key) | _pending_ |
| 7-day volume, awards excluded, all 8 NAICS codes | ≥ 20 to proceed | _pending_ |
| Does `ncode` accept multiple codes in one request? | No, per docs | _pending_ |
| Does a description fetch decrement the same quota? | Assume yes | _pending_ |
| Notices stating an estimated value | Few | _pending_ |

---

## What surprised us

**Day 1 — the call arithmetic in the spec does not close.**

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

---

## What got cut from the spec, and why

- **IP rate limiting** — moved to optional when the schedule went from 3 days ×
  3h to 4 days × 2h. The hard spend limit and the score cache carry most of the
  abuse protection; this is the belt to those braces.
- _(add as you go)_

## Elapsed time vs. estimate

| Day | Planned | Actual | Notes |
|---|---|---|---|
| 1 | 2h | _pending_ | Key not obtained; step zero deferred to Day 2 |
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
- _(add as you go)_
