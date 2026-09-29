# MyFans affiliate URL generation pilot

## Official UI contract

The documented Affiliate Center flow exposes official affiliate-link actions in authenticated UI, including the per-post action on search results. The update guide also documents a generated-link management surface. No official bulk-generation API/feed/CSV is available, so collector `0.6.2` treats only authenticated, user-visible capabilities as authorized surfaces.

- URL generation guide: <https://support.myfans.jp/hc/ja/articles/15722941497487>
- Affiliate Center update/generated-link guide: <https://support.myfans.jp/hc/ja/articles/15929691377039>
- Approved-creator/link validity guide: <https://support.myfans.jp/hc/ja/articles/17400497455119>

The implementation deliberately does not encode generated CSS classes or assume an undocumented DOM hierarchy. A search-result page is supported when the frozen UUID resolves to exactly one semantic post card, that card contains exactly one post identity, and exactly one enabled visible action labelled `投稿のアフィURLのコピー` exists inside that same card. It never selects a global button by ordinal position. A dedicated URL form remains supported when exactly one visible editable URL input and exactly one explicit generation control are present. Route name alone neither grants nor denies capability; any identity/card/control ambiguity stops before the click.

## Output and clipboard boundary

After generation, only a URL visible in the exact target card or an official result dialog/status region—as an anchor `href`, a visible input/textarea value, a visible control's narrowly allowlisted `data-clipboard-text`/`data-url`/`data-link` attribute, or rendered text—is considered. It must use HTTPS, exact host `link.affiliate.myfans.jp`, no credentials, no fragment, and a non-empty path or query. The first successfully observed pilot URL establishes the path-segment/query-key shape for the remaining two pilot records; a differing shape is a conflict, not an inferred replacement.

The clipboard is never read. If the official UI reports only “copied” and does not render the generated URL in any allowed visible form, the session pauses with `AUTOMATION_BLOCKED_BY_CLIPBOARD_ONLY_UI`. This is the explicit live-pilot decision boundary.

## Durable three-post pilot

The background service worker owns `AFFILIATE_GENERATION_SESSION`; `chrome.storage.local` is authoritative. The cumulative candidate count must still be exactly 1,194 at start. The worker first obtains a validated, read-only snapshot of the current authenticated post-search page and requires its canonical scope to equal the cumulative catalog scope. It then intersects the current DOM-ordered post identities with cumulative records having a valid UUID/canonical URL, `affiliate_eligible=true`, and no observed active link. Exactly the first three intersecting records are frozen, and their dynamic target hash plus page URL/fingerprint are journaled. A fourth target is structurally unreachable here.

Version `0.6.1` instead sorted all 1,194 cumulative candidates by UUID and froze the first three without checking current-page membership. In the failed page-60 attempt, those records came from saved pages 5, 6, and 25, so none could resolve to a page-60 card. The resulting `OFFICIAL_AFFILIATE_GENERATION_CAPABILITY_NOT_FOUND` was a correct pre-action failure; selector widening would not have fixed it.

Each write is journaled before the content-script click, separated by a four-second cooldown, and inspected for a visible result for a bounded 30 seconds. A worker restart after dispatch never re-clicks; it only inspects. The pilot stops after exactly three successes and exposes no mass-generation start message.

CAPTCHA/anti-bot, rate limit, login challenge, eligibility failure, selector ambiguity, multiple outputs, result timeout, and UUID/URL conflict stop fail-closed. No bypass or automatic retry storm exists.

## Data and sync boundary

A successful observation adds only the validated affiliate URL, `ACTIVE` link status, first/last seen provenance, collector version, generation-session identity and URL hash to the existing extension-local post. That catalog write and journal advancement occur in one storage update. Later catalog absence cannot erase the link; a different link for the same UUID is a conflict.

The pure incremental resolver classifies `ACTIVE_NEW`, `ACTIVE_IDENTICAL`, `CONFLICT`, and `INVALID`. In Phase 6P.1 it remains `apply:false`, with database writes, deploys, and production CTA activation all at zero. The public runtime validator is nevertheless hardened now so only exact-host ACTIVE links can ever show a CTA, with an adjacent `PR / アフィリエイトリンクを含みます` disclosure.

## Live-pilot handoff

Load collector `0.6.2`, open the signed-in Affiliate Center post-search page to be tested, and press **Affiliate URL生成パイロット（最大3件）** once. That explicit click is the authorization for at most three official-UI writes. The prior `0.6.1` page-60 failure at `0/3` occurred before dispatch, generated no link, and is a terminal prior journal that does not consume a target. Starting the fixed pilot archives that terminal summary and creates a new current-page target freeze; it never resumes the stale arbitrary targets. Do not start catalog collection and do not repeat the pilot after a terminal result. The run will either produce three mapped visible links and stop, or stop at the first real UI/safety boundary with its journal intact.

## Future one-click mass-session boundary

Mass generation is not enabled by `0.6.2`. The settled future design reuses the existing durable background navigation/checkpoint machinery: one explicit user start freezes the eligible/MISSING UUID universe, traverses the exact Affiliate Center scope page by page, intersects each validated visible page with that frozen set, and processes visible cards sequentially with bounded rate and a persistent completed-UUID checkpoint. Every click still requires exact UUID → one card → one official action. Popup closure or worker restart resumes the current page/target without re-clicking a dispatched target; login, CAPTCHA, rate limit, scope drift, identity ambiguity, or UI error pauses at the last confirmed checkpoint.

All 1,194 current cumulative records have usable exact `source_page_url`, first-seen page, and last-seen page provenance. That provenance may be used as a navigation hint, but live page traversal and identity revalidation remain authoritative because catalog contents can move. There is no manual per-page or three-at-a-time user loop, no URL construction, and no hidden API. Enabling that mass session requires a later phase after the three-card DOM pilot succeeds.
