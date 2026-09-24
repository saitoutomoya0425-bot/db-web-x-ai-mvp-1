# MyFans publication review classification

Phase 6K.7 classifies the 30 private creators and 100 private posts without changing publication state. It uses only the stored text catalog, exact source/identity relations, the written MyFans support response summarized in `MYFANS_LOCAL_COLLECTOR.md`, and the Phase 6K.6 publication contract.

## Review boundary

- Registered/approved affiliate media may publish information visible on the official MyFans service.
- Approved-only works may be introduced by an affiliate approved by that creator.
- Creator images, thumbnails, OGP, video, and other third-party media remain excluded without creator permission.
- The review is text-only and uses a local neutral placeholder.
- Missing affiliate URLs hide the affiliate CTA but do not block the catalog record itself.
- Adult content is not a rejection reason. Only technical, identity, provenance, privacy, rights, and contract conditions are evaluated.
- Existing `publication_visibility=unknown` and `publication_review_state=needs_review` are outputs-to-be-decided, not circular review reasons.

## Deterministic classifier

`src/lib/myfans/publication-review.ts` provides pure creator/post classifiers and an in-memory approval simulation. `scripts/myfans-publication-review.ts` reads the target source, creators, and posts in a read-only transaction and prints aggregates only. It never prints creator names, slugs, titles, URLs, or database IDs.

Classifications:

- `AUTO_APPROVABLE`: exact text-only contract is complete; proposed state is `affiliate_visible / approved`.
- `NEEDS_HUMAN_REVIEW`: the data is not known-invalid, but permission, rights, identity evidence, or unexpected metadata requires a person.
- `REJECT`: exact source/identity/relation/required-field validation failed or prohibited private data is present.

## Production read-only result

Run date: 2026-09-24.

| Entity | AUTO_APPROVABLE | NEEDS_HUMAN_REVIEW | REJECT |
| --- | ---: | ---: | ---: |
| creators | 30 | 0 | 0 |
| posts | 100 | 0 | 0 |

Reason-code counts:

| Reason | Count | Effect |
| --- | ---: | --- |
| `TEXT_ONLY_CREATOR_CONTRACT_SATISFIED` | 30 | auto-approvable |
| `TEXT_ONLY_POST_CONTRACT_SATISFIED` | 100 | auto-approvable |
| `AFFILIATE_LINK_MISSING_NON_BLOCKING` | 100 | CTA hidden; publication not blocked |
| `OPTIONAL_PRICE_MISSING` | 12 | price omitted |
| `OPTIONAL_MEDIA_TYPE_UNKNOWN` | 1 | source-neutral `unknown` label; publication not blocked |

All 100 auto-approvable posts depend on an auto-approvable creator. Creator review dependency blocks: 0. Creator rejection blocks: 0.

## In-memory approval simulation

Only `AUTO_APPROVABLE` records were simulated as `affiliate_visible / approved`; no database state was changed.

| Result | Count |
| --- | ---: |
| eligible posts | 100 |
| blocked posts | 0 |
| projection candidates | 100 |
| affiliate CTA visible | 0 |
| neutral placeholders | 100 |

The actual approved projection remains empty because every production publication state remains fail-closed and `data_sources.is_active=false`.

## Human review package

No Phase 6K.7 record entered `NEEDS_HUMAN_REVIEW`, so no item-by-item review package is required. Future batches can be grouped by reason code; only permission/rights exceptions, unexpected metadata, identity ambiguity, or creator dependency need human review.
