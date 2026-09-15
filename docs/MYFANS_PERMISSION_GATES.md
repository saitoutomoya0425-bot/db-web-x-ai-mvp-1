# MyFans Permission Gates

基準日: 2026-09-15 (JST)

全gate初期値: `UNKNOWN`

回答受領時は [support response checklist](./MYFANS_SUPPORT_RESPONSE_CHECKLIST.md) を埋め、その結果だけをimmutable permission snapshotへ変換する。

## 1. Status vocabulary

| Status | Runtime meaning |
| --- | --- |
| `UNKNOWN` | fail closed。取得、保存、公開、生成を開始しない |
| `ALLOWED` | written evidenceが対象account/media/operation/fieldを無条件に許可 |
| `ALLOWED_WITH_CONDITIONS` | 条件がmachine-readableで、全条件をruntime検証できる場合だけpass |
| `DENIED` | 対象operationを実装・実行しない |

口頭説明、技術的可否、UIに表示された事実はpermission evidenceにしない。MyFansのticket/email/document等の書面回答をredactしてhash参照し、effective date、scope、review dateを保存する。

## 2. Seven gates

### `permission-api`

対象: programmatic acquisition interface。

Evidenceに必要:

- authorized mode: `OFFICIAL_API / OFFICIAL_FEED / OFFICIAL_EXPORT / OFFICIAL_AUTH_UI`
- interface name/version and allowed base URL/routes
- authentication方式とcredential custody
- pagination、rate limit、update/delete semantics
- account/media scope、frequency、retention

APIがなくUI automationだけ許可された場合も、このgateを`ALLOWED_WITH_CONDITIONS`とし、`authorized_mode=OFFICIAL_AUTH_UI`を必須にする。単なる「画面を閲覧可能」はpassではない。

### `permission-storage`

対象: creator/post/plan/metrics/rate/eligibility/link/provenanceのDB・freeze保存。

Evidenceに必要:

- allowed fields
- raw vs normalized payload
- private staging/accounting/publication別のpurpose
- retention、deletion、revocation SLA
- account-specific/confidential data restrictions

このgateが通らなければfreezeはnon-sensitive contract metadataだけに限定し、catalog rowを保存しない。

### `permission-publication`

対象: approved affiliate media上のDB-derived page、search、creator/post card、price、genre、rate等。

Evidenceに必要:

- publicに表示可能なfield allowlist
- approved media URL/domain
- required attribution/`#PR`/disclaimer
- refresh/staleness requirements
- deletion/correction process

Storage permissionはpublication permissionを含まない。

### `permission-images`

対象: avatar、thumbnail、OGP、sample画像のURL保存、hotlink、cache、rehost、加工。

Evidenceに必要:

- allowed mode: `REMOTE_ONLY / AUTHORIZED_CACHE / AUTHORIZED_REHOST`
- permitted asset types/hosts
- creator/MyFans permission responsibility
- modification/crop/resize/watermark rules
- TTL、purge、rights expiry

初期modeは`REMOTE_ONLY_DISABLED_UNTIL_PERMISSION`。Remote URL表示も許可確認前は行わない。

### `permission-approved-only`

対象: `APPROVED_AFFILIATE_ONLY` creator/product/rate/link。

Evidenceに必要:

- public mediaへの掲載可否
- affiliate固有rateの表示/保存可否
- approval revoked時のdisable SLA
- authorized account/media scope

明示許可がなければstatusが他gateで`ALLOWED`でもpublic projectionはdenyする。

### `permission-link-generation`

対象: creator/post/TOP/gacha affiliate URLのprogrammatic generation、保存、再利用。

Evidenceに必要:

- allowed target types and generation interface
- batch/frequency/rate restrictions
- generated link retention and reuse
- eligibility recheck rule
- creator disables、approval revoked、post removed時のlink validity
- coupon/description等の付随field利用条件

既存URLの表示許可と、新規URLの自動生成許可を分けて記録する。

### `permission-dynamic-ad-review`

対象: database-driven creator/post/search/ranking pageの規約第6条相当のcreative review。

Evidenceに必要:

- review単位: template/domain/page/record/campaign
- 初回/更新時の提出方法
- data更新・sort変更・CTA変更時の再review要否
- approval evidence、有効期間、withdrawal process

Template単位の承認がない場合、recordが増えるたびに自動publishしない。

## 3. Derived execution gates

`ALLOWED_WITH_CONDITIONS`は全conditionsがruntimeでtrueのときだけ`PASS`として扱う。

```text
acquisition_ready = permission-api PASS

private_staging_ready =
  acquisition_ready
  AND permission-storage PASS

public_text_ready =
  private_staging_ready
  AND permission-publication PASS(field)
  AND permission-dynamic-ad-review PASS(page/template)
  AND visibility_scope allowed

public_approved_only_ready =
  public_text_ready
  AND permission-approved-only PASS(record/account/media)

affiliate_link_ready =
  private_staging_ready
  AND permission-link-generation PASS(target/action)
  AND current eligibility ACTIVE

public_affiliate_cta_ready =
  affiliate_link_ready
  AND public_text_ready
  AND media registration current
  AND #PR render contract active

public_image_ready =
  public_text_ready
  AND permission-images PASS(asset/mode)
```

## 4. Permission snapshot

Every job binds to an immutable permission snapshot:

```text
snapshot_id
gate statuses
condition objects
field allowlists
authorized source modes
account scope
media scope
effective_at / expires_at
evidence_hashes
reviewed_at / reviewed_by
snapshot_hash
```

Support responseにpersonal name/email/account IDが含まれる場合、repo/evidenceにはredacted summaryとhashだけを保存する。Credential、cookie、token、session valueは保存しない。

Job startとwrite transaction内でsnapshotの有効性を再確認する。Expired/revoked/changed snapshotではcheckpoint resumeを禁止する。

## 5. Field-level enforcement

Gate statusだけでなく、operation-specific allowlistを必須化する。

| Operation | Required field policy |
| --- | --- |
| acquire | requested source fieldがacquisition allowlist内 |
| freeze | raw/normalized retention ruleに適合 |
| stage | private storage allowlist + retention TTL |
| publish | public field allowlist + visibility + review evidence |
| image | asset type + mode + host + expiry |
| link | target type + account + media + reuse policy |

Unknown fieldはdropしてcount/reasonを記録する。Schemaへ自動追加しない。

## 6. Immediate revocation behavior

| Event | Required action |
| --- | --- |
| permission withdrawn | connector pause、public projection disable、new fetch/write 0 |
| media approval lost | affiliate CTA/public creative disable |
| creator approval revoked | approved-only record/linkを`REVOKED`、public disable |
| creator/post affiliate disabled | linkを`INELIGIBLE`、outbound serve停止 |
| target removed | `REMOVED` tombstone、public disable |
| image rights expired | image render/cache/rehost purge according to evidence |

Private source recordを即hard deleteするかはretention/deletion instructionに従う。Permission answerがない場合はnew useを停止し、法的/contractual deletion decisionへrouteする。

## 7. Current decision

| Gate | Status |
| --- | --- |
| `permission-api` | `UNKNOWN` |
| `permission-storage` | `UNKNOWN` |
| `permission-publication` | `UNKNOWN` |
| `permission-images` | `UNKNOWN` |
| `permission-approved-only` | `UNKNOWN` |
| `permission-link-generation` | `UNKNOWN` |
| `permission-dynamic-ad-review` | `UNKNOWN` |

Consequently:

- acquisition: disabled
- private staging: disabled
- public projection: disabled
- image mode: `REMOTE_ONLY_DISABLED_UNTIL_PERMISSION`
- link generation: disabled

`MYFANS_PERMISSION_REQUIRED`
