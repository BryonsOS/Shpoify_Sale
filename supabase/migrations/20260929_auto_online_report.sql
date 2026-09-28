-- Turn each nightly Shopify pull (dash_shopify_daily, written by bryon-dashboard-nightly)
-- into an online sales report, so the Report tab is ready to review and send.
-- Only the report cadence is used: Monday's run (Fri–Sun) and Tue–Fri runs (the prior day).
-- A report that was edited by hand or already emailed is never overwritten.

create or replace function public.sales_from_dash_shopify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if extract(isodow from new.report_date) not between 1 and 5
     or new.period_start is null or new.period_end is null
     or coalesce(new.period_label, '') like 'Sample%' then
    return new;
  end if;

  insert into public.sales_reports
    (channel, start_date, end_date, visits, total, categories,
     first_time_customers, first_time_spend, source)
  values
    ('online', new.period_start, new.period_end, new.sessions, coalesce(new.total, 0),
     jsonb_build_object('tickets', coalesce(new.tickets, 0), 'gps', coalesce(new.gps, 0),
                        'bbq', coalesce(new.bbq, 0), 'subscribers', coalesce(new.subscribers, 0),
                        'clay', coalesce(new.clay, 0)),
     new.first_time_customers, new.first_time_spend, 'shopify')
  on conflict (channel, start_date, end_date) do update set
    visits = excluded.visits,
    total = excluded.total,
    categories = excluded.categories,
    first_time_customers = excluded.first_time_customers,
    first_time_spend = excluded.first_time_spend,
    updated_at = now()
  where sales_reports.source = 'shopify' and sales_reports.sent_at is null;

  return new;
end;
$$;

revoke execute on function public.sales_from_dash_shopify() from public, anon, authenticated;

drop trigger if exists sales_from_dash_shopify on public.dash_shopify_daily;
create trigger sales_from_dash_shopify
after insert or update on public.dash_shopify_daily
for each row execute function public.sales_from_dash_shopify();
