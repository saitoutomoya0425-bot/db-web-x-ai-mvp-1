create table if not exists public.collection_sources (
  id uuid primary key default gen_random_uuid(),
  source text not null unique,
  query text not null,
  enabled boolean not null default true,
  since_id text,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  status text not null check(status in ('running','completed','partial','failed','rate_limited')),
  fetched_count integer not null default 0,
  accepted_count integer not null default 0,
  duplicate_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists collection_runs_source_started_idx on public.collection_runs(source, started_at desc);

alter table public.collection_sources enable row level security;
alter table public.collection_runs enable row level security;
create policy "admin collection sources" on public.collection_sources for all using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin collection runs" on public.collection_runs for select using ((auth.jwt()->'app_metadata'->>'role')='admin');

drop trigger if exists collection_sources_set_updated_at on public.collection_sources;
create trigger collection_sources_set_updated_at before update on public.collection_sources
for each row execute function public.set_updated_at();
