# 開発運用ルール

## モデル使い分け

| モデル | 担当 |
| --- | --- |
| Luna | CSV整形、一覧、軽量な集計・資料作成 |
| Terra | 通常実装、画像レビュー、FANZA追加、検証設計 |
| Sol | 設計、DB、難しいバグのみ。通常の画像監査・追加作業では使わない |

通常作業はTerraで完結させる。画像の全件走査や巨大な比較資料を作るためにSolを使わない。

## build条件

- ソースコード、依存関係、ビルド設定を変更していない場合は `lint`、`build`、`vercel-build` を実行しない。
- 実行する場合も、変更と直接関係する検証を最小限にする。
- `node_modules`、`.next` は不要に削除・再生成しない。依存変更、キャッシュ破損、再現不能な不整合時だけ対象を限定して再生成する。

## 画像レビュー手順

1. `docs/thumbnail-policy-v1.md` を正本として候補を判定する。
2. `data/thumbnail-gold-labels.csv` を必ず比較し、1件でも不一致なら自動反映を停止する。
3. 高信頼候補だけを自動候補にし、低信頼・新パターン・候補不足だけを `needs_user_review` に送る。
4. sampleは取得済みの最後まで確認するが、全作品の全候補PDFを作らない。
5. レビュー資料は対象作品だけの軽量一覧にし、再利用可能な資料を重複生成しない。
6. 古い `tmp` 資料は削除せず、必要時のみ同じ監査ディレクトリ配下の `archive/` へ移動する。
7. 画像生成・public配置・DB更新は、ユーザー承認済みの最終候補だけに限定する。

## Git手順

- `git status` と差分で対象を確認してから作業する。
- ユーザー承認済みのファイルだけをステージする。`tmp/`、キャッシュ、ログ、生成途中の資料は原則コミットしない。
- commit前にステージ済みファイル一覧と差分を確認する。
- push・Deploy・Rollbackはユーザーの明示承認後だけ行う。

## DB更新手順

- DB更新前に、画像ファイルを先に配置・デプロイし、Deployment Readyと画像取得を確認する。
- 更新は単一トランザクションで、`product_code` と更新前 `card_thumbnail_url` の両方を条件にする。
- 想定更新件数、更新前値、更新後値を検証し、差異が1件でもあればロールバックする。
- DB更新後は対象行だけを再読取し、保留・対象外・既存正常作品に差分がないことを確認する。

## 本番アクセス

- 本番確認はローカル確認後の最小代表件数に限定する。
- 大量確認はDBスナップショット、ローカルキャッシュ、ローカルプレビューで行う。
- production access guardの上限とDRY_RUNを優先し、上限超過時は停止する。

## Codex Cloud運用

- 通常開発はCodex Web / Codex Cloudを第一候補とし、GitHub `main`をcodeのsource of truthとする。Cloud taskはGitHubから開始し、変更はCodexのnative branch / PR flowでGitHubへ戻す。
- GitHub Actionsを通常のcode read、edit、test、review、commitの必須中継点にしない。ActionsはCI、長時間の定型job、または厳密なapproval gateが必要なProduction operationだけに限定する。
- Local Codex CLI、Mac repo、local stateはfallbackとして保持し、Cloud移行を理由に削除しない。
- secret valueをcommit、repo file、state object、artifact、stdout、log、reportへ出さない。Cloudで必要なsecretは用途別に最小限だけ設定する。
- persistent stateはprivate backendのallowlist済みexact fileだけを対象にする。repo、public URL、Actions artifact、container cacheをcanonical long-term stateにしない。画像、media、raw HTML、cache、browser profile、secret path、recursive HOME uploadは禁止する。
- Production operationは通常開発から分離し、dry-run、exact manifest hash、expected count、approval provenance、target-scoped verify、checkpointを必須とする。arbitrary SQL、free-form shell、blind retryは禁止する。
- FANZA / MyFansの既存safety gateをCloudでも維持する。certificate bypass、anti-bot bypass、private API、未承認promotion / publishは禁止する。
- 変更に直接関係するtargeted testだけを実行する。依存、build設定、runtime codeを変更していない場合はfull lint、full suite、build、vercel-buildを実行しない。
