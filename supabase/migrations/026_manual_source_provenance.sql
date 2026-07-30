alter table public.videos
  add column if not exists source_name text,
  add column if not exists external_product_id text,
  add column if not exists official_url text,
  add column if not exists source_checked_at timestamptz;

create index if not exists videos_external_product_id_idx
  on public.videos(external_product_id)
  where external_product_id is not null;

comment on column public.videos.source_name is
  '管理者が確認した公式提供元の名称。手動登録時の出典確認用。';
comment on column public.videos.external_product_id is
  '公式提供元の商品ID。品番とは別に保持する。';
comment on column public.videos.official_url is
  'アフィリエイトパラメータを含まない正規商品ページURL。';
comment on column public.videos.source_checked_at is
  '管理者が公式ページと内容を照合した日時。';
