# Refreshes data/jobs.json by running headless Claude Code (your existing
# Claude Code login/subscription -- not a separate metered API key and not a
# rate-limited public NLP service) to re-scrape local employer career pages
# and have Claude itself re-read and re-score every posting against
# data/resume-profile.json. This is what keeps requirements-vs-duties
# classification accurate without hitting any per-call API limit -- it only
# runs when you choose to run it, same pattern as WheelsAndDeals's
# refresh-snapshots.ps1.
#
# Usage: powershell -File scripts\refresh-jobs.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$prompt = @'
You are refreshing the job data snapshot for the LocalWork app in this folder.

1. Read data/resume-profile.json for the candidate's skills, tools, hard
   disqualifiers, and the "freshness" block (windowDays / bonusWithinDays).

2. Source postings from TWO categories:
   a. LOCAL -- employers within about a 20-minute drive of ZIP 23185
      (Williamsburg, VA). In addition to ZIP-based search, also search using
      "Williamsburg, VA" and "James City County, VA" as location terms --
      some job boards (state/county sites, ATS platforms) filter by
      city/county name rather than ZIP radius, and postings there can be
      missed by a ZIP-only search.
   b. REMOTE (VA) -- fully-remote roles explicitly tied to Virginia. On
      LinkedIn and similar boards this means the posting's location is
      "Remote, Virginia" (or similar state-scoped remote), NOT the
      nationwide "Remote, United States" -- exclude postings that are remote
      with no state tie, since those aren't meaningfully filtered by
      geography at all. Search LinkedIn's public job listings plus other
      boards (Indeed, ZipRecruiter, Built In, USAJobs telework/VA,
      LinkedIn/other boards filtered to Virginia).
   Both categories: desk/office professional roles only (program/project/
   product management, partner/alliance management, business development,
   GTM/sales enablement, marketing, operations, consulting). Use
   WebSearch/WebFetch and, if needed, the claude-in-chrome browser tools for
   JS-heavy career sites and LinkedIn (open Chrome first if it isn't
   running).

3. Freshness: only include postings with a visible posted date that is
   within the last `freshness.windowDays` days (currently 7) as of today.
   If a posting shows no date at all, you may still include it (the app
   treats an unknown date as neutral, not stale) but prefer dated, visibly
   fresh postings when you have a choice between similar listings. Note
   each posting's actual posted date in "postedDate" (YYYY-MM-DD) whenever
   the page shows one -- don't guess a date if none is shown.

4. For each posting, extract the verbatim Requirements/Qualifications
   section as an array of individual bullet strings -- not the job duties
   or perks sections.

5. For each requirement bullet, actually read and reason about whether it
   is satisfied by the resume profile: distinguish a true qualification
   requirement from a "nice to have," and distinguish job duties from
   requirements. Set matched:true/false, and hard:true only when your
   reasoning (not a regex) determined it's a clear disqualifier -- an
   unrelated required license, a physical-labor demand, a required
   unrelated technical skill, etc.

6. Assign a 0-100 score per job (holistic judgment of overall fit, not just
   percent-matched -- the app separately adds its own freshness bonus on
   top of this, so don't factor recency into this score) and set
   eliminated:true when a hard requirement is missing or the fit is clearly
   poor, with a one-sentence eliminatedReason.

7. Each job's "url" must be a direct link to that specific posting, not a
   general search/results page. Verify this by actually opening the URL:
   for Workday boards (myworkdayjobs.com), use the "/job/" path, not
   "/details/" -- "/details/" opens the job in a side panel on top of the
   full search-results list, which reads as a generic job board rather than
   a direct link to the role. If a site's URL scheme is unclear, open it and
   confirm the page it lands on (or auto-scrolls to) actually shows the
   specific job, not a list.

8. Write the full result as data/jobs.json, a JSON array of job objects
   with this shape:
   { "title": "", "employer": "", "location": "", "employerLocation": "",
     "remote": false, "remoteTiedTo": null,
     "estDriveMinutesFrom23185": 0, "url": "", "description": "",
     "postedDate": null, "requirements": ["..."],
     "ai": { "score": 0, "eliminated": false, "eliminatedReason": null,
             "requirements": [ { "text": "", "matched": true, "hard": false, "note": "" } ] } }
   For a LOCAL entry: "remote": false, "remoteTiedTo": null,
   "estDriveMinutesFrom23185" set to your best estimate. For a REMOTE (VA)
   entry: "remote": true, "remoteTiedTo": "VA" (or the specific tie if not
   simply Virginia), "estDriveMinutesFrom23185": null.
   requirements and ai.requirements must be the same bullets in the same
   order. If an existing entry's posting URL still returns a real, current
   listing within the freshness window and you don't have time to
   re-verify it this run, you may carry it forward unchanged; drop entries
   whose postings are gone (filled, expired, or now outside the freshness
   window) instead of guessing they're still open.

9. Only include postings you actually found on a real page. Never invent a
   job, employer, or requirement -- if you can't access a site, skip it and
   say so in your final summary rather than fabricating rows.
'@

claude -p $prompt
