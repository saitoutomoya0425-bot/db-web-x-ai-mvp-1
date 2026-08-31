# MyFans public metadata integration foundation

Status: Phase 6A research complete; ingestion and publication remain disabled.

Reviewed: 2026-08-31 (Asia/Tokyo)

## Decision

MyFans can be represented as an official external source, but the current catalog cannot safely publish MyFans entities without new schema and source-aware presentation contracts. Phase 6A therefore ships documentation only. It does not add a fetcher, parser, database migration, candidate writer, publication path, affiliate URL generator, or runtime route.

The approved boundary is `PUBLIC_METADATA_ONLY`:

- anonymous metadata intentionally exposed by MyFans may be researched;
- paid/member-only media, protected APIs, login state, age-gate bypass, and media-body downloads are excluded;
- creator content is referenced by official URL and is not copied or rehosted;
- an affiliate URL may be stored only after separate MyFans affiliate enrollment, media review, and per-creator/per-post eligibility have been established;
- ambiguous source access, identity, visibility, or rights fails closed.

## Official-source findings

### Access and policy

- `https://myfans.jp/robots.txt` returned `Allow: /` and an official sitemap reference.
- `https://support.myfans.jp/robots.txt` allows public help articles while disallowing account, authentication, ticket, private API-statistics, and other protected paths.
- The terms reviewed do not contain an explicit public scraping clause, but creator content ownership is retained by the creator and unauthorized reposting is prohibited. Robots permission is not a license to reuse content.
- The anonymous home surface exposes public genres, creator profile links, post UUID links, titles/teasers, relative timestamps, and limited media indicators. A mandatory 18+ interstitial was present; Phase 6A did not interact with or bypass it.
- No official public developer API or public feed was located in the official documentation surfaces reviewed. This is a research result, not proof that no private or future API exists.

### Public entity model

| Entity | Publicly documented/observed metadata | Phase 6A use |
| --- | --- | --- |
| Creator | stable profile slug/URL, display name, profile metadata, genres/tags where shown | stage identity and official URL only |
| Post | stable post UUID/URL, creator link, public title/teaser, public/free vs paid context, relative/published time where shown, public thumbnail/OGP reference where shown | stage public metadata only; never fetch protected body/media |
| Plan | plan existence, plan-based paid access, plan/post relation | schema design only; no public detail probe |
| Offer | single-sale and plan-based purchase are documented; public prices may exist on eligible surfaces | retain raw public value and currency only after an eligible probe |
| Genre/tag/ranking | genres, tags, discovery, and rankings are documented public navigation concepts | descriptive metadata only; never infer stable identity from rank |
| Affiliate | creator/post URLs can be converted only by approved affiliates and only when the target allows it | separate post-enrollment phase; never synthesize an affiliate URL |

## Existing schema reuse

### Safe to reuse

- `data_sources`: add one inactive/manual-review MyFans source record in a future migration. `source_type` can remain `other` until an official API/feed is documented.
- `source_products`: use only as immutable, provenance-rich staging for a public MyFans entity. Namespace `external_product_id` by entity kind, for example `myfans:post:<uuid>` and `myfans:creator:<slug>`. Store `entity_type` inside normalized data until a dedicated column exists.
- `video_source_links`: use only after human-reviewed cross-source linkage to a canonical work. Confidence alone is insufficient; match method, reviewer, and evidence must be recorded.
- `product_offers`: potentially reusable for a reviewed post offer only after a canonical work link exists. It does not model creators, plans, or post-plan membership.

### Not safe to reuse as-is

- `videos`: it requires a commercial-video-shaped product code and presentation fields. Writing a MyFans creator, plan, or post directly would create false semantics.
- FANZA normalization, promotion, publication safety, image allowlisting, and affiliate logic: all contain FANZA/DMM-specific identity, relation, host, and media assumptions.
- Public query media handling: current card/detail normalization only trusts FANZA image hosts. MyFans requires a source-aware media policy before any public render.

## Required schema foundation

Phase 6B should begin with schema and offline-fixture work, not network ingestion.

Minimum dedicated model:

1. `myfans_creators`
   - source identity, stable slug, official URL, public display metadata, visibility, observed/fetched timestamps, payload hash, provenance, review status.
2. `myfans_posts`
   - stable post UUID, creator identity, official URL, public title/description, visibility (`PUBLIC`, `FREE`, `PAID_METADATA_ONLY`, `LIMITED`, `UNKNOWN`), published/observed timestamps, public price fields, media-reference metadata, payload hash, provenance, review status.
3. `myfans_plans`
   - stable source identity, creator identity, official URL, public name/description/price/currency where explicitly visible, visibility, provenance, review status.
4. `myfans_post_plans`
   - explicit source-observed post-plan membership; never infer membership from price or copy.
5. An auditable canonical-link table or extension
   - source entity type/id, canonical target type/id, match method, confidence, evidence hash, reviewer, status, timestamps.

All new records start non-public. No migration should backfill or mutate existing FANZA rows.

## Normalization and identity

### Stable source keys

- creator: exact official profile slug (case-preserving raw value plus a normalized comparison key);
- post: exact UUID from the official `/posts/<uuid>` URL;
- plan: exact official plan identifier only when observed; never derive one from display text;
- official URL: HTTPS, `myfans.jp`, credentials absent, non-standard port absent, tracking query removed from the canonical identity but retained in raw provenance if needed.

### Dedupe order

1. exact source + entity type + stable external ID;
2. exact normalized official canonical URL;
3. exact official creator identity plus exact post/plan identity;
4. human-reviewed canonical linkage with evidence.

Never auto-merge on creator name, title, description, price, thumbnail hash, visual similarity, rank, or posting time. A MyFans post and a FANZA commercial work remain distinct unless a reviewer confirms they represent the same canonical work.

### Conflict handling

- source-local stable ID conflicts are `INVALID_SOURCE_IDENTITY` and block persistence;
- visibility ambiguity is `NEEDS_VISIBILITY_REVIEW` and blocks publication;
- creator/work/person matches are `NEEDS_HUMAN_LINK` unless exact previously reviewed evidence exists;
- differing public metadata creates a new immutable observation; it does not overwrite provenance;
- paid/protected evidence is never acquired to resolve a conflict.

## Provenance contract

Every staged observation must record:

- source name and entity type;
- exact official URL and normalized URL;
- observed/fetched timestamp;
- HTTP status and public/anonymous access classification;
- parser version and normalized payload version;
- raw metadata hash and normalized metadata hash;
- terms/robots research version;
- visibility and media-rights classification;
- fetch/request ID and duplicate-request guard key;
- review status and reason codes.

Media fields are references only. Phase 6A authorizes no image or video copying.

## Publication safety design

A future MyFans publication gate must be independent of the FANZA gate and require all of:

- `PUBLIC_METADATA_ONLY` source classification;
- exact stable source identity and official HTTPS URL;
- no credentials, non-standard port, login redirect, paid body, or protected API evidence;
- explicit creator/post/plan hierarchy;
- reviewed visibility and canonical-link decision;
- trusted source-aware thumbnail policy, or no thumbnail rendering;
- public official URL as the default outbound link;
- affiliate URL only when enrollment and target eligibility are recorded;
- idempotent candidate persistence with dry-run default;
- `apply=false` and non-public state until a separate human approval.

The gate must fail closed with reason codes such as `SOURCE_ACCESS_BLOCKED`, `PAID_CONTENT_EXCLUDED`, `AFFILIATE_ENROLLMENT_REQUIRED`, `IDENTITY_AMBIGUOUS`, `CREATOR_MODEL_REQUIRED`, `POST_MODEL_REQUIRED`, and `MEDIA_POLICY_REQUIRED`.

## Phase 6B recommendation

Recommended order:

1. Add the dedicated creator/post/plan schema and an immutable observation/provenance contract.
2. Add offline fixtures copied only from the Phase 6A normalized metadata shape, with no media bodies.
3. Implement an offline parser and validation tests.
4. Add a read-only exact-URL probe only after legal/operational approval of anonymous automated metadata access.
5. Stage at most three `apply=false` candidates; perform no publication.
6. Enroll in the official affiliate program separately before generating or storing affiliate URLs.

Do not begin bulk discovery, sitemap traversal, media download, database writes, or public rendering in Phase 6B.
