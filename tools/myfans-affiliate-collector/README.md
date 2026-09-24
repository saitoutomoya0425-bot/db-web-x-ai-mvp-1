# MyFans Affiliate Catalog Local Collector

Chrome Manifest V3 extension for exporting catalog text already rendered in the signed-in MyFans Affiliate Center UI. It is a local-only pilot: it does not call MyFans APIs, generate affiliate links, access browser credentials, download images, or write to a database.

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select this `tools/myfans-affiliate-collector/` directory.
5. Open or reload a supported Affiliate Center catalog page.

## Use

Open the extension popup on a supported page, then select one action:

- **現在ページを取得** exports the visible page once.
- **新規収集（最大5ページ）** starts at page 1 of the current canonical search/category scope.
- **続きから収集（最大5ページ）** resumes that same scope from its saved checkpoint.
- **Diagnostic / Probe** exports an anonymized structure summary when parsing does not match the current UI.

Each bounded list run downloads a run export and a cumulative export. The cumulative state is also held in extension-local storage, keyed by a canonical scope that excludes `page` but includes the route, category/search filters, media filter, and sort. A checkpoint is never reused across different scopes.

Unknown or duplicate pagination/filter query keys are not discarded into a broader scope; resumable collection stops until the scope contract is updated.

Every run remains capped at five successfully collected pages. Resume uses either the exact URL from the visible `次へ` link or returns to the last observed page and activates its normal visible `次へ` control. It never computes or guesses a future page URL.

The popup shows run post, creator, page, warning counts, cumulative unique post count, and at most three text-only samples.

## Supported pages

- `/affiliates/search` and child routes used for post search
- `/affiliates/search/creators`
- `/affiliates/search/creators/tab/registered`
- creator detail routes under `/affiliates/search/creators/`
- `/affiliates/generated` child routes are permitted for visible-link detection, but are not the Phase 1 parsing priority

The content script is not installed on report, account, media-management, or payment pages.

## Safety boundary

- Text and visible public URLs only
- No image, avatar, thumbnail, OGP, poster, media blob, or video URL fields
- No cookies, tokens, page local/session storage, credential values, raw HTML, screenshots, network capture, or request interception
- Checkpoint and cumulative catalogs use only `chrome.storage.local`; the page's storage is never read
- No extension-originated `fetch` or XHR
- No copy/generate button activation; only the normal visible `次へ` control may be clicked
- Login redirects, rate-limit/anti-bot text, unexpected visible modals, timeouts, and duplicate page fingerprints stop collection
- Output is local JSON only; the included staging-plan function has `apply: false` and performs no database operation

## Checkpoint and merge contract

The checkpoint records collector version, canonical scope, start/last page, an observed next-page candidate, pages collected in the run, cumulative UUID count, seen UUIDs, timestamps, completion state, and stop reason. Missing or disabled `次へ` is the only `COMPLETE` condition. Five-page bounds remain `IN_PROGRESS`; login, rate-limit/anti-bot, modal, timeout, or duplicate-page stops remain `INTERRUPTED`.

Cumulative merge uses the strict post UUID as identity. A new UUID is added, an identical allowed-field observation is a no-op, an allowed-field change replaces the latest observation as an update candidate, and a UUID/creator identity conflict fails closed before storage is changed. Records absent from later snapshots are never deleted or unpublished. Per-post and per-creator sidecars retain first/last seen time, run, source page, and collector version without raw HTML or media URLs.

The run export remains the existing `myfans-affiliate-catalog-local-v1` record shape with run metadata. The cumulative export uses the same catalog record schema plus `cumulative_schema_version`, checkpoint/run summaries, and observation sidecars. The dry-run importer accepts both collector `0.1.8` and `0.2.0`; it still performs no database or network operation.

See [MYFANS_LOCAL_COLLECTOR.md](../../docs/MYFANS_LOCAL_COLLECTOR.md) for the field policy and operational notes.

## Targeted tests

From the repository root:

```bash
node --test tools/myfans-affiliate-collector/tests/*.test.mjs
node --check tools/myfans-affiliate-collector/src/collector-core.js
node --check tools/myfans-affiliate-collector/src/content-script.js
node --check tools/myfans-affiliate-collector/src/popup.js
```

All fixtures are synthetic and sanitized. No real creator, post, account, or Affiliate Center HTML is stored in the repository.

## DB dry-run preview

Collector `0.1.8` snapshot exports and `0.2.0` run/cumulative exports can be validated and normalized into a migration-029-shaped preview without opening a database connection:

```bash
node tools/myfans-affiliate-collector/bin/dry-run-import.mjs \
  /path/to/myfans-affiliate-catalog-*.json --summary-only
```

Remove `--summary-only` to print the complete normalized preview to standard output. The command never writes an output file, imports a database client, reads environment credentials, or performs a network request. Its report always includes `apply: false`, `db_query_count: 0`, and `db_write_count: 0`.

See [MYFANS_DRY_RUN_IMPORTER.md](../../docs/MYFANS_DRY_RUN_IMPORTER.md) for the identity contract, field mapping, and known schema gaps.

## Read-only database resolution

After the local dry-run passes, resolve migration-029 identities and classify existing rows without writing:

```bash
node --env-file=.env.local \
  tools/myfans-affiliate-collector/bin/resolve-staging-plan.mjs \
  /path/to/myfans-affiliate-catalog-*.json --summary-only
```

The resolver stops if the MyFans `data_sources` row is absent or ambiguous. Otherwise it issues only three target-bounded `SELECT` queries, reports insert/update/no-op counts, and proves second-run idempotency in memory. It never prints raw database IDs. See [MYFANS_READ_ONLY_STAGING_PLAN.md](../../docs/MYFANS_READ_ONLY_STAGING_PLAN.md).
