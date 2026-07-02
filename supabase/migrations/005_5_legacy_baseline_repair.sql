create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=now();return new;end $$;

create table if not exists public.actresses(
  id uuid primary key default gen_random_uuid(),name text not null unique,name_kana text,profile_url text,created_at timestamptz not null default now()
);
create table if not exists public.makers(
  id uuid primary key default gen_random_uuid(),name text not null unique,official_url text,created_at timestamptz not null default now()
);
alter table public.actresses add column if not exists name_kana text,add column if not exists profile_url text,add column if not exists created_at timestamptz not null default now();
alter table public.makers add column if not exists official_url text,add column if not exists created_at timestamptz not null default now();
create table if not exists public.tags(
  id uuid primary key default gen_random_uuid(),name text not null unique,created_at timestamptz not null default now()
);
create table if not exists public.works(
  id uuid primary key default gen_random_uuid(),product_code text not null unique,title text not null,
  actress_id uuid references public.actresses(id) on delete set null,maker_id uuid references public.makers(id) on delete set null,
  release_date date,thumbnail_url text,sample_url text,affiliate_url text,description text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.work_tags(
  work_id uuid not null references public.works(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,primary key(work_id,tag_id)
);
create table if not exists public.search_logs(
  id uuid primary key default gen_random_uuid(),product_code text not null,source text not null default 'web',
  user_agent text,referrer text,created_at timestamptz not null default now()
);
alter table public.search_logs add column if not exists source text not null default 'web',add column if not exists user_agent text,
  add column if not exists referrer text,add column if not exists created_at timestamptz not null default now();
create table if not exists public.videos(
  id uuid primary key default gen_random_uuid(),product_code text not null unique,title text not null,
  actress_name text,maker_name text,series_name text,label_name text,genre text,duration integer,release_date date,
  sample_images text[] not null default '{}',thumbnail_url text,video_url text,affiliate_url text,description text,
  popularity integer not null default 0,favorite_count integer not null default 0,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
alter table public.videos
  add column if not exists series_name text,add column if not exists label_name text,add column if not exists genre text,
  add column if not exists duration integer,add column if not exists release_date date,
  add column if not exists sample_images text[] not null default '{}',add column if not exists thumbnail_url text,
  add column if not exists video_url text,add column if not exists affiliate_url text,add column if not exists description text,
  add column if not exists popularity integer not null default 0,add column if not exists favorite_count integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),add column if not exists updated_at timestamptz not null default now();

drop trigger if exists videos_set_updated_at on public.videos;
create trigger videos_set_updated_at before update on public.videos for each row execute function public.set_updated_at();
drop trigger if exists works_set_updated_at on public.works;
create trigger works_set_updated_at before update on public.works for each row execute function public.set_updated_at();

alter table public.actresses enable row level security;
alter table public.makers enable row level security;
alter table public.tags enable row level security;
alter table public.works enable row level security;
alter table public.work_tags enable row level security;
alter table public.search_logs enable row level security;
alter table public.videos enable row level security;
drop policy if exists "public_read_actresses" on public.actresses;
create policy "public_read_actresses" on public.actresses for select to anon,authenticated using(true);
drop policy if exists "public_read_makers" on public.makers;
create policy "public_read_makers" on public.makers for select to anon,authenticated using(true);
drop policy if exists "public_read_tags" on public.tags;
create policy "public_read_tags" on public.tags for select to anon,authenticated using(true);
drop policy if exists "public_read_works" on public.works;
create policy "public_read_works" on public.works for select to anon,authenticated using(true);
drop policy if exists "public_read_work_tags" on public.work_tags;
create policy "public_read_work_tags" on public.work_tags for select to anon,authenticated using(true);
drop policy if exists "public_insert_search_logs" on public.search_logs;
create policy "public_insert_search_logs" on public.search_logs for insert to anon,authenticated with check(true);
drop policy if exists "authenticated_read_search_logs" on public.search_logs;
create policy "authenticated_read_search_logs" on public.search_logs for select to authenticated using(true);
drop policy if exists "public_read_videos" on public.videos;
create policy "public_read_videos" on public.videos for select to anon,authenticated using(true);
drop policy if exists "admin_manage_videos" on public.videos;
create policy "admin_manage_videos" on public.videos for all to authenticated
  using((auth.jwt()->'app_metadata'->>'role')='admin') with check((auth.jwt()->'app_metadata'->>'role')='admin');

create index if not exists search_logs_product_code_idx on public.search_logs(product_code);
create index if not exists search_logs_created_at_idx on public.search_logs(created_at desc);
create index if not exists videos_product_code_idx on public.videos(product_code);
