-- 旧MVPを適用済みの環境を、新しい公開作品サイト用スキーマへ移行する。
alter table public.works add column if not exists actress_id uuid references public.actresses(id) on delete set null;
alter table public.works add column if not exists sample_url text;
alter table public.works add column if not exists affiliate_url text;

do $$
begin
  if to_regclass('public.work_actresses') is not null then
    execute 'update public.works w
      set actress_id = wa.actress_id
      from (
        select distinct on (work_id) work_id, actress_id
        from public.work_actresses
        order by work_id, actress_id
      ) wa
      where w.id = wa.work_id and w.actress_id is null';
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'works' and column_name = 'video_url'
  ) then
    execute 'update public.works set sample_url = video_url
      where sample_url is null and video_url is not null';
  end if;
end $$;

create table if not exists public.search_logs (
  id uuid primary key default gen_random_uuid(),
  product_code text not null,
  source text not null default 'web',
  user_agent text,
  referrer text,
  created_at timestamptz not null default now()
);

create index if not exists works_actress_id_idx on public.works (actress_id);
create index if not exists search_logs_product_code_idx on public.search_logs (product_code);
create index if not exists search_logs_created_at_idx on public.search_logs (created_at desc);

alter table public.search_logs enable row level security;

drop policy if exists "public_read_actresses" on public.actresses;
drop policy if exists "public_read_makers" on public.makers;
drop policy if exists "public_read_tags" on public.tags;
drop policy if exists "public_read_works" on public.works;
drop policy if exists "public_read_work_tags" on public.work_tags;
drop policy if exists "public_insert_search_logs" on public.search_logs;
drop policy if exists "authenticated_read_search_logs" on public.search_logs;

create policy "public_read_actresses" on public.actresses for select to anon, authenticated using (true);
create policy "public_read_makers" on public.makers for select to anon, authenticated using (true);
create policy "public_read_tags" on public.tags for select to anon, authenticated using (true);
create policy "public_read_works" on public.works for select to anon, authenticated using (true);
create policy "public_read_work_tags" on public.work_tags for select to anon, authenticated using (true);
create policy "public_insert_search_logs" on public.search_logs for insert to anon, authenticated with check (true);
create policy "authenticated_read_search_logs" on public.search_logs for select to authenticated using (true);

create or replace function public.get_popular_works(result_limit integer default 20)
returns table (product_code text, search_count bigint)
language sql security definer set search_path = '' stable
as $$
  select upper(sl.product_code), count(*)::bigint
  from public.search_logs sl
  group by upper(sl.product_code)
  order by count(*) desc
  limit greatest(1, least(result_limit, 100));
$$;

grant execute on function public.get_popular_works(integer) to anon, authenticated;
