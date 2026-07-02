alter table public.source_items
  add column if not exists review_bucket text not null default 'unprocessed'
    check (review_bucket in ('unprocessed','high','medium','low','duplicate','invalid','auto_approved'));
create index if not exists source_items_bucket_queue_idx
  on public.source_items(review_bucket, confidence desc, observed_at desc)
  where status='pending';

create table if not exists public.ai_quality_settings (
  id boolean primary key default true check(id),
  high_threshold numeric(5,4) not null default .90 check(high_threshold between 0 and 1),
  medium_threshold numeric(5,4) not null default .65 check(medium_threshold between 0 and 1),
  auto_approve_enabled boolean not null default false,
  auto_approve_threshold numeric(5,4) not null default .98 check(auto_approve_threshold between 0 and 1),
  minimum_evaluated_samples integer not null default 200 check(minimum_evaluated_samples >= 0),
  minimum_precision numeric(5,4) not null default .98 check(minimum_precision between 0 and 1),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.ai_quality_settings(id) values(true) on conflict do nothing;

create table if not exists public.ai_quality_snapshots (
  id bigint generated always as identity primary key,
  model text not null,
  sample_count integer not null,
  approved_count integer not null,
  rejected_count integer not null,
  corrected_count integer not null,
  approval_rate numeric(8,6),
  correction_rate numeric(8,6),
  average_confidence numeric(8,6),
  high_confidence_precision numeric(8,6),
  passed_gate boolean not null default false,
  calculated_at timestamptz not null default now()
);
create index if not exists ai_quality_snapshots_model_created_idx on public.ai_quality_snapshots(model, calculated_at desc);

alter table public.ai_quality_settings enable row level security;
alter table public.ai_quality_snapshots enable row level security;
create policy "admin quality settings" on public.ai_quality_settings for all
  using ((auth.jwt()->'app_metadata'->>'role')='admin') with check ((auth.jwt()->'app_metadata'->>'role')='admin');
create policy "admin quality snapshots" on public.ai_quality_snapshots for select
  using ((auth.jwt()->'app_metadata'->>'role')='admin');

create or replace function public.classify_source_candidate(
  candidate_confidence numeric, has_duplicate boolean, has_code boolean, has_title boolean
) returns text language sql stable security definer set search_path=public as $$
  select case
    when has_duplicate then 'duplicate'
    when not has_code or not has_title then 'invalid'
    when candidate_confidence >= (select high_threshold from ai_quality_settings where id=true) then 'high'
    when candidate_confidence >= (select medium_threshold from ai_quality_settings where id=true) then 'medium'
    else 'low'
  end;
$$;

create or replace function public.refresh_ai_quality_snapshot()
returns public.ai_quality_snapshots language plpgsql security definer set search_path=public as $$
declare result public.ai_quality_snapshots; settings ai_quality_settings;
begin
  if auth.role()<>'service_role' and coalesce(auth.jwt()->'app_metadata'->>'role','')<>'admin' then
    raise exception 'admin role required' using errcode='42501';
  end if;
  select * into settings from ai_quality_settings where id=true;
  insert into ai_quality_snapshots(
    model,sample_count,approved_count,rejected_count,corrected_count,
    approval_rate,correction_rate,average_confidence,high_confidence_precision,passed_gate
  )
  with latest_decision as (
    select distinct on(source_item_id) source_item_id,decision
    from ai_correction_examples where decision in ('approved','rejected')
    order by source_item_id,created_at desc
  ), stats as (
    select coalesce(s.extraction_model,'unknown') model,count(*) sample_count,
      count(*) filter(where d.decision='approved') approved_count,
      count(*) filter(where d.decision='rejected') rejected_count,
      count(*) filter(where exists(select 1 from ai_correction_examples c where c.source_item_id=s.id and c.decision='corrected')) corrected_count,
      avg(s.confidence) average_confidence,
      count(*) filter(where d.decision='approved' and s.confidence>=settings.high_threshold) high_approved,
      count(*) filter(where s.confidence>=settings.high_threshold) high_total
    from source_items s join latest_decision d on d.source_item_id=s.id group by coalesce(s.extraction_model,'unknown')
    order by count(*) desc limit 1
  )
  select model,sample_count,approved_count,rejected_count,corrected_count,
    approved_count::numeric/nullif(approved_count+rejected_count,0),
    corrected_count::numeric/nullif(sample_count,0),average_confidence,
    high_approved::numeric/nullif(high_total,0),
    sample_count>=settings.minimum_evaluated_samples
      and coalesce(high_approved::numeric/nullif(high_total,0),0)>=settings.minimum_precision
  from stats returning * into result;
  return result;
end $$;
grant execute on function public.classify_source_candidate(numeric,boolean,boolean,boolean) to service_role;
grant execute on function public.refresh_ai_quality_snapshot() to authenticated,service_role;
