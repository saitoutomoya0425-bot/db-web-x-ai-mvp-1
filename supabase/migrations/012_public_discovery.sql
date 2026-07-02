create index if not exists videos_created_at_idx on public.videos (created_at desc);
create index if not exists videos_release_date_idx on public.videos (release_date desc nulls last);
create index if not exists videos_popularity_idx on public.videos (popularity desc, created_at desc);
create index if not exists search_logs_created_at_code_idx on public.search_logs (created_at desc, product_code);

create or replace function public.get_popular_works_period(
  period_days integer default null,
  result_limit integer default 40,
  result_offset integer default 0
)
returns table(product_code text, search_count bigint)
language sql stable security definer set search_path = public
as $$
  select upper(sl.product_code), count(*)::bigint
  from search_logs sl
  where period_days is null or sl.created_at >= now() - make_interval(days => period_days)
  group by upper(sl.product_code)
  order by count(*) desc, upper(sl.product_code)
  limit least(greatest(result_limit, 1), 100)
  offset greatest(result_offset, 0);
$$;

grant execute on function public.get_popular_works_period(integer, integer, integer) to anon, authenticated;
