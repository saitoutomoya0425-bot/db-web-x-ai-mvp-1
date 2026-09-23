-- Fail-closed publication metadata for private MyFans staging records.
-- This migration does not approve, activate, or anonymously expose any row.

alter table public.myfans_creators
  add column if not exists publication_visibility text not null default 'unknown'
    check (publication_visibility in (
      'unknown','public_general','affiliate_visible','approved_affiliate_only','not_public'
    )),
  add column if not exists publication_review_state text not null default 'needs_review'
    check (publication_review_state in ('needs_review','approved','rejected','blocked'));

alter table public.myfans_posts
  add column if not exists publication_visibility text not null default 'unknown'
    check (publication_visibility in (
      'unknown','public_general','affiliate_visible','approved_affiliate_only','not_public'
    )),
  add column if not exists publication_review_state text not null default 'needs_review'
    check (publication_review_state in ('needs_review','approved','rejected','blocked')),
  add column if not exists affiliate_link_status text not null default 'missing'
    check (affiliate_link_status in ('missing','active','ineligible','revoked')),
  add column if not exists affiliate_url text
    check (
      affiliate_url is null
      or affiliate_url ~ '^https://[^/@:]+([/?#]|$)'
    );

create index if not exists myfans_creators_publication_ready_idx
  on public.myfans_creators(data_source_id, id)
  where publication_review_state = 'approved'
    and publication_visibility in ('public_general','affiliate_visible','approved_affiliate_only');

create index if not exists myfans_posts_publication_ready_idx
  on public.myfans_posts(data_source_id, creator_id, id)
  where publication_review_state = 'approved'
    and publication_visibility in ('public_general','affiliate_visible','approved_affiliate_only');

create or replace view public.myfans_approved_publication_projection
with (security_invoker = true, security_barrier = true)
as
select
  p.external_post_id,
  p.title,
  p.official_url as canonical_outbound_url,
  p.price,
  p.currency,
  coalesce(p.media_indicator, p.content_type, 'unknown') as media_type,
  p.affiliate_link_status,
  p.affiliate_url,
  (
    p.affiliate_link_status = 'active'
    and p.affiliate_url ~ '^https://([[:alnum:]-]+[.])*myfans[.]jp([/?#]|$)'
    and p.affiliate_url !~ '@'
  ) as show_affiliate_cta,
  c.external_creator_id,
  c.profile_slug as creator_profile_slug,
  c.display_name as creator_display_name,
  c.official_url as creator_canonical_url,
  'MyFans'::text as source_badge
from public.myfans_posts p
join public.myfans_creators c
  on c.id = p.creator_id
 and c.data_source_id = p.data_source_id
join public.data_sources ds
  on ds.id = p.data_source_id
where ds.name = 'MyFans Affiliate Center'
  and ds.is_active = true
  and c.publication_review_state = 'approved'
  and c.publication_visibility in ('public_general','affiliate_visible','approved_affiliate_only')
  and p.publication_review_state = 'approved'
  and p.publication_visibility in ('public_general','affiliate_visible','approved_affiliate_only')
  and char_length(trim(c.display_name)) > 0
  and char_length(trim(p.title)) > 0
  and lower(p.official_url) = 'https://myfans.jp/posts/' || lower(p.external_post_id);

revoke all on public.myfans_approved_publication_projection from public, anon, authenticated;
grant select on public.myfans_approved_publication_projection to service_role;

comment on column public.myfans_creators.publication_visibility is
  'Reviewed publication scope. UNKNOWN is fail-closed and is distinct from source content visibility.';
comment on column public.myfans_creators.publication_review_state is
  'Human publication review state. Existing rows default to NEEDS_REVIEW.';
comment on column public.myfans_posts.publication_visibility is
  'Reviewed publication scope. UNKNOWN is fail-closed and is distinct from source content visibility.';
comment on column public.myfans_posts.publication_review_state is
  'Human publication review state. Existing rows default to NEEDS_REVIEW.';
comment on column public.myfans_posts.affiliate_link_status is
  'Affiliate CTA lifecycle. MISSING never blocks text-only publication and never enables the CTA.';
comment on column public.myfans_posts.affiliate_url is
  'Optional generated affiliate URL. Canonical outbound URL remains myfans_posts.official_url.';
comment on view public.myfans_approved_publication_projection is
  'Service-only allowlist projection. No anonymous/authenticated grant; core MyFans tables remain private.';
