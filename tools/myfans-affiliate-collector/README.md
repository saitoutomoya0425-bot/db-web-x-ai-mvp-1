# MyFans Affiliate Catalog Local Collector

Chrome Manifest V3 extension for exporting catalog text already rendered in the signed-in MyFans Affiliate Center UI. Collector `0.6.0` also prepares a fail-closed, user-started three-post pilot that uses only the official visible affiliate-link generation form. It does not call MyFans APIs, infer links, read the clipboard or browser credentials, download images, or write to a database.

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select this `tools/myfans-affiliate-collector/` directory.
5. Open or reload a supported Affiliate Center catalog page.

## Use

Open the extension popup on a supported page, then select one action:

- **続きから自動収集** is the normal operation. One click resumes the saved scope, automatically chains five-page atomic chunks up to 50 pages or catalog end, and saves one session summary plus the latest cumulative catalog.
- **現在ページを取得** exports the visible page once.
- **新規収集（内部5ページ）** and **1 chunkだけ収集（5ページ）** remain under Advanced / Diagnostic.
- **Diagnostic / Probe** exports an anonymized structure summary when parsing does not match the current UI.
- **Affiliate URL生成パイロット（最大3件）** uses the official visible generation form. One explicit click freezes three attested eligible/MISSING targets; no mass run starts.

Each internal chunk remains bounded to five pages and commits its cumulative/checkpoint state atomically. The background worker immediately starts the next chunk without requiring the popup. A normal session ends at 50 pages or a settled missing/disabled next control, then automatically saves exactly one lightweight session summary and one latest cumulative export. The cumulative state is keyed by a canonical scope that excludes `page` but includes the route, category/search filters, media filter, and sort. A checkpoint is never reused across different scopes.

Unknown or duplicate pagination/filter query keys are not discarded into a broader scope; resumable collection stops until the scope contract is updated.

Every run remains capped at five successfully collected pages. Resume uses either the exact URL from the visible `次へ` link or returns to the last observed page and activates its normal visible `次へ` control. It never computes or guesses a future page URL.

Collector `0.3.0` moves bounded-run ownership to an MV3 background service worker. Its persistent operation journal in `chrome.storage.local` is the source of truth; the popup is only a controller and status view. Closing the popup does not stop a run. Reopening it restores the active stage, pages staged, expected/current page, warning/error state, and completed export state.

Collector `0.3.1` restores bounded hydration readiness inside that durable architecture. For every transition, the current content script validates the page and visible next control and returns a preparation ACK without navigating. The service worker first journals the expected transition, then sends a separate navigation command. That command returns its ACK before scheduling the visible click. A content-script READY signal is only a re-evaluation trigger: the worker waits up to ten seconds for the expected scope/page, populated catalog records, a changed UUID fingerprint, and the same fingerprint after a 250ms settle window. This works for SPA-like changes and full document reloads without keeping a message response open across navigation.

Collector `0.3.2` makes completed exports deterministic across `chrome.storage.local` round-trips. Run and cumulative objects are recursively key-sorted, pretty-printed with exactly one trailing newline, encoded as UTF-8, and SHA-256 hashed. The exact serialized text that was hashed is retained in the operation journal and is also the exact text delivered to the local file. Run and cumulative artifacts have independent hashes and delivery states.

Collector `0.4.0` moves physical artifact delivery into the MV3 background service worker. It requests only the additional Chrome `downloads` permission, verifies each canonical artifact, and downloads the run artifact before the cumulative artifact with `conflictAction: "uniquify"`. The returned download ID, requested filename, Chrome-resolved filename, byte count, completion/interruption state, and delivery-attempt ID are journaled. Closing the popup does not interrupt delivery; worker restarts reconcile the persisted ID through `chrome.downloads.search`. Status reads are pure and never change a valid in-progress delivery.

Collector `0.5.0` adds a persistent automatic-session journal above the proven five-page operation state machine. Five pages are an internal atomic checkpoint, not a user interaction boundary. The default session chains up to ten chunks (50 pages), survives popup closure and service-worker restart, and never merges a partial failed chunk. It produces no physical per-chunk files. At session completion it derives an additive incremental dry-run (`NEW`, `EXISTING_IDENTICAL`, `UPDATE_NEEDED`, `CONFLICT`) against the starting cumulative baseline, explicitly proposes zero deletes/unpublishes, and marks `DB_SYNC_READY` only when no identity conflict exists. To avoid duplicating a growing cumulative JSON in `chrome.storage.local`, the final session journal retains canonical artifact hash/length metadata and the small logical summary; immediately before download, the worker deterministically regenerates the cumulative bytes from the formal catalog and requires the hash and length to match. This artifact prepares a later database resolver; it does not query or mutate a database.

Collector `0.6.0` adds a separate background-owned `AFFILIATE_GENERATION_SESSION`. It is hard-capped at three targets with a four-second cooldown and durable target/progress/result hashes. Popup closure and worker restart preserve the journal; after a dispatched click, recovery inspects the visible result and never clicks again. CAPTCHA, rate limit, login challenge, ineligible result, ambiguous selector/output, different-link conflict, or clipboard-only success stops fail-closed. Only a visible `https://link.affiliate.myfans.jp/...` result is accepted.

The journal retains the original hydration start/deadline, last observed page/record count/fingerprint, and settle candidate, so a service-worker restart resumes the remaining deadline instead of starting a new ten-second window. Temporary zero-row snapshots remain in `WAITING_FOR_NEW_DOCUMENT`; a permanent zero-row page fails as `CATALOG_ROWS_NOT_READY`, an unchanged fingerprint as `PAGE_FINGERPRINT_UNCHANGED`, and an unstable populated page as `PAGE_SNAPSHOT_NOT_STABLE`.

Staged page snapshots remain in the operation journal, not popup memory. Formal checkpoint/cumulative data is updated in one storage commit only after the entire bounded chunk succeeds. A channel failure, timeout, login redirect, anti-bot indication, modal, page mismatch, duplicate fingerprint, cancellation, or worker restart before commit leaves the previous successful checkpoint/cumulative catalog unchanged. Existing `0.2.0`, `0.2.1`, `0.3.0`, `0.3.1`, `0.3.2`, and `0.4.0` checkpoints are accepted and become `0.5.0` only after a successful chunk commit.

The worker recovers the journal after extension/browser startup, a new content-document readiness signal, or a popup status refresh. State transitions are explicit and invalid transitions fail closed. A worker restart during collection, navigation waiting, staging, or commit replays the idempotent stage. Operation ID and run ID prevent double merge, checkpoint advance, run-count increment, or export generation.

The popup shows cumulative count, checkpoint, automatic session/chunk progress, new unique posts, elapsed time, warning/stop state, and at most three text-only samples. It explicitly says that collection continues while the popup is closed.

## Supported pages

- `/affiliates/search` and child routes used for post search
- `/affiliates/search/creators`
- `/affiliates/search/creators/tab/registered`
- creator detail routes under `/affiliates/search/creators/`
- `/affiliates/generated` child routes are permitted for visible-link detection, but are not the Phase 1 parsing priority
- `/affiliates/search/from_url` and `/affiliates/url` are generation routes; the visible input and control must each be unique

The content script is not installed on report, account, media-management, or payment pages.

## Safety boundary

- Text and visible public URLs only
- No image, avatar, thumbnail, OGP, poster, media blob, or video URL fields
- No cookies, tokens, page local/session storage, credential values, raw HTML, screenshots, network capture, or request interception
- Operation journal, staged snapshots, checkpoint, and cumulative catalogs use only `chrome.storage.local`; the page's storage is never read
- No extension-originated `fetch` or XHR
- No copy-button activation or clipboard read. The generate control is activated only by the explicit three-post pilot on an official generation route.
- Login redirects, rate-limit/anti-bot text, unexpected visible modals, timeouts, and duplicate page fingerprints stop collection
- Output is local JSON only; the included staging-plan function has `apply: false` and performs no database operation

## Checkpoint and merge contract

The checkpoint records collector version, canonical scope, start/last page, an observed next-page candidate, pages collected in the run, cumulative UUID count, seen UUIDs, timestamps, completion state, and stop reason. Missing or disabled `次へ` is the only `COMPLETE` condition. Five-page bounds remain `IN_PROGRESS`; login, rate-limit/anti-bot, modal, timeout, or duplicate-page stops remain `INTERRUPTED`.

Cumulative merge uses the strict post UUID as identity. A new UUID is added, an identical allowed-field observation is a no-op, an allowed-field change replaces the latest observation as an update candidate, and a UUID/creator identity conflict fails closed before storage is changed. Records absent from later snapshots are never deleted or unpublished. Per-post and per-creator sidecars retain first/last seen time, run, source page, and collector version without raw HTML or media URLs.

Manual bounded-run export remains compatible. Automatic sessions instead emit a lightweight session summary and a cumulative export with an `incremental_sync` sidecar. The cumulative export remains `myfans-affiliate-catalog-local-v1` and can be passed directly to the dry-run importer. Export artifacts are generated once at session end and retained until delivery succeeds. Chrome marks an artifact delivered only after the Downloads API reports `complete` and readback confirms the expected filename family, exact byte length, and `exists=true`. Interrupted or unresolvable delivery never auto-retries. Delivered/downloading artifacts reject duplicate delivery. The dry-run importer accepts through collector `0.6.0`; it still performs no database or network operation.

See [MYFANS_LOCAL_COLLECTOR.md](../../docs/MYFANS_LOCAL_COLLECTOR.md) for the field policy and operational notes.

## Targeted tests

From the repository root:

```bash
node --test tools/myfans-affiliate-collector/tests/*.test.mjs
node --check tools/myfans-affiliate-collector/src/collector-core.js
node --check tools/myfans-affiliate-collector/src/export-artifacts.js
node --check tools/myfans-affiliate-collector/src/affiliate-generation-core.js
node --check tools/myfans-affiliate-collector/src/download-delivery.js
node --check tools/myfans-affiliate-collector/src/content-script.js
node --check tools/myfans-affiliate-collector/src/orchestrator-core.js
node --check tools/myfans-affiliate-collector/src/session-core.js
node --check tools/myfans-affiliate-collector/src/background.js
node --check tools/myfans-affiliate-collector/src/popup.js
```

All fixtures are synthetic and sanitized. No real creator, post, account, or Affiliate Center HTML is stored in the repository.

## DB dry-run preview

Collector `0.1.8` snapshot exports and `0.2.x` through `0.6.x` run/cumulative exports can be validated and normalized into a migration-029-shaped preview without opening a database connection:

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
