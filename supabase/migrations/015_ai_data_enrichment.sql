alter table public.source_items
  add column if not exists extraction_status text not null default 'pending'
    check (extraction_status in ('pending','processing','completed','fallback','failed')),
  add column if not exists extraction_provider text,
  add column if not exists extraction_model text,
  add column if not exists confidence numeric(5,4) check (confidence between 0 and 1),
  add column if not exists field_confidence jsonb not null default '{}',
  add column if not exists duplicate_of bigint references public.source_items(id) on delete set null,
  add column if not exists duplicate_video_id uuid references public.videos(id) on delete set null,
  add column if not exists extracted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null;

create index if not exists source_items_extraction_queue_idx
  on public.source_items(id) where status='pending' and extraction_status in ('pending','failed');
create index if not exists source_items_review_queue_idx
  on public.source_items(confidence desc, observed_at desc) where status='pending' and extraction_status in ('completed','fallback');
create index if not exists source_items_duplicate_of_idx on public.source_items(duplicate_of) where duplicate_of is not null;
create index if not exists source_items_normalized_code_idx
  on public.source_items ((upper(regexp_replace(coalesce(product_code,''),'[^A-Z0-9]','','g'))))
  where product_code is not null;

create table if not exists public.ai_extraction_runs (
  id uuid primary key default gen_random_uuid(),
  source_item_id bigint references public.source_items(id) on delete set null,
  provider text not null,
  model text not null,
  status text not null check(status in ('completed','failed','fallback')),
  request_id text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  latency_ms integer not null default 0,
  estimated_cost numeric(14,8),
  error_code text,
  error_message text,
  raw_output jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ai_extraction_runs_created_idx on public.ai_extraction_runs(created_at desc);
create index if not exists ai_extraction_runs_status_created_idx on public.ai_extraction_runs(status, created_at desc);

create table if not exists public.ai_correction_examples (
  id bigint generated always as identity primary key,
  source_item_id bigint not null references public.source_items(id) on delete cascade,
  input_text text not null,
  model_output jsonb not null default '{}',
  corrected_output jsonb not null,
  changed_fields text[] not null default '{}',
  reviewer_id uuid references auth.users(id) on delete set null,
  decision text not null check(decision in ('corrected','approved','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists ai_correction_examples_created_idx on public.ai_correction_examples(created_at desc);

create table if not exists public.media_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  source_item_id bigint not null references public.source_items(id) on delete cascade,
  media_type text not null check(media_type in ('image','video')),
  media_url text not null,
  status text not null default 'pending' check(status in ('pending','processing','completed','failed')),
  provider text,
  model text,
  result jsonb,
  confidence numeric(5,4) check(confidence between 0 and 1),
  error_message text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_item_id, media_url)
);
create index if not exists media_analysis_jobs_queue_idx on public.media_analysis_jobs(next_attempt_at, id) where status in ('pending','failed');

alter table public.ai_extraction_runs enable row level security;
alter table public.ai_correction_examples enable row level security;
alter table public.media_analysis_jobs enable row level security;
create policy "admin ai runs" on public.ai_extraction_runs for select using ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin corrections" on public.ai_correction_examples for all using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin media jobs" on public.media_analysis_jobs for all using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');

create or replace function public.claim_source_items_for_extraction(batch_size integer default 20)
returns setof public.source_items language sql security definer set search_path=public as $$
  update source_items s set extraction_status='processing', updated_at=now()
  where s.id in (
    select id from source_items
    where status='pending' and extraction_status in ('pending','failed')
    order by id for update skip locked
    limit least(greatest(batch_size,1),50)
  )
  returning s.*;
$$;

create or replace function public.find_candidate_duplicate(candidate_code text, exclude_source_id bigint)
returns table(duplicate_source_id bigint, duplicate_video_id uuid)
language sql stable security definer set search_path=public as $$
  with code as (select upper(regexp_replace(coalesce(candidate_code,''),'[^A-Z0-9]','','g')) value),
  source_match as (
    select s.id from source_items s, code c
    where s.id<>exclude_source_id and s.status in ('pending','promoted')
      and upper(regexp_replace(coalesce(s.product_code,''),'[^A-Z0-9]','','g'))=c.value
    order by (s.status='promoted') desc,s.id limit 1
  ),
  video_match as (
    select v.id from videos v, code c
    where upper(regexp_replace(v.product_code,'[^A-Z0-9]','','g'))=c.value limit 1
  )
  select (select id from source_match),(select id from video_match);
$$;
grant execute on function public.claim_source_items_for_extraction(integer) to service_role;
grant execute on function public.find_candidate_duplicate(text,bigint) to service_role;

create or replace function public.get_admin_operations_metrics()
returns table(
  collected bigint, candidates bigint, approved bigint, rejected bigint, duplicates bigint,
  errors bigint, ai_requests bigint, input_tokens bigint, output_tokens bigint, affiliate_clicks bigint
) language sql stable security definer set search_path=public as $$
  select
    (select count(*) from source_items),
    (select count(*) from source_items where product_code is not null),
    (select count(*) from source_items where status='promoted'),
    (select count(*) from source_items where status='ignored'),
    (select count(*) from source_items where duplicate_of is not null or duplicate_video_id is not null),
    (select count(*) from source_items where status='error' or extraction_status='failed')
      + (select count(*) from ai_extraction_runs where status='failed'),
    (select count(*) from ai_extraction_runs),
    (select coalesce(sum(input_tokens),0) from ai_extraction_runs),
    (select coalesce(sum(output_tokens),0) from ai_extraction_runs),
    (select count(*) from affiliate_clicks)
  where coalesce(auth.jwt()->'app_metadata'->>'role','')='admin';
$$;

create or replace function public.refresh_keyword_metrics()
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' and coalesce(auth.jwt()->'app_metadata'->>'role','')<>'admin' then
    raise exception 'admin role required' using errcode='42501';
  end if;
  delete from discovery_metrics where entity_type='keyword' and period in ('week','month','all');
  insert into discovery_metrics(entity_type,entity_key,period,searches,score,rank)
  select 'keyword',product_code,period,searches,searches,row_number() over(partition by period order by searches desc,product_code)
  from (
    select product_code,p.period,count(*) searches
    from search_logs cross join (values ('week',now()-interval '7 days'),('month',now()-interval '30 days'),('all','-infinity'::timestamptz)) p(period,cutoff)
    where source='web_search' and created_at>=p.cutoff
    group by product_code,p.period
  ) q;
end $$;
grant execute on function public.get_admin_operations_metrics() to authenticated;
grant execute on function public.refresh_keyword_metrics() to authenticated,service_role;
