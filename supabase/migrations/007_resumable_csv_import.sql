alter table public.import_jobs
  add column if not exists file_fingerprint text,
  add column if not exists total_count bigint,
  add column if not exists duplicate_count bigint not null default 0,
  add column if not exists last_error text;

create index if not exists import_jobs_resume_idx
  on public.import_jobs (user_id, file_fingerprint, status, updated_at desc);

create index if not exists import_jobs_created_at_idx
  on public.import_jobs (created_at desc);
