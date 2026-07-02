create index if not exists videos_actress_popular_idx
  on public.videos (actress_name, popularity desc, id);
create index if not exists videos_actress_release_idx
  on public.videos (actress_name, release_date desc nulls last, id);
create index if not exists videos_actress_maker_idx
  on public.videos (actress_name, maker_name, id);

create or replace function public.get_actress_works(
  target_actress text,
  search_query text default '',
  sort_by text default 'popular',
  result_limit integer default 24,
  result_offset integer default 0
)
returns setof public.videos
language sql stable security definer set search_path = ''
as $$
  select v.*
  from public.videos v
  where v.actress_name = target_actress
    and (
      trim(coalesce(search_query, '')) = ''
      or v.product_code ilike '%' || trim(search_query) || '%'
      or v.title ilike '%' || trim(search_query) || '%'
      or v.maker_name ilike '%' || trim(search_query) || '%'
      or v.series_name ilike '%' || trim(search_query) || '%'
    )
  order by
    case when sort_by = 'popular' then v.popularity end desc nulls last,
    case when sort_by = 'release' then v.release_date end desc nulls last,
    case when sort_by = 'maker' then v.maker_name end asc nulls last,
    v.created_at desc,
    v.id
  limit greatest(1, least(result_limit, 100))
  offset greatest(0, result_offset);
$$;

create or replace function public.count_actress_works(
  target_actress text,
  search_query text default ''
)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select count(*)
  from public.videos v
  where v.actress_name = target_actress
    and (
      trim(coalesce(search_query, '')) = ''
      or v.product_code ilike '%' || trim(search_query) || '%'
      or v.title ilike '%' || trim(search_query) || '%'
      or v.maker_name ilike '%' || trim(search_query) || '%'
      or v.series_name ilike '%' || trim(search_query) || '%'
    );
$$;

create or replace function public.get_actress_stats(target_actress text)
returns table (work_count bigint, maker_count bigint)
language sql stable security definer set search_path = ''
as $$
  select count(*), count(distinct v.maker_name)
  from public.videos v
  where v.actress_name = target_actress;
$$;

create or replace function public.get_same_maker_actresses(
  target_actress text,
  result_limit integer default 8
)
returns table (actress_name text, work_count bigint, popularity bigint)
language sql stable security definer set search_path = ''
as $$
  with target_makers as (
    select distinct maker_name from public.videos
    where actress_name = target_actress and maker_name is not null
  )
  select v.actress_name, count(*)::bigint, sum(coalesce(v.popularity, 0))::bigint
  from public.videos v
  join target_makers m on m.maker_name = v.maker_name
  where v.actress_name is not null and v.actress_name <> target_actress
  group by v.actress_name
  order by sum(coalesce(v.popularity, 0)) desc, count(*) desc
  limit greatest(1, least(result_limit, 30));
$$;

create or replace function public.get_related_actresses(
  target_actress text,
  result_limit integer default 8
)
returns table (actress_name text, work_count bigint, popularity bigint)
language sql stable security definer set search_path = ''
as $$
  with target_genres as (
    select distinct genre from public.videos
    where actress_name = target_actress and genre is not null
  )
  select v.actress_name, count(*)::bigint, sum(coalesce(v.popularity, 0))::bigint
  from public.videos v
  join target_genres g on g.genre = v.genre
  where v.actress_name is not null and v.actress_name <> target_actress
  group by v.actress_name
  order by sum(coalesce(v.popularity, 0)) desc, count(*) desc
  limit greatest(1, least(result_limit, 30));
$$;

grant execute on function public.get_actress_works(text, text, text, integer, integer) to anon, authenticated;
grant execute on function public.count_actress_works(text, text) to anon, authenticated;
grant execute on function public.get_actress_stats(text) to anon, authenticated;
grant execute on function public.get_same_maker_actresses(text, integer) to anon, authenticated;
grant execute on function public.get_related_actresses(text, integer) to anon, authenticated;
