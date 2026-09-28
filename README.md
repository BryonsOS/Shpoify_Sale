# Sick Sales

A small web app that replaces `shopify_daily_email_template_button.xlsm`, the workbook used for the daily
Shopify (online) and merch trailer (POS) sales emails.

## What it does

| Screen | What it's for |
|---|---|
| **Today** | Opens here. The morning online report with its change vs last week and the 4-week average, **Review & send** / **Send as is**, reports not emailed yet, the live or upcoming event, headline tiles and a 12-week chart. |
| **Report** | Enter or edit one day or a Fri–Sun weekend. **Pull from Shopify**, Other worked out for you, a live "vs last week" line, and an email preview with **Open in email**, **Copy for Gmail** (keeps a table layout) and an optional "vs last week" note. During an event, trailer days show the matching day from last year's event next to each category. |
| **Log** | Every report, filterable by channel, month, "Not emailed" and "Needs check", with a CSV download. |
| **Totals** | Any date range: tiles (vs the previous period and the same dates last year), a stacked chart by report or by week, category mix, breakdown table and a summary email. |
| **Events** | Event list, plus **event mode**: a day-by-day strip to enter trailer days, totals vs a comparison event (same name with a different year is picked automatically), a category comparison chart and an event summary email. |
| **Settings** | Channel names, recipients, subject line, categories, PIN, and how to add the app to your phone's home screen. |

## How it's built

- `site/` is a static site (plain HTML/CSS/JS, no build step), deployed on Netlify (`netlify.toml`).
- Data lives in the Supabase project `mhktyejanikvdnjbndgi` in the `sales_reports`, `sales_events`,
  `sales_config` and `sales_auth` tables. They have RLS on and no policies, so the public key can't read
  them directly. The browser only calls the `sales_*` functions, and every one checks the PIN first
  (5 wrong tries locks it for 15 minutes). This is the same pattern as the dashboard.
- The PIN starts out the same as the dashboard PIN. Change it under Settings.
- **Pull from Shopify** reads `dash_shopify_daily`, which the `bryon-dashboard-nightly` job fills each
  morning using the same rules as the `sick-daily-merch-report` skill (EDT cutoff, POS excluded, Monday = Fri–Sun).
  An exact date match is used first; otherwise single-day pulls are added up if every day is there.
- **Online reports create themselves.** A trigger on `dash_shopify_daily` turns each weekday nightly pull
  (Monday = Fri–Sun, Tue–Fri = the day before) into an online report, so each morning you just open the
  Report tab, check the numbers and hit Save & email. A report you've edited by hand or already emailed is
  never overwritten. Trailer (POS) reports are still entered by hand, since the trailer only runs at events.
- The schema is in `supabase/migrations/`.

## History

`scripts/import_workbook.py` produced the one-time import of the spreadsheet: 61 online reports
(Jan 26 – Apr 20, 2026), 8 trailer reports, and the Sick Week 2026 event. Trailer reports from May 28 – Sep 27, 2026
were added later from a newer copy of the sheet (19 trailer reports in total). Online reports from Aug 14, 2026
onward were backfilled from the nightly Shopify pulls (source `shopify` in the Log). Apr 21 – Aug 13 has
no data yet; add those days on the Report tab (Pull from Shopify won't have them) if you need them for totals.

## Running locally

```
cd site && python3 -m http.server 8000
```
Then open http://localhost:8000. It talks to the live database.
