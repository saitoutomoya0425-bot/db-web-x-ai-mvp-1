alter table public.videos
  add column if not exists card_thumbnail_url text;

comment on column public.videos.card_thumbnail_url is
  'Card/list dedicated thumbnail URL. Prefer official API cover/list image such as FANZA imageURL.list; keep thumbnail_url for detail page main image.';
