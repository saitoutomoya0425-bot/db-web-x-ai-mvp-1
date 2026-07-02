alter table public.affiliate_clicks
  add column if not exists store text,
  add column if not exists destination_url text;

create index if not exists affiliate_clicks_store_created_idx
  on public.affiliate_clicks (store, created_at desc);
