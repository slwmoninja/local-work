# LocalWork

A PWA that finds desk-job openings within about a 20-minute drive of ZIP 23185 (Williamsburg, VA) plus fully-remote roles tied to Virginia, scores each one against your resume, and helps you save / eliminate / apply-and-track roles.

## How it works

- **Job data** lives in `data/jobs.json`, a static snapshot — this is a GitHub Pages app with no backend, no database, and no API key anywhere in the project.
- **Resume skills profile** lives in `data/resume-profile.json` — a list of your skills/tools (with synonyms) and hard disqualifiers (licenses, physical demands, unrelated required technical skills) used for scoring. Edit this file directly if your skills change; no rebuild step needed.
- **Scoring** happens two ways, and the app tells you which one produced a given score:
  - **Claude-reasoned** (`job.ai` present): produced offline by `scripts/refresh-jobs.ps1`, which runs headless Claude Code (your existing subscription login, not a metered API key) to actually read each posting, separate real qualifications from job duties/perks, and judge fit. This is the accurate path and avoids any free-NLP-API rate limit entirely, since it's not calling a public API at all.
  - **On-device keyword match** (no `job.ai`): an instant, zero-cost fallback built into `app.js` — plain keyword/synonym/regex matching against `resume-profile.json`. Used automatically for any job that hasn't been through a Claude refresh pass yet.
- **Save / Eliminate / Apply & Track** state is stored in `localStorage` only, per browser/device. An explicit Save always wins over automatic elimination — if a saved job later goes stale or fails a rescore on refresh, it stays in Saved rather than silently moving to Not a Fit.
- **Freshness**: postings older than 7 days are auto-moved to Not a Fit (`freshness.windowDays` in `resume-profile.json`); postings from the last business day get a score bonus (`freshness.bonusWithinDays` / `bonusPoints`). Postings with no visible posted date are treated as neutral, not stale.
- **Local vs remote**: `job.remote: true` entries show a "Remote (VA)" badge instead of a drive time. The two checkboxes above the list filter either category out independently.

## Refreshing job data

```
powershell -File scripts\refresh-jobs.ps1
```

This re-scrapes local employer career pages and re-scores every posting, overwriting `data/jobs.json`. Review the diff before committing/pushing — Claude is instructed never to invent postings, but always sanity-check before you push a public update.

## Running locally

```
powershell -File scripts\serve.ps1
```

Then open http://localhost:8791/index.html — the app fetches `data/*.json` over `fetch()`, which needs an actual HTTP server (not a bare `file://` open).

## Files

- `index.html` / `app.js` / `sw.js` / `manifest.json` — the app shell
- `data/resume-profile.json` — your skills/tools/disqualifiers used for scoring
- `data/jobs.json` — the job snapshot (Claude-scored where available)
- `scripts/refresh-jobs.ps1` — re-scrapes + re-scores via headless Claude Code
- `scripts/serve.ps1` — local static server for testing
