# MyFans integration status

## Current status

`AUTOMATION_PAUSED`

MyFans automatic public discovery is paused. The private additive schema, public-metadata safety model, parsers, tests, diagnostic browser utility, and canonical research evidence are retained. No MyFans data is exposed in the public UI.

Do not restart ranking, sitemap-child, tag/search, genre, or other route discovery unless one of the re-entry conditions below is met. The existing browser workflow is diagnostic only and is not a production ingestion pipeline.

## Completed foundation

- Official-source research and access-boundary review (Phase 6A)
- Additive private schema for creators, posts, plans, and post-plan relations (Phase 6B)
- Creator/post identity and fail-closed safety model
- Reserved-route and false-positive hardening
- Local Safari and Chrome transport validation
- Modern hosted Chrome validation
- Official robots-declared sitemap discovery
- Official tag/search discovery

The last successful foundation phase is **6B schema foundation**. The last automatic discovery attempt is **6C tag search**.

## Confirmed blockers

- The public creator-ranking document contains no automatable creator entity structures, including in a current hosted Chrome runtime.
- The official sitemap exposes tag/search surfaces rather than usable public post or creator entity URLs in the bounded sample.
- Three official public tag/search pages exposed no stable `/posts/<UUID>` candidates through permitted direct public HTML or hydration surfaces.

These results do not authorize private or undocumented endpoint analysis.

## Safety boundaries

- No private or undocumented API replay
- No login, account, cookie, token, or authenticated-session use
- No anti-bot, challenge, certificate, or access-control bypass
- No search-engine discovery or ingestion
- No paid, limited, or protected media download
- No ranking/tag crawler scheduling or automatic dispatch
- No public UI, search, SEO, sitemap, or anonymous MyFans exposure

## Re-entry conditions

Automatic discovery may be reconsidered only when at least one condition is true:

1. MyFans provides an official public API suitable for catalog discovery.
2. MyFans provides an official feed or data export.
3. An official affiliate or partner program provides authorized catalog, feed, or API access.
4. Official public HTML or the official sitemap begins exposing stable public post IDs or canonical post URLs.
5. The user lawfully possesses exact public MyFans post URLs from another source and requests exact-URL validation without discovery crawling.

Without one of these conditions, `MYFANS_AUTOMATIC_PUBLIC_DISCOVERY` remains paused.

## Future exact-URL mode

If the user later supplies exact public post URLs, a crawler is unnecessary. A future, separately authorized flow may be:

```text
exact public URL
  -> anonymous public metadata validation
  -> visibility and paid/limited/auth checks
  -> lossless structured freeze
  -> target-scoped private staging
```

This exact-URL mode is a documented re-entry option only; it is not implemented by Phase 6D.

## Diagnostic workflow

`.github/workflows/myfans-public-browser-pilot.yml` is retained solely as a manually dispatched diagnostic utility. It has read-only repository permission, no schedule or push trigger, no production/DB credentials, and no production mutation step. Do not dispatch it for routine ingestion while automation is paused.
