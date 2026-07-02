create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table public.actresses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) > 0),
  name_kana text,
  profile_url text,
  created_at timestamptz not null default now()
);

create table public.makers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) > 0),
  official_url text,
  created_at timestamptz not null default now()
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) > 0),
  created_at timestamptz not null default now()
);

create table public.works (
  id uuid primary key default gen_random_uuid(),
  product_code text not null unique check (char_length(trim(product_code)) > 0),
  title text not null check (char_length(trim(title)) > 0),
  actress_id uuid references public.actresses(id) on delete set null,
  maker_id uuid references public.makers(id) on delete set null,
  release_date date,
  thumbnail_url text,
  sample_url text,
  affiliate_url text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.work_tags (
  work_id uuid not null references public.works(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (work_id, tag_id)
);

create table public.search_logs (
  id uuid primary key default gen_random_uuid(),
  product_code text not null,
  source text not null default 'web',
  user_agent text,
  referrer text,
  created_at timestamptz not null default now()
);

create index works_product_code_trgm_idx on public.works using gin (product_code gin_trgm_ops);
create index works_actress_id_idx on public.works (actress_id);
create index works_maker_id_idx on public.works (maker_id);
create index works_release_date_idx on public.works (release_date desc);
create index work_tags_tag_id_idx on public.work_tags (tag_id);
create index search_logs_product_code_idx on public.search_logs (product_code);
create index search_logs_created_at_idx on public.search_logs (created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger works_set_updated_at before update on public.works
for each row execute function public.set_updated_at();

create or replace function public.get_popular_works(result_limit integer default 20)
returns table (
  product_code text,
  search_count bigint
)
language sql
security definer
set search_path = ''
stable
as $$
  select upper(sl.product_code), count(*)::bigint
  from public.search_logs sl
  group by upper(sl.product_code)
  order by count(*) desc
  limit greatest(1, least(result_limit, 100));
$$;

alter table public.actresses enable row level security;
alter table public.makers enable row level security;
alter table public.tags enable row level security;
alter table public.works enable row level security;
alter table public.work_tags enable row level security;
alter table public.search_logs enable row level security;

create policy "public_read_actresses" on public.actresses for select to anon, authenticated using (true);
create policy "public_read_makers" on public.makers for select to anon, authenticated using (true);
create policy "public_read_tags" on public.tags for select to anon, authenticated using (true);
create policy "public_read_works" on public.works for select to anon, authenticated using (true);
create policy "public_read_work_tags" on public.work_tags for select to anon, authenticated using (true);
create policy "public_insert_search_logs" on public.search_logs for insert to anon, authenticated with check (true);

create policy "authenticated_manage_actresses" on public.actresses for all to authenticated using (true) with check (true);
create policy "authenticated_manage_makers" on public.makers for all to authenticated using (true) with check (true);
create policy "authenticated_manage_tags" on public.tags for all to authenticated using (true) with check (true);
create policy "authenticated_manage_works" on public.works for all to authenticated using (true) with check (true);
create policy "authenticated_manage_work_tags" on public.work_tags for all to authenticated using (true) with check (true);
create policy "authenticated_read_search_logs" on public.search_logs for select to authenticated using (true);

grant execute on function public.get_popular_works(integer) to anon, authenticated;
