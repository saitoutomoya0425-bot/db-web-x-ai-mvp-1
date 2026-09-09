# MyFans Affiliate Compliance Matrix

基準日: 2026-09-09 (JST)  
これは調査上のoperational gateであり、法律意見ではない。`DISCOVERABLE`、`INGESTIBLE`、`REPUBLISHABLE` は独立判定する。

## 1. Decision vocabulary

- `YES`: 公式資料が用途を明示的に許す
- `AUTH_ONLY`: 審査済みaffiliateの認証内でのみ確認可能
- `PUBLIC_VIEW_ONLY`: publicに閲覧できるが、保存・再公開許諾は含まない
- `PERMISSION_REQUIRED`: 明示許諾がない、または規約上の事前確認が必要
- `CREATOR_PERMISSION_REQUIRED`: creator本人の事前許可が必要
- `NO`: 公式資料が禁止
- `UNKNOWN`: 公開証拠不足

## 2. Field rights matrix

| Field | DISCOVERABLE | INGESTIBLE | REPUBLISHABLE | Gate / rationale |
| --- | --- | --- | --- | --- |
| creator ID/internal ID | `UNKNOWN` | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | field自体未確認 |
| creator username/slug | `AUTH_ONLY` / exact public URL | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | systematic reuseの許諾なし |
| creator name | `AUTH_ONLY`; public profileでも可 | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | creator紹介文の少量引用可と、bulk catalogは別 |
| profile URL | `AUTH_ONLY`; exact URLはpublic | `PERMISSION_REQUIRED` | `YES` only as approved affiliate creative/link | media登録・creative事前確認が前提 |
| post ID | `UNKNOWN` | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | stable ID/schema未確認 |
| post URL | `AUTH_ONLY`; exact URLはpublic | `PERMISSION_REQUIRED` | `YES` only as approved affiliate creative/link | URL generator経由、media承認前提 |
| title / intro text | `AUTH_ONLY` / public | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED`; small quotation is allowed | FAQは紹介文引用可、bulk複製許諾ではない |
| thumbnail/profile image | `AUTH_ONLY` / `PUBLIC_VIEW_ONLY` | `CREATOR_PERMISSION_REQUIRED` | `CREATOR_PERMISSION_REQUIRED` | 保存・転載・加工をcreator許可なしで行わない |
| affiliate-link OGP | public after URL generation | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | link previewと画像の保存/加工は分ける。公式回答待ち |
| price / sale price | `AUTH_ONLY`; public pageの場合あり | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | factual dataでもcontract/API rightsが未確認 |
| plan / genre / tag | `AUTH_ONLY`; public pageの場合あり | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | systematic syncは未許諾 |
| reward rate/amount | `AUTH_ONLY` | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | affiliate固有率は非公開性・秘密保持リスク |
| affiliate eligibility | `AUTH_ONLY` | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | approved-onlyで閲覧者依存 |
| approval status / approved-only creator | `AUTH_ONLY` | `PERMISSION_REQUIRED` | `NO` until explicit written permission | unauthorized affiliatesに非表示の情報 |
| followers / likes/bookmarks | public sourceが存在する可能性 | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | Center fieldは未確認、third-partyをsourceにしない |
| published date | public sourceが存在する可能性 | `PERMISSION_REQUIRED` | `PERMISSION_REQUIRED` | same |
| own affiliate URL | generated after auth | storage for own operation is functionally expected, but automation `PERMISSION_REQUIRED` | `YES` on approved media after creative review and `#PR` | link useとcatalog copyを混同しない |
| sales report/CSV | `AUTH_ONLY` | `YES` for own accounting use; secondary database use `PERMISSION_REQUIRED` | `NO` absent explicit permission | buyer/nonpublic business dataを公開しない |

## 3. Rule map

| Topic | Current official rule | Operational interpretation |
| --- | --- | --- |
| media registration | mediaごとに申請。Approved/Pending/Rejected | publication先をすべて登録。URL変更は再申請 |
| disclosure | `#PR` 必須 | page/card/post単位で明瞭表示 |
| media/creative review | webpage、SNS、banner等は公開前にMyFans確認 | dynamic catalogの承認単位・更新手順を事前照会 |
| images/video | creator提供・許可済み素材のみ。thumbnail/profile/sampleの保存・転載・加工は原則不可 | image ingestionを開始しない。creatorまたはMyFansの書面許可を得る |
| text | 紹介文の引用は可 | 出典・引用範囲を明示。全量複製はしない |
| logo | 公式素材未提供、使用を控える | MyFans logoを自作・転用しない |
| short URL | 利用可 | redirect先とaffiliate parameterを保持し、誤認させない |
| credentials | ID/passwordを貸与・交換・譲渡・売買・第三者利用させない | password/token/cookieをautomation、外注、AIへ渡さない |
| subcontracting | 再委託可能、affiliateが責任を負い同等義務を課す | credential共有なし、範囲と監督を契約化 |
| bot/tool prohibition | 購入等の指定行為をbot/toolで発生させる行為等を禁止 | fake conversion/cookie stuffing等は明確に禁止。catalog automationの許可根拠にはならない |
| confidentiality | 非公開の技術・営業等情報を秘密保持。既に公知等は例外 | auth-only schema/rate/ACLは公開しない。approved-onlyは特に制限 |
| IP | system/content/official ads等の権利は会社に帰属し、affiliate業務目的の限定利用 | access可能性をコピー権と解釈しない |
| link validity | creator停止・approval解除で無効化あり | eligibilityを継続検証する必要。ただし検証automationも要許諾 |
| attribution | 24hと7日/168hの公式矛盾 | `DOC_CONFLICT`; display/forecastで断定しない |
| transfer fee | 220円控除とMyFans負担の公式矛盾 | `DOC_CONFLICT`; accounting実装を固定しない |

Rules are grounded in current [Affiliate Terms][1], [registration guide][2], [FAQ][3], [receiving rewards guide][4], and [approved-only guide][5].

## 4. Compliance gates by proposed operation

| Proposed operation | Gate | Reason |
| --- | --- | --- |
| public Support/Termsを人が調査 | `ALLOWED` | public reference |
| public exact profile/postを少数確認 | `ALLOWED_FOR_RESEARCH` | no bulk/no ingestion |
| public static JSからroute名を確認 | `ALLOWED_FOR_ARCHITECTURE_RESEARCH` | endpointを呼ばない |
| undocumented authenticated endpointを直接call | `BLOCKED` | private replay禁止、documented permissionなし |
| Center UIをsigned-in browserで少数manual map | `PENDING_USER_LOGIN` | user session内でvisual/field確認のみ |
| Center catalogを定期crawl/DB保存 | `BLOCKED_PENDING_WRITTEN_PERMISSION` | API/automation/storage terms不明 |
| sales CSVを自分の会計用途でdownload | `AUTH_ONLY` | 公式機能。catalog seedにはしない |
| sales CSVをpublic catalog化 | `BLOCKED` | purpose/coverage/秘密保持が不一致 |
| creator thumbnailをdownload/rehost | `BLOCKED_PENDING_CREATOR_PERMISSION` | FAQが事前許可を要求 |
| generated affiliate URLのnative OGPをlink-card表示 | `PENDING_MYFANS_CONFIRMATION` | public link previewと画像再利用の境界が未確定 |
| approved-only creator/productをpublic表示 | `BLOCKED_PENDING_WRITTEN_PERMISSION` | unauthorized affiliateにも非表示となる情報 |
| oshiscopeをcrawl/DB replication | `NO` | operator policyが明示禁止 |

## 5. Required pre-ingestion evidence

DB/schema/code workへ進む前に全て必要:

1. MyFansからdocumented API/feed/exportまたは書面によるautomation許可
2. authentication、pagination、rate limit、更新頻度、停止条件
3. 保存可能fieldとretention、削除/approval解除時の反映SLA
4. publicに再掲可能なfield、特にrate/eligibility/approved-only
5. thumbnail/OGPの保存・加工・rehost/link-preview条件
6. dynamic pageのcreative事前承認方法
7. 24h vs 168h、220円 vs MyFans負担の公式回答

Until then:

- DB mutation: 0
- ingestion: 0
- private API replay: 0
- images saved: 0
- competitor raw rows: 0

## Footnotes / Sources

[^1]: Terms Article 10のbot/tool文言は、公開catalogの自動取得を明示的に許可も禁止もしていないため、本調査は保守的にpermission gateとする。

[1]: https://www.affiliate.myfans.jp/terms
[2]: https://support.myfans.jp/hc/ja/articles/15722941497487
[3]: https://support.myfans.jp/hc/ja/articles/14946655853711
[4]: https://support.myfans.jp/hc/ja/articles/15722971105167
[5]: https://support.myfans.jp/hc/ja/articles/17400497455119
