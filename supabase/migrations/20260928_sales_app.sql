-- Sick Sales app: daily online + merch trailer reports, events, settings.
-- Same security model as the dashboard: RLS on, no policies, so the tables are
-- unreachable with the public key. Every read/write goes through a
-- SECURITY DEFINER function that checks the PIN first (5 misses = 15 min lock).

create table if not exists public.sales_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_auth (
  id           int primary key default 1 check (id = 1),
  fails        int not null default 0,
  locked_until timestamptz
);
insert into public.sales_auth (id) values (1) on conflict do nothing;

create table if not exists public.sales_reports (
  id                   bigint generated always as identity primary key,
  channel              text not null check (channel in ('online', 'trailer')),
  start_date           date not null,
  end_date             date not null,
  visits               int,
  total                numeric(12,2) not null default 0,
  categories           jsonb not null default '{}'::jsonb,
  first_time_customers int,
  first_time_spend     numeric(12,2),
  notes                text,
  source               text not null default 'manual',
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint sales_reports_range check (end_date >= start_date),
  constraint sales_reports_period_key unique (channel, start_date, end_date)
);
create index if not exists sales_reports_end_idx on public.sales_reports (end_date);

create table if not exists public.sales_events (
  id         bigint generated always as identity primary key,
  name       text not null,
  start_date date not null,
  end_date   date not null,
  notes      text,
  created_at timestamptz not null default now(),
  constraint sales_events_range check (end_date >= start_date)
);

alter table public.sales_config  enable row level security;
alter table public.sales_auth    enable row level security;
alter table public.sales_reports enable row level security;
alter table public.sales_events  enable row level security;
revoke all on public.sales_config, public.sales_auth, public.sales_reports, public.sales_events from anon, authenticated;

-- Channel setup: category columns, email recipients and wording. Editable in the app.
insert into public.sales_config (key, value) values ('channels', $json$
{
  "online": {
    "label": "Online",
    "visits_label": "Number of Visits",
    "categories": [
      {"key": "tickets",     "label": "Tickets"},
      {"key": "gps",         "label": "GPS"},
      {"key": "bbq",         "label": "BBQ"},
      {"key": "subscribers", "label": "Subscribers"},
      {"key": "clay",        "label": "Clay"}
    ],
    "email_order": ["visits", "tickets", "gps", "bbq", "subscribers", "other", "clay", "total"],
    "to": "tom@sickthemagazine.com",
    "cc": "jenna@sickthemagazine.com; lexi@sickthemagazine.com",
    "subject_prefix": "Daily Shopify Report — "
  },
  "trailer": {
    "label": "Trailer",
    "visits_label": "Orders",
    "categories": [
      {"key": "tshirts",  "label": "T-Shirts"},
      {"key": "hoodies",  "label": "Hoodies"},
      {"key": "hats",     "label": "Hats"},
      {"key": "stickers", "label": "Stickers"},
      {"key": "tickets",  "label": "Tickets"},
      {"key": "bbq",      "label": "BBQ"}
    ],
    "email_order": ["visits", "tshirts", "hoodies", "hats", "stickers", "tickets", "bbq", "other", "total"],
    "to": "tom@sickthemagazine.com",
    "cc": "jenna@sickthemagazine.com; lexi@sickthemagazine.com",
    "subject_prefix": "Merch Trailer Report — "
  }
}
$json$::jsonb)
on conflict (key) do nothing;

-- Start with the dashboard's PIN so there is nothing new to remember; change it in Settings.
insert into public.sales_config (key, value)
select 'pin_hash', value from public.dash_config where key = 'dash_pin_hash'
on conflict (key) do nothing;

------------------------------------------------------------------------------
-- Auth
------------------------------------------------------------------------------
create or replace function public.sales_auth_guard(p_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text; v_fails int; v_locked timestamptz;
  c_limit constant int := 5;
  c_lock  constant interval := '15 minutes';
begin
  select value #>> '{}' into v_hash from public.sales_config where key = 'pin_hash';
  select fails, locked_until into v_fails, v_locked from public.sales_auth where id = 1 for update;

  if v_locked is not null and v_locked > now() then
    return 'locked';
  end if;

  if v_hash is not null and p_pin is not null and extensions.crypt(p_pin, v_hash) = v_hash then
    update public.sales_auth set fails = 0, locked_until = null where id = 1;
    return 'ok';
  end if;

  v_fails := coalesce(v_fails, 0) + 1;
  if v_fails >= c_limit then
    update public.sales_auth set fails = 0, locked_until = now() + c_lock where id = 1;
    return 'locked';
  end if;
  update public.sales_auth set fails = v_fails, locked_until = null where id = 1;
  return 'bad';
end;
$$;

create or replace function public.sales_change_pin(p_pin text, p_new_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_state text;
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return v_state; end if;
  if p_new_pin is null or length(p_new_pin) < 4 then return 'too_short'; end if;
  update public.sales_config
     set value = to_jsonb(extensions.crypt(p_new_pin, extensions.gen_salt('bf'))), updated_at = now()
   where key = 'pin_hash';
  return 'ok';
end;
$$;

------------------------------------------------------------------------------
-- Read everything the app needs in one call (a few hundred rows a year).
------------------------------------------------------------------------------
create or replace function public.sales_payload(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_state text;
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return jsonb_build_object('state', v_state); end if;

  return jsonb_build_object(
    'state', 'ok',
    'channels', (select value from public.sales_config where key = 'channels'),
    'reports', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.end_date desc, r.channel)
      from public.sales_reports r), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.start_date desc)
      from public.sales_events e), '[]'::jsonb)
  );
end;
$$;

------------------------------------------------------------------------------
-- Reports
------------------------------------------------------------------------------
create or replace function public.sales_save_report(p_pin text, p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
  v_id bigint := nullif(p_row->>'id', '')::bigint;
  v_start date := (p_row->>'start_date')::date;
  v_end date := coalesce(nullif(p_row->>'end_date', '')::date, (p_row->>'start_date')::date);
  v_clash bigint;
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return jsonb_build_object('state', v_state); end if;
  if coalesce(p_row->>'channel', '') not in ('online', 'trailer') or v_start is null or v_end < v_start then
    return jsonb_build_object('state', 'invalid');
  end if;

  select id into v_clash from public.sales_reports
   where channel = p_row->>'channel' and start_date = v_start and end_date = v_end
     and id is distinct from v_id;
  if v_clash is not null then
    return jsonb_build_object('state', 'duplicate', 'id', v_clash);
  end if;

  if v_id is null then
    insert into public.sales_reports
      (channel, start_date, end_date, visits, total, categories,
       first_time_customers, first_time_spend, notes, source)
    values
      (p_row->>'channel', v_start, v_end,
       nullif(p_row->>'visits', '')::int,
       coalesce(nullif(p_row->>'total', '')::numeric, 0),
       coalesce(p_row->'categories', '{}'::jsonb),
       nullif(p_row->>'first_time_customers', '')::int,
       nullif(p_row->>'first_time_spend', '')::numeric,
       nullif(p_row->>'notes', ''),
       coalesce(nullif(p_row->>'source', ''), 'manual'))
    returning id into v_id;
  else
    update public.sales_reports set
      channel = p_row->>'channel', start_date = v_start, end_date = v_end,
      visits = nullif(p_row->>'visits', '')::int,
      total = coalesce(nullif(p_row->>'total', '')::numeric, 0),
      categories = coalesce(p_row->'categories', '{}'::jsonb),
      first_time_customers = nullif(p_row->>'first_time_customers', '')::int,
      first_time_spend = nullif(p_row->>'first_time_spend', '')::numeric,
      notes = nullif(p_row->>'notes', ''),
      source = coalesce(nullif(p_row->>'source', ''), source),
      updated_at = now()
    where id = v_id;
    if not found then return jsonb_build_object('state', 'not_found'); end if;
  end if;

  return jsonb_build_object('state', 'ok', 'id', v_id);
end;
$$;

create or replace function public.sales_delete_report(p_pin text, p_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_state text;
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return v_state; end if;
  delete from public.sales_reports where id = p_id;
  return case when found then 'ok' else 'not_found' end;
end;
$$;

create or replace function public.sales_mark_sent(p_pin text, p_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_state text;
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return v_state; end if;
  update public.sales_reports set sent_at = now() where id = p_id;
  return case when found then 'ok' else 'not_found' end;
end;
$$;

------------------------------------------------------------------------------
-- Shopify numbers, read from the dashboard's nightly pull (dash_shopify_daily).
-- An exact period match wins (the Monday row already covers Fri–Sun); otherwise
-- single-day rows are summed, but only if every day in the range is present.
------------------------------------------------------------------------------
create or replace function public.sales_shopify_lookup(p_pin text, p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
  v_row public.dash_shopify_daily;
  v_days int;
  v_out jsonb;
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return jsonb_build_object('state', v_state); end if;
  if p_start is null or p_end is null or p_end < p_start then
    return jsonb_build_object('state', 'invalid');
  end if;

  select * into v_row from public.dash_shopify_daily
   where period_start = p_start and period_end = p_end
   order by fetched_at desc limit 1;

  if found then
    return jsonb_build_object(
      'state', 'ok', 'found', true, 'label', v_row.period_label, 'fetched_at', v_row.fetched_at,
      'visits', v_row.sessions, 'total', v_row.total,
      'categories', jsonb_build_object('tickets', v_row.tickets, 'gps', v_row.gps, 'bbq', v_row.bbq,
                                       'subscribers', v_row.subscribers, 'clay', v_row.clay),
      'first_time_customers', v_row.first_time_customers, 'first_time_spend', v_row.first_time_spend);
  end if;

  with singles as (
    select distinct on (period_start) *
      from public.dash_shopify_daily
     where period_start = period_end and period_start between p_start and p_end
     order by period_start, fetched_at desc)
  select count(*),
         jsonb_build_object(
           'state', 'ok', 'found', true,
           'label', 'Summed ' || count(*) || ' daily pulls', 'fetched_at', max(fetched_at),
           'visits', case when bool_and(sessions is not null) then sum(sessions) end,
           'total', sum(total),
           'categories', jsonb_build_object('tickets', sum(tickets), 'gps', sum(gps), 'bbq', sum(bbq),
                                            'subscribers', sum(subscribers), 'clay', sum(clay)),
           'first_time_customers', sum(first_time_customers),
           'first_time_spend', sum(first_time_spend))
    into v_days, v_out
    from singles;

  if v_days = (p_end - p_start + 1) then
    return v_out;
  end if;
  return jsonb_build_object('state', 'ok', 'found', false);
end;
$$;

------------------------------------------------------------------------------
-- Events and settings
------------------------------------------------------------------------------
create or replace function public.sales_save_event(p_pin text, p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
  v_id bigint := nullif(p_row->>'id', '')::bigint;
  v_name text := nullif(trim(p_row->>'name'), '');
  v_start date := (p_row->>'start_date')::date;
  v_end date := coalesce(nullif(p_row->>'end_date', '')::date, (p_row->>'start_date')::date);
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return jsonb_build_object('state', v_state); end if;
  if v_name is null or v_start is null or v_end < v_start then
    return jsonb_build_object('state', 'invalid');
  end if;

  if v_id is null then
    insert into public.sales_events (name, start_date, end_date, notes)
    values (v_name, v_start, v_end, nullif(p_row->>'notes', ''))
    returning id into v_id;
  else
    update public.sales_events
       set name = v_name, start_date = v_start, end_date = v_end, notes = nullif(p_row->>'notes', '')
     where id = v_id;
    if not found then return jsonb_build_object('state', 'not_found'); end if;
  end if;
  return jsonb_build_object('state', 'ok', 'id', v_id);
end;
$$;

create or replace function public.sales_delete_event(p_pin text, p_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_state text;
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return v_state; end if;
  delete from public.sales_events where id = p_id;
  return case when found then 'ok' else 'not_found' end;
end;
$$;

create or replace function public.sales_save_channels(p_pin text, p_channels jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_state text;
begin
  v_state := public.sales_auth_guard(p_pin);
  if v_state <> 'ok' then return v_state; end if;
  if jsonb_typeof(p_channels->'online') <> 'object' or jsonb_typeof(p_channels->'trailer') <> 'object' then
    return 'invalid';
  end if;
  update public.sales_config set value = p_channels, updated_at = now() where key = 'channels';
  return 'ok';
end;
$$;

-- Only the RPCs are callable from the browser.
revoke all on function
  public.sales_auth_guard(text),
  public.sales_change_pin(text, text),
  public.sales_payload(text),
  public.sales_save_report(text, jsonb),
  public.sales_delete_report(text, bigint),
  public.sales_mark_sent(text, bigint),
  public.sales_shopify_lookup(text, date, date),
  public.sales_save_event(text, jsonb),
  public.sales_delete_event(text, bigint),
  public.sales_save_channels(text, jsonb)
from public;

grant execute on function
  public.sales_change_pin(text, text),
  public.sales_payload(text),
  public.sales_save_report(text, jsonb),
  public.sales_delete_report(text, bigint),
  public.sales_mark_sent(text, bigint),
  public.sales_shopify_lookup(text, date, date),
  public.sales_save_event(text, jsonb),
  public.sales_delete_event(text, bigint),
  public.sales_save_channels(text, jsonb)
to anon, authenticated;

-- Supabase grants anon execute on new functions by default; the guard is internal only.
revoke execute on function public.sales_auth_guard(text) from anon, authenticated;
