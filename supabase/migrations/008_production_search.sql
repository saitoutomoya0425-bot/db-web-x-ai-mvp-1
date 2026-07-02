create extension if not exists pg_trgm;

-- Product codes are compared after removing hyphens, spaces and punctuation.
create index if not exists videos_product_code_normalized_idx
  on public.videos (lower(regexp_replace(product_code, '[^a-zA-Z0-9]', '', 'g')));
create index if not exists videos_product_code_normalized_trgm_idx
  on public.videos using gin (
    lower(regexp_replace(product_code, '[^a-zA-Z0-9]', '', 'g')) gin_trgm_ops
  );
create index if not exists videos_title_trgm_idx
  on public.videos using gin (title gin_trgm_ops);
create index if not exists videos_actress_name_trgm_idx
  on public.videos using gin (actress_name gin_trgm_ops);
create index if not exists videos_maker_name_trgm_idx
  on public.videos using gin (maker_name gin_trgm_ops);
create index if not exists videos_series_name_trgm_idx
  on public.videos using gin (series_name gin_trgm_ops);
create index if not exists videos_popularity_created_idx
  on public.videos (popularity desc, created_at desc);
create index if not exists videos_release_date_sort_idx
  on public.videos (release_date desc nulls last);

drop function if exists public.search_videos(text, integer, integer);

create or replace function public.search_videos(
  search_query text,
  sort_by text default 'popular',
  result_limit integer default 24,
  result_offset integer default 0
)
returns setof public.videos
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  q text := trim(coalesce(search_query, ''));
  normalized_code text := lower(regexp_replace(coalesce(search_query, ''), '[^a-zA-Z0-9]', '', 'g'));
  safe_sort text := case when sort_by in ('popular', 'new', 'release') then sort_by else 'popular' end;
begin
  if q = '' then return; end if;
  return query
  select v.*
  from public.videos v
  where
    (normalized_code <> '' and lower(regexp_replace(v.product_code, '[^a-zA-Z0-9]', '', 'g')) like '%' || normalized_code || '%')
    or v.product_code ilike '%' || q || '%'
    or v.title ilike '%' || q || '%'
    or v.actress_name ilike '%' || q || '%'
    or v.maker_name ilike '%' || q || '%'
    or v.series_name ilike '%' || q || '%'
  order by
    case when lower(regexp_replace(v.product_code, '[^a-zA-Z0-9]', '', 'g')) = normalized_code then 0 else 1 end,
    case when safe_sort = 'popular' then v.popularity end desc nulls last,
    case when safe_sort = 'new' then v.created_at end desc nulls last,
    case when safe_sort = 'release' then v.release_date end desc nulls last,
    greatest(
      public.similarity(coalesce(v.product_code, ''), q),
      public.similarity(coalesce(v.title, ''), q),
      public.similarity(coalesce(v.actress_name, ''), q),
      public.similarity(coalesce(v.maker_name, ''), q),
      public.similarity(coalesce(v.series_name, ''), q)
    ) desc,
    v.id
  limit greatest(1, least(result_limit, 100))
  offset greatest(0, result_offset);
end;
$$;

grant execute on function public.search_videos(text, text, integer, integer) to anon, authenticated;
