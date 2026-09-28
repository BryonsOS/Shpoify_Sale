# Sick Sales

A small web app that replaces `shopify_daily_email_template_button.xlsm`, the workbook used for the daily
Shopify (online) and merch trailer (POS) sales emails.

## What it does

| Tab | Replaces | What it does |
|---|---|---|
| **Report** | `ONLINE_REPORT_LOG`, `POS_TRAILER`, both BOSS_VIEW sheets, the email macro | Enter one day or a Fri–Sun weekend. **Pull from Shopify** fills the online numbers from the dashboard's nightly pull. Other is worked out for you and flagged if negative. The email preview updates live; **Save & email** opens it in your mail app with To/CC/subject filled in. |
| **Log** | the log sheets | Every report, newest first, with OK / Check / Emailed badges. Tap one to edit or delete it. |
| **Totals** | `ONLINE_WEEKLY_CONTROL` / `ONLINE_WEEKLY_SUMMARY` | Any date range (this week, last month, year to date…) for either channel, with a summary email. Warns when days in the range have no report. |
| **Events** | `Event Archive` | Name an event and its dates; trailer and online totals are calculated from the reports, nothing to copy by hand. |
| **Settings** | cells B3/B4 | Recipients, subject line, category names and order, PIN. |

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
- The schema is in `supabase/migrations/20260928_sales_app.sql`.

## History

`scripts/import_workbook.py` produced the one-time import of the spreadsheet: 61 online reports
(Jan 26 – Apr 20, 2026), 8 trailer reports, and the Sick Week 2026 event. Online reports from Aug 14, 2026
onward were backfilled from the nightly Shopify pulls (source `shopify` in the Log). Apr 21 – Aug 13 has
no data yet; add those days on the Report tab (Pull from Shopify won't have them) if you need them for totals.

## Running locally

```
cd site && python3 -m http.server 8000
```
Then open http://localhost:8000. It talks to the live database.
