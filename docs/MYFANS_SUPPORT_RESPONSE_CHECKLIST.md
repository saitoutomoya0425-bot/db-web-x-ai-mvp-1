# MyFans Support Response Checklist

このchecklistはMyFansの書面回答を受領した後に一度だけ複製し、回答を転記する。回答前は全項目 `UNKNOWN`。個人名、email、affiliate/account ID、credential、cookie、token、session値は記録しない。

Gateの意味とpass条件は [MyFans permission gates](./MYFANS_PERMISSION_GATES.md)、回答別の実装順は [implementation plan](./MYFANS_INTEGRATION_IMPLEMENTATION_PLAN.md) を正とする。

Status choices:

- `UNKNOWN`
- `ALLOWED`
- `ALLOWED_WITH_CONDITIONS`
- `DENIED`

## 1. Response evidence

| Item | Fill after response |
| --- | --- |
| response received date | `UNKNOWN` |
| official ticket/reference, redacted | `UNKNOWN` |
| applicable Affiliate Center account/media | `UNKNOWN` |
| effective date | `UNKNOWN` |
| expiry/review date | `UNKNOWN` |
| redacted response evidence SHA-256 | `UNKNOWN` |
| reviewer | `UNKNOWN` |

Do not paste the full response into a public repository. Store only a redacted operational summary and hash; keep the source response in the approved private record system.

## 2. Acquisition interface

### Official API/feed

| Question | Answer |
| --- | --- |
| official creator/post API exists | `UNKNOWN` |
| official feed exists | `UNKNOWN` |
| full catalog CSV exists | `UNKNOWN` |
| catalog export is distinct from sales/report CSV | `UNKNOWN` |
| permitted programmatic use | `UNKNOWN` |
| interface name/version | `UNKNOWN` |
| documented base URL | `UNKNOWN` |
| authentication method | `UNKNOWN` |
| credential custody conditions | `UNKNOWN` |
| scopes/account/media binding | `UNKNOWN` |
| pagination kind/keys | `UNKNOWN` |
| page-size default/max | `UNKNOWN` |
| rate limit/retry rule | `UNKNOWN` |
| update cursor/timestamp | `UNKNOWN` |
| delete/disable/tombstone semantics | `UNKNOWN` |
| recommended sync frequency | `UNKNOWN` |

### UI automation fallback

Complete only if no suitable API/feed/export exists.

| Question | Answer |
| --- | --- |
| authenticated Affiliate Center UI automation allowed | `UNKNOWN` |
| allowed screens/routes | `UNKNOWN` |
| allowed search/filter/pagination actions | `UNKNOWN` |
| maximum frequency/navigation/concurrency | `UNKNOWN` |
| session renewal/MFA handling | `UNKNOWN` |
| raw HTML/DOM/screenshot storage allowed | `UNKNOWN` |
| direct private API replay allowed | expected `DENIED`; record official answer |
| link generation button automation allowed | `UNKNOWN` |

Operational rule: even if UI automation is allowed, cookie/token export、profile copy、private endpoint replayは実装しない。

## 3. Field storage and publication

Fill each cell with `ALLOWED`, `ALLOWED_WITH_CONDITIONS`, or `DENIED`.

| Field | Private DB storage | Approved public media | Conditions/retention |
| --- | --- | --- | --- |
| creator external ID/username | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| creator name/profile URL | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| post UUID/title/URL | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| price/sale price | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| plan/name/price | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| genre/tag | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| followers/likes/counts | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| exact published timestamp | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| reward rate/estimated reward | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| affiliate eligibility | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| approval state | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| generated affiliate URL | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` |
| source response/raw payload | `UNKNOWN` | `DENIED` | `UNKNOWN` |

Also record:

- deletion/creator opt-out SLA: `UNKNOWN`
- eligibility/reward rate refresh SLA: `UNKNOWN`
- maximum retention for historical snapshots: `UNKNOWN`
- whether rates are confidential/account-specific: `UNKNOWN`

## 4. Approved-only data

| Question | Answer |
| --- | --- |
| may store `APPROVED_AFFILIATE_ONLY` creator/product privately | `UNKNOWN` |
| may show it on the specifically approved public media | `UNKNOWN` |
| may show affiliate-specific reward rate | `UNKNOWN` |
| may include it in search/genre/ranking | `UNKNOWN` |
| required action when approval is revoked | `UNKNOWN` |
| maximum disable/delete SLA | `UNKNOWN` |

If any answer is not explicit, `permission-approved-only=DENIED` for public projection.

## 5. Images and OGP

| Mode/question | Answer |
| --- | --- |
| store remote avatar/thumbnail URL | `UNKNOWN` |
| `REMOTE_ONLY`: browser loads official URL directly | `UNKNOWN` |
| native affiliate link OGP preview | `UNKNOWN` |
| `AUTHORIZED_CACHE`: temporary proxy/cache | `UNKNOWN` |
| cache TTL/purge headers | `UNKNOWN` |
| `AUTHORIZED_REHOST`: copy to own storage | `UNKNOWN` |
| resize/crop/format conversion | `UNKNOWN` |
| creator permission required per asset | `UNKNOWN` |
| rights expiry/revocation process | `UNKNOWN` |

Until a mode is explicit: `REMOTE_ONLY_DISABLED_UNTIL_PERMISSION`。

## 6. Affiliate URL lifecycle

| Question | Answer |
| --- | --- |
| programmatic link generation allowed | `UNKNOWN` |
| allowed target types: TOP/creator/post/gacha | `UNKNOWN` |
| batch/frequency limit | `UNKNOWN` |
| generated link may be stored | `UNKNOWN` |
| existing link may be reused indefinitely | `UNKNOWN` |
| link must be regenerated after metadata change | `UNKNOWN` |
| link validity after creator disables affiliate | `UNKNOWN` |
| link validity after approval revoked | `UNKNOWN` |
| link validity after post removal | `UNKNOWN` |
| eligibility recheck frequency | `UNKNOWN` |
| coupon/link-description storage/publication | `UNKNOWN` |

Unknown reuse policy means old URL is not automatically reactivated.

## 7. Dynamic advertising review

| Question | Answer |
| --- | --- |
| approved media/domain | `UNKNOWN` |
| template-level review accepted | `UNKNOWN` |
| page/record-level review required | `UNKNOWN` |
| data refresh requires re-review | `UNKNOWN` |
| sort/ranking change requires re-review | `UNKNOWN` |
| CTA/text/image change requires re-review | `UNKNOWN` |
| submission channel and required materials | `UNKNOWN` |
| approval evidence validity/withdrawal | `UNKNOWN` |
| required `#PR` placement/copy | `UNKNOWN` |

If review granularity is unclear, dynamic auto-publication remains disabled.

## 8. Existing documentation conflicts

| Topic | Official current answer |
| --- | --- |
| attribution: 24h vs 7 days/168h | `UNKNOWN` |
| transfer fee: 220 yen deduction vs MyFans-paid | `UNKNOWN` |
| sales report: item detail vs aggregate only | `UNKNOWN` |

Do not hard-code an economics/accounting rule until resolved.

## 9. Gate transcription

After answering Sections 1–8, fill exactly one status and a condition object for each gate.

| Gate | Status | Machine-checkable conditions | Evidence reference |
| --- | --- | --- | --- |
| `permission-api` | `UNKNOWN` | `{}` | `UNKNOWN` |
| `permission-storage` | `UNKNOWN` | `{}` | `UNKNOWN` |
| `permission-publication` | `UNKNOWN` | `{}` | `UNKNOWN` |
| `permission-images` | `UNKNOWN` | `{}` | `UNKNOWN` |
| `permission-approved-only` | `UNKNOWN` | `{}` | `UNKNOWN` |
| `permission-link-generation` | `UNKNOWN` | `{}` | `UNKNOWN` |
| `permission-dynamic-ad-review` | `UNKNOWN` | `{}` | `UNKNOWN` |

`ALLOWED_WITH_CONDITIONS` with an empty condition object is invalid and behaves as `UNKNOWN`.

## 10. Deterministic scenario selection

Evaluate in this order:

1. All acquisition modes denied -> Scenario F; archive response and stop.
2. Official API/feed allowed -> Scenario A.
3. Catalog CSV allowed and complete enough -> Scenario B.
4. Auth UI automation explicitly allowed -> Scenario C.
5. Storage denied -> no ingestion, regardless of interface.
6. Images denied while text storage/publication allowed -> additionally Scenario D constraints.
7. Publication denied while storage allowed -> additionally Scenario E constraints.
8. Approved-only unknown/denied -> always exclude that visibility class.

## 11. Exact handoff action

Once the response is received:

1. Redact personal/account/credential information.
2. Complete this checklist without interpreting silence as permission.
3. Generate the seven-gate JSON snapshot and SHA-256.
4. Select Scenario A/B/C/F plus D/E constraints deterministically.
5. Open only the matching Phase6J contract/fixture task.

No network connector, migration, DB write, link generation, image handling, or public UI work starts from the email alone; it starts only after the completed gate snapshot is reviewed.
