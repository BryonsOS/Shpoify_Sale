"""One-time import of the old Excel workbook into the sales_* tables.

Usage: python3 scripts/import_workbook.py shopify_daily_email_template_button.xlsm > import.sql
Then run import.sql in the Supabase SQL editor. Existing periods are left alone.
"""
import datetime
import json
import re
import sys

import openpyxl

ONLINE_COLS = ["tickets", "gps", "bbq", "subscribers", "clay"]      # H..L
TRAILER_COLS = ["tshirts", "hoodies", "hats", "stickers", "tickets", "bbq"]  # H..M


def as_date(v):
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, str):
        m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", v.strip())  # e.g. the "3/9/20269" typo
        if m:
            return datetime.date(int(m[3]), int(m[1]), int(m[2]))
    return None


def num(v):
    return round(float(v), 2) if isinstance(v, (int, float)) else 0.0


def sql_str(v):
    return "null" if v is None else "'" + str(v).replace("'", "''") + "'"


def rows(ws, channel, cats):
    out = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        start = as_date(r[1])
        if start is None:
            continue
        end = as_date(r[2]) or start
        categories = {k: num(r[7 + i]) for i, k in enumerate(cats)}
        notes = r[14] if channel == "online" and len(r) > 14 else None
        visits = r[5] if isinstance(r[5], (int, float)) else None
        out.append(
            "({ch}, '{s}', '{e}', {v}, {t}, {c}::jsonb, {n}, 'excel')".format(
                ch=sql_str(channel), s=start, e=end,
                v="null" if visits is None else int(visits),
                t=num(r[6]), c=sql_str(json.dumps(categories)), n=sql_str(notes)))
    return out


def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    values = rows(wb["ONLINE_REPORT_LOG"], "online", ONLINE_COLS) + rows(wb["POS_TRAILER"], "trailer", TRAILER_COLS)
    print("insert into public.sales_reports (channel, start_date, end_date, visits, total, categories, notes, source) values")
    print(",\n".join(values))
    print("on conflict (channel, start_date, end_date) do nothing;")

    arch = wb["Event Archive"]
    name, start, end = arch["A1"].value, as_date(arch["B1"].value), as_date(arch["C1"].value)
    if name and start and end:
        print("insert into public.sales_events (name, start_date, end_date) select {n}, '{s}', '{e}' "
              "where not exists (select 1 from public.sales_events where name = {n});".format(n=sql_str(name), s=start, e=end))


if __name__ == "__main__":
    main(sys.argv[1])
