# MyFans read-only import resolution

Status: `SELECT_ONLY / APPLY_FALSE / FAIL_CLOSED`

This phase resolves a validated MyFans Affiliate Collector `0.1.8` snapshot or `0.2.x` run/cumulative preview against migration 029 without changing the database. Missing UUIDs in a later cumulative observation are never treated as delete/unpublish candidates. The resolver performs at most three bounded `SELECT` statements and has no mutation path:

1. locate the single MyFans row in `data_sources`;
2. resolve only the 30 imported creator identities by external ID, profile slug, or canonical profile URL;
3. resolve only the 100 imported post UUIDs.

If the first query returns zero or multiple source rows, resolution stops immediately. Creator names are never identity keys. Database UUIDs are used only in memory; reports contain a short SHA-256-derived token instead.

## Command

```bash
node --env-file=.env.local \
  tools/myfans-affiliate-collector/bin/resolve-staging-plan.mjs \
  /path/to/myfans-affiliate-catalog-*.json \
  --summary-only
```

The command always reports `apply=false`, `database_mode=SELECT_ONLY`, and `db_write_count=0`. It does not contact MyFans.

## Resolution contracts

Creators are classified as:

- `EXISTING_EXACT`: one row matches a stable external ID, normalized profile slug, or canonical profile URL, with no identity contradiction;
- `NEW`: none of those stable keys match;
- `AMBIGUOUS`: the stable keys point to more than one row;
- `CONFLICT`: one candidate has a contradictory slug, URL, or fallback external ID.

An existing creator may have a planned metadata update while remaining `EXISTING_EXACT`. Only `profile_slug` and `display_name` are compared for this collector. Existing visibility, review state, image, biography, raw metadata, and account-scoped fields are not overwritten. New creators use a hashed temporary key until a later authorized insert resolves their database ID.

Posts are classified as:

- `NEW`;
- `EXISTING_IDENTICAL`;
- `EXISTING_UPDATE_NEEDED` for differences in allowed collector-owned fields only;
- `CONFLICT` for duplicate UUID rows, canonical URL disagreement, or creator-relation disagreement.

Allowed post comparison fields are `title`, `content_type`, `media_indicator`, `price`, and `currency`. Image fields, relative dates, reward fields, affiliate state, diagnostics, credentials, and account data never enter the planned core-table mutation.

## Idempotency simulation

When the first pass has no ambiguity or conflict, the resolver applies its proposed inserts and updates to an in-memory snapshot only, then runs the same resolution again. A ready plan requires the second run to have:

```text
creator inserts 0
creator updates 0
post inserts 0
post updates 0
ambiguity 0
conflicts 0
all posts EXISTING_IDENTICAL
```

No transaction, RPC, storage call, or database write is used for the simulation.

## Current production result

On 2026-09-24, the bounded source-resolution query returned zero MyFans `data_sources` rows. The run stopped after that single query, before reading `myfans_creators` or `myfans_posts`:

```text
status BLOCKED
reason MYFANS_DATA_SOURCE_NOT_FOUND
DB queries 1
DB writes 0
MyFans requests 0
```

No canonical source name/type or planned creator/post mutation count can be asserted until a uniquely identified source row exists. Creating that row is a separate, explicitly authorized write phase; this read-only tool will not create it.
