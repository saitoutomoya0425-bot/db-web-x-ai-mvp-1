# MyFans Affiliate Catalog Local Collector

## Purpose and boundary

The Phase 6J collector is a Chrome Manifest V3 extension that exports text catalog metadata already rendered in the signed-in MyFans Affiliate Center. It is intended for a registered and approved affiliate media operator. The output remains a local JSON file for pilot validation; there is no production database writer.

The text-only boundary follows the MyFans support response received on 2026-09-17: information visible on the official site may be used by the registered/approved affiliate media, while creator images, work thumbnails, OGP, and video require prior creator permission. Phase 6J therefore excludes every media asset even when the DOM contains it.

The extension deliberately does not reproduce private APIs. It observes the current rendered DOM, visible labels, semantic links, accessible labels, and normal UI controls. It does not access cookies, tokens, session values, page local/session storage, raw HTML, request/response bodies, or the browser profile. Collector checkpoints use only the extension's own `chrome.storage.local` area.

Implementation: [tools/myfans-affiliate-collector/README.md](../tools/myfans-affiliate-collector/README.md)

## Supported surfaces

Phase 1 prioritizes:

- Affiliate post search and genre result pages under `/affiliates/search`
- Creator lists under `/affiliates/search/creators`
- Approved creator list under `/affiliates/search/creators/tab/registered`
- Creator detail pages under `/affiliates/search/creators/`

The manifest also permits `/affiliates/generated` child routes so a URL already displayed as text may be recognized. Version `0.6.1` supports the official per-post affiliate action already present on authenticated search-result cards, while retaining the separate `/affiliates/search/from_url` and `/affiliates/url` forms. Ordinary collection never presses a copy, register, or create control. A generation/copy control may be activated only by the explicit, attested three-post pilot described below. Reports, account pages, media management, and payment pages remain outside the content-script scope.

## Export schema

Collector `0.6.1` keeps the existing text-only catalog record schema and adds a durable automatic-session summary plus optional visible affiliate-link observations. The JSON root contains:

- `schema_version` and `collector_version`
- `source` with `mode: RENDERED_UI_TEXT`
- `collected_at` and a fail-closed `stop_reason`
- `pages` with URL, surface, time, anonymous fingerprint, counts, and warnings
- deduplicated `creators` and `posts`
- aggregate `counts` and warnings

Normal automatic collection produces two files only at session completion: a lightweight session summary and a cumulative export for the same canonical scope. The cumulative export adds checkpoint, run summaries, first/last collection time, per-identity observation sidecars, and an additive incremental classification. It remains compatible with the dry-run importer's allowed post/creator record shapes.

Every catalog record includes `source_surface`, `source_page_url`, `collected_at`, and `parser_confidence`. Posts are deduplicated by strict UUID parsed from `https://myfans.jp/posts/<UUID>`. Creators are deduplicated by username, falling back to a visible public profile URL.

### Post fields

Fields are included only when they can be read from visible UI text or semantic links:

- `post_uuid`, `post_public_url`, and title
- creator name, username, and visible public profile URL
- price, affiliate reward rate, and estimated reward
- media type, text duration plus normalized seconds, likes, and relative published text
- `affiliate_eligible: true` for records found on a supported affiliate catalog surface
- an optional `displayed_affiliate_url` only when an affiliate URL is visibly rendered by the official UI
- optional `affiliate_link_status: ACTIVE` and generation observation provenance after an explicitly started pilot

Relative time such as `3日前` is retained as text and is never converted into `published_at`.

### Creator fields

- creator name, username, and visible public profile URL
- likes, followers, following, post count, and affiliate-enabled post count
- single-sale, initial plan, and continuation reward rates
- visible plan name, monthly price, post count, and description
- visible public profile URLs for recognized social platforms only

Stable plan IDs are not available from rendered labels. Plans therefore remain unresolved candidates for a later authorized import rather than being assigned synthetic identifiers.

## Image and private-data prohibition

The collector never exports image-related fields. This includes thumbnail, avatar, OGP, `img src`, poster, image/video URL, blob, or embedded media data. A recursive output guard rejects image-key additions. The future staging design explicitly sets creator and post image columns to `null`.

The collector also excludes account name, email, affiliate ID, bank details, dashboard revenue, passwords, cookies, tokens, and session values. Catalog collection does not read form values. The generation pilot reads/writes only the unique visible official URL input/output; it never reads password inputs or the clipboard. The popup renders at most three text-only catalog samples and never renders remote media.

## Parser and pagination behavior

The parser prioritizes public MyFans URL shapes, button and visible Japanese labels, roles, accessible labels, headings, and relative semantic containers such as articles and list items. Generated or Tailwind class names are not used as primary identifiers.

The multi-page actions use only a visible, enabled `次へ` or `次のページ` control. Collection is a background-service-worker-orchestrated, one-page-at-a-time state machine. Every internal operation remains capped at five successful pages; `0.5.0` automatically chains up to ten such atomic operations for the default 50-page user session. The current content script parses only its document, returns a preparation ACK without navigating, then accepts a separate navigation command and returns that ACK before scheduling the visible click. The SPA-updated or newly loaded content script signals only that it is reachable; each signal triggers a bounded re-evaluation. The service worker waits up to ten seconds for the expected scope/page, catalog UUID records, a changed rendered-record fingerprint, and the same fingerprint after a 250ms settle window. A URL change, content-script signal, catalog shell, or changed empty fingerprint alone is not page-ready.

The popup is a controller/view only. Closing it destroys no operation state; reopening it reads the durable journal and shows the current stage and progress. The journal and temporary staged pages live in extension-owned `chrome.storage.local`. Hydration start/deadline, last observed page/record count/fingerprint, and the settle candidate are journaled. Worker startup, content readiness, or a popup status refresh resumes the remaining original deadline after service-worker suspension or browser restart; it never starts a fresh ten-second allowance.

Only a complete five-page-or-less chunk performs a formal merge/checkpoint/cumulative commit. Internal chunks produce no physical download. Any transition or safety failure leaves the last successful extension-local checkpoint and cumulative catalog untouched; partial pages remain staging only. Operation, run, and session IDs prevent duplicate merge, checkpoint advance, run-count increment, or final export. Saved `0.2.0` through `0.6.0` checkpoints remain resumable; loading version `0.6.1` alone does not rewrite them.

Completed run and cumulative exports are canonical artifacts: object keys are recursively sorted, array order is retained, JSON is pretty-printed with one trailing newline, and SHA-256 covers the exact UTF-8 text delivered to the file. Each artifact has an independent delivery state. Version `0.4.0` hands those exact bytes to `chrome.downloads` from the background service worker, journals each download ID, and delivers run then cumulative sequentially. Completion requires Downloads API readback with `state=complete`, the expected exact-or-uniquified filename, exact byte length, and `exists=true`. An interrupted or ambiguous delivery is not automatically repeated; the popup requires explicit confirmation that the files are absent. Legacy `0.3.1` completed operations can rebuild only these export artifacts from their committed run/catalog data without changing UUIDs, run count, checkpoint, operation ID, or collection result.

**続きから自動収集** reads the checkpoint for the exact current route/filter/sort scope and requires only one user action. It resumes through an exact visible next-link URL when available; for button-only pagination it returns to the observed last page and clicks its visible next control. It never increments or fabricates a page URL. Each chunk stops at five pages, commits, and chains automatically. The user session stops at 50 pages by default or catalog end. A failed later chunk keeps all prior successful chunks and can be resumed from their last checkpoint. It also stops on:

- five scanned pages
- missing or disabled next control
- repeated page fingerprint
- catalog rows not ready before the hydration deadline
- populated page that does not stabilize before the deadline
- page-change timeout
- login redirect
- rate-limit, anti-bot, or CAPTCHA indication
- an unexpected visible modal

Only an absent/disabled next control marks a scope `COMPLETE`. The five-page bound leaves an `IN_PROGRESS` checkpoint. Login redirects, rate limits/anti-bot responses, unexpected modals, timeouts, and duplicate pages preserve an `INTERRUPTED` checkpoint and are never treated as completion or bypassed.

The cumulative merge is UUID-based: new observations add, identical observations no-op, allowed-field changes become update candidates, and identity conflicts fail closed. Absence from a later run never means deletion or unpublication. Per-record observation sidecars preserve first/last seen time, run, source page, and collector version.

## Diagnostic / Probe

Probe mode is for DOM drift. It saves only element tag, role, safe known label or `REDACTED`, URL pattern class, field-presence flags, and a shallow anonymous tag/role hierarchy. Query values in the diagnostic page URL are replaced with `REDACTED`.

It does not save creator names, post titles, price/rate values, raw DOM, HTML, classes, screenshots, image URLs, or account information.

## Install and one-click export

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `tools/myfans-affiliate-collector/`.
4. Open a supported signed-in Affiliate Center page and reload it once after installation.
5. Open the extension and choose **続きから自動収集** once.
6. The popup may be closed while collection continues. Reopen it only if you want to view progress; session and cumulative JSON are saved automatically at completion.

Chrome downloads the two final JSON artifacts through the background worker. For automatic sessions, the journal stores the small session summary plus canonical hash/byte-length metadata instead of a second persistent copy of the growing cumulative JSON. The worker regenerates deterministic canonical bytes from the formal cumulative catalog immediately before download and fails closed if hash or byte length differs. The extension uses the narrow `downloads` permission only to save these local JSON artifacts and reconcile a persisted download ID with `downloads.search({ id })`; it does not enumerate download history, call `downloads.open`, or broaden host access. Existing files are never overwritten because Chrome receives `conflictAction: "uniquify"`. No upload or database operation is used. If counts are unexpectedly zero, run **Diagnostic / Probe** instead; no HTML or DevTools copy is required.

## Import handoff design

The final cumulative export carries an `incremental_sync` sidecar classifying observed identities as `NEW`, `EXISTING_IDENTICAL`, `UPDATE_NEEDED`, or `CONFLICT` against the session-start cumulative baseline. Snapshot absence always proposes zero deletes/unpublishes. `DB_SYNC_READY` means the local artifact is safe to hand to the existing read-only DB resolver; it is not a database comparison or write authorization. The importer always returns `apply: false` and makes no Supabase or production connection.

## Affiliate generation pilot

The `AFFILIATE_GENERATION_SESSION` is owned by the MV3 background worker and stored in `chrome.storage.local`; popup closure cannot broaden or restart it. Candidates come from the existing cumulative catalog (`affiliate_eligible=true`, valid canonical UUID URL, no observed link), and the first three sorted identities must match the production read-only target attestation hash. A fourth target is structurally unreachable.

For each target on search results, the content script requires one exact UUID-to-card mapping, exactly one post identity in that card, and one enabled visible `投稿のアフィURLのコピー` action inside that same card. It never chooses a global button index. The dedicated-form path remains available when one visible URL input and one explicit generate control exist. The worker journals dispatch state, the content script ACKs, and only then schedules one click. Results are accepted solely from the target card or official result UI as a visible anchor `href`, input value, allowlisted explicit DOM attribute, or rendered text with exact host `link.affiliate.myfans.jp`, HTTPS, no credentials and a non-root path. It does not infer URL structure, call an endpoint, or read the clipboard. Clipboard-only success pauses after the first attempted target with `AUTOMATION_BLOCKED_BY_CLIPBOARD_ONLY_UI`.

The pilot waits four seconds between writes and stops on CAPTCHA/anti-bot, rate limit, login challenge, ineligible target, UI ambiguity, timeout, or conflicting URL identity/shape. Recovery after a worker restart inspects a previously dispatched result and never dispatches the same click again. A successful observation is atomically written with the generation journal to the extension-local cumulative record. Later catalog absence preserves it; a different visible URL for the same UUID fails closed. The affiliate resolver remains `apply:false`; no production database write occurs in this phase.

## Uninstall

Open `chrome://extensions`, locate **MyFans Affiliate Catalog Local Collector**, and select **Remove**. Its background journal, staged snapshots, checkpoint, and cumulative state are stored only in extension-local storage and are removed with the extension; delete any downloaded JSON separately if it is no longer required.
