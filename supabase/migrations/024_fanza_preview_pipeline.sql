alter table public.source_products
  add column if not exists original_product_code text,
  add column if not exists normalized_product_code text,
  add column if not exists normalized_data jsonb not null default '{}',
  add column if not exists preview_status text not null default 'needs_review'
    check (preview_status in ('new','update','unchanged','duplicate','needs_review')),
  add column if not exists review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected','promoted','error')),
  add column if not exists duplicate_video_id uuid references public.videos(id) on delete set null,
  add column if not exists promoted_video_id uuid references public.videos(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists error_message text;

create index if not exists source_products_preview_idx
  on public.source_products(data_source_id, review_status, preview_status, fetched_at desc);
create index if not exists source_products_normalized_code_idx
  on public.source_products(normalized_product_code)
  where normalized_product_code is not null;

alter table public.product_offers
  add column if not exists source_product_id uuid references public.source_products(id) on delete set null;
create index if not exists product_offers_source_product_idx
  on public.product_offers(source_product_id)
  where source_product_id is not null;

-- The API connector is deliberately manual-only. This row stores provenance,
-- not credentials. Secrets remain in server environment variables.
insert into public.data_sources(name, source_type, priority, terms_note, is_active)
values (
  'FANZA Webサービス',
  'api',
  10,
  'DMM Webサービス API v3 ItemList。公式API応答のURLだけを保存し、利用条件は運用時の最新規約に従う。',
  true
)
on conflict(name) do update set
  source_type=excluded.source_type,
  priority=excluded.priority,
  terms_note=excluded.terms_note,
  is_active=true;
