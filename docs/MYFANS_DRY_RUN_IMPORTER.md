# MyFans catalog dry-run importer

Status: `LOCAL_NORMALIZATION_ONLY / APPLY_FALSE / NO_DB_CONNECTION`

This importer validates MyFans Affiliate Collector `0.1.8` snapshot JSON and `0.2.0`/`0.2.1`/`0.3.0`/`0.3.1`/`0.3.2` bounded run/cumulative JSON, then produces a deterministic migration-029-shaped preview. The resumable checkpoint/run/observation sidecars are validated by the collector boundary but are not mapped into migration 029. The importer has no Supabase/Postgres dependency, performs no network request, and cannot apply its output.

## Command

```bash
node tools/myfans-affiliate-collector/bin/dry-run-import.mjs \
  /path/to/myfans-affiliate-catalog-*.json --summary-only
```

Without `--summary-only`, normalized creator/post previews are emitted to standard output. No file is created. Every report fixes these counters at:

```text
apply=false
database_apply_supported=false
db_query_count=0
db_write_count=0
network_request_count=0
```

## Identity and deduplication

- Post identity is the lowercase UUID cross-checked against the exact canonical `https://myfans.jp/posts/<uuid>` URL. Migration 029 dedupes it as `data_source_id + external_post_id`.
- Creator identity is the observed username/profile slug. The fallback external ID is `profile_slug:<lowercase-slug>`. Display name is never an identity and is never used to merge creators.
- An identical repeated post UUID is skipped. A repeated UUID with different normalized catalog fields is `DUPLICATE_CONFLICTING_UUID` and fails the dry-run.
- `data_source_id` and `creator_id` require future read-only DB resolution. They remain `null` in the preview, so the preview is deliberately not directly writable.

## Field mapping

| Class | Source fields | Migration 029 destination or action |
| --- | --- | --- |
| A: direct | post UUID/URL, title, media type, price, creator name | `myfans_posts.external_post_id/official_url/title/content_type/media_indicator/price`; `myfans_creators.display_name` |
| B: normalized | creator username, observed timestamp, JPY currency, canonical hashes | creator slug/external ID/official URL, `fetched_at`, `currency`, `metadata_hash` |
| C: no destination | reward rate/amount, eligibility, duration, likes, collector/source provenance | retained only in the dry-run sidecar and reported as schema gaps |
| D: prohibited/not stored | images, avatar/thumbnail/OGP/video URL, relative time, diagnostic data, affiliate URL, raw HTML, credentials/account data | rejected or intentionally omitted; `published_at` and image columns stay `null` |
| E: hold | plans without stable IDs, exact affiliate visibility/approval state | no `myfans_plans`/`myfans_post_plans` row; do not overload migration-029 visibility |

`raw_public_metadata` remains `{}` because authenticated affiliate observations must not be placed into the public-metadata payload. Reward, eligibility, metrics, and provenance are visible in the sidecar only; they are not silently dropped into unrelated columns.

## Fail-closed validation

The importer rejects or stops for:

- unexpected schema or collector version;
- non-rendered-UI source contract or source warnings;
- prohibited image/private/account/credential fields at any depth;
- missing or malformed post UUID and UUID/URL disagreement;
- malformed creator username/profile URL or missing creator identity;
- negative/non-integer money, invalid rate, impossible reward/price relationships;
- invalid source route/surface or timestamps;
- conflicting duplicate UUID or creator identity.

Null price and estimated reward are permitted and remain null. Relative publication text is never converted into an exact timestamp.

## Schema gaps before any write phase

- Resolve the existing MyFans `data_sources.id` by read-only query.
- Resolve creator foreign keys after exact external-creator identity matching.
- Add an approved authenticated-observation/provenance model.
- Add account-scoped creator/post affiliate-state storage for eligibility and reward values.
- Add metric/duration storage only if still required and permitted.
- Persist plans only after a stable source plan ID is observed.

No migration is included in this phase. `myfans_plans`, `myfans_post_plans`, and `video_source_link_evidence` previews remain empty.
