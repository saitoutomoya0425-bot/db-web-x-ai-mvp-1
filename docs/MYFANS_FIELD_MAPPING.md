# MyFans Canonical Field Mapping

基準日: 2026-09-15 (JST)

状態: `PROPOSAL_ONLY / NO MIGRATION / MYFANS_PERMISSION_REQUIRED`

関連設計: [implementation plan](./MYFANS_INTEGRATION_IMPLEMENTATION_PLAN.md)、[sync design](./MYFANS_SYNC_DESIGN.md)、[permission gates](./MYFANS_PERMISSION_GATES.md)。

## 1. Classification

| Class | Meaning |
| --- | --- |
| `REQUIRED` | identity、relationship、lifecycle、permission判定に必須。欠落時はrecordをpersistしない、または`UNKNOWN`を明示的に保持する |
| `OPTIONAL` | interfaceとpermissionが値を提供・保存可能なときだけ保持。欠落を推測しない |
| `DERIVED` | required/optional source fieldから決定的に計算。導出versionを保持する |
| `NOT_STORED` | 曖昧、相対表示、credential/account identity、または権利上保存しない |

`REQUIRED`はpublic表示必須を意味しない。全recordは最初にprivate stagingへ入り、publication field allowlistは別gateで決める。

## 2. Shared provenance envelope

| Canonical field | Class | Existing/proposed storage | Rule |
| --- | --- | --- | --- |
| `source_type` | `REQUIRED` | proposed observation | `OFFICIAL_API / OFFICIAL_FEED / OFFICIAL_EXPORT / OFFICIAL_AUTH_UI / PUBLIC_MYFANS_PAGE` |
| `source_url` | `REQUIRED` | proposed observation | documented endpoint/feed/export/pageのcanonical URL。credential/query secretなし |
| `external_id` | `REQUIRED` | existing entity external ID + observation | source-native stable IDを優先。identity kindを同時記録 |
| `fetched_at` | `REQUIRED` | existing + observation | actual UTC timestamp。相対表示から生成しない |
| `source_hash` | `REQUIRED` | proposed observation | canonical allowed-field source payloadのlowercase SHA-256。既存`metadata_hash`と同一視しない |
| `parser_version` | `REQUIRED` | proposed observation | connector + normalization schema version |
| `permission_scope` | `REQUIRED` | proposed observation | gate decision setのimmutable version/hash |
| `source_account_scope` | `REQUIRED` | proposed affiliate state | auth sourceで必須。operator-issued opaque UUID。affiliate ID/email/nameは保存しない |
| request/session/cookie/token | `NOT_STORED` | none | authentication material、header、browser storageをevidenceへ入れない |

## 3. Creator model

| Observed concept | Class | Existing field / proposed destination | Normalization and gate |
| --- | --- | --- | --- |
| source-local creator identity | `REQUIRED` | `myfans_creators.external_creator_id` | documented stable IDがあれば使用。なければ`profile_slug:<normalized-slug>`。identity kindをprovenanceへ保持 |
| username/slug | `REQUIRED` | `profile_slug` | exact observed valueを保持し、comparison keyだけUnicode/case normalization。表示値を上書きしない |
| name | `REQUIRED` | `display_name` | trimのみ。空ならstageを停止 |
| official profile URL | `DERIVED` | `official_url` | source-provided URLとslugを相互検証し、`https://myfans.jp/...`だけ許可 |
| avatar URL | `OPTIONAL` | `profile_image_url` | `permission-images`がURL保存を許可した場合のみ。download/cache/rehostは別mode |
| biography | `OPTIONAL` | `bio` | official interfaceで提供され、text storage/publication scopeに含まれる場合のみ |
| likes | `OPTIONAL` | proposed `myfans_metric_snapshots` | exact integer + observed timestamp。UI formatted valueを推測変換しない |
| followers | `OPTIONAL` | proposed metric snapshot | same |
| following | `OPTIONAL` | proposed metric snapshot | same |
| post count | `OPTIONAL` | proposed metric snapshot | total semanticsがdocumentedな場合のみ |
| affiliate-enabled post count | `OPTIONAL` | creator affiliate state | account/time-relative。general post countと分離 |
| SNS links | `OPTIONAL` | proposed normalized social-links payload/table | official displayed URLだけ。icon自体は`DERIVED` |
| SNS icon | `DERIVED` | not persisted | validated host/typeからrender |
| single reward rate | `OPTIONAL` | creator affiliate state | numeric decimal ratio、account scope必須。public defaultは非表示 |
| plan initial reward rate | `OPTIONAL` | creator affiliate state | same |
| plan continuation reward rate | `OPTIONAL` | creator affiliate state | same |
| approval state | `REQUIRED` | creator affiliate state | `PUBLIC_GENERAL / AFFILIATE_VISIBLE / APPROVED_AFFILIATE_ONLY / UNKNOWN`のscopeと別にapproval relationを保存 |
| plans | `OPTIONAL` | `myfans_plans` relation | stable identityを取得できるplanだけupsert。display textからIDを作らない |
| raw affiliate ID/account ID | `NOT_STORED` | none | opaque `source_account_scope`へ置換 |

Creator publication minimumはname、official URL、permitted visibility、current lifecycle、permission evidenceである。Metrics、rate、imageはpublic minimumではない。

Auth-derived dataをmigration 029の`raw_public_metadata`へ入れない。Core tableの`metadata_hash`はpublic-safe canonical metadata、future observationの`source_hash`はauthorized source envelopeを表す。

## 4. Post model

| Observed concept | Class | Existing field / proposed destination | Normalization and gate |
| --- | --- | --- | --- |
| public UUID-like route ID | `REQUIRED` | `myfans_posts.external_post_id` | `/posts/<UUID>`からexact parseしcanonical UUID表現を検証。backend property名に依存しない |
| creator relation | `REQUIRED` | `creator_id` FK | source accountを跨いでname matchingしない。source-local creator identityでresolve |
| official post URL | `DERIVED` | `official_url` | source URLとUUIDを相互検証 |
| title | `OPTIONAL` | `title` | private stageはnullable。public projectionにはpermitted non-empty titleが必要 |
| teaser/description | `OPTIONAL` | `teaser` | official allowed textのみ。paid/protected bodyを保存しない |
| thumbnail URL | `OPTIONAL` | `thumbnail_url` | image gate pass時だけURL保存。asset bodyはimage modeに従う |
| media type | `OPTIONAL` | `content_type` | `text/image/video/mixed/unknown`へallowlist mapping |
| UI media indicator | `DERIVED` | `media_indicator` | exact source typeからrender用enumへ変換 |
| video duration | `OPTIONAL` | proposed allowed metadata | exact secondsが提供された場合のみ。display textを曖昧parseしない |
| access/lock icon | `DERIVED` | not persisted | visibility/access flagからrender。icon visualを保存しない |
| likes | `OPTIONAL` | proposed metric snapshot | exact integer + timestamp |
| relative published time | `NOT_STORED` | none | `n日前`等をtimestampへ変換しない |
| exact published timestamp | `OPTIONAL` | `published_at` | official exact timestampがある場合のみ |
| single-sale price | `OPTIONAL` | `price` | decimal + `currency=JPY`。formatted stringとtax/discount semanticsをraw provenanceへ |
| sale/list price distinction | `OPTIONAL` | proposed offer metadata | official schemaが両者を区別するときだけ保持 |
| affiliate reward rate | `OPTIONAL` | post affiliate state | source account scope必須。0とmissingを区別 |
| estimated reward | `OPTIONAL` | post affiliate state | official supplied valueを優先。formula不明の独自再計算をしない |
| creator relation display name | `DERIVED` | creator join | post rowへduplicateしない |
| affiliate eligibility | `REQUIRED` | post affiliate state | `ACTIVE / INELIGIBLE / REVOKED / REMOVED / UNKNOWN`。確認時刻必須 |
| genre ID/name | `OPTIONAL` | proposed source taxonomy relation | source-native termを保持。existing canonical `genres`へ自動mergeしない |
| tag ID/name | `OPTIONAL` | proposed source taxonomy relation | same |
| affiliate URL action/button | `NOT_STORED` | none | UI controlはdataではない |
| generated affiliate URL | `OPTIONAL` | proposed `myfans_affiliate_links` | link-generation/storage/publication gatesとaccount scope必須 |
| paid/protected post body | `NOT_STORED` | none | acquisition対象外 |

`estimated_reward`は画面表示値であり、販売価格とrateだけから再現できるとは限らない。公式式、creator fee、rounding inputsが全てdocumentedな場合だけ別の`DERIVED` valueを作り、source supplied valueと上書きしない。

## 5. Plan model

| Concept | Class | Existing/proposed destination | Rule |
| --- | --- | --- | --- |
| stable plan ID | `REQUIRED` | `myfans_plans.external_plan_id` | plan persistence時に必須。official IDがないplanはunresolved observationとしてfreezeし、plan tableへinsertしない |
| creator relation | `REQUIRED` | `creator_id` | exact source identity |
| name | `OPTIONAL` | `name` | emptyを推測補完しない |
| description | `OPTIONAL` | `description` | allowed public text only |
| official URL | `OPTIONAL` | `official_url` | exact official URLだけ |
| monthly price | `OPTIONAL` | `price` | recurring intervalをprovenanceへ |
| currency | `DERIVED` | `currency` | interfaceがJPYを明示/contract保証するときだけdefault |
| plan post count | `OPTIONAL` | metric snapshot | count semanticsとobserved time必須 |
| initial/continuation reward rates | `OPTIONAL` | creator/plan affiliate state proposal | account-scoped。core plan rowへ入れない |
| post-plan membership | `OPTIONAL` | `myfans_post_plans` | sourceが明示したrelationだけ。price/titleから推測しない |

Migration 029では`external_plan_id`がnullableだが、production adapterはstable IDなしのplan upsertを禁止する。これはschema変更前にapplication gateで実現可能である。

## 6. Affiliate metadata proposal

| Field | Class | Scope | Important constraint |
| --- | --- | --- | --- |
| `affiliate_enabled` | `REQUIRED` | creator/post + account | booleanだけでなくunknownを扱うためlifecycle enumと併用 |
| `single_reward_rate` | `OPTIONAL` | creator/post + account | decimal ratio; `0`, null, missingを区別 |
| `estimated_reward` | `OPTIONAL` | post + account + price observation | currency and source timestamp required |
| `plan_initial_reward_rate` | `OPTIONAL` | creator/plan + account | account-relative |
| `plan_continuation_reward_rate` | `OPTIONAL` | creator/plan + account | account-relative |
| `approval_scope` | `REQUIRED` | creator/product + account | visibility classとapproval relationを分離 |
| `affiliate_url` | `OPTIONAL` | target + account | private by default; active public projectionのみserve |
| `affiliate_url_generated_at` | `REQUIRED` when URL exists | link | exact source timestamp or local confirmed generation timestamp |
| `eligibility_checked_at` | `REQUIRED` | affiliate state | stale gateに使用 |
| `source_account_scope` | `REQUIRED` | all auth-derived records | opaque internal UUID; raw account IDは`NOT_STORED` |

## 7. Visibility model

Affiliate visibilityはexisting content visibility列へ混在させず、別field `affiliate_visibility_scope`として提案する。

| Value | Meaning | Default public action |
| --- | --- | --- |
| `PUBLIC_GENERAL` | 一般public sourceから同じ内容を確認できる | publication gate次第 |
| `AFFILIATE_VISIBLE` | approved affiliate account内で一般に見える | private。written publication permissionが必要 |
| `APPROVED_AFFILIATE_ONLY` | creatorが承認したaffiliateだけに見える | public deny by default |
| `UNKNOWN` | scopeを確定できない | ingest/publication stop |

Approved-only情報は`permission-approved-only=ALLOWED`に加え、対象mediaへの掲載範囲、rateを含めてよいか、approval解除時SLAが書面化された場合だけpublic候補にできる。

## 8. Current gaps

Existing schemaに不足するもの:

- affiliate visibilityとapproval relation
- account-scoped creator/post/plan rate
- affiliate URL lifecycle
- immutable observation historyとpermission-scope hash
- connector job/checkpoint/request/error accounting
- metrics snapshotとretention
- source taxonomy identity/mapping
- coarse `data_sources.source_type`とseparateなexact connector mode
- image use mode/rights expiry/purge evidence
- public projection allowlist
- official IDとslug fallbackのalias/history

これらはsupport回答後に必要最小限へ縮約してadditive migrationを設計する。回答前migrationは0。
