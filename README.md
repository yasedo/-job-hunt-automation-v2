# YSD Job Hunt Automation v2

Automated job discovery pipeline for the **Job Hunt OS** Airtable base.

## What it does

Every 6 hours, GitHub Actions runs `src/collector.mjs` and:

1. Reads active companies from Airtable `Company Watchlist`.
2. Collects public postings from supported ATS boards:
   - Lever
   - Greenhouse
   - Ashby
   - SmartRecruiters
3. Keeps broad-fit opportunities: Turkey, remote/EMEA/worldwide, internships, working-student/early-career roles, and relevant engineering/operations/product/sales/marketing/support/data roles.
4. Scores and classifies each opening.
5. Deduplicates by ATS job key and normalized posting URL.
6. Creates new records in `Jobs` and refreshes `Last Checked` on known openings.
7. Writes an audit record to `Collection Runs`.

The collector intentionally does **not** auto-submit applications. `Application Queue` remains a separate execution layer so a discovered job cannot accidentally become an application.

## Required GitHub secret

Create one repository Actions secret:

- `AIRTABLE_TOKEN` — Airtable personal access token with record read/write access to the **Job Hunt OS** base.

The base ID is already configured as `appzNZgfYlDQnSZqG` in the workflow. Do not commit an Airtable token to this repository.

## Run it manually

Open **Actions → Job Hunt Collector → Run workflow**.

- `dry_run = true`: reads Airtable + ATS feeds, but does not write Airtable records.
- `dry_run = false`: normal collection run.

## Schedule

`.github/workflows/job-hunt.yml` runs at minute 17 every 6 hours (UTC). GitHub Actions schedules can be delayed slightly during platform load.

## Current scope

The first automated layer handles public ATS feeds. Companies in the watchlist whose ATS is `Other` (for example custom career portals) are deliberately not scraped by this collector yet; they will be added through dedicated adapters or a separate discovery layer rather than unreliable generic HTML scraping.
