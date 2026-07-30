-- Resumable FANZA API staging. This never publishes videos automatically.
create table if not exists public.fanza_import_jobs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references auth.users(id) on delete set null,
  data_source_id uuid not null references public.data_sources(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending','running','paused','completed','failed','cancelled')),
  keyword text,
  page_size integer not null default 50 check (page_size between 1 and 100),
  max_items integer not null default 10 check (max_items between 1 and 1000000),
  next_offset integer not null default 1 check (next_offset >= 1),
  processed_count bigint not null default 0,
  staged_count bigint not null default 0,
  unchanged_count bigint not null default 0,
  duplicate_count bigint not null default 0,
  needs_review_count bigint not null default 0,
  failed_count bigint not null default 0,
  retry_count integer not null default 0,
  dry_run boolean not null default true,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fanza_import_jobs_status_updated_idx
  on public.fanza_import_jobs(status, updated_at desc);

create table if not exists public.fanza_import_errors (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.fanza_import_jobs(id) on delete cascade,
  external_product_id text,
  original_product_code text,
  api_offset integer,
  processing_stage text not null default 'unknown'
    check (processing_stage in ('fetch','normalize','deduplicate','persist','promote','unknown')),
  error_type text not null default 'unknown',
  attempt_count integer not null default 1,
  error_code text,
  message text not null,
  raw_payload jsonb,
  retryable boolean not null default true,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists fanza_import_errors_retry_idx
  on public.fanza_import_errors(job_id, retryable, resolved_at, created_at)
  where resolved_at is null;

create table if not exists public.video_actresses (
  video_id uuid not null references public.videos(id) on delete cascade,
  actress_id uuid not null references public.actresses(id) on delete cascade,
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  primary key(video_id, actress_id)
);
create index if not exists video_actresses_actress_video_idx
  on public.video_actresses(actress_id, video_id);

alter table public.source_products
  add column if not exists import_job_id uuid references public.fanza_import_jobs(id) on delete set null,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_retry_at timestamptz;
create index if not exists source_products_job_review_idx
  on public.source_products(import_job_id, review_status, preview_status, id)
  where import_job_id is not null;
create index if not exists source_products_external_lookup_idx
  on public.source_products(data_source_id, external_product_id);

-- Public catalogue query indexes. Partial indexes stay small when staged data is unpublished.
create index if not exists videos_published_title_trgm_idx
  on public.videos using gin(title gin_trgm_ops) where is_published;
create index if not exists videos_published_code_normalized_idx
  on public.videos(lower(regexp_replace(product_code,'[^a-zA-Z0-9]','','g')))
  where is_published;
create index if not exists videos_published_series_popular_idx
  on public.videos(series_name, popularity desc, id) where is_published and series_name is not null;
create index if not exists videos_published_genre_popular_idx
  on public.videos(genre, popularity desc, id) where is_published and genre is not null;
create index if not exists search_logs_code_created_idx
  on public.search_logs(product_code, created_at desc);

create or replace function public.match_videos_for_import(
  external_ids text[],
  normalized_codes text[]
) returns setof public.videos
language sql stable security definer set search_path='' as $$
  select v.* from public.videos v
  where
    (v.external_product_id is not null and v.external_product_id = any(coalesce(external_ids, '{}'::text[])))
    or lower(regexp_replace(v.product_code,'[^a-zA-Z0-9]','','g')) = any(coalesce(normalized_codes, '{}'::text[]));
$$;
revoke all on function public.match_videos_for_import(text[],text[]) from public, anon, authenticated;
grant execute on function public.match_videos_for_import(text[],text[]) to service_role;

drop trigger if exists fanza_import_jobs_set_updated_at on public.fanza_import_jobs;
create trigger fanza_import_jobs_set_updated_at before update on public.fanza_import_jobs
for each row execute function public.set_updated_at();

alter table public.fanza_import_jobs enable row level security;
alter table public.fanza_import_errors enable row level security;
alter table public.video_actresses enable row level security;
create policy "admin manage fanza import jobs" on public.fanza_import_jobs for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin manage fanza import errors" on public.fanza_import_errors for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "public read video actresses" on public.video_actresses for select using (true);
create policy "admin manage video actresses" on public.video_actresses for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');
grant all on public.fanza_import_jobs, public.fanza_import_errors to authenticated;
grant select on public.video_actresses to anon, authenticated;
grant all on public.video_actresses to authenticated;
grant usage, select on sequence public.fanza_import_errors_id_seq to authenticated, service_role;
