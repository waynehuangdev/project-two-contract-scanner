# Federal IT Contract Scanner

> **Day 1 stub.** The real README — under 400 words, covering the problem, the
> fetch/score split and why, and one tradeoff — gets written on Day 4. This is
> scaffolding so the file exists and accumulates rather than being invented at
> the end.

Scans the last seven days of federal contract opportunities and says which are
worth reading, with a one-line reason for each.

## Status

| Day | Scope | State |
|---|---|---|
| 1 | Source de-risk: adapter, normalizer, offline fixture | ✅ code done, step zero blocked on API key |
| 2 | KV notice cache, lazy TTL refresh, call counter | — |
| 3 | Scoring prompt, `/api/scan` | — |
| 4 | Frontend, domain, ship | — |

## Running it

```bash
npm install
npm test              # normalizer + filter tests, no network, no API key
npm run typecheck
npm run dev           # Worker on localhost, serving the hand-written fixture

# Once the SAM.gov key exists — run step zero BEFORE anything else:
SAM_API_KEY=xxxx npm run step-zero
SAM_API_KEY=xxxx npm run capture-fixture
```

`npm run step-zero` reports the real daily request budget off the response
headers, the 7-day notice volume, and what a description actually costs. It
spends at most 9 requests and applies the spec's decision gate itself.

## Layout

```
src/
  types.ts              internal Notice shape — nulls are load-bearing
  config.ts             service area → NAICS, allowed notice types, size bands
  sources/adapter.ts    SourceAdapter interface (source two costs a file)
  sources/samgov.ts     SAM.gov implementation + normalizer
  lib/filter.ts         hard constraints — the no-model half of the split
  lib/window.ts         trailing 7-day window, UTC
scripts/
  step-zero.mjs         the volume + budget check. Run before building.
  capture-fixture.mjs   one-time capture of real notices for offline work
fixtures/
  raw-sam-sample.json   hand-written awkward cases (tracked)
  hand-written.json     generated from the above (tracked)
  notices-sample.json   real capture (gitignored — large, churns daily)
```

## Known limitation

SAM.gov is federal prime only — no state, local, or education procurement.
Federal contracting requires SAM registration and often set-aside status, which
is a stretch for a 15-person agency. This is stated plainly rather than hidden;
adding a local source is the fix, and the adapter layer is already shaped for it.
