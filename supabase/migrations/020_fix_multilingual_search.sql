-- Avoid matching every row when a Japanese query has no ASCII product-code characters.
create or replace function public.search_videos(
  search_query text,
  sort_by text default 'popular',
  result_limit integer default 24,
  result_offset integer default 0
) returns setof public.videos
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  q text := trim(coalesce(search_query, ''));
  normalized text := lower(regexp_replace(coalesce(search_query, ''), '[[:space:]‐‑‒–—―ー・_/.-]', '', 'g'));
  normalized_code text := lower(regexp_replace(coalesce(search_query, ''), '[^a-zA-Z0-9]', '', 'g'));
  safe_sort text := case when sort_by in ('popular', 'new', 'release') then sort_by else 'popular' end;
begin
  if q = '' then return; end if;
  return query
  with aliases as (
    select distinct a.canonical_name
    from public.entity_aliases a
    where a.normalized_alias like '%' || normalized || '%'
  )
  select v.*
  from public.videos v
  where
    (normalized_code <> '' and lower(regexp_replace(v.product_code, '[^a-zA-Z0-9]', '', 'g')) like '%' || normalized_code || '%')
    or lower(regexp_replace(coalesce(v.actress_name, ''), '[[:space:]‐‑‒–—―ー・_/.-]', '', 'g')) like '%' || normalized || '%'
    or v.product_code ilike '%' || q || '%'
    or v.title ilike '%' || q || '%'
    or v.maker_name ilike '%' || q || '%'
    or v.series_name ilike '%' || q || '%'
    or v.actress_name in (select canonical_name from aliases)
    or v.maker_name in (select canonical_name from aliases)
    or v.series_name in (select canonical_name from aliases)
  order by
    case when normalized_code <> '' and lower(regexp_replace(v.product_code, '[^a-zA-Z0-9]', '', 'g')) = normalized_code then 0 else 1 end,
    case when safe_sort = 'popular' then v.popularity end desc nulls last,
    case when safe_sort = 'new' then v.created_at end desc nulls last,
    case when safe_sort = 'release' then v.release_date end desc nulls last,
    greatest(
      public.similarity(coalesce(v.product_code, ''), q),
      public.similarity(coalesce(v.title, ''), q),
      public.similarity(coalesce(v.actress_name, ''), q),
      public.similarity(coalesce(v.maker_name, ''), q)
    ) desc,
    v.id
  limit greatest(1, least(result_limit, 100))
  offset greatest(0, result_offset);
end
$$;

grant execute on function public.search_videos(text, text, integer, integer) to anon, authenticated;
