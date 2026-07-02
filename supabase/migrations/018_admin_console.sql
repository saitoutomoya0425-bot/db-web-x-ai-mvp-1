create table if not exists public.site_settings(
  id boolean primary key default true check(id),
  site_name text not null default 'おかずDB',
  default_title text not null default 'おかずDB｜品番・女優・メーカーから作品検索',
  default_description text not null default '品番から作品情報、女優、関連作品をすぐに確認',
  canonical_base_url text,
  og_image_url text,
  robots_index boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check(canonical_base_url is null or canonical_base_url like 'https://%'),
  check(og_image_url is null or og_image_url like 'https://%')
);
insert into public.site_settings(id) values(true) on conflict do nothing;

create table if not exists public.system_error_logs(
  id bigint generated always as identity primary key,
  source text not null,severity text not null default 'error' check(severity in('warning','error','critical')),
  code text,message text not null,context jsonb not null default '{}',resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists system_error_logs_open_idx on public.system_error_logs(severity,created_at desc) where resolved_at is null;

create table if not exists public.backup_jobs(
  id uuid primary key default gen_random_uuid(),kind text not null default 'manifest',
  status text not null check(status in('queued','running','completed','failed')),
  requested_by uuid references auth.users(id) on delete set null,
  object_path text,metadata jsonb not null default '{}',error_message text,
  created_at timestamptz not null default now(),completed_at timestamptz
);
create index if not exists backup_jobs_created_idx on public.backup_jobs(created_at desc);

alter table public.site_settings enable row level security;
alter table public.system_error_logs enable row level security;
alter table public.backup_jobs enable row level security;
create policy "admin site settings" on public.site_settings for all using((auth.jwt()->'app_metadata'->>'role')='admin') with check((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin error logs" on public.system_error_logs for all using((auth.jwt()->'app_metadata'->>'role')='admin') with check((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin backup jobs" on public.backup_jobs for all using((auth.jwt()->'app_metadata'->>'role')='admin') with check((auth.jwt()->'app_metadata'->>'role')='admin');
