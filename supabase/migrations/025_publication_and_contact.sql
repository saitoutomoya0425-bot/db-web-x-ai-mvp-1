alter table public.videos
  add column if not exists is_published boolean not null default false,
  add column if not exists content_category text not null default 'commercial_av'
    check (content_category in ('commercial_av','creator','doujin'));

create index if not exists videos_published_popularity_idx
  on public.videos(popularity desc, created_at desc) where is_published;
create index if not exists videos_published_release_idx
  on public.videos(release_date desc nulls last, id) where is_published;
create index if not exists videos_published_actress_idx
  on public.videos(actress_name, popularity desc) where is_published;
create index if not exists videos_published_maker_idx
  on public.videos(maker_name, popularity desc) where is_published;
create index if not exists videos_published_series_idx
  on public.videos(series_name, popularity desc) where is_published;

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  email text not null check (char_length(email) between 3 and 320),
  subject text not null check (char_length(subject) between 1 and 200),
  message text not null check (char_length(message) between 1 and 5000),
  status text not null default 'unread' check (status in ('unread','read','resolved','spam')),
  user_agent text,
  referrer text,
  created_at timestamptz not null default now()
);
create index if not exists contact_messages_status_created_idx on public.contact_messages(status, created_at desc);
alter table public.contact_messages enable row level security;
create policy "public submit contact" on public.contact_messages for insert to anon, authenticated with check (status='unread');
create policy "admin read contact" on public.contact_messages for select
  using ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin update contact" on public.contact_messages for update
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');
grant insert on public.contact_messages to anon, authenticated;
grant select, update on public.contact_messages to authenticated;

create or replace function public.search_videos(
  search_query text, sort_by text default 'popular', result_limit integer default 24, result_offset integer default 0
) returns setof public.videos language plpgsql stable security definer set search_path='' as $$
declare
  q text:=trim(coalesce(search_query,''));
  normalized text:=lower(regexp_replace(coalesce(search_query,''),'[[:space:]‐‑‒–—―ー・_/.-]','','g'));
  normalized_code text:=lower(regexp_replace(coalesce(search_query,''),'[^a-zA-Z0-9]','','g'));
  safe_sort text:=case when sort_by in('popular','new','release') then sort_by else 'popular' end;
begin
  if q='' then return; end if;
  return query
  with aliases as(
    select distinct a.canonical_name from public.entity_aliases a
    where a.normalized_alias like '%'||normalized||'%'
  )
  select v.* from public.videos v
  where v.is_published and (
    (normalized_code<>'' and lower(regexp_replace(v.product_code,'[^a-zA-Z0-9]','','g')) like '%'||normalized_code||'%')
    or lower(regexp_replace(coalesce(v.actress_name,''),'[[:space:]‐‑‒–—―ー・_/.-]','','g')) like '%'||normalized||'%'
    or v.product_code ilike '%'||q||'%' or v.title ilike '%'||q||'%'
    or v.maker_name ilike '%'||q||'%' or v.series_name ilike '%'||q||'%'
    or v.actress_name in(select canonical_name from aliases)
    or v.maker_name in(select canonical_name from aliases)
    or v.series_name in(select canonical_name from aliases)
  )
  order by
    case when normalized_code<>'' and lower(regexp_replace(v.product_code,'[^a-zA-Z0-9]','','g'))=normalized_code then 0 else 1 end,
    case when safe_sort='popular' then v.popularity end desc nulls last,
    case when safe_sort='new' then v.created_at end desc nulls last,
    case when safe_sort='release' then v.release_date end desc nulls last,
    greatest(public.similarity(coalesce(v.product_code,''),q),public.similarity(coalesce(v.title,''),q),
      public.similarity(coalesce(v.actress_name,''),q),public.similarity(coalesce(v.maker_name,''),q)) desc,v.id
  limit greatest(1,least(result_limit,100)) offset greatest(0,result_offset);
end $$;

create or replace function public.get_popular_works(result_limit integer default 20)
returns table(product_code text,search_count bigint)
language sql stable security definer set search_path='' as $$
  select upper(sl.product_code),count(*)::bigint
  from public.search_logs sl join public.videos v on upper(v.product_code)=upper(sl.product_code) and v.is_published
  group by upper(sl.product_code) order by count(*) desc
  limit greatest(1,least(result_limit,100));
$$;

create or replace function public.get_popular_works_period(
  period_days integer default null,result_limit integer default 40,result_offset integer default 0
) returns table(product_code text,search_count bigint)
language sql stable security definer set search_path=public as $$
  select upper(sl.product_code),count(*)::bigint
  from search_logs sl join videos v on upper(v.product_code)=upper(sl.product_code) and v.is_published
  where period_days is null or sl.created_at>=now()-make_interval(days=>period_days)
  group by upper(sl.product_code) order by count(*) desc,upper(sl.product_code)
  limit least(greatest(result_limit,1),100) offset greatest(result_offset,0);
$$;

create or replace function public.get_catalog_makers(result_limit integer default 100,result_offset integer default 0)
returns table(name text,work_count bigint,popularity bigint)
language sql stable security definer set search_path=public as $$
  select maker_name,count(*),sum(coalesce(popularity,0))::bigint from videos
  where is_published and maker_name is not null and trim(maker_name)<>''
  group by maker_name order by count(*) desc,maker_name
  limit least(greatest(result_limit,1),200) offset greatest(result_offset,0);
$$;
create or replace function public.get_catalog_genres(result_limit integer default 100,result_offset integer default 0)
returns table(name text,work_count bigint,popularity bigint)
language sql stable security definer set search_path=public as $$
  select genre,count(*),sum(coalesce(popularity,0))::bigint from videos
  where is_published and genre is not null and trim(genre)<>''
  group by genre order by count(*) desc,genre
  limit least(greatest(result_limit,1),200) offset greatest(result_offset,0);
$$;

create or replace function public.get_actress_works(
  target_actress text,search_query text default '',sort_by text default 'popular',
  result_limit integer default 24,result_offset integer default 0
) returns setof public.videos language sql stable security definer set search_path='' as $$
  select v.* from public.videos v where v.is_published and v.actress_name=target_actress and (
    trim(coalesce(search_query,''))='' or v.product_code ilike '%'||trim(search_query)||'%'
    or v.title ilike '%'||trim(search_query)||'%' or v.maker_name ilike '%'||trim(search_query)||'%'
    or v.series_name ilike '%'||trim(search_query)||'%')
  order by case when sort_by='popular' then v.popularity end desc nulls last,
    case when sort_by='release' then v.release_date end desc nulls last,
    case when sort_by='maker' then v.maker_name end asc nulls last,v.created_at desc,v.id
  limit greatest(1,least(result_limit,100)) offset greatest(0,result_offset);
$$;
create or replace function public.count_actress_works(target_actress text,search_query text default '')
returns bigint language sql stable security definer set search_path='' as $$
  select count(*) from public.videos v where v.is_published and v.actress_name=target_actress and (
    trim(coalesce(search_query,''))='' or v.product_code ilike '%'||trim(search_query)||'%'
    or v.title ilike '%'||trim(search_query)||'%' or v.maker_name ilike '%'||trim(search_query)||'%'
    or v.series_name ilike '%'||trim(search_query)||'%');
$$;
create or replace function public.get_actress_stats(target_actress text)
returns table(work_count bigint,maker_count bigint)
language sql stable security definer set search_path='' as $$
  select count(*),count(distinct v.maker_name) from public.videos v
  where v.is_published and v.actress_name=target_actress;
$$;
create or replace function public.get_same_maker_actresses(target_actress text,result_limit integer default 8)
returns table(actress_name text,work_count bigint,popularity bigint)
language sql stable security definer set search_path='' as $$
  with target_makers as(select distinct maker_name from public.videos where is_published and actress_name=target_actress and maker_name is not null)
  select v.actress_name,count(*)::bigint,sum(coalesce(v.popularity,0))::bigint
  from public.videos v join target_makers m on m.maker_name=v.maker_name
  where v.is_published and v.actress_name is not null and v.actress_name<>target_actress
  group by v.actress_name order by sum(coalesce(v.popularity,0)) desc,count(*) desc
  limit greatest(1,least(result_limit,30));
$$;
create or replace function public.get_related_actresses(target_actress text,result_limit integer default 8)
returns table(actress_name text,work_count bigint,popularity bigint)
language sql stable security definer set search_path='' as $$
  with target_genres as(select distinct genre from public.videos where is_published and actress_name=target_actress and genre is not null)
  select v.actress_name,count(*)::bigint,sum(coalesce(v.popularity,0))::bigint
  from public.videos v join target_genres g on g.genre=v.genre
  where v.is_published and v.actress_name is not null and v.actress_name<>target_actress
  group by v.actress_name order by sum(coalesce(v.popularity,0)) desc,count(*) desc
  limit greatest(1,least(result_limit,30));
$$;

create or replace function public.refresh_discovery_metrics()
returns void language plpgsql security definer set search_path=public as $$
declare p text;cutoff timestamptz;
begin
  if auth.role()<>'service_role' and coalesce(auth.jwt()->'app_metadata'->>'role','')<>'admin' then
    raise exception 'admin role required' using errcode='42501';
  end if;
  foreach p in array array['day','week','month','all'] loop
    cutoff:=case p when 'day' then now()-interval '1 day' when 'week' then now()-interval '7 days' when 'month' then now()-interval '30 days' else '-infinity'::timestamptz end;
    delete from discovery_metrics where period=p;
    insert into discovery_metrics(entity_type,entity_key,period,views,searches,clicks,score,rank)
    select 'work',upper(v.product_code),p,
      (select count(*) from video_page_views pv where pv.video_id=v.id and pv.created_at>=cutoff),
      (select count(*) from search_logs sl where upper(sl.product_code)=upper(v.product_code) and sl.created_at>=cutoff),
      (select count(*) from affiliate_clicks ac where ac.video_id=v.id and ac.created_at>=cutoff),
      (select count(*) from search_logs sl where upper(sl.product_code)=upper(v.product_code) and sl.created_at>=cutoff)
        +(select count(*)*2 from affiliate_clicks ac where ac.video_id=v.id and ac.created_at>=cutoff),
      row_number() over(order by v.popularity desc,v.product_code)
    from videos v where v.is_published;
    insert into discovery_metrics(entity_type,entity_key,period,searches,clicks,score,rank,metadata)
    select entity_type,entity_key,p,sum(searches),sum(clicks),sum(score),
      row_number() over(partition by entity_type order by sum(score) desc,entity_key),
      jsonb_build_object('work_count',count(distinct product_code))
    from(
      select 'actress' entity_type,v.actress_name entity_key,v.product_code,m.searches,m.clicks,m.score+coalesce(v.popularity,0)*.01 score
      from videos v join discovery_metrics m on m.entity_type='work' and m.entity_key=upper(v.product_code) and m.period=p
      where v.is_published and v.actress_name is not null
      union all
      select 'maker',v.maker_name,v.product_code,m.searches,m.clicks,m.score+coalesce(v.popularity,0)*.01
      from videos v join discovery_metrics m on m.entity_type='work' and m.entity_key=upper(v.product_code) and m.period=p
      where v.is_published and v.maker_name is not null
      union all
      select 'series',v.series_name,v.product_code,m.searches,m.clicks,m.score+coalesce(v.popularity,0)*.01
      from videos v join discovery_metrics m on m.entity_type='work' and m.entity_key=upper(v.product_code) and m.period=p
      where v.is_published and v.series_name is not null
    ) x group by entity_type,entity_key;
  end loop;
end $$;

delete from public.discovery_metrics;

grant execute on function public.search_videos(text,text,integer,integer) to anon,authenticated;
grant execute on function public.get_popular_works(integer) to anon,authenticated;
grant execute on function public.get_popular_works_period(integer,integer,integer) to anon,authenticated;
grant execute on function public.get_catalog_makers(integer,integer) to anon,authenticated;
grant execute on function public.get_catalog_genres(integer,integer) to anon,authenticated;
grant execute on function public.get_actress_works(text,text,text,integer,integer) to anon,authenticated;
grant execute on function public.count_actress_works(text,text) to anon,authenticated;
grant execute on function public.get_actress_stats(text) to anon,authenticated;
grant execute on function public.get_same_maker_actresses(text,integer) to anon,authenticated;
grant execute on function public.get_related_actresses(text,integer) to anon,authenticated;
