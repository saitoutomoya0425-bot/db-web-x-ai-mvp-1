create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  product_code text not null unique check (char_length(trim(product_code)) > 0),
  title text not null check (char_length(trim(title)) > 0),
  actress_name text,
  maker_name text,
  series_name text,
  label_name text,
  genre text,
  duration integer check (duration is null or duration >= 0),
  release_date date,
  sample_images text[] not null default '{}',
  thumbnail_url text,
  video_url text,
  affiliate_url text,
  description text,
  popularity integer not null default 0 check (popularity >= 0),
  favorite_count integer not null default 0 check (favorite_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists videos_product_code_idx on public.videos (product_code);
create index if not exists videos_popularity_idx on public.videos (popularity desc);
create index if not exists videos_favorite_count_idx on public.videos (favorite_count desc);

drop trigger if exists videos_set_updated_at on public.videos;
create trigger videos_set_updated_at before update on public.videos
for each row execute function public.set_updated_at();

alter table public.videos enable row level security;

drop policy if exists "authenticated_manage_videos" on public.videos;
create policy "authenticated_manage_videos"
on public.videos for all to authenticated
using (true) with check (true);
