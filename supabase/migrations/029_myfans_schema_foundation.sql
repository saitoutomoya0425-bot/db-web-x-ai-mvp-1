-- Additive MyFans schema foundation. This migration does not ingest or expose MyFans data.

create table if not exists public.myfans_creators (
  id uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources(id) on delete restrict,
  external_creator_id text not null check (char_length(trim(external_creator_id)) > 0),
  profile_slug text check (profile_slug is null or char_length(trim(profile_slug)) > 0),
  display_name text not null check (char_length(trim(display_name)) > 0),
  official_url text not null check (official_url ~ '^https://myfans[.]jp(/|$)'),
  profile_image_url text check (profile_image_url is null or profile_image_url ~ '^https://[^/@:]+(/|$)'),
  bio text,
  visibility text not null default 'unknown'
    check (visibility in ('public','free','paid_metadata_only','limited','paid','unknown')),
  review_status text not null default 'pending'
    check (review_status in (
      'pending','public_metadata_staged','needs_visibility_review','needs_human_link',
      'affiliate_enrollment_required','source_access_blocked','paid_content_excluded',
      'invalid_source_identity','approved','rejected','blocked'
    )),
  raw_public_metadata jsonb not null default '{}'::jsonb,
  metadata_hash text not null check (metadata_hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(data_source_id, external_creator_id)
);
create unique index if not exists myfans_creators_source_slug_unique_idx
  on public.myfans_creators(data_source_id, profile_slug)
  where profile_slug is not null;

create table if not exists public.myfans_posts (
  id uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources(id) on delete restrict,
  creator_id uuid not null references public.myfans_creators(id) on delete restrict,
  external_post_id text not null check (char_length(trim(external_post_id)) > 0),
  source_product_id uuid references public.source_products(id) on delete set null,
  title text check (title is null or char_length(trim(title)) > 0),
  teaser text,
  official_url text not null check (official_url ~ '^https://myfans[.]jp(/|$)'),
  thumbnail_url text check (thumbnail_url is null or thumbnail_url ~ '^https://[^/@:]+(/|$)'),
  published_at timestamptz,
  content_type text check (content_type is null or content_type in ('text','image','video','mixed','unknown')),
  media_indicator text check (media_indicator is null or media_indicator in ('text','image','video','mixed','unknown')),
  sample_available boolean,
  visibility text not null default 'unknown'
    check (visibility in ('public','free','paid_metadata_only','limited','paid','unknown')),
  price numeric(12,2) check (price is null or price >= 0),
  currency char(3) not null default 'JPY' check (currency ~ '^[A-Z]{3}$'),
  review_status text not null default 'pending'
    check (review_status in (
      'pending','public_metadata_staged','needs_visibility_review','needs_human_link',
      'affiliate_enrollment_required','source_access_blocked','paid_content_excluded',
      'invalid_source_identity','approved','rejected','blocked'
    )),
  raw_public_metadata jsonb not null default '{}'::jsonb,
  metadata_hash text not null check (metadata_hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(data_source_id, external_post_id)
);
create unique index if not exists myfans_posts_source_product_unique_idx
  on public.myfans_posts(source_product_id)
  where source_product_id is not null;
create index if not exists myfans_posts_creator_published_idx
  on public.myfans_posts(creator_id, published_at desc);
create index if not exists myfans_posts_visibility_idx
  on public.myfans_posts(visibility);

create table if not exists public.myfans_plans (
  id uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources(id) on delete restrict,
  creator_id uuid not null references public.myfans_creators(id) on delete restrict,
  external_plan_id text check (external_plan_id is null or char_length(trim(external_plan_id)) > 0),
  name text check (name is null or char_length(trim(name)) > 0),
  description text,
  official_url text check (official_url is null or official_url ~ '^https://myfans[.]jp(/|$)'),
  price numeric(12,2) check (price is null or price >= 0),
  currency char(3) not null default 'JPY' check (currency ~ '^[A-Z]{3}$'),
  visibility text not null default 'unknown'
    check (visibility in ('public','free','paid_metadata_only','limited','paid','unknown')),
  review_status text not null default 'pending'
    check (review_status in (
      'pending','public_metadata_staged','needs_visibility_review','needs_human_link',
      'affiliate_enrollment_required','source_access_blocked','paid_content_excluded',
      'invalid_source_identity','approved','rejected','blocked'
    )),
  raw_public_metadata jsonb not null default '{}'::jsonb,
  metadata_hash text not null check (metadata_hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists myfans_plans_external_id_unique_idx
  on public.myfans_plans(data_source_id, external_plan_id)
  where external_plan_id is not null;
create index if not exists myfans_plans_creator_idx
  on public.myfans_plans(creator_id);

create table if not exists public.myfans_post_plans (
  post_id uuid not null references public.myfans_posts(id) on delete cascade,
  plan_id uuid not null references public.myfans_plans(id) on delete cascade,
  source_observed_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key(post_id, plan_id)
);

create table if not exists public.video_source_link_evidence (
  id uuid primary key default gen_random_uuid(),
  video_source_link_id uuid not null references public.video_source_links(id) on delete cascade,
  match_method text not null
    check (match_method in ('exact_explicit','human_review','legacy','other')),
  review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected','legacy')),
  confidence numeric(5,4) not null check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '{}'::jsonb,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((reviewed_by is null) = (reviewed_at is null)),
  check (review_status not in ('approved','rejected') or reviewed_by is not null)
);
create index if not exists video_source_link_evidence_link_idx
  on public.video_source_link_evidence(video_source_link_id, created_at desc);

drop trigger if exists myfans_creators_set_updated_at on public.myfans_creators;
create trigger myfans_creators_set_updated_at before update on public.myfans_creators
for each row execute function public.set_updated_at();
drop trigger if exists myfans_posts_set_updated_at on public.myfans_posts;
create trigger myfans_posts_set_updated_at before update on public.myfans_posts
for each row execute function public.set_updated_at();
drop trigger if exists myfans_plans_set_updated_at on public.myfans_plans;
create trigger myfans_plans_set_updated_at before update on public.myfans_plans
for each row execute function public.set_updated_at();
drop trigger if exists video_source_link_evidence_set_updated_at on public.video_source_link_evidence;
create trigger video_source_link_evidence_set_updated_at before update on public.video_source_link_evidence
for each row execute function public.set_updated_at();

alter table public.myfans_creators enable row level security;
alter table public.myfans_posts enable row level security;
alter table public.myfans_plans enable row level security;
alter table public.myfans_post_plans enable row level security;
alter table public.video_source_link_evidence enable row level security;

drop policy if exists "admin manage myfans creators" on public.myfans_creators;
create policy "admin manage myfans creators" on public.myfans_creators for all to authenticated
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');
drop policy if exists "admin manage myfans posts" on public.myfans_posts;
create policy "admin manage myfans posts" on public.myfans_posts for all to authenticated
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');
drop policy if exists "admin manage myfans plans" on public.myfans_plans;
create policy "admin manage myfans plans" on public.myfans_plans for all to authenticated
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');
drop policy if exists "admin manage myfans post plans" on public.myfans_post_plans;
create policy "admin manage myfans post plans" on public.myfans_post_plans for all to authenticated
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');
drop policy if exists "admin manage video source link evidence" on public.video_source_link_evidence;
create policy "admin manage video source link evidence" on public.video_source_link_evidence for all to authenticated
  using ((auth.jwt()->'app_metadata'->>'role')='admin')
  with check ((auth.jwt()->'app_metadata'->>'role')='admin');

revoke all on public.myfans_creators, public.myfans_posts, public.myfans_plans,
  public.myfans_post_plans, public.video_source_link_evidence from public, anon;
grant all on public.myfans_creators, public.myfans_posts, public.myfans_plans,
  public.myfans_post_plans, public.video_source_link_evidence to authenticated, service_role;

comment on table public.myfans_creators is
  'Private staging model for public MyFans creator metadata. No anonymous access policy.';
comment on table public.myfans_posts is
  'Private staging model for public MyFans post metadata. Paid/protected payloads and media URLs are excluded.';
comment on table public.myfans_plans is
  'Private staging model for public MyFans plan metadata. External IDs remain nullable until officially observed.';
comment on table public.video_source_link_evidence is
  'Auditable evidence for cross-source canonical links; fuzzy matching never approves a link automatically.';
