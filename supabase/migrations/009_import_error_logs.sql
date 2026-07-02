create table if not exists public.import_errors (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.import_jobs(id) on delete cascade,
  row_number bigint not null,
  product_code text,
  message text not null,
  raw_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists import_errors_job_row_idx
  on public.import_errors (job_id, row_number);

alter table public.import_errors enable row level security;

drop policy if exists "admin_read_own_import_errors" on public.import_errors;
create policy "admin_read_own_import_errors"
on public.import_errors for select to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  and exists (
    select 1 from public.import_jobs j
    where j.id = import_errors.job_id and j.user_id = auth.uid()
  )
);

drop policy if exists "admin_insert_own_import_errors" on public.import_errors;
create policy "admin_insert_own_import_errors"
on public.import_errors for insert to authenticated
with check (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  and exists (
    select 1 from public.import_jobs j
    where j.id = import_errors.job_id and j.user_id = auth.uid()
  )
);
