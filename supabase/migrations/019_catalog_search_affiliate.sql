create table if not exists public.entity_aliases(
  id bigint generated always as identity primary key,
  entity_type text not null check(entity_type in('actress','maker','series')),
  canonical_name text not null,
  alias text not null,
  normalized_alias text generated always as (lower(regexp_replace(alias,'[[:space:]‐‑‒–—―ー・_/.-]','','g'))) stored,
  created_at timestamptz not null default now(),
  unique(entity_type,normalized_alias,canonical_name)
);
create index if not exists entity_aliases_lookup_idx on public.entity_aliases(entity_type,normalized_alias) include(canonical_name);
alter table public.entity_aliases enable row level security;
create policy "public read aliases" on public.entity_aliases for select using(true);
create policy "admin manage aliases" on public.entity_aliases for all
  using((auth.jwt()->'app_metadata'->>'role')='admin') with check((auth.jwt()->'app_metadata'->>'role')='admin');

create index if not exists videos_actress_normalized_idx on public.videos(lower(regexp_replace(coalesce(actress_name,''),'[[:space:]‐‑‒–—―ー・_/.-]','','g')));
create index if not exists videos_maker_popular_catalog_idx on public.videos(maker_name,popularity desc) where maker_name is not null;
create index if not exists videos_genre_popular_catalog_idx on public.videos(genre,popularity desc) where genre is not null;

create or replace function public.sync_catalog_dimensions()
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' and coalesce(auth.jwt()->'app_metadata'->>'role','')<>'admin' then
    raise exception 'admin role required' using errcode='42501';
  end if;
  insert into actresses(name) select distinct actress_name from videos where actress_name is not null and trim(actress_name)<>'' on conflict(name) do nothing;
  insert into makers(name) select distinct maker_name from videos where maker_name is not null and trim(maker_name)<>'' on conflict(name) do nothing;
end $$;

create or replace function public.get_catalog_makers(result_limit integer default 100,result_offset integer default 0)
returns table(name text,work_count bigint,popularity bigint)
language sql stable security definer set search_path=public as $$
  select maker_name,count(*),sum(coalesce(videos.popularity,0))::bigint from videos
  where maker_name is not null and trim(maker_name)<>''
  group by maker_name order by count(*) desc,maker_name
  limit least(greatest(result_limit,1),200) offset greatest(result_offset,0);
$$;
create or replace function public.get_catalog_genres(result_limit integer default 100,result_offset integer default 0)
returns table(name text,work_count bigint,popularity bigint)
language sql stable security definer set search_path=public as $$
  select genre,count(*),sum(coalesce(videos.popularity,0))::bigint from videos
  where genre is not null and trim(genre)<>''
  group by genre order by count(*) desc,genre
  limit least(greatest(result_limit,1),200) offset greatest(result_offset,0);
$$;
grant execute on function public.sync_catalog_dimensions() to authenticated,service_role;
grant execute on function public.get_catalog_makers(integer,integer) to anon,authenticated;
grant execute on function public.get_catalog_genres(integer,integer) to anon,authenticated;

create or replace function public.search_videos(
  search_query text,sort_by text default 'popular',result_limit integer default 24,result_offset integer default 0
) returns setof public.videos language plpgsql stable security definer set search_path='' as $$
declare
  q text:=trim(coalesce(search_query,''));
  normalized text:=lower(regexp_replace(coalesce(search_query,''),'[[:space:]‐‑‒–—―ー・_/.-]','','g'));
  safe_sort text:=case when sort_by in('popular','new','release') then sort_by else 'popular' end;
begin
  if q='' then return;end if;
  return query
  with aliases as(
    select distinct a.canonical_name from public.entity_aliases a where a.normalized_alias like '%'||normalized||'%'
  )
  select v.* from public.videos v
  where lower(regexp_replace(v.product_code,'[^a-zA-Z0-9]','','g')) like '%'||lower(regexp_replace(q,'[^a-zA-Z0-9]','','g'))||'%'
    or lower(regexp_replace(coalesce(v.actress_name,''),'[[:space:]‐‑‒–—―ー・_/.-]','','g')) like '%'||normalized||'%'
    or v.product_code ilike '%'||q||'%' or v.title ilike '%'||q||'%' or v.maker_name ilike '%'||q||'%' or v.series_name ilike '%'||q||'%'
    or v.actress_name in(select canonical_name from aliases) or v.maker_name in(select canonical_name from aliases) or v.series_name in(select canonical_name from aliases)
  order by
    case when lower(regexp_replace(v.product_code,'[^a-zA-Z0-9]','','g'))=lower(regexp_replace(q,'[^a-zA-Z0-9]','','g')) then 0 else 1 end,
    case when safe_sort='popular' then v.popularity end desc nulls last,
    case when safe_sort='new' then v.created_at end desc nulls last,
    case when safe_sort='release' then v.release_date end desc nulls last,
    greatest(public.similarity(coalesce(v.product_code,''),q),public.similarity(coalesce(v.title,''),q),public.similarity(coalesce(v.actress_name,''),q),public.similarity(coalesce(v.maker_name,''),q)) desc,v.id
  limit greatest(1,least(result_limit,100)) offset greatest(0,result_offset);
end $$;
grant execute on function public.search_videos(text,text,integer,integer) to anon,authenticated;

alter table public.affiliate_settings add column if not exists affiliate_id text;
create or replace function public.set_video_affiliate_url()
returns trigger language plpgsql security definer set search_path=public as $$
declare settings affiliate_settings;
begin
  if new.affiliate_url is null then
    select * into settings from affiliate_settings where id=true and enabled=true;
    if settings.url_template is not null and settings.affiliate_id is not null then
      new.affiliate_url:=replace(replace(settings.url_template,'{product_code}',new.product_code),'{affiliate_id}',settings.affiliate_id);
    end if;
  end if;return new;
end $$;
create or replace function public.apply_affiliate_template(batch_limit integer default 10000)
returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;settings affiliate_settings;
begin
  if auth.role()<>'service_role' and coalesce(auth.jwt()->'app_metadata'->>'role','')<>'admin' then raise exception 'admin role required' using errcode='42501';end if;
  select * into settings from affiliate_settings where id=true and enabled=true;
  if settings.url_template is null or settings.affiliate_id is null then return 0;end if;
  with targets as(select id from videos where affiliate_url is null order by id limit least(greatest(batch_limit,1),50000))
  update videos v set affiliate_url=replace(replace(settings.url_template,'{product_code}',v.product_code),'{affiliate_id}',settings.affiliate_id)
  from targets where v.id=targets.id;
  get diagnostics affected=row_count;return affected;
end $$;
