# MyFans affiliate URL generation pilot

## Official UI contract

The documented Affiliate Center flow exposes official affiliate-link actions in authenticated UI, including the per-post action on search results. The update guide also documents a generated-link management surface. No official bulk-generation API/feed/CSV is available, so collector `0.6.1` treats only authenticated, user-visible capabilities as authorized surfaces.

- URL generation guide: <https://support.myfans.jp/hc/ja/articles/15722941497487>
- Affiliate Center update/generated-link guide: <https://support.myfans.jp/hc/ja/articles/15929691377039>
- Approved-creator/link validity guide: <https://support.myfans.jp/hc/ja/articles/17400497455119>

The implementation deliberately does not encode generated CSS classes or assume an undocumented DOM hierarchy. A search-result page is supported when the frozen UUID resolves to exactly one semantic post card, that card contains exactly one post identity, and exactly one enabled visible action labelled `投稿のアフィURLのコピー` exists inside that same card. It never selects a global button by ordinal position. A dedicated URL form remains supported when exactly one visible editable URL input and exactly one explicit generation control are present. Route name alone neither grants nor denies capability; any identity/card/control ambiguity stops before the click.

## Output and clipboard boundary

After generation, only a URL visible in the exact target card or an official result dialog/status region—as an anchor `href`, a visible input/textarea value, a visible control's narrowly allowlisted `data-clipboard-text`/`data-url`/`data-link` attribute, or rendered text—is considered. It must use HTTPS, exact host `link.affiliate.myfans.jp`, no credentials, no fragment, and a non-empty path or query. The first successfully observed pilot URL establishes the path-segment/query-key shape for the remaining two pilot records; a differing shape is a conflict, not an inferred replacement.

The clipboard is never read. If the official UI reports only “copied” and does not render the generated URL in any allowed visible form, the session pauses with `AUTOMATION_BLOCKED_BY_CLIPBOARD_ONLY_UI`. This is the explicit live-pilot decision boundary.

## Durable three-post pilot

The background service worker owns `AFFILIATE_GENERATION_SESSION`; `chrome.storage.local` is authoritative. The cumulative candidate count must still be exactly 1,194 at start. The frozen targets are the sorted first three records that have a valid post UUID/canonical URL, `affiliate_eligible=true`, and no observed active link. Their deterministic target hash must equal the read-only production attestation `sha256:c997ffabd37cdfbbb66eba8e04490e61de9a893d040b3a4a801fd78e46ebd3f4`. This binds the local pilot to three independently confirmed approved/MISSING production targets without persisting a production UUID list in documentation. A future mass session requires its own fresh production target freeze; a fourth target is structurally unreachable here.

Each write is journaled before the content-script click, separated by a four-second cooldown, and inspected for a visible result for a bounded 30 seconds. A worker restart after dispatch never re-clicks; it only inspects. The pilot stops after exactly three successes and exposes no mass-generation start message.

CAPTCHA/anti-bot, rate limit, login challenge, eligibility failure, selector ambiguity, multiple outputs, result timeout, and UUID/URL conflict stop fail-closed. No bypass or automatic retry storm exists.

## Data and sync boundary

A successful observation adds only the validated affiliate URL, `ACTIVE` link status, first/last seen provenance, collector version, generation-session identity and URL hash to the existing extension-local post. That catalog write and journal advancement occur in one storage update. Later catalog absence cannot erase the link; a different link for the same UUID is a conflict.

The pure incremental resolver classifies `ACTIVE_NEW`, `ACTIVE_IDENTICAL`, `CONFLICT`, and `INVALID`. In Phase 6P.1 it remains `apply:false`, with database writes, deploys, and production CTA activation all at zero. The public runtime validator is nevertheless hardened now so only exact-host ACTIVE links can ever show a CTA, with an adjacent `PR / アフィリエイトリンクを含みます` disclosure.

## Live-pilot handoff

Load collector `0.6.1`, open the signed-in Affiliate Center search-results page containing the frozen target cards (a dedicated generation form remains optional), and press **Affiliate URL生成パイロット（最大3件）** once. That explicit click is the authorization for at most three official-UI writes. The previous `0.6.0` failure at `0/3` occurred before dispatch, generated no link, and is a terminal prior journal that does not consume a target. Do not start catalog collection and do not repeat the new pilot after a terminal result. The run will either produce three mapped visible links and stop, or stop at the first real UI/safety boundary with its journal intact.
