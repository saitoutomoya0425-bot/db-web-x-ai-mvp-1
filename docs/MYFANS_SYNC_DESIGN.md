# MyFans Sync Architecture Design

基準日: 2026-09-15 (JST)

状態: `IMPLEMENTATION-READY DESIGN / CONNECTORS DISABLED`

Field contractは [canonical field mapping](./MYFANS_FIELD_MAPPING.md)、execution authorityは [permission gates](./MYFANS_PERMISSION_GATES.md) を正とする。

## 1. Design goals

- official API/feed/exportが提供された場合と、authenticated UI automationが書面許可された場合を同じdownstream pipelineへ接続する。
- connector固有のquery、pagination、rate limit、authをnormalizer以降へ漏らさない。
- acquisition、freeze、private staging、publicationを別job/confirmationに分離する。
- defaultは`apply=false`、permission不明はfail closed、同一record/URLのduplicate fetchを防止する。
- full recrawlを通常運用にせず、official cursorまたはhash差分でincremental syncする。

## 2. Architecture

```text
Permission snapshot
        |
        v
Connector A: official API/feed/export -----+
                                            +-> SourceEnvelope allowlist
Connector B: permitted authenticated UI ---+        |
                                                     v
                                            identity validation
                                                     |
                                                     v
                                      normalize + visibility classify
                                                     |
                                                     v
                                      immutable allowed-field freeze
                                                     |
                                                     v
                                         target-scoped dry-run plan
                                                     |
                                                     v
                                      private staging transaction
                                                     |
                                                     v
                                     post-write exact-scope validation
                                                     |
                                                     v
                                  separate human-controlled publish gate
```

## 3. Connector boundary

### Path A: official API/feed/export

実装条件:

- written interface name/version/base URL
- permitted authentication method
- scopes and account/media binding
- rate limit、retry rule、pagination、update/delete semantics
- permitted fields、raw response retention、storage/publication scope

Connectorはdocumented host/pathだけをallowlistし、redirect先hostが変われば停止する。`Retry-After`等のofficial signalを優先し、specにないendpointへfallbackしない。

Export/CSVは`catalog`、`sales`、`summary`を明確に区別する。Sales CSVはcatalog discoveryへ使用しない。Catalog exportにcreator/post全体、eligibility、削除/無効化が含まれない場合はpartial connectorとして扱う。

### Path B: permitted authenticated UI automation

実装条件:

- MyFansが対象media/accountに対し、画面自動操作・定期取得・保存を明示許可
- allowed routes/actions、maximum frequency/navigation、session renewal方法
- link generation/copyの可否
- generated list/reportの利用範囲

禁止を設計に固定:

- cookie/token/session/localStorage export
- browser profile copy、remote-debug強制、credential共有
- UI trafficからprivate endpointを抽出・replay
- raw HTML/DOM/HAR/screenshotのpersistent保存
- anti-bot/MFA/TCC bypass

UI adapterはuser/operator管理のapproved account contextで、visible labelとnormal routeだけを操作する。session失効/MFAはautomation stopとし、credentialをjobへ渡さない。

## 4. SourceEnvelope and canonicalization

全connector outputは次を必須とする。

```json
{
  "source_type": "OFFICIAL_API|OFFICIAL_FEED|OFFICIAL_EXPORT|OFFICIAL_AUTH_UI",
  "source_url": "canonical non-secret URL",
  "external_id": "source-local stable key",
  "entity_type": "creator|post|plan|affiliate_state|affiliate_link",
  "source_account_scope": "opaque UUID or null for public feed",
  "fetched_at": "exact timestamp",
  "source_hash": "lowercase sha256",
  "parser_version": "connector/schema version",
  "permission_scope": "permission snapshot hash",
  "normalized_record": {}
}
```

Normalization requirements:

- field allowlistはpermission snapshotから生成し、unknown fieldをDBへ自動追加しない。
- source-supplied raw value、normalized value、normalization warningを分離する。
- URL identityはscheme/host/pathをvalidateし、tracking queryをcanonical identityから除外する。
- external IDが欠落/変化した場合、slug/name/priceでauto mergeしない。
- relative timeはdropし、exact source timestampだけを`published_at`へ入れる。
- rateはdecimal ratio、moneyはdecimal + ISO currency。formatted textをそのままnumericにしない。

## 5. Lossless freeze

Freezeはnetwork acquisitionとDB writeの間のimmutable boundaryである。既存 [MyFans public pilot](../scripts/myfans-public-pilot.mjs) のmanifest/membership hashと、FANZAのlossless freeze patternを再利用する。

成果物:

- compressed JSONL of allowlisted `SourceEnvelope`
- record count、entity counts
- ordered membership SHA-256
- per-record source hash
- manifest SHA-256
- connector/parser/permission versions
- checkpoint input/output
- planned/actual/duplicate/retry request counts
- excluded-field counts and reason codes

「lossless」は許可されたfield集合内でのlosslessを意味する。Permissionがraw response保存を認めない場合は、responseをmemory上でallowlist normalize/hashした後に破棄し、raw body、HTML、DOM、header、cookie/tokenをfreezeしない。

Freeze validation failure時はDBへ接続しない。同一manifestは同一job scopeで再fetchせずresume可能にする。

## 6. Request accounting

[Production access guard](../scripts/lib/production-access-guard.mjs) のconceptをsource connectorへ一般化する。

| Counter | Required behavior |
| --- | --- |
| `planned_request_count` | network前にexact target/pageをmanifest化 |
| `actual_request_count` | redirect/retryを含む実requestを記録 |
| `duplicate_request_count` | method + normalized URL + body hashで判定。1以上はpreflight stop |
| `retry_count` | endpoint/page単位。official upper boundを超えない |
| `rate_limit_wait_ms` | official header/ruleによる待機だけを集計 |
| `records_seen/staged/unchanged/conflict` | entity typeごとに計数 |

Default concurrency/retry/page sizeはsupport回答やofficial specから決める。回答前に数値を推測しない。Jobはpermission snapshot hashが変わったらresumeせず、新jobとして開始する。

## 7. Incremental checkpoint strategy

Connector capabilityを次の優先順位で選ぶ。

1. official `updated_at` cursor + stable tie-breaker
2. opaque `next_cursor` supplied by interface
3. monotonic stable ID only when official contract guarantees ordering
4. deterministic page cursor + record hash diff
5. complete snapshot reconciliation as infrequent controlled job

Checkpoint record:

```text
connector_version
source_account_scope
entity_scope
cursor_kind
cursor_value
tie_breaker
last_complete_page
snapshot_id
permission_scope_hash
committed_at
```

Checkpointは次の全てが成功した後だけadvanceする。

1. page acquisition complete
2. freeze persisted and hash verified
3. dry-run target scope exact
4. private staging transaction committed
5. targeted post-write readback passed

途中失敗は同じcheckpointからresumeし、既存freezeが一致する場合はnetwork fetchを省略する。

## 8. Duplicate prevention and idempotency

Request key:

`connector + account_scope + method + normalized_url + body_hash`

Record idempotency key:

`data_source + account_scope + entity_type + external_id + source_hash`

Current-state uniqueness:

- creator: `data_source_id + external_creator_id`
- post: `data_source_id + external_post_id`
- plan: `data_source_id + external_plan_id`
- affiliate state: `entity + source_account_scope`
- link: `target + source_account_scope + generated source ID` or documented link ID

同じexternal ID/URLに異なるidentityが現れた場合は`IDENTITY_CONFLICT`。last write winsにしない。Same hashは`UNCHANGED`、allowed field差分は`CHANGED_REVIEW`、permission/visibility低下は即public disable candidateとする。

## 9. Dry-run plan

Dry-runはDB read-only transactionでtarget stateを読み、以下へ分類する。

- `NEW`
- `UNCHANGED`
- `CHANGED_REVIEW`
- `VISIBILITY_RESTRICTED`
- `INELIGIBLE`
- `REMOVED_CANDIDATE`
- `IDENTITY_CONFLICT`
- `PERMISSION_BLOCKED`

Outputは対象external ID、old/new hash、changed field names、planned table/action、reason、apply=falseを含む。Account identity、affiliate URL value、private rate valueはreportへ出さず、redacted/hash representationにする。

Write confirmationはdry-run manifest hash、permission snapshot hash、target count、checkpointをbindする。いずれかが変わればwriteを拒否する。

## 10. Private staging write

一batchをsingle transactionにし、次をenforceする。

- existing hash/visibility/affiliate stateをpreconditionに含める
- permission snapshotがcurrentかtransaction内で再確認
- `NEW`とreview済み`CHANGED_REVIEW`だけをupsert
- `IDENTITY_CONFLICT`を1件でも含めばrollback
- public projection、FANZA rows、canonical video linkは変更しない
- source observationはcurrent rowと同transactionでappend
- checkpoint advanceはcommit後のtargeted readback成功後

Readbackはtarget external IDsだけを取得し、count、hash、FK、RLS/public exposure 0を検証する。

## 11. Removal and eligibility reconciliation

一回のlist不在を削除とみなさない。

- explicit official tombstone/deleted status: `REMOVED`
- completed full snapshotで不在: `REMOVED_CANDIDATE`
- configured consecutive complete snapshotsでも不在、またはdirect detailでconfirmed not-found: `REMOVED`
- partial page、transport error、permission loss: `UNKNOWN`; last-known stateを削除しない
- creator disables affiliate: `INELIGIBLE`
- approved-only approval revoked: `REVOKED`

`absence_confirmation_runs`とverification methodはofficial interface guidanceに従う。値がなければ自動`REMOVED`へ遷移しない。

## 12. Publication gate

Publicationはsync jobに含めない。別jobが次を検証する。

- all required permission gates pass
- permitted field allowlistのみ
- current source observation/check timestampがSLA内
- visibility and approval scope allowed
- affiliate link state active or official URL fallback explicitly allowed
- image mode allowed and rights evidence current
- dynamic media/creative review evidence current
- `#PR`/source disclosure/render contract present
- independent ranking policy

Failureはpublic projectionをdisable/tombstoneにし、private audit recordを保持する。Source row自体をhard deleteしない。

## 13. Monitoring and rollback

Metrics:

- request/error/429/401/403 rate
- schema unknown-field rate
- identity conflict rate
- eligible→ineligible/revoked/removed transitions
- stale eligibility/link/image-rights count
- public projection suppressed count by gate
- checkpoint age and lag

Stop immediately on permission revocation, contract drift, auth boundary change, unexpected PII/private field, or public projection mismatch. Rollback is public projection disable + connector pause; source observations remain for audit subject to retention permission.

## 14. No-live state

Current connector configuration is conceptually:

```text
enabled=false
permission_scope=UNKNOWN
apply=false
publish=false
image_mode=REMOTE_ONLY_DISABLED_UNTIL_PERMISSION
```

No code, migration, schedule, credential, fetch, DB write, or public route is added by this design.
