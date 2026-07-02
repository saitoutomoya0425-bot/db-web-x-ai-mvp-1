create extension if not exists pg_trgm;

create table if not exists public.source_items (
  id bigint generated always as identity primary key,
  source text not null,
  source_key text not null,
  source_url text,
  observed_at timestamptz not null default now(),
  product_code text,
  title text,
  actress_name text,
  maker_name text,
  series_name text,
  tags text[] not null default '{}',
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','promoted','ignored','error')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, source_key)
);
create index if not exists source_items_status_observed_idx on public.source_items(status, observed_at desc);
create index if not exists source_items_product_code_idx on public.source_items(product_code);
create index if not exists source_items_actress_trgm_idx on public.source_items using gin(actress_name gin_trgm_ops);

create table if not exists public.video_tags (
  video_id uuid not null references public.videos(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key(video_id, tag_id)
);
create index if not exists video_tags_tag_video_idx on public.video_tags(tag_id, video_id);

create table if not exists public.discovery_metrics (
  entity_type text not null check(entity_type in ('work','actress','maker','series','tag','keyword')),
  entity_key text not null,
  period text not null check(period in ('day','week','month','all')),
  views bigint not null default 0,
  searches bigint not null default 0,
  clicks bigint not null default 0,
  score numeric not null default 0,
  rank integer,
  metadata jsonb not null default '{}',
  calculated_at timestamptz not null default now(),
  primary key(entity_type, entity_key, period)
);
create index if not exists discovery_metrics_lookup_idx on public.discovery_metrics(entity_type, period, rank) include(entity_key, score, views, searches, clicks);

alter table public.source_items enable row level security;
alter table public.video_tags enable row level security;
alter table public.discovery_metrics enable row level security;
create policy "public read video tags" on public.video_tags for select using (true);
create policy "public read discovery metrics" on public.discovery_metrics for select using (true);
create policy "admin source items" on public.source_items for all using ((auth.jwt()->'app_metadata'->>'role') = 'admin') with check ((auth.jwt()->'app_metadata'->>'role') = 'admin');
create policy "admin video tags" on public.video_tags for all using ((auth.jwt()->'app_metadata'->>'role') = 'admin') with check ((auth.jwt()->'app_metadata'->>'role') = 'admin');
create policy "admin metrics" on public.discovery_metrics for all using ((auth.jwt()->'app_metadata'->>'role') = 'admin') with check ((auth.jwt()->'app_metadata'->>'role') = 'admin');

create or replace function public.refresh_discovery_metrics()
returns void language plpgsql security definer set search_path=public as $$
declare p text; cutoff timestamptz;
begin
  if auth.role() <> 'service_role' and coalesce(auth.jwt()->'app_metadata'->>'role','') <> 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  foreach p in array array['day','week','month','all'] loop
    cutoff := case p when 'day' then now()-interval '1 day' when 'week' then now()-interval '7 days' when 'month' then now()-interval '30 days' else '-infinity'::timestamptz end;
    delete from discovery_metrics where period=p;

    insert into discovery_metrics(entity_type,entity_key,period,searches,score,rank)
    select 'work', product_code, p, searches, searches,
      row_number() over(order by searches desc, product_code)
    from (select upper(product_code) product_code,count(*) searches from search_logs where created_at>=cutoff group by 1) s;

    insert into discovery_metrics(entity_type,entity_key,period,clicks,score,rank)
    select 'work', upper(product_code), p, count(*), count(*)*2,
      row_number() over(order by count(*) desc, upper(product_code))
    from affiliate_clicks where created_at>=cutoff group by upper(product_code)
    on conflict(entity_type,entity_key,period) do update set
      clicks=excluded.clicks, score=discovery_metrics.score+excluded.score,
      rank=null, calculated_at=now();

    insert into discovery_metrics(entity_type,entity_key,period,searches,clicks,score,rank,metadata)
    select entity_type,entity_key,p,sum(searches),sum(clicks),sum(score),
      row_number() over(partition by entity_type order by sum(score) desc,entity_key),
      jsonb_build_object('work_count',count(distinct product_code))
    from (
      select 'actress' entity_type,v.actress_name entity_key,v.product_code,
        coalesce(m.searches,0) searches,coalesce(m.clicks,0) clicks,
        coalesce(m.score,0)+coalesce(v.popularity,0)*.01 score
      from videos v left join discovery_metrics m on m.entity_type='work' and m.entity_key=upper(v.product_code) and m.period=p
      where v.actress_name is not null
      union all
      select 'maker',v.maker_name,v.product_code,coalesce(m.searches,0),coalesce(m.clicks,0),coalesce(m.score,0)+coalesce(v.popularity,0)*.01
      from videos v left join discovery_metrics m on m.entity_type='work' and m.entity_key=upper(v.product_code) and m.period=p where v.maker_name is not null
      union all
      select 'series',v.series_name,v.product_code,coalesce(m.searches,0),coalesce(m.clicks,0),coalesce(m.score,0)+coalesce(v.popularity,0)*.01
      from videos v left join discovery_metrics m on m.entity_type='work' and m.entity_key=upper(v.product_code) and m.period=p where v.series_name is not null
    ) x group by entity_type,entity_key;
  end loop;
end $$;

grant select on public.video_tags, public.discovery_metrics to anon, authenticated;
grant execute on function public.refresh_discovery_metrics() to authenticated;
