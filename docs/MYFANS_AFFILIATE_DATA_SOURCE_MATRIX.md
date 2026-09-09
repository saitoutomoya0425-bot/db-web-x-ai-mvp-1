# MyFans Affiliate Data Source Matrix

基準日: 2026-09-09 (JST)  
この文書は「画面に存在する」「取得できる」「保存・再公開してよい」を分ける。API path literalはresponse schemaの証拠に使わない。

## 1. Source inventory

| Source | Source class | Access | Coverage | Data-use readiness | Finding |
| --- | --- | --- | --- | --- | --- |
| Affiliate Center LP / Terms / Privacy | `OFFICIAL_PUBLIC` | public | 制度・規約 | `PUBLIC_NO_AUTH_READY` | catalog rowはない |
| Official Support Guide | `OFFICIAL_PUBLIC` | public | 機能・field説明・経済条件 | `PUBLIC_NO_AUTH_READY` | documentation source |
| `myfans.jp` profile/post | `OFFICIAL_PUBLIC` | exact URLはpublicの場合あり | 個別creator/post | complete discoveryは `NOT_USABLE` | Phase 6D pause対象 |
| Affiliate URL public redirect/OGP | `OFFICIAL_PUBLIC` | 生成済みURL | 個別link/preview | feedとして `NOT_USABLE` | 画像再利用は要許諾 |
| Affiliate Center search/list/detail | `OFFICIAL_AUTHENTICATED` | approved account | affiliate対象creator/post | UI閲覧は `AFFILIATE_ACCOUNT_REQUIRED`; automationは `MYFANS_PERMISSION_REQUIRED` | 最有力catalog source |
| URL generator/generated list | `OFFICIAL_AUTHENTICATED` | approved account | known URL→affiliate URL | `AFFILIATE_ACCOUNT_REQUIRED` | bulk generation仕様なし |
| sales report | `OFFICIAL_AUTHENTICATED` | approved account | click/sale/reward | `AFFILIATE_ACCOUNT_REQUIRED` | discoveryではなくperformance |
| sales/creator CSV | `OFFICIAL_EXPORT` | approved account | realized sales | `AFFILIATE_ACCOUNT_REQUIRED` | full catalog CSVではない |
| public static JS route/API literals | `OFFICIAL_PUBLIC` | public asset | architecture only | `NOT_USABLE` | endpoint request禁止 |
| oshiscope | `THIRD_PARTY_PROOF_ONLY` | public pages | daily observed affiliate scope | `NOT_USABLE` | policyがbulk/DB化を禁止 |
| other operators | `THIRD_PARTY_PROOF_ONLY` | few public pages | curated examples/UX | `NOT_USABLE` | research reference only |
| official developer API/feed | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `MYFANS_PERMISSION_REQUIRED` | public docsを発見できず |
| official full catalog CSV | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `MYFANS_PERMISSION_REQUIRED` | sales CSV以外を発見できず |

## 2. Surface map

| Surface | Existence | Access | Confirmed fields/actions | Likely fields | Unknown |
| --- | --- | --- | --- | --- | --- |
| search result | `CONFIRMED` | authenticated | eligible post/profile、single-sale price、single reward rate、URL generation | creator name、post title、thumbnail、genre/tag | internal IDs、followers、likes、published date |
| creator list | `CONFIRMED` | authenticated | affiliate-participating creators、approved-only filtering effect | creator name/profile、rate summary、thumbnail | exact columns、pagination/export |
| ranking | `CONFIRMED` | authenticated | approved-only creator is hidden from unapproved affiliate | creator name/profile | ranking basis、all fields |
| recommendations | `CONFIRMED` | authenticated | approved-only creator is hidden from unapproved affiliate | creator name/profile | recommendation basis、all fields |
| approved creator search | `CONFIRMED` | authenticated | Approved tab、approved creator、post URL paste、individual “your rate” | approval status | exact row schema |
| creator detail/profile | `CONFIRMED` | authenticated | posts、sort by reward rate / reward amount | creator name、post title、price、thumbnail | follower/likes/date、plan rate display columns |
| post search/detail | `CONFIRMED` | authenticated | eligible post、post URL input、price、rate | title、thumbnail、creator、estimated reward | post ID、like/date fields |
| URL generator | `CONFIRMED` | authenticated | creator/post public URL input、affiliate URL output、ineligible error | target type | content metadata、bulk mode |
| generated URL list | `CONFIRMED` | authenticated | affiliate URL、description、coupon marker | target title/thumbnail | export |
| sales detail | `CONFIRMED` | authenticated | thumbnail、creator、sale price、reward rate、estimated reward、single/plan type | title | post URL/ID、buyer detail |
| sales report | `CONFIRMED` | authenticated | clicks、CVR、purchases、reward、period | date aggregation | exact current granularity (`DOC_CONFLICT`) |
| creator-level sales CSV | `CONFIRMED` | authenticated export | creator-level sales detail | creator、sale/reward aggregates | exact header/schema、catalog coverage |
| coupon | `CONFIRMED` | selected authenticated affiliates | campaign、period、post affiliate URL、coupon attached | discount/value | CSV/API |
| registration/media | `CONFIRMED` | authenticated | media name/type/URL、Approved/Pending/Rejected、affiliate ID、bank/invoice/account | rejection reason | media API terms |

Sources: official [approved-only guide][1], [registration guide][2], [FAQ][3], [June update][4], [coupon guide][5].

## 3. Field classification

Classification here answers only whether the field is evidenced on an official Affiliate Center surface. It does not grant ingestion/publication rights.

| Field | Search/list | Creator detail | Post detail/search | Sales/report/CSV | Generator | Overall |
| --- | --- | --- | --- | --- | --- | --- |
| creator ID (internal) | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| creator username/slug | `LIKELY` | `LIKELY` | `LIKELY` | `UNKNOWN` | `LIKELY` | `LIKELY` (static `:username` route) |
| creator name | `CONFIRMED` | `CONFIRMED` | `LIKELY` | `CONFIRMED` | `UNKNOWN` | `CONFIRMED` |
| profile URL | `CONFIRMED` as input/target | `LIKELY` | n/a | `UNKNOWN` | `CONFIRMED` input | `CONFIRMED` |
| post ID | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| post URL | `CONFIRMED` | `LIKELY` | `CONFIRMED` | `UNKNOWN` | `CONFIRMED` input | `CONFIRMED` |
| title | `LIKELY` | `LIKELY` | `LIKELY` | `LIKELY` | `UNKNOWN` | `LIKELY` |
| thumbnail | `LIKELY` | `LIKELY` | `LIKELY` | `CONFIRMED` | `UNKNOWN`; generated URL OGPは別 | `CONFIRMED` in sales detail |
| price | `CONFIRMED` (single) | `LIKELY` | `CONFIRMED` (single) | `CONFIRMED` sale price | `UNKNOWN` | `CONFIRMED` |
| sale price | `UNKNOWN` as discount field | `UNKNOWN` | `UNKNOWN` | `CONFIRMED` transaction sale price | `UNKNOWN` | `CONFIRMED` only in report context |
| plan | `LIKELY` | `LIKELY` | `LIKELY` | `CONFIRMED` as sale type | `UNKNOWN` | `CONFIRMED` as product type |
| genre | `LIKELY` (public static genre routes) | `LIKELY` | `LIKELY` | `UNKNOWN` | `UNKNOWN` | `LIKELY` |
| tag | `LIKELY` | `LIKELY` | `LIKELY` | `UNKNOWN` | `UNKNOWN` | `LIKELY` |
| reward rate | `CONFIRMED` (single) | `CONFIRMED` (sort; value strongly implied) | `CONFIRMED` | `CONFIRMED` | `UNKNOWN` | `CONFIRMED` |
| reward amount | `LIKELY` | `CONFIRMED` (sort; value strongly implied) | `LIKELY` | `CONFIRMED` estimated reward | `UNKNOWN` | `CONFIRMED` |
| affiliate eligibility | `CONFIRMED` | `CONFIRMED` | `CONFIRMED` | historical only | `CONFIRMED` via success/error | `CONFIRMED` |
| approval status | `CONFIRMED` for Approved tab | `LIKELY` | `LIKELY` | `UNKNOWN` | implicit | `CONFIRMED` |
| followers | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| likes/bookmarks | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| published date | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| affiliate URL | output action | `LIKELY` action | `CONFIRMED` action | `UNKNOWN` | `CONFIRMED` output | `CONFIRMED` |
| coupon | `UNKNOWN` | `UNKNOWN` | `CONFIRMED` for selected campaign | `UNKNOWN` | generated-list marker | `CONFIRMED` |

Notes:

- `creator name` is explicit in sales detail and creator-list/search narratives; exact visible field labels still need signed-in screenshot mapping.
- Static route `:username` supports a slug inference only; it does not confirm a stable public creator ID.
- Followers、likes/bookmarks、published date are observed by oshiscope, but that does not confirm their presence in Affiliate Center.
- A sort control confirms an underlying sortable value, not necessarily the exact rendered column/format.
- Approved-only status is relational: the same creator may be visible to one affiliate and absent to another.

## 4. Public architecture evidence

Observed relevant path literals only:

```text
/api/creators
/api/creators/registered
/api/search/creators
/api/search/posts
/api/search/gachas
/api/links
/api/links/creators
/api/sales
/api/sales/creators
/api/sales/csv
/api/sales/creators/csv
/api/summary/csv
/api/medias
```

Evidence level: `LIKELY_INTERNAL_FIRST_PARTY_ARCHITECTURE`.  
Allowed next step: official documentation/support answer, or manual UI mapping in a user-signed-in browser.  
Disallowed step: direct request/replay, credential/token extraction, automated enumeration.

## 5. Ranked path by target

| Target | #1 | #2 | Fallback/proof |
| --- | --- | --- | --- |
| creator list | Center creator list/search (`OFFICIAL_AUTHENTICATED`) | future official catalog export/API (`UNKNOWN`) | oshiscope (`THIRD_PARTY_PROOF_ONLY`) |
| post list | Center creator detail/post search (`OFFICIAL_AUTHENTICATED`) | known-URL generator eligibility check (`OFFICIAL_AUTHENTICATED`) | oshiscope (`THIRD_PARTY_PROOF_ONLY`) |
| price | Center search/detail (`OFFICIAL_AUTHENTICATED`) | exact public post URL (`OFFICIAL_PUBLIC`) | sold-item CSV (`OFFICIAL_EXPORT`) |
| thumbnail | Center UI (`OFFICIAL_AUTHENTICATED`) | generated link OGP (`OFFICIAL_PUBLIC`) | public post/profile image (`OFFICIAL_PUBLIC`) |
| reward rate | Center search/detail (`OFFICIAL_AUTHENTICATED`) | report/CSV for sales (`OFFICIAL_EXPORT`) | default-rate docs (`OFFICIAL_PUBLIC`) |
| eligibility | Center search/list/generator (`OFFICIAL_AUTHENTICATED`) | none | operator observation (`THIRD_PARTY_PROOF_ONLY`) |
| affiliate URL | official generator/list (`OFFICIAL_AUTHENTICATED`) | none | operator redirect is not reusable |

Every authenticated catalog row remains `MYFANS_PERMISSION_REQUIRED` for automated storage and public republication until written permission or a documented partner interface is obtained.

## Footnotes / Sources

[^1]: Static asset inspection was restricted to public HTML-linked assets; no API request was made.

[1]: https://support.myfans.jp/hc/ja/articles/17400497455119
[2]: https://support.myfans.jp/hc/ja/articles/15722941497487
[3]: https://support.myfans.jp/hc/ja/articles/14946655853711
[4]: https://support.myfans.jp/hc/ja/articles/16591475920015
[5]: https://support.myfans.jp/hc/ja/articles/17478548208015
