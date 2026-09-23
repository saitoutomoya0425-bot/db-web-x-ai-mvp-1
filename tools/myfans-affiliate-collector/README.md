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
- **一覧を収集（最大5ページ）** follows only a visible, enabled `次へ` control and stops after at most five pages.
- **Diagnostic / Probe** exports an anonymized structure summary when parsing does not match the current UI.

The first two actions download a `myfans-affiliate-catalog-*.json` file. The popup shows post, creator, page, and warning counts plus at most three text-only samples.

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
- No cookies, tokens, browser storage, credential values, raw HTML, screenshots, network capture, or request interception
- No extension-originated `fetch` or XHR
- No copy/generate button activation; only the normal visible `次へ` control may be clicked
- Login redirects, rate-limit/anti-bot text, unexpected visible modals, timeouts, and duplicate page fingerprints stop collection
- Phase 1 output is local JSON only; the included staging-plan function has `apply: false` and performs no database operation

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

Collector `0.1.8` exports can be validated and normalized into a migration-029-shaped preview without opening a database connection:

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
