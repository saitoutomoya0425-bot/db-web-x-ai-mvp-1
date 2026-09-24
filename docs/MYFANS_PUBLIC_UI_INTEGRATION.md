# MyFans public UI integration (disabled)

Phase 6K.9 prepares a source-aware public catalog without publishing MyFans. The server-only feature flag is `MYFANS_PUBLIC_ENABLED`; absence and every value other than the exact string `true` are disabled. The checked-in example remains `false`.

## Architecture

The existing FANZA `videos` queries and `PublicWorkCard` remain the FANZA adapter. MyFans is never copied into `videos`. A separate server-only adapter reads only `myfans_approved_publication_projection` with the service-role client, validates every row again, and maps it to a source-neutral public work model. The projection itself still requires `data_sources.is_active=true` and remains unavailable to `public`, `anon`, and `authenticated`.

When the flag is false, the MyFans loader is not invoked. Catalog/search results contain the existing FANZA rows only, the MyFans detail route returns 404, and the sitemap receives no MyFans rows.

## Public model and UI

MyFans models expose only the allowlisted projection fields: UUID identity, title, creator display name/profile slug, optional price, media type, canonical MyFans URL, affiliate state/link, and source badge. The card and detail components use a CSS/local neutral placeholder and contain no MyFans image URL. They never synthesize a product code, actress, maker, FANZA image, or affiliate URL.

The detail route is collision-free: `/work/myfans/<post UUID>`. Its canonical CTA is labelled `MyFansで作品を見る` and uses the canonical public URL. The separate affiliate CTA appears only for `active` plus a valid MyFans affiliate URL; the current 100 `missing/NULL` rows produce zero affiliate CTAs.

## Query coverage

- `/works` uses the source-aware catalog aggregator.
- `/search` adds MyFans title/creator keyword matches only when no FANZA-only actress/maker/series filter is active.
- The home-page newest carousel uses the source-aware model.
- Popularity and entity rankings remain FANZA-only because no comparable MyFans ranking signal exists.
- MyFans catalog rows have no trustworthy cross-source publication timestamp in the approved projection. Each source retains deterministic internal order; the aggregation layer does not claim a unified chronological or popularity ranking.

## SEO and publication safety

The MyFans route is `notFound()` and returns no indexable metadata while disabled. Sitemap integration calls the same gated projection loader, so the disabled result is zero. No migration, grant, policy, source activation, public database permission, or Vercel environment activation is part of this phase.

## Private production preview

`scripts/myfans-public-ui-preview.ts` reads the approved core rows inside a read-only transaction, creates only the public allowlist model, and emits aggregates. It never selects images, raw metadata, account fields, or individual titles/identifiers. The expected disabled-state result is 100 renderable cards/details, 100 neutral placeholders and canonical links, 0 affiliate CTAs, 12 omitted prices, 1 safe unknown-media value, and 0 current projection rows because the source remains inactive.
