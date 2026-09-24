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

The manifest also permits `/affiliates/generated` child routes so a URL already displayed as text may be recognized. The collector never presses a copy, generate, register, or create button. Reports, account pages, media management, and payment pages are outside the content-script scope.

## Export schema

Collector `0.2.0` keeps the existing text-only catalog record schema and adds bounded run/cumulative metadata. The JSON root contains:

- `schema_version` and `collector_version`
- `source` with `mode: RENDERED_UI_TEXT`
- `collected_at` and a fail-closed `stop_reason`
- `pages` with URL, surface, time, anonymous fingerprint, counts, and warnings
- deduplicated `creators` and `posts`
- aggregate `counts` and warnings

List collection produces two files: a five-page-or-less run export and a cumulative export for the same canonical scope. The cumulative export adds checkpoint, run summaries, first/last collection time, and per-identity observation sidecars. It remains compatible with the dry-run importer's allowed post/creator record shapes.

Every catalog record includes `source_surface`, `source_page_url`, `collected_at`, and `parser_confidence`. Posts are deduplicated by strict UUID parsed from `https://myfans.jp/posts/<UUID>`. Creators are deduplicated by username, falling back to a visible public profile URL.

### Post fields

Fields are included only when they can be read from visible UI text or semantic links:

- `post_uuid`, `post_public_url`, and title
- creator name, username, and visible public profile URL
- price, affiliate reward rate, and estimated reward
- media type, text duration plus normalized seconds, likes, and relative published text
- `affiliate_eligible: true` for records found on a supported affiliate catalog surface
- an optional `displayed_affiliate_url` only when an affiliate URL is already present as a visible link

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

The collector also excludes account name, email, affiliate ID, bank details, dashboard revenue, passwords, cookies, tokens, and session values. It does not read form values. The popup renders at most three text-only catalog samples and never renders remote media.

## Parser and pagination behavior

The parser prioritizes public MyFans URL shapes, button and visible Japanese labels, roles, accessible labels, headings, and relative semantic containers such as articles and list items. Generated or Tailwind class names are not used as primary identifiers.

The multi-page actions use only a visible, enabled `次へ` or `次のページ` control. After a click the collector waits up to 10 seconds for the URL to change, the expected catalog rows to be present, and the rendered-record fingerprint to differ. A URL change alone is not page-ready. Every invocation remains capped at five successful pages.

**新規収集** starts only from page 1. **続きから収集** reads the checkpoint for the exact current route/filter/sort scope. It resumes through an exact visible next-link URL when available; for button-only pagination it returns to the observed last page and clicks its visible next control. It never increments or fabricates a page URL. It stops on:

- five scanned pages
- missing or disabled next control
- repeated page fingerprint
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
5. Open the extension and choose **現在ページを取得**, **新規収集（最大5ページ）**, or **続きから収集（最大5ページ）**.

Chrome downloads the JSON locally. No upload or database operation follows. If counts are unexpectedly zero, run **Diagnostic / Probe** instead; no HTML or DevTools copy is required.

## Import handoff design

The core contains a validator and a design-only target-scoped staging mapper for `myfans_creators` and `myfans_posts`. It always returns `apply: false`; `myfans_plans` and `myfans_post_plans` remain empty until stable plan identity and post-plan relationships are available. It makes no Supabase or production connection.

A production importer, affiliate URL handling, image handling, and publication remain out of scope until a user pilot confirms the DOM parser and a later phase explicitly authorizes those changes.

## Uninstall

Open `chrome://extensions`, locate **MyFans Affiliate Catalog Local Collector**, and select **Remove**. The extension has no background worker. Its checkpoint/cumulative state is stored only in extension-local storage and is removed with the extension; delete any downloaded JSON separately if it is no longer required.
