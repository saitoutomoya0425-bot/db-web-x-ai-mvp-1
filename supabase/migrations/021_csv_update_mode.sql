alter table public.import_jobs
  add column if not exists updated_count bigint not null default 0;
