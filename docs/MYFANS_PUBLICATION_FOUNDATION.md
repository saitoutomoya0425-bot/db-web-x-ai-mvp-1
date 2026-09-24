# MyFans publication foundation

This foundation keeps the imported MyFans catalog private while making publication decisions deterministic and testable. It does not activate the MyFans data source, grant anonymous access, add a public route, or copy MyFans records into `videos`.

## State separation

The migration-029 `visibility` and `review_status` fields describe source content/access and ingestion review. Publication is an independent decision, so migration 030 adds:

- creators: `publication_visibility`, `publication_review_state`
- posts: `publication_visibility`, `publication_review_state`, `affiliate_link_status`, nullable `affiliate_url`

Storage values are lowercase. Conceptual defaults are `UNKNOWN`, `NEEDS_REVIEW`, and `MISSING`. Existing records receive those fail-closed defaults and are never promoted to `APPROVED` automatically.

`publication_visibility` values:

- `unknown`
- `public_general`
- `affiliate_visible`
- `approved_affiliate_only`
- `not_public`

`publication_review_state` values:

- `needs_review`
- `approved`
- `rejected`
- `blocked`

`affiliate_link_status` values:

- `missing`
- `active`
- `ineligible`
- `revoked`

## Publication decision

`src/lib/myfans/publication.ts` is the pure source contract. A post is eligible only when creator and post visibility are publishable, both review states are approved, the source and creator relation are exact, the title and UUID-bound canonical URL are valid, and the adapter found no prohibited/private fields.

Images are not required. The preview uses a local neutral placeholder and never reads a MyFans thumbnail or avatar URL.

Affiliate state is independent of publication eligibility. `missing`, `ineligible`, and `revoked` always hide the affiliate CTA. `active` shows it only when the URL is a credential-free HTTPS MyFans URL. The canonical outbound URL remains the post `official_url`; it is never relabeled as an affiliate URL.

## Approved-only projection

`public.myfans_approved_publication_projection` is a security-invoker, security-barrier allowlist view. It requires:

- active `MyFans Affiliate Center` data source
- approved creator and post review states
- publishable creator and post visibility states
- non-empty display name and title
- exact `https://myfans.jp/posts/<external_post_id>` canonical URL

The view excludes raw metadata, images, account data, and internal database IDs. All privileges are revoked from `public`, `anon`, and `authenticated`; only `service_role` receives `SELECT`. Core MyFans table grants and RLS are unchanged.

## Private preview

`src/lib/myfans/private-preview.ts` maps an authorized server-side record to a source-neutral preview model. `src/components/private/source-neutral-preview-card.tsx` renders that model with a neutral placeholder, source badge, optional price, canonical link, gate status, and affiliate CTA decision.

There is deliberately no page, route, navigation link, sitemap entry, public query, or production loader for this component. A later authorized phase can mount it behind an explicit private server-side access boundary without changing its data contract.

## Read-only pre-review

Phase 6K.7 adds a deterministic pre-review in `src/lib/myfans/publication-review.ts` and an aggregate-only database runner in `scripts/myfans-publication-review.ts`. It treats current fail-closed publication state as an output rather than a reason for circular human review. The production aggregate result and simulation are recorded in [MyFans publication review classification](./MYFANS_PUBLICATION_REVIEW_CLASSIFICATION.md).
