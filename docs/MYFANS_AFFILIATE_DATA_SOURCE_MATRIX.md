# MyFans Affiliate Data Source Matrix

基準日: 2026-09-15 (JST)
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
| search result | `CONFIRMED_USER_AUTH_UI` | authenticated | eligible post/profile、thumbnail、duration、single-sale price、reward rate、estimated reward、title、creator、relative published time、profile action、URL copy、All/video/image、popular、次へ | genre relation | internal IDs、exact API properties/runtime values |
| creator list | `CONFIRMED_USER_AUTH_UI` | authenticated | name、avatar、likes、followers、affiliate-enabled post count、SNS icons、single/plan-initial reward rate、5 sort labels | profile target | internal ID、exact API properties/runtime values |
| ranking | `CONFIRMED` | authenticated | approved-only creator is hidden from unapproved affiliate | creator name/profile | ranking basis、all fields |
| recommendations | `CONFIRMED` | authenticated | approved-only creator is hidden from unapproved affiliate | creator name/profile | recommendation basis、all fields |
| approved creator search | `CONFIRMED_USER_AUTH_UI` | authenticated | 一般/承認済みtab、exact registered route、empty-state wording | approval status | exact row/API schema |
| creator detail/profile | `CONFIRMED_USER_AUTH_UI` | authenticated | @username、post/like/follower/following counts、plan fields/rates、eligible-only notice、5 post sort labels、20-item UI instance | profile target | internal ID、exact API properties/runtime values |
| post search/detail | `CONFIRMED_USER_AUTH_UI` | authenticated | eligible post、UUID-like public post route、title、thumbnail、duration、creator、price、rate、estimated reward、likes、relative published time、affiliate action | creator relation | internal post property、exact timestamp/API properties |
| URL generator | `CONFIRMED` | authenticated | creator/post public URL input、affiliate URL output、ineligible error | target type | content metadata、bulk mode |
| generated URL list | `CURRENT_ACTIVE_ROUTE_READ_MODEL_CONFIRMED` | authenticated | current routes、`/api/links`/`creators` GET clients | affiliate URL、description、coupon、target type | `USER_VISIBLE_NAV: NOT_OBSERVED`、page chunk、response property、mutation/export |
| sales detail | `CONFIRMED` | authenticated | thumbnail、creator、sale price、reward rate、estimated reward、single/plan type | title | post URL/ID、buyer detail |
| sales report | `CONFIRMED_USER_AUTH_UI` | authenticated | today/yesterday/this month/last month/period、gross/confirmed/estimated/click/purchase、sale/creator views、all/estimated/confirmed/rejected、CSV control | date aggregation | exact query/status/runtime keys、current granularity (`DOC_CONFLICT`) |
| creator-level sales CSV | `CONFIRMED` | authenticated export | creator-level sales detail、sales CSV click-count column added 2026-09-04 | creator、sale/reward aggregates | remaining exact header/schema、catalog coverage |
| coupon | `CONFIRMED` | selected authenticated affiliates | campaign、period、post affiliate URL、coupon attached | discount/value | CSV/API |
| registration/media | `CONFIRMED` | authenticated | media name/type/URL、Approved/Pending/Rejected、affiliate ID、bank/invoice/account | rejection reason | media API terms |

Sources: official [approved-only guide][1], [registration guide][2], [FAQ][3], [June update][4], [coupon guide][5].

## 3. Field classification

Classification here answers only whether the field is evidenced on an official Affiliate Center surface. It does not grant ingestion/publication rights.

| Field | Search/list | Creator detail | Post detail/search | Sales/report/CSV | Generator | Overall |
| --- | --- | --- | --- | --- | --- | --- |
| creator ID (internal) | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| creator username/slug | `LIKELY` | `CONFIRMED_USER_AUTH_UI` as `@username` | `LIKELY` | `UNKNOWN` | `LIKELY` | detail UI/route confirmed; response fieldは`UNKNOWN` |
| creator name | `CONFIRMED_USER_AUTH_UI` | `LIKELY` | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED` | `UNKNOWN` | list/post cardで`CONFIRMED_USER_AUTH_UI`; detail/API propertyは`UNKNOWN` |
| profile URL | `CONFIRMED_USER_AUTH_UI` action | `LIKELY` | n/a | `UNKNOWN` | `CONFIRMED` input | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| post ID | `UNKNOWN` | `UNKNOWN` | UUID-like route identifierは`CONFIRMED_USER_AUTH_UI` | `UNKNOWN` | `UNKNOWN` | URL identifier confirmed; internal/response propertyは`UNKNOWN` |
| post URL | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED_USER_AUTH_UI` action | `CONFIRMED_USER_AUTH_UI` | `UNKNOWN` | `CONFIRMED` input | `CONFIRMED_USER_AUTH_UI` |
| title | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED_USER_AUTH_UI` | `LIKELY` | `UNKNOWN` | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| thumbnail | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED` | `UNKNOWN`; generated URL OGPは別 | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| price | `CONFIRMED_USER_AUTH_UI` (single) | `CONFIRMED_USER_AUTH_UI` (post/plan) | `CONFIRMED_USER_AUTH_UI` (single) | `CONFIRMED` sale price | `UNKNOWN` | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| sale price | `UNKNOWN` as discount field | `UNKNOWN` | `UNKNOWN` | `CONFIRMED` transaction sale price | `UNKNOWN` | `CONFIRMED` only in report context |
| plan | `LIKELY` | `CONFIRMED_USER_AUTH_UI` name/monthly price/post count/description | `LIKELY` | `CONFIRMED` as sale type | `UNKNOWN` | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| genre | category/URL queryは`CONFIRMED_USER_AUTH_UI` | `LIKELY` | `LIKELY` | `UNKNOWN` | `UNKNOWN` | UI taxonomy/query confirmed; API relation/propertyは`UNKNOWN` |
| tag | `LIKELY` | `LIKELY` | `LIKELY` | `UNKNOWN` | `UNKNOWN` | `LIKELY` |
| reward rate | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED_USER_AUTH_UI` value/sort | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED` | `UNKNOWN` | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| reward amount | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED_USER_AUTH_UI` sort concept | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED` estimated reward | `UNKNOWN` | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| affiliate eligibility | `CONFIRMED_USER_AUTH_UI` notice/result scope | `CONFIRMED_USER_AUTH_UI` eligible-only notice | `CONFIRMED_USER_AUTH_UI` | historical only | `CONFIRMED` via success/error docs | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| approval status | `CONFIRMED_USER_AUTH_UI` Approved tab | `LIKELY` | `LIKELY` | `UNKNOWN` | implicit | surface/model confirmed; row propertyは`UNKNOWN` |
| followers | `CONFIRMED_USER_AUTH_UI` | `CONFIRMED_USER_AUTH_UI` | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | `CONFIRMED_USER_AUTH_UI`; API propertyは`UNKNOWN` |
| likes/bookmarks | likes `CONFIRMED_USER_AUTH_UI`; bookmarks `UNKNOWN` | likes `CONFIRMED_USER_AUTH_UI` | likes `CONFIRMED_USER_AUTH_UI`; bookmarks `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | likes confirmed; bookmarks/API property `UNKNOWN` |
| published date | relative time `CONFIRMED_USER_AUTH_UI` | relative time `CONFIRMED_USER_AUTH_UI` | relative time `CONFIRMED_USER_AUTH_UI` | `UNKNOWN` | `UNKNOWN` | relative display confirmed; exact timestamp/API property `UNKNOWN` |
| affiliate URL | `CONFIRMED_USER_AUTH_UI` TOP/copy action | `CONFIRMED_USER_AUTH_UI` action | `CONFIRMED_USER_AUTH_UI` action | `UNKNOWN` | `CONFIRMED` output | `CONFIRMED_USER_AUTH_UI` |
| coupon | `UNKNOWN` | `UNKNOWN` | `CONFIRMED` for selected campaign | `UNKNOWN` | generated-list marker | `CONFIRMED` |

Notes:

- UI field existence and API response-property names are separate evidence layers; every exact response property remains `UNKNOWN` unless stated otherwise.
- Static route `:username` supports a slug inference only; it does not confirm a stable public creator ID.
- Followers、likes、relative published time are now `CONFIRMED_USER_AUTH_UI`; bookmarks and exact published timestamp remain `UNKNOWN`.
- A sort control confirms an underlying sortable value, not necessarily the exact rendered column/format.
- Approved-only status is relational: the same creator may be visible to one affiliate and absent to another.

## 4. Public architecture evidence

Phase 6Gで、2026-09-14更新のcurrent route manifestと、public HTMLから参照されたgenerated clientを再確認した。以下はすべてstatic declarationであり、API response schemaまたは利用許諾ではない。

```text
/api/creators
/api/creators/registered
/api/creators/:username
/api/users/:userId/posts
/api/search/creators
/api/search/posts
/api/search/gachas
/api/genres
/api/genres/search
/api/links
/api/links/creators
/api/sales
/api/sales/creators
/api/sales/csv
/api/sales/creators/csv
/api/summary
/api/summary/csv
/api/affiliate_reward_rates
/api/medias
```

確認できたcontract: API origin、GET method、React Query hook/query key、`:username`/`:userId` path parameter、generic `URLSearchParams` serialization。

`UNKNOWN`: exact filter/sort/pagination key、default/max limit、response property、link-generation mutation。

Generated URL list: route/build/read-model levelで `CURRENT_ACTIVE_ROUTE_READ_MODEL_CONFIRMED`; authenticated user-visible navは `NOT_OBSERVED`。

Phase6Hでは同じdeploymentをpublic landing 1 GETで確認し、static assetは再GETしなかった。Current route manifestはroute patternからpage chunk URLへのmappingを持たず、public Turbopack runtimeにもglobal auth route-to-chunk tableはない。auth page/RSC GETなしではauth page call siteを決定的に導出できないため、exact auth asset 0、`CONFIRMED_STATIC_CALLSITE` 0、backend exact query/sort/pagination/response propertyは `UNKNOWN` のままである。

UI-visible exact query: `sexual_orientation`、`genre_name` (`CONFIRMED_USER_AUTH_UI`)。Backend API queryとしては `UNKNOWN`。

Boundary: `PHASE6H_AUTH_ROUTE_STATIC_BOUNDARY_REACHED`。

Evidence level: `CONFIRMED_CURRENT_PUBLIC_FRONTEND_DECLARATION / OFFICIAL_AUTHENTICATED_RUNTIME_NOT_PROBED`。

Allowed next step: official documentation/support answer。
Disallowed step: direct request/replay, credential/token extraction, automated enumeration.

Full architecture map: [MYFANS_AFFILIATE_FRONTEND_ARCHITECTURE.md](./MYFANS_AFFILIATE_FRONTEND_ARCHITECTURE.md)。

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
