alter table public.videos
  add column if not exists series_name text,
  add column if not exists label_name text,
  add column if not exists genre text,
  add column if not exists duration integer,
  add column if not exists sample_images text[] not null default '{}',
  add column if not exists popularity integer not null default 0,
  add column if not exists favorite_count integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'videos_duration_nonnegative') then
    alter table public.videos add constraint videos_duration_nonnegative
      check (duration is null or duration >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'videos_popularity_nonnegative') then
    alter table public.videos add constraint videos_popularity_nonnegative
      check (popularity >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'videos_favorite_count_nonnegative') then
    alter table public.videos add constraint videos_favorite_count_nonnegative
      check (favorite_count >= 0);
  end if;
end $$;

create index if not exists videos_popularity_idx on public.videos (popularity desc);
create index if not exists videos_favorite_count_idx on public.videos (favorite_count desc);
create index if not exists videos_series_name_idx on public.videos (series_name);
create index if not exists videos_label_name_idx on public.videos (label_name);
create index if not exists videos_genre_idx on public.videos (genre);
