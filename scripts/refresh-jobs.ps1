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

1. Read data/resume-profile.json for the candidate's skills, tools, and hard disqualifiers.
2. Find real, current job postings from employers within about a 20-minute
   drive of ZIP 23185 (Williamsburg, VA) -- desk/office professional roles
   only (program/project/product management, partner/alliance management,
   business development, GTM/sales enablement, marketing, operations,
   consulting) -- using WebSearch/WebFetch and, if needed, the
   claude-in-chrome browser tools for JS-heavy career sites (open Chrome
   first if it isn't running).
3. For each posting, extract the verbatim Requirements/Qualifications
   section as an array of individual bullet strings -- not the job duties
   or perks sections.
4. For each requirement bullet, actually read and reason about whether it
   is satisfied by the resume profile: distinguish a true qualification
   requirement from a "nice to have," and distinguish job duties from
   requirements. Set matched:true/false, and hard:true only when your
   reasoning (not a regex) determined it's a clear disqualifier -- an
   unrelated required license, a physical-labor demand, a required
   unrelated technical skill, etc.
5. Assign a 0-100 score per job (holistic judgment of overall fit, not just
   percent-matched) and set eliminated:true when a hard requirement is
   missing or the fit is clearly poor, with a one-sentence eliminatedReason.
6. Write the full result as data/jobs.json, a JSON array of job objects
   with this shape:
   { "title": "", "employer": "", "location": "", "employerLocation": "",
     "estDriveMinutesFrom23185": 0, "url": "", "description": "",
     "postedDate": null, "requirements": ["..."],
     "ai": { "score": 0, "eliminated": false, "eliminatedReason": null,
             "requirements": [ { "text": "", "matched": true, "hard": false, "note": "" } ] } }
   requirements and ai.requirements must be the same bullets in the same
   order. If an existing entry's posting URL still returns a real, current
   listing and you don't have time to re-verify it this run, you may carry
   it forward unchanged; drop entries whose postings are gone (filled or
   expired) instead of guessing they're still open.
7. Only include postings you actually found on a real page. Never invent a
   job, employer, or requirement -- if you can't access a site, skip it and
   say so in your final summary rather than fabricating rows.
'@

claude -p $prompt
