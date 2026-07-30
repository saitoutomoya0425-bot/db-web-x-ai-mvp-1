-- videos is the canonical public catalog. Legacy works/work_tags remain read-only.
create table if not exists public.series (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  maker_id uuid references public.makers(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists series_name_unique_idx on public.series(name);

create table if not exists public.genres (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists genres_name_unique_idx on public.genres(name);

create table if not exists public.video_genres (
  video_id uuid not null references public.videos(id) on delete cascade,
  genre_id uuid not null references public.genres(id) on delete cascade,
  primary key(video_id, genre_id)
);
create index if not exists video_genres_genre_video_idx on public.video_genres(genre_id, video_id);

alter table public.videos
  add column if not exists actress_id uuid references public.actresses(id) on delete set null,
  add column if not exists maker_id uuid references public.makers(id) on delete set null,
  add column if not exists series_id uuid references public.series(id) on delete set null;
create index if not exists videos_actress_id_idx on public.videos(actress_id);
create index if not exists videos_maker_id_idx on public.videos(maker_id);
create index if not exists videos_series_id_idx on public.videos(series_id);

create table if not exists public.data_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  source_type text not null check (source_type in ('api','csv','feed','manual','other')),
  priority integer not null default 100 check (priority >= 0),
  terms_note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.source_products (
  id uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources(id) on delete restrict,
  external_product_id text not null,
  product_code text,
  raw_payload jsonb not null default '{}',
  payload_hash text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(data_source_id, external_product_id)
);
create index if not exists source_products_product_code_idx on public.source_products(product_code);
create index if not exists source_products_fetched_idx on public.source_products(data_source_id, fetched_at desc);
create index if not exists source_products_payload_hash_idx on public.source_products(payload_hash) where payload_hash is not null;

create table if not exists public.product_offers (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  data_source_id uuid not null references public.data_sources(id) on delete restrict,
  external_product_id text not null,
  seller_name text not null,
  official_url text,
  affiliate_url text,
  price numeric(12,2) check (price is null or price >= 0),
  currency char(3) not null default 'JPY',
  availability_status text not null default 'unknown'
    check (availability_status in ('unknown','available','unavailable','preorder')),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(data_source_id, external_product_id)
);
create index if not exists product_offers_video_idx on public.product_offers(video_id, availability_status);
create index if not exists product_offers_check_idx on public.product_offers(data_source_id, last_checked_at);

create table if not exists public.video_source_links (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  source_product_id uuid not null references public.source_products(id) on delete cascade,
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  created_at timestamptz not null default now(),
  unique(video_id, source_product_id)
);
create index if not exists video_source_links_source_idx on public.video_source_links(source_product_id);

create table if not exists public.video_change_logs (
  id bigint generated always as identity primary key,
  video_id uuid not null references public.videos(id) on delete cascade,
  changed_fields text[] not null default '{}',
  before_data jsonb not null default '{}',
  after_data jsonb not null default '{}',
  change_source text not null default 'unknown',
  created_at timestamptz not null default now()
);
create index if not exists video_change_logs_video_created_idx on public.video_change_logs(video_id, created_at desc);

create table if not exists public.video_page_views (
  id bigint generated always as identity primary key,
  video_id uuid not null references public.videos(id) on delete cascade,
  session_id uuid,
  referrer text,
  source text not null default 'web',
  created_at timestamptz not null default now()
);
create index if not exists video_page_views_video_created_idx on public.video_page_views(video_id, created_at desc);
create index if not exists video_page_views_session_created_idx on public.video_page_views(session_id, created_at desc)
  where session_id is not null;

create table if not exists public.related_video_clicks (
  id bigint generated always as identity primary key,
  video_id uuid not null references public.videos(id) on delete cascade,
  related_video_id uuid not null references public.videos(id) on delete cascade,
  session_id uuid,
  referrer text,
  source text not null default 'related',
  created_at timestamptz not null default now(),
  check (video_id <> related_video_id)
);
create index if not exists related_video_clicks_video_created_idx on public.related_video_clicks(video_id, created_at desc);
create index if not exists related_video_clicks_target_created_idx on public.related_video_clicks(related_video_id, created_at desc);
create index if not exists related_video_clicks_session_created_idx on public.related_video_clicks(session_id, created_at desc)
  where session_id is not null;

alter table public.search_logs add column if not exists session_id uuid;
alter table public.affiliate_clicks
  add column if not exists video_id uuid references public.videos(id) on delete set null,
  add column if not exists session_id uuid,
  add column if not exists source text;
create index if not exists search_logs_session_created_idx on public.search_logs(session_id, created_at desc)
  where session_id is not null;
create index if not exists affiliate_clicks_session_created_idx on public.affiliate_clicks(session_id, created_at desc)
  where session_id is not null;

drop trigger if exists data_sources_set_updated_at on public.data_sources;
create trigger data_sources_set_updated_at before update on public.data_sources
for each row execute function public.set_updated_at();
drop trigger if exists source_products_set_updated_at on public.source_products;
create trigger source_products_set_updated_at before update on public.source_products
for each row execute function public.set_updated_at();
drop trigger if exists product_offers_set_updated_at on public.product_offers;
create trigger product_offers_set_updated_at before update on public.product_offers
for each row execute function public.set_updated_at();

alter table public.series enable row level security;
alter table public.genres enable row level security;
alter table public.video_genres enable row level security;
alter table public.data_sources enable row level security;
alter table public.source_products enable row level security;
alter table public.product_offers enable row level security;
alter table public.video_source_links enable row level security;
alter table public.video_change_logs enable row level security;
alter table public.video_page_views enable row level security;
alter table public.related_video_clicks enable row level security;

create policy "public read series" on public.series for select using (true);
create policy "public read genres" on public.genres for select using (true);
create policy "public read video genres" on public.video_genres for select using (true);
create policy "public read active sources" on public.data_sources for select using (is_active);
create policy "public read offers" on public.product_offers for select using (true);
create policy "public insert video views" on public.video_page_views for insert to anon, authenticated with check (true);
create policy "public insert related clicks" on public.related_video_clicks for insert to anon, authenticated with check (true);

create policy "admin manage series" on public.series for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin manage genres" on public.genres for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin manage video genres" on public.video_genres for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin manage data sources" on public.data_sources for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin manage source products" on public.source_products for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin manage offers" on public.product_offers for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin manage video source links" on public.video_source_links for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin read video changes" on public.video_change_logs for select
  using ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin read video views" on public.video_page_views for select
  using ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin read related clicks" on public.related_video_clicks for select
  using ((auth.jwt()->'app_metadata'->>'role')='admin');

grant select on public.series, public.genres, public.video_genres, public.data_sources, public.product_offers to anon, authenticated;
grant insert on public.video_page_views, public.related_video_clicks to anon, authenticated;
grant all on public.series, public.genres, public.video_genres, public.data_sources, public.source_products,
  public.product_offers, public.video_source_links to authenticated;
grant select on public.video_change_logs, public.video_page_views, public.related_video_clicks to authenticated;
grant usage, select on sequence public.video_change_logs_id_seq to authenticated, service_role;
grant usage, select on sequence public.video_page_views_id_seq to anon, authenticated, service_role;
grant usage, select on sequence public.related_video_clicks_id_seq to anon, authenticated, service_role;

-- Backfill dimensions and relation IDs without changing public catalog values.
insert into public.actresses(name)
select distinct trim(actress_name) from public.videos
where actress_name is not null and trim(actress_name) <> ''
on conflict(name) do nothing;
insert into public.makers(name)
select distinct trim(maker_name) from public.videos
where maker_name is not null and trim(maker_name) <> ''
on conflict(name) do nothing;
insert into public.series(name, maker_id)
select distinct on (trim(v.series_name)) trim(v.series_name), m.id
from public.videos v left join public.makers m on m.name = trim(v.maker_name)
where v.series_name is not null and trim(v.series_name) <> ''
order by trim(v.series_name), m.id nulls last
on conflict(name) do update set maker_id = coalesce(public.series.maker_id, excluded.maker_id);
insert into public.genres(name)
select distinct trim(genre) from public.videos
where genre is not null and trim(genre) <> ''
on conflict(name) do nothing;

update public.videos v set actress_id = a.id
from public.actresses a
where a.name = v.actress_name and v.actress_id is distinct from a.id;
update public.videos v set maker_id = m.id
from public.makers m
where m.name = v.maker_name and v.maker_id is distinct from m.id;
update public.videos v set series_id = s.id
from public.series s
where s.name = v.series_name and v.series_id is distinct from s.id;
insert into public.video_genres(video_id, genre_id)
select v.id, g.id from public.videos v join public.genres g on g.name = trim(v.genre)
where v.genre is not null and trim(v.genre) <> ''
on conflict do nothing;
