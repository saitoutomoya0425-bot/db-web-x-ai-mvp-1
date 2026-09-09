# Phase 6E — MyFans Affiliate Ecosystem Deep Research

調査基準日: 2026-09-09 (JST)  
調査区分: RESEARCH ONLY / DB 0 / production 0 / ingestion 0 / private API replay 0  
判定語: `CONFIRMED` = 公式本文または公開画面で確認、`LIKELY` = 公開static asset・複数資料から強く示唆、`UNKNOWN` = 証拠不足

## Executive conclusion

Phase 6D の `AUTOMATION_PAUSED` は、`myfans.jp` の未認証ranking / sitemap / tag surfaceから全件を自動発見する経路だけに適用される。MyFans integration全体を断念する根拠ではない。

2026年3月以降、公式の [MyFans Affiliate Center][1] は、審査済みaffiliate向けにcreator/post検索、creator一覧、ranking/recommendations、creator詳細、URL生成、売上report、CSV、coupon、media管理を段階的に追加している。2026-09-01以降は、creatorが「承認済みaffiliateのみに公開」を選べるため、affiliate catalogは閲覧affiliateごとに異なり得る。[^1]

公開情報だけで確認できた最有力data pathは、`affiliate.myfans.jp` の認証内catalogである。公開static JavaScriptにはsearch/creator/link/sales系のroute名とAPI path literalが存在するが、これはarchitecture evidenceに過ぎない。公開developer API/feedの仕様、catalog export、利用許諾は発見できなかった。endpointは呼び出していない。

したがって現在の結論は次の2つである。

- source mapping: `AUTHENTICATED_AFFILIATE_CENTER_MAPPING_PENDING_USER_LOGIN`
- ingestion/publication: `MYFANS_PERMISSION_REQUIRED`

oshiscopeが毎日約1,572 creatorを観測できていることは、affiliate対象集合を継続取得できるproof-of-feasibilityである。しかし同サイトのpolicyはautomated scraping、bulk copy、DB replicationを明示的に禁止するため、`THIRD_PARTY_PROOF_ONLY` でありingestion sourceにはならない。[^2]

## 1. Scope and safety boundary

実施したこと:

- Affiliate Centerの公開LP、Terms、Privacy、robots、sitemap、manifest、公開HTMLと同HTMLから直接参照されるstatic JSを少数確認
- 公式Support Guideのaffiliate section全9記事、creator向け報酬率記事、2026年4月以降の月次updateを確認
- 検索engine、公開GitHub code search、operatorの少数公開pageをreference用途で確認
- route/function/API pathの文字列だけをarchitecture evidenceとして記録

実施していないこと:

- login bypass、credential/cookie/token取得・export、private endpoint replay、anti-bot bypass、brute force
- competitor siteの自動巡回、bulk scrape、database化、raw dataset保存
- MyFans/競合画像の保存、DB mutation、ingestion、production access、deploy

公開GitHub code searchと検索engineでは、MyFans公式のdeveloper documentation、公開SDK、catalog API/feed仕様は確認できなかった。不存在の証明ではなく、`NOT_FOUND_IN_PUBLIC_RESEARCH` である。

実行環境のin-app browser sessionを取得できなかったため、Support記事内の画像だけに写る列名、signed-in UI、CSV headerはvisual確認していない。本文で明示されないfieldをこの制約下で `CONFIRMED` にしていない。検索engine indexでも認証内catalog row/pageは発見できなかった。

## 2. Official public footprint

### 2.1 Public pages

| Surface | Public finding | Result |
| --- | --- | --- |
| Affiliate Center LP | 登録、login、URL生成、SNS/blog利用、direct最大100%、category最大2%、運営主体表示 | `CONFIRMED` |
| Terms | media/creative事前確認、credential、再委託、禁止事項、秘密保持、IP、支払 | `CONFIRMED` |
| Privacy | cookie/IP/log/閲覧・購買等の取得目的 | `CONFIRMED` |
| `robots.txt` | `Allow: /` とsitemap指定 | `CONFIRMED`。利用許諾やAPI公開を意味しない |
| sitemap | root URLのみ | `CONFIRMED`。catalog discoveryには使えない |
| dashboard / URL生成へのSupport link | 未認証時はsigninへredirect | `CONFIRMED` |

Termsは2026-03-13発効、2026-08-31、09-02、09-04改定と表示される。[^3] Privacyは2026-03-01付。[^4]

### 2.2 Public static architecture evidence

公開pageから直接参照されるstatic bundle内で、次のUI route名を確認した。routeの存在は `LIKELY`、機能の意味は公式Support本文と一致する場合のみ `CONFIRMED` とした。

- `/affiliates/search`, `/affiliates/search/result`, `/affiliates/search/suggest`
- `/affiliates/search/creators`, `/affiliates/search/creators/:username`, `/affiliates/search/creators/tab/registered`
- `/affiliates/search/from_url`, `/affiliates/search/genres/:id/result`
- `/affiliates/generated`, `/affiliates/generated/creators/:username`
- `/affiliates/gachas`, `/affiliates/top`, `/affiliates/url`
- `/reports`
- `/settings/media`, `/settings/media/new`, `/settings/banks`, account/profile verification routes

同じstatic bundleには `/api/search/creators`, `/api/search/posts`, `/api/search/gachas`, `/api/creators`, `/api/creators/registered`, `/api/links`, `/api/links/creators`, `/api/sales`, `/api/sales/creators`, `/api/sales/csv`, `/api/sales/creators/csv`, `/api/summary/csv`, `/api/medias` などのpath literalがある。

これらは次を意味しない。

- 公開APIである
- third-party clientから呼び出してよい
- catalogのbulk exportが許可される
- response schemaが判明した

API requestは0件。responseは0件。認証方式、rate limit、pagination、利用条件はいずれも `UNKNOWN` である。

## 3. Official Affiliate Center function map

| Function | Status | Official evidence / boundary |
| --- | --- | --- |
| affiliate search | `CONFIRMED` | 参加済みpost/profileを検索しURL生成。2026-04-16 |
| creator list | `CONFIRMED` | 2026-06-04追加 |
| ranking | `CONFIRMED` | 2026-09-01の非承認affiliateから非表示となるsurfaceとして公式列挙 |
| recommendations | `CONFIRMED` | 同上 |
| approved creator search | `CONFIRMED` | creator検索の「承認済み」tab |
| creator detail/profile | `CONFIRMED` | creator profile内post表示・sort |
| post detail/search | `CONFIRMED` | search result、URL paste、post URL生成 |
| URL generator | `CONFIRMED` | public creator/post URLを貼付して生成。対象外はerror |
| reward-rate sorting | `CONFIRMED` | creator profile内postを報酬率順。2026-06-12 |
| reward-amount sorting | `CONFIRMED` | creator profile内postを報酬額順。2026-06-12 |
| sales report | `CONFIRMED` | click/sale/reward、反映は最大24h |
| creator-level sales CSV | `CONFIRMED` | 2026-08-28追加。catalog CSVではない |
| coupon | `CONFIRMED` | 選定affiliate限定、post URL限定。2026-09-03時点 |
| registration/media management | `CONFIRMED` | mediaごとに申請、Approved/Pending/Rejected |
| public catalog/feed/API | `UNKNOWN` | 公式documentationなし |
| full catalog CSV | `UNKNOWN` | sales CSV以外は確認できず |

詳細なsurface×field判定は [MYFANS_AFFILIATE_DATA_SOURCE_MATRIX.md](./MYFANS_AFFILIATE_DATA_SOURCE_MATRIX.md) に分離した。

### 3.1 Official Support Guide affiliate inventory

Affiliate sectionに列挙された9記事を全件確認した。関連するcreator向け報酬率記事も併読した。

| Official guide | Confirmed content |
| --- | --- |
| アフィリエイト報酬対象・料率 | purchase path別のdirect/category率、対象外商品、報酬式 |
| アフィリエイト報酬の受取 | report、CSV、残高、最低出金、支払cycle、24h attribution記載 |
| アフィリエイト登録方法 | 個人/法人情報、SMS・本人確認、bank/invoice、mediaごとの審査、URL生成flow |
| creatorのaffiliate参加方法 | profile/postごとの対象化、参加設定 |
| invoice登録 | invoice事業者情報の登録flow |
| bank account登録 | 報酬受取口座の登録flow |
| FAQ | 対象商品、last click、report、media、`#PR`、画像/動画/引用/logo/short URL rules |
| approved affiliates only | creator/product ACL、affiliate個別率、Approved tab、既存linkの有効/無効 |
| affiliate coupon | 選定affiliate限定campaign、post link限定、generated-list marker |
| creator向け報酬率設定（関連section） | plan加入/継続、single、gachaの個別率と選択範囲 |

Support sectionの公開9記事は、報酬、登録、creator参加、invoice、bank、FAQ、approval ACL、couponまでを説明するが、developer API/feed、catalog export、認証方式、pagination、rate limitは説明していない。[^21]

## 4. Chronology since March 2026

| Date | Affiliate change | Evidence status |
| --- | --- | --- |
| 2026-03-13 | Affiliate Terms発効 | `CONFIRMED` |
| 2026-04-10 | Affiliate Center公開、creator参加設定 | `CONFIRMED` |
| 2026-04-16 | search resultから参加済みpost/profileのURL生成 | `CONFIRMED` |
| 2026-04-20 | 報酬画面をAPI連携へ切替 | `CONFIRMED`。公開APIの意味ではない |
| 2026-04-21 | 生成URL一覧の説明文表示等を改善 | `CONFIRMED` |
| 2026-05-01 | creatorの単品報酬率10–50%設定 | `CONFIRMED`。後に上限100%へ拡張 |
| 2026-06-03 | search resultに単品販売価格、plan継続報酬設定 | `CONFIRMED` |
| 2026-06-04 | affiliate向けcreator一覧 | `CONFIRMED` |
| 2026-06-11 | affiliate URLのSNS OGP/thumbnail | `CONFIRMED` |
| 2026-06-12 | sales detailに作品thumbnail、creator、販売額、率、推定報酬。creator profileで率/額sort | `CONFIRMED` |
| 2026-06-17 | creator設定率上限100% | `CONFIRMED` |
| 2026-06-24 | plan継続時のdefault率設定 | `CONFIRMED`。数値defaultは未確認 |
| 2026-07-10 | attributionを24hから7日/168hへ延長 | `CONFIRMED`。現行別記事と矛盾 |
| 2026-07-24 | gachaを報酬対象に追加 | `CONFIRMED` |
| 2026-08-10 | 報酬式を販売価格×率から（販売価格−creator手数料）×率へ変更 | `CONFIRMED` |
| 2026-08-18 | creator設定率のAffiliate Center反映条件を緩和 | `CONFIRMED` |
| 2026-08-28 | reportにcreator-level sales detail CSV | `CONFIRMED` |
| 2026-08-31 | 支払cycle短縮、Terms 7.6/7.7改定 | `CONFIRMED` |
| 2026-09-01 | approved affiliates only、個別率、非承認からsearch/list/ranking/recommendation非表示 | `CONFIRMED` |
| 2026-09-03 | 選定affiliate向けcoupon | `CONFIRMED` |
| 2026-09-04 | Terms最終表示改定日 | `CONFIRMED` |

月次更新の根拠は公式4月、5月、6月、7月、8月記事による。[^5][^6][^7][^8][^9]

## 5. Official economics

報酬額の現行式は `floor((販売価格 − creator手数料) × 報酬率)`。2026-08-10に変更された。[^9]

| Purchase path | Official default/direct rule | Status |
| --- | --- | --- |
| post link → linked single post | 10% | `CONFIRMED` |
| post link → same creator, other single post | 1% | `CONFIRMED` |
| post link → plan/bundle containing linked post | 15% | `CONFIRMED` |
| post link → other plan/bundle | 1% | `CONFIRMED` |
| post link → backnumber plan/month | 1% | `CONFIRMED` |
| creator profile link → same creator single/plan/bundle/backnumber | 5% | `CONFIRMED` |
| gacha link → linked gacha | 10% | `CONFIRMED` |
| other creator/top link | category reward 2% | `CONFIRMED` |
| tip / super comment / unlimited channel | 対象外 | `CONFIRMED` |
| plan continuation | creatorが加入時/継続時を別設定。継続発生には元加入がpost-link direct等の条件あり | `CONFIRMED`。platformの数値defaultは `UNKNOWN` |
| creator custom | plan加入/継続、single post、gachaごとに10–100%を10%刻み。planのみ15%も選択可 | `CONFIRMED` |
| approved affiliate custom | affiliateごとに10–100% | `CONFIRMED` |

上表は公式報酬表、FAQ、creator向け率設定guideを突合した。[^10][^11][^12]

### Payment and attribution

| Item | Official statements | Determination |
| --- | --- | --- |
| attribution | 2026-07-10 update: 7日/168h。報酬受取記事（2026-08-31更新）: click後24h | `DOC_CONFLICT` |
| last-click | 複数link経由は最後のclickがdirect reward対象 | `CONFIRMED` |
| report latency | click/saleは最大24hで反映 | `CONFIRMED` |
| close/approval/pay | 月末締め、翌月5日まで通知、8日まで異議、10日まで支払 | `CONFIRMED` |
| minimum withdrawal | 5,000円 | `CONFIRMED` |
| transfer fee | Support: 220円を報酬から控除。現行Terms 7.7: 振込手数料はMyFans負担 | `DOC_CONFLICT` |
| sales detail | 2026-06-12 update: 作品単位detail。2026-09-09 FAQ: 個別購入内容は見えずaggregateのみ | `DOC_CONFLICT` |

矛盾は一方を勝手に優先せず、サポート照会対象とする。

## 6. Affiliate data-path investigation

### 6.1 Candidate source classes

1. **Authenticated Affiliate Center search/list/detail** — creator/post eligibilityとrateを含む最有力source。`OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED`。documented export/APIはないためautomationは `MYFANS_PERMISSION_REQUIRED`。
2. **Official sales/creator CSV** — 実際に発生したsalesのreport source。`OFFICIAL_EXPORT / AFFILIATE_ACCOUNT_REQUIRED`。全catalog discoveryには不適。
3. **Affiliate URL/OGP resource** — 自分が生成済みの個別linkのpublic landing/preview。`OFFICIAL_PUBLIC` だがseed URLを必要とし、feedではない。画像再利用は別途許諾が必要。
4. **Public myfans profile/post pages** — exact URLを既知ならcreator name/title/price等を確認できる場合がある。しかしPhase 6Dで全件自動discoveryは不成立。`OFFICIAL_PUBLIC / NOT_USABLE` for complete affiliate catalog。
5. **oshiscope等** — 継続観測可能性のproof。`THIRD_PARTY_PROOF_ONLY / NOT_USABLE`。
6. **Public static JS route/API literals** — source architecture evidenceのみ。`OFFICIAL_PUBLIC / NOT_USABLE` as data source。

### 6.2 What oshiscope proves—and does not prove

oshiscopeはmethodologyで「毎日決まった時刻」「myfansの公開・取扱データ」「購入可能・affiliateで取り扱えるcreator」「affiliate対象post」を区別し、creator数、post数、followers、likes/bookmarks、価格、sale、公開時刻を集計すると説明する。2026-09-09のhome表示は約1,572 creator、95 genreだった。[^2][^13]

これは以下を支持する。

- affiliate eligible集合は日次で変化し、機械的観測が技術的には可能
- creator-levelだけでなくpost-levelの何らかのsource classがある
- public MyFans全体とaffiliate取扱集合は同一ではない

一方、source URL、認証有無、API/feedの種類、契約許諾は公開methodologyだけでは特定できない。oshiscopeのdata policyにより同サイト自体を取得元にすることもできない。

### 6.3 Architecture inference

公式Supportとstatic route名の一致から、Affiliate Center SPAが認証後にsearch/list/detail/link/reportのbackendを利用することは強く示唆される。ただし、これは公開APIの存在ではなくfirst-party web application内部architectureの推定である。

現時点で最も合理的な仮説は次の通り。

```text
creator participation / approved-affiliate ACL
                  ↓
authenticated Affiliate Center catalog/search
     ├─ creator list/detail/ranking/recommendations
     ├─ eligible post search + price/rate/estimated reward
     ├─ affiliate URL generator → public redirect/OGP
     └─ sales events → report / creator-level CSV
```

未確認なのは、catalog backendをaffiliateがdocumented API/feedとして使えるか、またはbrowser UI専用かである。

## 7. Real affiliate operators

| Operator | Traffic / UX | Discovery & automation | Fields used | Link / economics | Compliance posture |
| --- | --- | --- | --- | --- | --- |
| oshiscope | SEO、検索、ranking、急上昇、新着、価格変動、比較、budget simulator | 毎日定時に自動観測と明記。source classは非開示 | creator、followers、post count、likes/bookmarks、price/sale、published time、genre | `/go/c`, `/go/p`、率はranking不使用・非公開。収益非公開 | PR/`rel=sponsored`、削除訂正窓口。自サイトのbulk取得を明示禁止 |
| NoxReel / MyFansアフィ研究所 | X → 縦swipe site → creator/work browse → MyFans CTA | research/test/admin/analysis CSVを自動化、選定/copyは人手最終判断 | public video、creator/work、genre/tag、related/recommendation | 7日: 2,941 sessions、526 CTA、6 MyFans conversions、推定5,512円 | 公開free範囲のみと説明。権利/表示課題を認識 |
| FansLabo | SEO、15件のtext-first curated list、price/update/atmosphere | 手動確認。公開済みのみ、draft/research中を除外 | creator、profile/post URL、price、更新、雰囲気 | `link.affiliate.myfans.jp`。収益非公開 | PR、無断画像不使用、OGPは保存加工しないと説明 |
| けんけん@myfansアフィ | note + X、初心者向けguide、有料creator list | creator選定→video選択→URL copy→Center貼付を手動、25名で約10時間 | creator候補、video URL | Affiliate Centerで1件ずつ生成。収益非公開 | note上ではID名中心。詳細なrights方針は `UNKNOWN` |
| マイファン図鑑 | SEO、12 creator比較 | 公開followers、更新継続、SNS、priceを月1回見直し | name、profile image、plan、price、followers | affiliate identifierあり。収益非公開 | privacy/disclosureと削除窓口。画像許諾根拠は `UNKNOWN` |
| ファンサイトラボ | SEO、23名をgenre/予算別に編集 | 2026-07/08時点を手動researchした記事 | creator、genre、X followers、plan/price | affiliate link有無/収益は確認範囲で `UNKNOWN` | source dateを表示。画像・権利手続は `UNKNOWN` |

NoxReelの公開数値から計算するとCTA/sessionは17.9%、conversion/CTAは1.14%、conversion/sessionは0.204%。小標本・自己申告であり、一般化しない。[^14][^15] FansLabo、けんけん、マイファン図鑑、ファンサイトラボの根拠は各公開記事による。[^16][^17][^18][^19]

## 8. Compliance conclusion

主要結論は [MYFANS_AFFILIATE_COMPLIANCE_MATRIX.md](./MYFANS_AFFILIATE_COMPLIANCE_MATRIX.md) に詳述する。

- affiliate mediaはmediaごとの登録・審査が必要。未登録mediaのclickは報酬対象外。[^20]
- `#PR` 表示が必要。
- Terms 6はwebpage/SNS/banner等のcreativeを公開前にMyFans確認へ出すよう求める。dynamic catalogの承認方法は未記載。
- creator thumbnail/profile image/sample videoの保存・転載・加工は、creatorの事前許可がない限り避ける/禁止とFAQが明記。紹介文の引用は可。[^11]
- Affiliate CenterのID/passwordを第三者に使わせてはならない。credential共有を伴うautomationは不可。
- 再委託自体はTerms 9で許されるが、affiliate本人が責任を負い、同等義務を課す必要がある。
- Termsのbot/tool禁止は「購入等の指定行為を発生させる」用途を対象にしている。catalog automation一般の包括禁止と読み替えない。ただし許可も記載されていないため `MYFANS_PERMISSION_REQUIRED`。
- 非公開の技術・営業情報は秘密保持対象。approved-only creator/rateは閲覧affiliate依存であり、公開catalogへ転載してよいとは判断できない。
- 自分のaffiliate URLを承認済みmediaに掲示することと、認証内catalogをbulk保存・再公開することは別の権利判断である。

## 9. Final source ranking

順位は「正確性＋coverage＋affiliate eligibilityとの一致」で付ける。`PUBLIC_NO_AUTH_READY` は単一既知URLの表示可否ではなく、反復可能なsourceとしての準備状況を表す。

| Target | Rank 1 | Rank 2 | Rank 3 |
| --- | --- | --- | --- |
| A. creator list | Affiliate Center creator list/search — `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED`, automationは `MYFANS_PERMISSION_REQUIRED` | official catalog export/API — `UNKNOWN / MYFANS_PERMISSION_REQUIRED` | oshiscope — `THIRD_PARTY_PROOF_ONLY / NOT_USABLE` |
| B. post list | Affiliate Center creator detail/post search — `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED`, automationは `MYFANS_PERMISSION_REQUIRED` | URL-paste generator（known URLのeligibility確認）— `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED` | oshiscope — `THIRD_PARTY_PROOF_ONLY / NOT_USABLE` |
| C. price | Affiliate search result/creator detail — `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED` | known public post page — `OFFICIAL_PUBLIC / PUBLIC_NO_AUTH_READY` for exact URL only | sales CSV — `OFFICIAL_EXPORT / AFFILIATE_ACCOUNT_REQUIRED` for sold items only |
| D. thumbnail | Affiliate Center sales/search UI — `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED`; reuse is `MYFANS_PERMISSION_REQUIRED` | generated affiliate URL OGP — `OFFICIAL_PUBLIC / PUBLIC_NO_AUTH_READY` for generated URL; reuse is permission-sensitive | public profile/post image — `OFFICIAL_PUBLIC / PUBLIC_NO_AUTH_READY` for view only, ingestion/publication not ready |
| E. reward rate | Affiliate Center search/detail — `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED` | sales detail/CSV — `OFFICIAL_EXPORT / AFFILIATE_ACCOUNT_REQUIRED` for realized sales | official default table — `OFFICIAL_PUBLIC / PUBLIC_NO_AUTH_READY` for generic rule only |
| F. affiliate eligibility | Affiliate Center search/list + URL generator — `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED` | generated link behavior — `OFFICIAL_PUBLIC / NOT_USABLE` as complete catalog | oshiscope — `THIRD_PARTY_PROOF_ONLY / NOT_USABLE` |
| G. affiliate URL | official URL generator — `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED` | generated URL list — `OFFICIAL_AUTHENTICATED / AFFILIATE_ACCOUNT_REQUIRED` | public operator redirects — `THIRD_PARTY_PROOF_ONLY / NOT_USABLE` |

Important qualifiers:

- creator/post **complete feed**: `PUBLIC_NO_AUTH_READY = false`
- full catalog API/feed/export: `UNKNOWN`
- sales CSV: `CONFIRMED` but not a discovery feed
- approved-only records: `OFFICIAL_AUTHENTICATED` and affiliate-specific; public reuse is `MYFANS_PERMISSION_REQUIRED`
- competitor source: all `NOT_USABLE` for ingestion

## 10. Decision and sole user action

Current state:

`AUTHENTICATED_AFFILIATE_CENTER_MAPPING_PENDING_USER_LOGIN`

次のuser-only actionは1つだけ:

**審査済みAffiliate Centerアカウントへご自身のブラウザでログインし、ログイン完了だけを知らせる。**

password、SMS code、本人確認書類、cookie/tokenの共有は不要かつ禁止。次phaseで許されるのは、ユーザーのsigned-in browser上の画面を少数手動確認し、field/CSV header/UIをmapすることまでであり、private API replayやDB ingestionではない。

## Footnotes / Sources

[^1]: [承認済みアフィリエイターのみに公開する方法（公式）](https://support.myfans.jp/hc/ja/articles/17400497455119)
[^2]: [oshiscope Methodology](https://oshiscope.com/methodology/) および [Data Policy](https://oshiscope.com/data-policy/)
[^3]: [MyFans Affiliate Center Terms](https://www.affiliate.myfans.jp/terms)
[^4]: [MyFans Affiliate Center Privacy](https://www.affiliate.myfans.jp/privacy)
[^5]: [2026年4月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/15929691366031)
[^6]: [2026年5月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/16034365664143)
[^7]: [2026年6月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/16591475920015)
[^8]: [2026年7月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/17438725435151)
[^9]: [2026年8月 機能アップデートまとめ（公式）](https://support.myfans.jp/hc/ja/articles/17438720560271)
[^10]: [アフィリエイト報酬対象・料率（公式）](https://support.myfans.jp/hc/ja/articles/15767560367247)
[^11]: [アフィリエイト FAQ（公式）](https://support.myfans.jp/hc/ja/articles/14946655853711)
[^12]: [アフィリエイト報酬率の設定方法（公式）](https://support.myfans.jp/hc/ja/articles/16511399451279)
[^13]: [oshiscope](https://oshiscope.com/) および [Disclosure](https://oshiscope.com/disclosure/)
[^14]: [NoxReel / MyFansアフィ研究所 — 開発・運用記事](https://note.com/myfans_lab/n/nf687fc9907a1)
[^15]: [NoxReel / MyFansアフィ研究所 — 7日間の公開数値](https://note.com/myfans_lab/n/n0f34e26588d3)
[^16]: [FansLabo](https://fanslabo.com/creators) および [creator探索方法](https://fanslabo.com/articles/how-to-find-myfans-affiliate-creators)
[^17]: [けんけん@myfansアフィ — 手動URL生成](https://note.com/ken_myfans_affi/n/n7af5bcae9aaa)
[^18]: [マイファン図鑑](https://www.fanskan.jp/) および [Privacy](https://www.fanskan.jp/privacy)
[^19]: [ファンサイトラボ — MyFans creator 23選](https://fansite-lab.com/articles/myfans-osusume-creators/)
[^20]: [affiliate登録方法（公式）](https://support.myfans.jp/hc/ja/articles/15722941497487)
[^21]: [Affiliate Support section（公式）](https://support.myfans.jp/hc/ja/sections/4404364544271)

[1]: https://www.affiliate.myfans.jp/
