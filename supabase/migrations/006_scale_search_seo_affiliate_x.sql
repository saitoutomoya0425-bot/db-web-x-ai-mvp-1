create extension if not exists pg_trgm;

-- Fast lookup indexes for million-row catalogues.
create index if not exists videos_product_code_upper_idx on public.videos (upper(product_code));
create index if not exists videos_product_code_trgm_idx on public.videos using gin (product_code gin_trgm_ops);
create index if not exists videos_actress_name_trgm_idx on public.videos using gin (actress_name gin_trgm_ops);
create index if not exists videos_maker_name_trgm_idx on public.videos using gin (maker_name gin_trgm_ops);
create index if not exists videos_series_name_trgm_idx on public.videos using gin (series_name gin_trgm_ops);
create index if not exists videos_created_at_idx on public.videos (created_at desc);

create or replace function public.search_videos(
  search_query text,
  result_limit integer default 24,
  result_offset integer default 0
)
returns setof public.videos
language sql
stable
security definer
set search_path = ''
as $$
  select v.*
  from public.videos v
  where
    upper(v.product_code) = upper(trim(search_query))
    or v.product_code ilike '%' || trim(search_query) || '%'
    or v.actress_name ilike '%' || trim(search_query) || '%'
    or v.maker_name ilike '%' || trim(search_query) || '%'
    or v.series_name ilike '%' || trim(search_query) || '%'
  order by
    case when upper(v.product_code) = upper(trim(search_query)) then 0 else 1 end,
    greatest(
      public.similarity(coalesce(v.product_code, ''), trim(search_query)),
      public.similarity(coalesce(v.actress_name, ''), trim(search_query)),
      public.similarity(coalesce(v.maker_name, ''), trim(search_query)),
      public.similarity(coalesce(v.series_name, ''), trim(search_query))
    ) desc,
    v.popularity desc,
    v.created_at desc
  limit greatest(1, least(result_limit, 100))
  offset greatest(0, result_offset);
$$;

grant execute on function public.search_videos(text, integer, integer) to anon, authenticated;

drop policy if exists "public_read_videos" on public.videos;
create policy "public_read_videos" on public.videos
for select to anon, authenticated using (true);

create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  file_size bigint not null default 0,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  processed_count bigint not null default 0,
  imported_count bigint not null default 0,
  failed_count bigint not null default 0,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists import_jobs_set_updated_at on public.import_jobs;
create trigger import_jobs_set_updated_at before update on public.import_jobs
for each row execute function public.set_updated_at();

alter table public.import_jobs enable row level security;
drop policy if exists "admin_manage_own_import_jobs" on public.import_jobs;
create policy "admin_manage_own_import_jobs" on public.import_jobs
for all to authenticated
using (
  user_id = auth.uid()
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
with check (
  user_id = auth.uid()
  and (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create table if not exists public.affiliate_clicks (
  id bigint generated always as identity primary key,
  product_code text not null,
  referrer text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists affiliate_clicks_product_code_idx on public.affiliate_clicks (product_code);
create index if not exists affiliate_clicks_created_at_idx on public.affiliate_clicks (created_at desc);
alter table public.affiliate_clicks enable row level security;
drop policy if exists "public_insert_affiliate_clicks" on public.affiliate_clicks;
create policy "public_insert_affiliate_clicks" on public.affiliate_clicks
for insert to anon, authenticated with check (true);

create table if not exists public.x_reply_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  product_code text not null,
  reply_text text not null,
  source_tweet_id text,
  created_at timestamptz not null default now()
);
create index if not exists x_reply_requests_product_code_idx on public.x_reply_requests (product_code);
alter table public.x_reply_requests enable row level security;
