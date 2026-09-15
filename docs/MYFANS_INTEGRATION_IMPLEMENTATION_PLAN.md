# MyFans Integration Implementation-Ready Plan

基準日: 2026-09-15 (JST)

状態: `WAITING_FOR_OFFICIAL_PERMISSION / DESIGN ONLY`

## 1. Decision

MyFans integrationは、取得transportだけを交換できる二つのadapterと、共通のnormalization・private staging・publication gateとして実装する。

- Path A: `OFFICIAL_API / OFFICIAL_FEED / OFFICIAL_EXPORT`
- Path B: MyFansが書面で許可した `OFFICIAL_AUTH_UI` automation

どちらも `SourceEnvelope -> normalize -> classify -> freeze -> dry-run -> private staging -> validate -> publish gate` を共有する。Path Bでもprivate endpointを直接callせず、cookie/token/sessionをexportしない。現時点では全permission gateが `UNKNOWN` なので、connector、migration、DB write、public UIを実装しない。

既存の [migration 029](../supabase/migrations/029_myfans_schema_foundation.sql) はbasic identityとprivate stagingの土台として維持する。Phase6Iはproposalだけであり、migration 030等を作成しない。

## 2. Evidence boundary

この設計は次をsource of truthとする。

- [Phase6B schema foundation](../supabase/migrations/029_myfans_schema_foundation.sql)
- [MyFans public metadata foundation](./myfans-public-metadata-foundation.md)
- [Affiliate ecosystem research](./MYFANS_AFFILIATE_ECOSYSTEM_RESEARCH.md)
- [Affiliate data-source matrix](./MYFANS_AFFILIATE_DATA_SOURCE_MATRIX.md)
- [Affiliate compliance matrix](./MYFANS_AFFILIATE_COMPLIANCE_MATRIX.md)
- [Frontend architecture and Phase6H boundary](./MYFANS_AFFILIATE_FRONTEND_ARCHITECTURE.md)

Phase6HのUI evidenceはfieldの存在を確認するが、API property名、automation、storage、publicationの許諾を確認しない。`PHASE6H_AUTH_ROUTE_STATIC_BOUNDARY_REACHED` と `MYFANS_PERMISSION_REQUIRED` を維持する。

## 3. Existing schema fit

### Reuse without semantic change

| Existing object | Fit | Intended use after permission |
| --- | --- | --- |
| `data_sources` | partial | API/feed/CSVなら既存`source_type`を利用。`OFFICIAL_AUTH_UI`はcoarseな`other`にしか入らないため、exact modeはproposed sync job/observationへ保持 |
| `myfans_creators` | good for core identity | source-local ID/slug、name、official URL、optional public profile metadata、current source hash |
| `myfans_posts` | good for core identity | post UUID、creator FK、title、official URL、exact published timestamp、price、content type |
| `myfans_plans` | good for plan basics | stable plan ID、name/description、price、creator relation |
| `myfans_post_plans` | good | sourceが明示したpost-plan relationだけを保存 |
| `video_source_link_evidence` | good | human-reviewed MyFans postとcanonical videoのlink evidence |
| Phase6C freeze/dry-run contracts | reusable pattern | lossless allowed-field freeze、target-scoped plan、idempotent insert、private verify |
| `production-access-guard` | reusable pattern | planned/actual/duplicate request accountingと上限 enforcement |

Migration 029のSHA-256は `b7d0063f07883f37ecc00f3165e5e00dd06bf3166422868e68504d1cf6b332f4` で、Phase6B evidenceと一致する。全MyFans tableはanon accessなしのprivate stagingである。

### Do not overload

- `myfans_creators.visibility`等はcontent access visibilityであり、affiliate ACLではない。
- `raw_public_metadata`へauth-only rate、approval、affiliate URL、account scopeを入れない。
- Migration 029の`raw_public_metadata`/`metadata_hash`はpublic-metadata契約のまま維持する。Auth-derived rowを直接writeせず、future observation/affiliate-state migrationを先に適用する。
- `videos.affiliate_url`およびFANZAのtemplate triggerをMyFans link生成へ流用しない。
- `product_offers`はcanonical videoへlink済みのoffer向けであり、creator/plan/catalog stagingの代替にしない。
- `video_source_link_evidence`はsource identityの自動merge tableではない。name/title/image/rankだけでlinkをapproveしない。

## 4. Proposed additive model after permission

以下は不足fieldを示すproposalで、まだmigrationしない。

| Proposed object | Purpose | Public access |
| --- | --- | --- |
| `myfans_source_observations` | immutable allowed-field provenance、source hash、parser version、permission scope | none |
| `myfans_creator_affiliate_states` | account-scoped approval、eligibility、creator reward rates、affiliate post count | none |
| `myfans_post_affiliate_states` | account-scoped post eligibility、single reward rate、estimated reward | none |
| `myfans_affiliate_links` | target別generated URLとlifecycle。plaintext/public projectionを分離 | none by default |
| `myfans_metric_snapshots` | permissionで許されたcreator/post metricsの時点値。history retentionは条件化 | none |
| `myfans_sync_jobs` / `myfans_sync_errors` | connector、checkpoint、request counts、retry/stop state | admin/service only |
| `myfans_permission_decisions` | 七つのgate、条件、evidence reference、有効期限 | admin/service only |
| `myfans_public_projection` | publication gateを通過したallowlistだけをmaterialize | anon select only after approval |

`source_account_scope`はaffiliate IDやemailを保存せず、運用側で発行したopaque scope UUIDを使う。単一accountでも必須にし、将来複数accountのrate/approval/linkを混同しない。

Future observationの`source_hash`は許可されたsource envelope全体、既存core rowの`metadata_hash`はpublic-safe canonical metadataだけを表す。両者を同じ値だと仮定しない。

## 5. Connector contract

両pathは次のlogical operationだけを実装する。

1. `discoverCreators(checkpoint)`
2. `fetchCreatorDetail(externalCreatorKey)`
3. `fetchEligiblePosts(externalCreatorKey, checkpoint)`
4. `fetchPlans(externalCreatorKey)`（interfaceが明示する場合）
5. `checkEligibility(targetKey)`（許可されたinterfaceがある場合）
6. `generateAffiliateLink(targetKey)`（`permission-link-generation`通過後のみ）

各resultは次の`SourceEnvelope`へ変換する。

```text
source_type
source_url
external_id
source_account_scope
fetched_at
source_hash
parser_version
permission_scope
payload_schema_version
normalized_record
```

API/feed/export pathはMyFansが提供するdocumented authentication、pagination、rate limitだけを使う。UI pathは書面で指定された画面・操作・頻度に限定し、HTML/DOM/screenshotを保存せず、private endpointへ変換・replayしない。

## 6. Private staging and publication separation

DB flowは三段階に固定する。

```text
immutable freeze
  -> private normalized staging (anon RLS 0)
  -> public projection (seven permission gates + human approval)
```

Private stagingへのupsertはpublicationではない。public projectionは別transaction、別confirmation token、対象ID allowlistでのみ更新する。既存FANZA row、published video、search/ranking/sitemapはMyFans canaryで変更しない。

Publication candidateに最低限必要:

- stable source identity and official URL
- `permission-storage` pass
- `permission-publication` pass for every field
- visibility classが`PUBLIC_GENERAL`または明示許諾済みscope
- current lifecycleが`ACTIVE`
- imageを表示する場合はimage mode gate pass
- affiliate CTAならcurrent permitted link + approved media + `#PR`
- dynamic page review conditionを満たすevidence
- human-approved canonical link or source-native standalone presentation

## 7. Public product design, not implementation

許可後のおかずDB UIはsource-awareとする。

- text badge `MyFans`を表示。公式logoは別許可がない限り使わない。
- creator page、genre/search、FANZAとの統合検索はsource filterを保持する。
- CTA「本編を見る」は`ACTIVE`かつpublication gateを通ったaffiliate URLだけへ向ける。
- affiliate URLが使えない場合に認証内URLやexpired URLへfallbackしない。
- priceはsource timestampとcurrencyを伴い、古い場合は非表示または「確認時点」を表示する。
- reward rate/amountはaffiliate固有・営業情報になり得るため、public valueを生まない。MyFansが明示許可し、UX上の必要性を別審査した場合だけ表示する。
- approved-only creator/productはwritten permissionなしでpublic projectionへ入れない。
- postのrelative published timeは保存せず、exact timestampがあるときだけdate表示する。

## 8. Image strategy

Defaultは `REMOTE_ONLY_DISABLED_UNTIL_PERMISSION`。Creator/MyFansの許可なしにdownload、cache、proxy、rehost、crop、format conversionを行わない。

| Mode | Transport/storage | Required evidence | Revocation behavior |
| --- | --- | --- | --- |
| `REMOTE_ONLY` | approved public pageがofficial URLを直接参照。server/CDNへasset bodyを保存しない | remote display/hotlinkまたはnative OGPを明示許可、host/type allowlist | URL renderを停止しplaceholderへ |
| `AUTHORIZED_CACHE` | permissionで定めたTTLのprivate cache。original bytes/hash/headersを保持し加工しない | cache可、TTL、purge、creator permission responsibility | cache purge + public placeholder |
| `AUTHORIZED_REHOST` | provenance/rights expiry付きでcontrolled object storageへcopy | rehost、asset type、加工可否、retentionを明示許可 | object unpublish/purge + audit tombstone |

Image recordはsource URL、source hash、asset type、mode、permission snapshot、rights effective/expiry、fetched/purged timestampsを持つ。`REMOTE_ONLY`でもbrowser/CDN behaviorが実質cacheにならない構成をreviewする。

## 9. Affiliate URL lifecycle

Eligibilityとgenerated linkを混同しない。Targetはlink未生成でも`ACTIVE`になり得るが、link rowは`permission-link-generation`通過後だけ作成する。

| State | Meaning | Public CTA |
| --- | --- | --- |
| `UNKNOWN` | 未確認、stale、transport/permission不明 | disabled |
| `ACTIVE` | latest permitted observationでeligible。Link rowは別途currentである必要 | all gates pass時のみenabled |
| `INELIGIBLE` | creator/postがaffiliate利用を停止、または対象外 | disabled immediately |
| `REVOKED` | approved-only approvalまたはaffiliate/media authorizationが解除 | disabled immediately |
| `REMOVED` | targetがofficially deleted/removedと確認 | disabled; tombstone retained |

`ACTIVE -> INELIGIBLE/REVOKED/REMOVED`はpublic projectionを同じ処理でfail closedする。Reactivation時はeligibilityを再確認し、旧linkのreuseをMyFansが明示許可した場合だけ再利用する。不明なら新規生成承認待ちとする。Source row/link historyはhard deleteせず、retention instructionに従う。

## 10. Ranking policy

Official UI sortとおかずDB独自rankingを別metadataとして扱う。

| Source sort concept | Allowed internal meaning | Public ranking use |
| --- | --- | --- |
| creator new | source order/filter | freshness input候補。exact timestampがなければrank値を保存しない |
| affiliate post count | source sort | coverage indicator。permission時のみ |
| single/plan reward | affiliate economics | defaultでpublic ranking weight 0 |
| followers | source metric | freshness/scale補助。metric ageを必須化 |
| post new/old | source order | exact published timestampがある場合だけ再現 |
| likes | source metric | engagement候補。source/dateを保持 |
| reward rate/amount | affiliate economics | defaultでpublic ranking weight 0 |

報酬率だけでユーザー向け順位を歪めない。公式順を表示する場合は「MyFans提供順」、独自順は「おかずDB独自」と明記し、sort provenanceを保存する。

## 11. Rollout after permission

許可を得ても直接live ingestionへ進まない。

1. Support回答を [response checklist](./MYFANS_SUPPORT_RESPONSE_CHECKLIST.md) に転記し、七gateを確定。
2. 回答添付specのlocal copy/hashと有効日をevidence化。credentialは保存しない。
3. 正式interfaceのcontract fixtureを手作業でredactし、offline parser/testを先に作る。
4. Proposed migrationをreviewし、全tableをprivate/RLSで追加。rows 0を確認。
5. `apply=false`でrequest planとtarget scopeをfreeze。
6. 許可された最小canary（creator 1、post最大5）をfetchし、DB write 0でnormalize/freeze/dry-run。
7. Private stagingを一batch transactionで実施し、exact target rowsだけ再読取。
8. eligibility/link revocation simulation、idempotent replay、checkpoint resumeを検証。
9. Public projectionは別phase・別承認。dynamic creative review完了前は0。

## 12. Scenario matrix

| Scenario | Conditions | Exact next phase/action | Excluded action |
| --- | --- | --- | --- |
| A. official API/feed | documented interface + acquisition allowed | `Phase6J-A Official Interface Contract`: spec freeze、auth/rate/pagination fixture、offline adapter tests | undocumented endpoint fallback |
| B. catalog CSV | catalog coverageとstorage termsが明示 | `Phase6J-B Catalog Export Contract`: headers/coverage/delta/delete semanticsをoffline検証 | sales CSVをcatalog化 |
| C. auth UI automation | API/feedなし、UI automationを明示許可 | `Phase6J-C Authorized UI Adapter`: permitted routes/actions/navigation budgetをfixture化 | cookie export、private API replay |
| D. DB可・画像不可 | acquisition/storage allowed、images denied | text-only private stagingを実装しimage modeをdisabledに固定 | download/cache/rehost/hotlink |
| E. public掲載不可 | storage allowed、publication denied | private audit/analytics stagingだけを実装、public projectionを作らない | search/SEO/sitemap/card exposure |
| F. 全部不可 | acquisition/storage等denied | 回答をevidence化しconnectorをdisabledで終了 | migration、fetch、DB、UI |

BのCSVがsales-onlyの場合はcatalog discovery interfaceとして不適格なので、EまたはF相当の限定運用に落とす。

## 13. Stop conditions

実装phaseは次のいずれかでfail closedする。

- permission evidence欠落・期限切れ・scope mismatch
- 401/403/429またはMyFansの停止要請
- documented schema/auth/paginationとの差異
- source account scope不一致
- duplicate requestまたはcheckpoint regression
- stable external ID欠落/衝突
- approved-only classification不明
- raw responseにallowlist外private field
- image/link/publication gate不通過
- target-scoped dry-runとwrite対象の不一致
- existing FANZA/public recordsに差分

## 14. Current phase result

Phase6Iで行うのはdocs/designとmachine-readable evidenceだけである。

- MyFans external request: 0
- authenticated API request: 0
- live ingestion: 0
- migration: 0
- DB mutation: 0
- public UI implementation: 0

`MYFANS_PERMISSION_REQUIRED`
