# MyFans Affiliate Center Public Frontend Architecture

基準日: 2026-09-15 (JST)
調査区分: `RESEARCH ONLY / OFFICIAL PUBLIC STATIC ASSETS ONLY`

## Executive conclusion

Affiliate Centerは、Next.js 16.2.6 App Router + Turbopack、TanStack React Query、`https://api.affiliate.myfans.jp` を向くfirst-party client wrapperで構成されている。2026-09-14更新のsitemapと同じdeploymentの公開HTML参照assetから、creator/post/gacha/genre search、creator list/detail、approved creator、generated-link list、report、CSV、media managementのrouteとread wrapperを確認した。認証APIは一度も呼び出していない。[^1][^2][^3]

最重要の「アフィリエイトURL管理画面」は、`/affiliates/generated` と `/affiliates/generated/creators/:username` が現行route manifestに含まれ、`/api/links` と `/api/links/creators` のGET query clientも現行assetに存在する。したがってroute/buildおよびread-modelの判定は `CURRENT_ACTIVE` とする。公開page chunkには認証後navigation componentが含まれないため、sidebar/headerに現在表示されるかは別問題であり、nav判定は `NO_PUBLIC_EVIDENCE` である。これは「navに存在しない」ことの証明ではない。[^2][^3][^4]

静的に確定したのは、endpoint path、HTTP method、route parameter、React Query hook、generic query serializationまでである。exact query parameter名、sort enum値、page/limit名、catalog rowのresponse property名は、公開pageから参照されたassetには含まれていなかった。推測で埋めず `UNKNOWN` とした。

Phase6Hでは、ユーザーが2026-09-15に認証済み実画面で確認済みのroute、field、sort label、browser URL queryを `CONFIRMED_USER_AUTH_UI` として統合した。これによりUI schemaは大きく確定したが、UI上のbrowser URL queryとbackend API query、visible fieldとAPI response propertyは同一視していない。current public build metadataからauth route固有chunkを安全に導出できなかったため、exact API runtime contractは引き続き `UNKNOWN` である。[^20]

## 1. Boundary and method

取得対象は、Affiliate Centerのpublic landing、signin、register、terms、privacy、robots、sitemapと、それらのHTMLが実際に参照したcurrent static JS/CSS/webmanifestだけである。7 public page/fileと40 unique assetを各1回取得し、同一URLのduplicate GETは0、chunk名のbrute-force enumerationは0だった。sitemapの`lastmod`は `2026-09-14T09:00:46.200Z`、asset deployment識別子は `dpl_381BzSYTpyqKpbE9FHiEEna8tp3a` だった。[^1][^5]

行っていないこと:

- `/api/...` へのrequest、認証routeへのrequest、private API replay
- cookie、token、session、localStorage、credentialの読取・保存
- authenticated UI操作、link生成、CSV download
- source map/chunkの推測列挙、anti-bot回避
- competitorのbulk取得、raw dataset化
- DBまたはproduction dataの変更

public static codeに認証用wrapperが存在することと、そのendpointを呼んでよいことは別である。以下のpathはarchitecture evidenceであって、公開API specificationではない。

## 2. Current frontend stack

| Layer | Static finding | Confidence |
| --- | --- | --- |
| application | Next.js App Router | `CONFIRMED_STATIC` |
| version | Next.js 16.2.6 | `CONFIRMED_STATIC` |
| bundler | Turbopack | `CONFIRMED_STATIC` |
| server rendering | React Server Components flight data embedded in public HTML | `CONFIRMED_STATIC` |
| query/cache | TanStack React Query `useGet*Query` hooks | `CONFIRMED_STATIC` |
| API origin | `https://api.affiliate.myfans.jp` | `CONFIRMED_STATIC` |
| request auth behavior | `credentials: include`; 401時は`/signin`へredirect | `CONFIRMED_STATIC_CODE`, request未実行 |
| response wrapper | `{ data, status, headers }`; JSONはContent-Typeで判定 | `CONFIRMED_STATIC` |
| query serialization | caller objectを`URLSearchParams`化。`undefined`は省略、`null`は文字列`null` | `CONFIRMED_STATIC` |
| response schema | runtime validator/property access | `NOT FOUND` |

public register pageがAPI client barrelを取り込む構成のため、認証後page componentそのものを取得せずに多数のgenerated hookが公開chunkへ含まれている。一方、search card、creator card、report table、authenticated navigationのrender codeは当該chunk群に含まれていない。この境界が、path/methodは確定できるがfield/property名を確定できない理由である。[^2][^3]

## 3. Current route map

現行Sentry route manifestで確認した主要routeは次の通り。[^2]

| Surface | Current route | Determination |
| --- | --- | --- |
| top / ranking候補 | `/affiliates/top` | current buildに存在。内部tab構造は`UNKNOWN` |
| affiliate search | `/affiliates/search` | current buildに存在 |
| creator list | `/affiliates/search/creators` | current buildに存在 |
| approved/registered creator | `/affiliates/search/creators/tab/registered` | current buildに存在 |
| creator detail | `/affiliates/search/creators/:username` | current build、parameterは`username` |
| genre | `/affiliates/search/genres/:id` | current build、parameterは`id` |
| genre result | `/affiliates/search/genres/:id/result` | current build |
| gacha | `/affiliates/gachas` | current buildに存在 |
| URL generator | `/affiliates/url` | current buildに存在 |
| generated URL list | `/affiliates/generated` | current buildに存在 |
| generated creator detail | `/affiliates/generated/creators/:username` | current build、parameterは`username` |
| report | `/reports` | current buildに存在 |
| payout | `/payouts` | current buildに存在 |
| special rate | `/special-rate` | current buildに存在 |
| media list/new | `/settings/media`, `/settings/media/new` | current buildに存在 |

route helperには `/affiliates/search/suggest`、`/affiliates/search/result`、`/affiliates/search/from_url` もあるが、現行Sentry route manifestにはない。これらは `HELPER_ONLY / LEGACY_OR_INTERNAL_UNKNOWN` とし、current page routeへ昇格しない。[^2][^4]

`ranking`と`recommendations`は公式guideがsurface名を明示するが、それぞれに専用route/API literalは見つからなかった。`/affiliates/top`またはsearch response内のsection/tabである可能性はあるものの、これは `LIKELY` を超えない。approved-only creatorは未承認affiliateの通常検索・一覧・ranking・おすすめから非表示になるため、結果集合はaccount-relativeである。[^6]

## 4. Generated URL list verdict

公式2026-04-21 updateは「アフィリエイトURL管理画面」「最近生成したアフィリエイトURL」「一覧画面」を明記している。[^7] Current assetとの照合結果は以下の通り。

| Question | Result | Evidence |
| --- | --- | --- |
| past official existence | `YES` | 2026-04-21 official update |
| route still in current build | `YES` | static + dynamic current route manifest |
| current read model | `YES` | `/api/links`, `/api/links/creators` GET hooks |
| current nav | `USER_VISIBLE_NAV: NOT_OBSERVED` | 認証済みbottom navigationでgenerated専用entryは観測されず、public refsにもnavigation componentなし |
| dead/legacy | `UNLIKELY`, runtime未証明 | current manifest + helper + read hooksの三点一致 |
| conditional | `UNKNOWN` | authenticated UIを開いていない |
| generation後のみ使う | `UNKNOWN` | page component不在 |
| renamed | `NO EVIDENCE` | current path/helper名はgeneratedのまま |

最終分類: **`CURRENT_ACTIVE_ROUTE_READ_MODEL_CONFIRMED`**。ただし、これはcurrent compiled route/read modelに対する判定であり、UI entry pointが全accountで常時表示されるという判定ではない。route固有page chunkを決定的に導出できなかったため、`CURRENT_ACTIVE_STATIC_PAGE_IMPLEMENTATION_CONFIRMED` へは昇格しない。

## 5. Static request-contract map

すべてstatic declarationの観測であり、requestは0である。[^3]

### Catalog and search

| Endpoint shape | Method | Exported client | Static conclusion |
| --- | --- | --- | --- |
| `/api/search/creators` | GET | `useGetSearchCreatorsQuery` | creator search read contract |
| `/api/search/posts` | GET | `useGetSearchPostsQuery` | post search read contract |
| `/api/search/gachas` | GET | `useGetSearchGachasQuery` | gacha search read contract |
| `/api/creators` | GET | `useGetCreatorsQuery` | creator list read contract |
| `/api/creators/registered` | GET | `useGetCreatorsRegisteredQuery` | approved/registered subset read contract |
| `/api/creators/:username` | GET | `useGetCreatorsUsernameQuery` | username-based creator detail |
| `/api/users/:userId/posts` | GET | `useGetUsersUserIdPostsQuery` | creator/user relationからpost list |
| `/api/genres` | GET | `useGetGenresQuery` | genre collection |
| `/api/genres/search` | GET | `useGetGenresSearchQuery` | genre search |

`/api/creators/:username` と hook名の一致によりusername/slugはfrontend contractとして確認できる。またpost list hookは`userId`をpath argumentとして要求する。しかし、creator response中のproperty名やこのIDがUIに表示されるかは不明であり、「取得可能なstable creator ID」とはまだ判定できない。

### Link, report, and media

| Endpoint shape | Method | Exported client | Role |
| --- | --- | --- | --- |
| `/api/links` | GET | `useGetLinksQuery` | generated link general list |
| `/api/links/creators` | GET | `useGetLinksCreatorsQuery` | creator grouping/index |
| `/api/summary` | GET | `useGetSummaryQuery` | report summary |
| `/api/summary/csv` | GET | `getSummaryCsv` | summary export |
| `/api/sales` | GET | `useGetSalesQuery` | sales list |
| `/api/sales/csv` | GET | `getSalesCsv` | sales export |
| `/api/sales/creators` | GET | `useGetSalesCreatorsQuery` | creator sales list |
| `/api/sales/creators/csv` | GET | `getSalesCreatorsCsv` | creator sales export |
| `/api/affiliate_reward_rates` | GET | `useGetAffiliateRewardRatesQuery` | affiliate reward-rate reference |
| `/api/medias` | GET | `useGetMediasQuery` | registered media list |
| `/api/medias` | POST declaration | `usePostMediasMutation` | media registration;未実行 |

link generation用mutationは、許可範囲のpublic-referenced assetに見つからなかった。`/api/links` がGETであることから「このpathへPOSTすればよい」と推定・実行してはならない。

## 6. Creator catalog contract

| Concept | Status | Reason |
| --- | --- | --- |
| username/slug | `CONFIRMED_STATIC_CONTRACT` | route `:username` + detail hook |
| creator name | `CONFIRMED_OFFICIAL_DOC` | creator list/search/salesの公式記述。exact propertyは`UNKNOWN` |
| creator user ID | `CONFIRMED_AS_PATH_INPUT` | `/api/users/:userId/posts`; response property/UI visibilityは`UNKNOWN` |
| stable creator ID distinct from user ID | `UNKNOWN` | literal/propertyなし |
| avatar URL | `UNKNOWN` | current catalog propertyなし |
| followers / following / likes | `UNKNOWN` | current catalog propertyなし |
| post count / affiliate post count | `UNKNOWN` | current propertyなし |
| single reward rate | `CONFIRMED_OFFICIAL_DOC` | official search/rate docs。property名は`UNKNOWN` |
| plan initial / continuation rate | `CONFIRMED_OFFICIAL_DOC` | official reward settings。property名は`UNKNOWN`[^8] |
| approval state | `CONFIRMED_SEMANTIC` | registered endpoint/tab + approved-only guide。property名は`UNKNOWN`[^6] |
| approved-only flag | `CONFIRMED_SEMANTIC` | creator-side official setting。property名は`UNKNOWN` |
| SNS links / plan count / public-private flags | `UNKNOWN` | allowed static sourceにpropertyなし |

Creator catalogは、list、registered subset、username detail、userId-scoped postsという四層構造が最もよく説明する。exact pagination/sort parametersは不明である。

## 7. Post catalog contract

| Concept | Status | Reason |
| --- | --- | --- |
| post UUID/ID | `UNKNOWN` | response property/path parameterなし |
| creator relation | `CONFIRMED_AS_USER_ID_PATH` | `/api/users/:userId/posts` |
| title | `LIKELY` | search/list UXには必要だがcurrent property未確認 |
| post URL | `CONFIRMED_OFFICIAL_DOC` | generator input、approved search flow[^6][^9] |
| thumbnail | `CONFIRMED_OFFICIAL_DOC` | sold-work detail、affiliate OGP。search propertyは`UNKNOWN`[^10] |
| media type / duration / image count | `UNKNOWN_FOR_AFFILIATE_CENTER` | general MyFans card機能の記述はあるがcatalog contractとは別 |
| likes / bookmarks / published timestamp | `UNKNOWN` | current response propertyなし |
| price | `CONFIRMED_OFFICIAL_DOC` | 2026-06-03 search result[^10] |
| sale price | `CONFIRMED_IN_REPORT_CONTEXT` | realized sale。discount/list-price semanticsは`UNKNOWN` |
| single reward rate / estimated reward | `CONFIRMED_OFFICIAL_DOC` | creator sortとsales detail[^10] |
| affiliate eligibility | `CONFIRMED_SEMANTIC` | search participationとgenerator success/error[^9] |
| genre relation | `LIKELY` | genre routes/APIはcurrent。post propertyは`UNKNOWN` |
| tag IDs/names | `UNKNOWN` | public static contractなし |
| visibility/access flags | `UNKNOWN` | approved-only semanticsはあるがpropertyなし |

この結果は「fieldがbackendにない」という意味ではない。public entry pagesへbundleされたcodeからresponse property accessを観測できなかった、という限定された結論である。

## 8. Search, filter, sort, and pagination

Search targetはcreator/post/gacha、genre collection/searchまで `CONFIRMED_STATIC_CONTRACT`。ユーザーが前段UIで確認したgenre category label「見た目」「プレイ」「タイプ」「シチュエーション」「コスチューム」は別evidenceとして保持するが、Phase6G static assetからはexact schemaへ結び付かなかった。

| Concept | UI/official evidence | Exact runtime name/value |
| --- | --- | --- |
| sexual orientation | category conceptはprior UI evidence | `UNKNOWN` |
| genre id | dynamic route `:id` | request/response propertyは`UNKNOWN` |
| genre slug/name | genre UXからlikely | `UNKNOWN` |
| search query | search feature confirmed | parameter名`UNKNOWN` |
| media type | candidate filter | `UNKNOWN` |
| approved | dedicated registered endpoint/tab | filter parameterは`UNKNOWN` |
| reward-rate descending | official 2026-06-12 | sort enum値`UNKNOWN`[^10] |
| reward-amount descending | official 2026-06-12 | sort enum値`UNKNOWN`[^10] |
| new / old / likes sort | `UNKNOWN` | enum値`UNKNOWN` |
| page / limit / offset / cursor | generic query object supports caller keys | actual key、default、max、response metadataすべて`UNKNOWN` |

generic `Object.entries(params) → URLSearchParams` implementationは、任意のkeyを受けるためparameter名の証拠にはならない。minified third-party library中の`page`や`limit`という文字列もapplication contractとして採用しなかった。

### 8.1 Authenticated UI evidence consolidated in Phase6H

次はユーザー本人が認証済みAffiliate Centerの通常UIで確認済みのschema factsであり、API responseの観測ではない。個別creator名、作品名、報酬率、売上、affiliate URL、account情報は保存していない。[^20]

| Surface | `CONFIRMED_USER_AUTH_UI` | API/runtime boundary |
| --- | --- | --- |
| bottom navigation | ホーム、アフィ検索、クリエイター検索、レポート | navigation component propertyは`UNKNOWN` |
| dashboard | 前日の実績、週間パフォーマンス、見込報酬、購入、click、CVR | `/api/summary` response propertyは`UNKNOWN` |
| affiliate search | TOP、投稿検索、ガチャ、URL貼付。TOPにaffiliate URL表示 | tab/runtime valueは`UNKNOWN` |
| browser URL query | `sexual_orientation=woman`、genre resultの`genre_name` | backend API query名としては`UNKNOWN` |
| genre category | 見た目、プレイ、タイプ、シチュエーション、コスチューム | genre response propertyは`UNKNOWN` |
| post search card | thumbnail、video duration、single sale price、reward rate、estimated reward、title、creator、relative published time、profile action、affiliate URL copy | exact response propertyはすべて`UNKNOWN` |
| post search control | All/video/image、popular sort、次へ | runtime enumとpagination keyは`UNKNOWN` |
| creator search | 一般/承認済み、`/affiliates/search/creators`、`/affiliates/search/creators/tab/registered` | registered row schemaは`UNKNOWN` |
| creator list | name、avatar、likes、followers、affiliate-enabled post count、SNS icons、single/plan-initial reward rate | exact response propertyは`UNKNOWN` |
| creator detail | `@username`、post/like/follower/following counts、plan initial/continuation rates、plan name/monthly price/post count/description | internal creator IDとproperty名は`UNKNOWN` |
| creator post card | thumbnail、duration、title、access icon、likes、relative time、price、single reward rate、affiliate action | exact response propertyは`UNKNOWN` |
| public post URL | `https://myfans.jp/posts/<UUID>` | stable UUID-like route identifierは確認、backend property名は`UNKNOWN` |
| report | 今日/昨日/今月/先月/期間、gross/confirmed/estimated/click/purchase、sale/creator views、全/見込/確定/否認、CSV control | date/status runtime value、query key、response propertyは`UNKNOWN` |

Creator listの表示sort labelは、新規登録順、アフィ設定作品の公開件数が多い順、報酬単価（単品販売）が高い順、報酬単価（プラン加入）が高い順、フォロワー数が多い順。Creator detail post listは、新しい順、古い順、いいね数、報酬率が高い順、報酬額が高い順。意味概念へのmappingは可能だが、runtime enum valueはすべて `UNKNOWN` のままである。

Creator detailに表示された `1-20/91件` は、当該UI instanceが20件を表示したことを確認する。APIのdefault `limit=20`、parameter名、maximumを確認する証拠ではない。

## 9. Affiliate link-generation model

公式guideでは、creator profileまたはpost URLをURL生成画面へpasteし、対象外ならerror、対象ならaffiliate URLを生成し、自動でclipboardへcopyする。search resultからaffiliate参加済みpost/profileを直接生成する導線も2026-04-16に追加された。[^7][^9]

Target modelは次のように整理できる。

- TOP: official reward tableでtarget typeを確認。generation implementationは`UNKNOWN`。[^8]
- creator: `/affiliates/search/creators/:username`、creator link reward、profile URL pasteで確認。
- post: `/api/search/posts`、post link reward、post URL pasteで確認。
- gacha: `/affiliates/gachas`、`/api/search/gachas`、gacha link rewardで確認。

静的に確認できたworkflowは `catalog/search → eligibility context → UI generation action → generated list read model`。生成request path/method、input body、generated link response property、eligibility error propertyはすべて`UNKNOWN`である。研究中のlink生成は0。

## 10. Reports and CSV

report architectureはsummary、sale、creator-saleの三系列で、各系列にscreen read contract、前二系列を含む三つのCSV contractがある。Creator-level CSVは公式2026-08-28 updateとも一致する。[^3][^11]

公式2026-09-04 updateは、販売単位の売上のclick数を累計ではなく、上部filterの「今日・昨日・今月・先月・期間指定」に揃え、同tabのCSVへ「クリック数」列を追加したと説明する。[^12] よってdate filter conceptとclick-count CSV columnは確認できるが、query key名やCSV exact header全体は確認できない。

売上detailについては、2026-06-12 updateがthumbnail、creator、estimated reward、sale price、reward rateを明示する一方、Phase6Eで確認したFAQにはaggregate-onlyと読める記述があり、`DOC_CONFLICT` を維持する。authenticated UI/CSVを開かずに片方を正としない。

## 11. Third-party feasibility comparison

Phase6Gではcompetitor pageをfresh/bulk取得せず、2026-09-09のPhase6E public-page evidenceを再利用した。

| Operator | Observed scope / fields | Frequency / automation | Fit with official frontend map | Source status |
| --- | --- | --- | --- | --- |
| oshiscope | 約1,572 affiliate creator、post、followers、post count、likes/bookmarks、price/sale、published time、genre | daily fixed-time、high automationを自己説明 | eligibility/creator/post/price/genreはよく説明。followers/likes/dateはcurrent public static response propertyだけでは説明不能 | `THIRD_PARTY_PROOF_ONLY / NOT_USABLE`[^13][^14] |
| NoxReel | creator/work/genre/tag/recommendation/public free video | automation + human editorial | full catalog feedなしでも、public content + manual selectionで説明可能 | `RESEARCH_REFERENCE_ONLY`[^15][^16] |
| FansLabo | creator/profile URL/post URL/price/update/atmosphere | small, manual curated | exact public page check + one-by-one affiliate operationと整合 | `RESEARCH_REFERENCE_ONLY`[^17] |
| けんけん | creator candidate/video URL | manual、25 creatorで約10時間と自己説明 | URL copy → Center paste → one-by-one generationと整合 | `RESEARCH_REFERENCE_ONLY`[^18] |

oshiscopeのpolicyはautomated scraping、bulk copy、database replicationを禁止するため、feasibility proofとしてのみ扱い、sourceにはしない。[^14]

## 12. Ranked architecture hypothesis

1. **D. Multiple-source combination — `MEDIUM_HIGH`**
   Authenticated Affiliate Centerからaffiliate-eligible creator/post universeを得て、public MyFans pages等からfollowers、likes、published timeなどを補う構成が最も説明力が高い。approved-only ACLがaccount-relativeであることも、eligibility seedに認証sourceを必要とする方向を支持する。ただしoshiscopeの実装についての確認ではない。

2. **B. Authenticated Affiliate Center catalog — `MEDIUM`**
   current creator/search/post/genre clientsとofficial UI featureは大規模観測の中核を説明する。response schemaが見えないため、観測fieldのすべてを単一sourceが返す可能性は残る。

3. **C. Public-but-undocumented first-party feed — `LOW`**
   技術的可能性は否定できないが、publicly linked feed/API documentationもcatalog exportも見つからない。

4. **A. Public MyFans pages only — `LOW`**
   exact URLのpublic fieldsは説明できるが、affiliate eligibility、approved-only visibility、complete discoveryを単独では説明しにくい。Phase6Dのunauthenticated discovery pauseとも整合しない。

## 13. Implementation boundary

追加のuser interactionなしで実装可能なのは、public landingからHTML-referenced static assetだけを辿り、route/helper/wrapperのhashとliteral driftを検知するread-only architecture monitor、およびdocs/evidence更新である。これはcreator/post dataの取得機能ではない。

次は引き続き `MYFANS_PERMISSION_REQUIRED`:

- authenticated catalog/API/UIをprogrammatically取得、paginate、定期同期すること
- creator/post name、URL、price、rate、eligibilityをDBへ保存・public mediaへ再掲すること
- approved-only creator/product/rateを保存・公開すること
- thumbnail、profile image、sample video、OGPを保存・転載・加工すること
- URL generationの自動化、generated listのbulk管理
- dynamic catalog pageを広告物事前確認へ出す方法

現行規約・FAQ上のcompliance判断は既存 [MYFANS_AFFILIATE_COMPLIANCE_MATRIX.md](./MYFANS_AFFILIATE_COMPLIANCE_MATRIX.md) を正とする。staticで「技術的に構造が見えた」ことは、ingestionまたはrepublicationの許諾を意味しない。[^19]

## 14. Security and evidence counters

| Counter | Value |
| --- | ---: |
| Phase6G public first-party HTML/file GET | 7 |
| Phase6G unique HTML-referenced static asset GET | 40 |
| Phase6H public landing drift-check GET | 1 |
| Phase6H public static asset GET | 0 |
| same-URL duplicate GET | 0 |
| brute-force chunk enumeration | 0 |
| authenticated page/RSC GET | 0 |
| authenticated API request | 0 |
| raw/private API response saved | 0 |
| cookie/token/session/localStorage access | 0 |
| browser/user UI action by Codex | 0 |
| affiliate link created | 0 |
| CSV downloaded | 0 |
| competitor raw dataset | 0 |
| DB / production mutation | 0 |

Machine-readable evidence is frozen under:

`/Users/saitoutomoya/Documents/Codex/okazudb-state/myfans-research/phase6g-public-frontend-architecture-20260915/`

Phase6H evidence:

`/Users/saitoutomoya/Documents/Codex/okazudb-state/myfans-research/phase6h-auth-route-static-20260915/`

## 15. Phase6H auth route static-resolution boundary

Phase6Hのpublic landing drift checkはPhase6Gと同じdeployment `dpl_381BzSYTpyqKpbE9FHiEEna8tp3a` を返した。このため同一static assetを再取得せず、Phase6Gで保存済みの40 asset、route manifest、Turbopack runtime、route helper、generated client evidenceを再利用した。public landing GETは1、追加static asset GETは0である。[^1][^2][^3][^4]

現在のroute manifestはauth route patternを列挙するが、各patternにpage/client chunk URLを割り当てない。Turbopack runtimeはroute responseから渡されたexact chunk pathをloadするが、調査済みpublic entry assetに全auth routeのglobal route-to-chunk tableはない。App Routerのroute-specific client referencesは対象routeのHTML/RSC response側で得られるが、auth page/RSC GETは禁止範囲である。

従って結果は次の通り。

| Item | Result |
| --- | --- |
| exact auth route static assets derived | `0` |
| additional public static asset GET | `0 / 20` |
| `CONFIRMED_STATIC_CALLSITE` contract | `0` |
| filename/hash guessing、404探索 | `0` |
| exact backend query keys | `UNKNOWN` |
| sort runtime enum | `UNKNOWN` |
| pagination key/default | `UNKNOWN` |
| response property names | `UNKNOWN` |
| generated-link mutation/error shape | `UNKNOWN` |
| report runtime contract | `UNKNOWN` |

これは「route/page implementationが存在しない」という結論ではない。許可されたpublic-static chainだけではchunk URLを決定的に導出できない、という取得境界である。次の技術的gateは抜け道ではなく、MyFansの書面許可またはofficial integration guidanceである。`MYFANS_PERMISSION_REQUIRED` を維持する。

`PHASE6H_AUTH_ROUTE_STATIC_BOUNDARY_REACHED`

## Sources

[^1]: [Affiliate Center public landing](https://www.affiliate.myfans.jp/) and [sitemap](https://www.affiliate.myfans.jp/sitemap.xml), inspected 2026-09-15.
[^2]: [Current public chunk containing the route manifest](https://www.affiliate.myfans.jp/_next/static/chunks/0le5wf1kz_v.0.js?dpl=dpl_381BzSYTpyqKpbE9FHiEEna8tp3a), SHA-256 `d5871311fdb6a82f4a05105825a0f37dc08328728c63dd77910877c3b5482249`.
[^3]: [Current public chunk containing generated API clients](https://www.affiliate.myfans.jp/_next/static/chunks/0xdz3zdv07-rs.js?dpl=dpl_381BzSYTpyqKpbE9FHiEEna8tp3a), SHA-256 `6416333d9ebde03e9707a771be5100e44abc34ffc42afe931c56dae51141107c`.
[^4]: [Current public chunk containing the route helper and request wrapper](https://www.affiliate.myfans.jp/_next/static/chunks/0bt9qf~zhu06q.js?dpl=dpl_381BzSYTpyqKpbE9FHiEEna8tp3a), SHA-256 `342b235b7041e57e00f154defe952f0b0485c3ce07d262461c83ca454688cedc`.
[^5]: [Affiliate Center robots.txt](https://www.affiliate.myfans.jp/robots.txt).
[^6]: [承認済みアフィリエイターのみに公開する方法（公式）](https://support.myfans.jp/hc/ja/articles/17400497455119).
[^7]: [2026年4月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/15929691377039).
[^8]: [アフィリエイト報酬一覧表（公式）](https://support.myfans.jp/hc/ja/articles/15767560367247) and [アフィリエイト報酬率の設定方法（公式）](https://support.myfans.jp/hc/ja/articles/16511399451279).
[^9]: [アフィリエイター向けの登録方法（公式）](https://support.myfans.jp/hc/ja/articles/15722941497487).
[^10]: [2026年6月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/16591475920015).
[^11]: [2026年8月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/17438720560271).
[^12]: [2026年9月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/17592028989071).
[^13]: [oshiscope methodology](https://oshiscope.com/methodology/) and [disclosure](https://oshiscope.com/disclosure/).
[^14]: [oshiscope data policy](https://oshiscope.com/data-policy/).
[^15]: [NoxReel / MyFansアフィ研究所 — development and operation](https://note.com/myfans_lab/n/nf687fc9907a1).
[^16]: [NoxReel / MyFansアフィ研究所 — seven-day results](https://note.com/myfans_lab/n/n0f34e26588d3).
[^17]: [FansLabo creator discovery](https://fanslabo.com/articles/how-to-find-myfans-affiliate-creators).
[^18]: [けんけん@myfansアフィ — manual URL generation](https://note.com/ken_myfans_affi/n/n7af5bcae9aaa).
[^19]: [Current Affiliate Terms](https://www.affiliate.myfans.jp/terms).
[^20]: User-provided authenticated Affiliate Center UI observations, 2026-09-15. No screenshot, raw DOM, catalog row, affiliate URL, account identifier, cookie, token, or session value was collected or stored.
