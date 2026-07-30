# FANZA API 承認後Runbook

この手順は、DMM/FANZAの承認後に公式APIから候補データを段階取得するためのものです。取得候補は `source_products` に保存され、承認操作を行うまで `videos` へ反映・公開されません。

## 事前準備

1. DMM Webサービス利用登録を完了する。
2. API IDとAPI用アフィリエイトIDを確認する。
3. ローカルの `.env.local` とVercelのサーバー環境変数へ次を設定する。
   - `FANZA_API_ID`
   - `FANZA_AFFILIATE_ID`
   - `FANZA_API_SITE=FANZA`
   - `FANZA_API_SERVICE=digital`
   - `FANZA_API_FLOOR=videoa`
4. DMM Webサービスの最新ガイドに従い、指定されたクレジット表示と利用条件を確認する。
5. `027_fanza_bulk_import_foundation.sql` までMigrationを適用する。
6. `npm run check:supabase`、`npm run test:fanza`、`npm run test:fanza-pipeline`、`npm run build` を実行する。

## 段階取得

### 1. 疎通確認と10件dry-run

- 既存の `/admin/fanza-import` で資格情報が「設定済み」と表示されることを確認する。
- 10件取得し、raw payload、外部商品ID、品番、公式URL、画像URL、取得日時を確認する。
- 最初はdry-runジョブを使い、`videos` と `source_products` の件数が変化しないことを確認する。

停止条件：

- HTTP 401/403、利用条件に関するエラー、レスポンス形式不一致が1件でもある。
- 外部商品IDまたはタイトル欠落が10%を超える。
- 既存公開10作品のいずれかが自動更新・非公開化される。

### 2. 10件ステージング

- dry-runを解除して10件を `source_products` に保存する。
- `new / update / unchanged / duplicate / needs_review` の分類を確認する。
- `duplicate` と `needs_review` は承認しない。
- 既存公開10作品との照合結果を目視確認する。

停止条件：

- 外部商品IDまたは正規化品番が同じなのに `new` になる。
- 異なる商品が同じ作品へ統合される。
- エラー率が1%を超える（10件では1件でも停止）。

### 3. 100件

- page sizeは20〜50件から開始し、1リクエスト1バッチで実行する。
- 各バッチ後に `next_offset`、処理件数、失敗件数を確認する。
- 一時失敗は同じjob ID・同じoffsetから再実行する。

停止条件：

- エラー率が1%を超える。
- 重複誤判定が1件でも見つかる。
- 1バッチが45秒を超える。
- APIから429が継続して3回返る。

### 4. 1,000件

- page size 50以下を維持する。
- ステージング完了後に検索、作品一覧、女優、メーカー、シリーズ、ジャンル、ランキングを確認する。
- 公開は一括で行わず、確認済み候補だけを段階公開する。

停止条件：

- 検索応答が通常時1秒、遅い場合でも2秒を継続して超える。
- DB CPU・接続数・APIエラー率が運用基準を超える。
- sitemap生成がタイムアウトする。

### 5. 1万件以上

- 1,000件の結果が安定した後だけ拡張する。
- API取得、候補確認、昇格、公開を別工程として扱う。
- ランキングは都度全件集計せず `discovery_metrics` の定期集計を使用する。
- sitemapは1ファイル最大50,000 URLの分割を維持する。

## 再開と失敗処理

- `fanza_import_jobs.next_offset` が次回開始位置である。
- APIページ取得に失敗した場合、offsetを進めず `fanza_import_errors` に記録する。
- 失敗jobは同じjob IDで再実行し、成功後に次のoffsetへ進む。
- 作品単位の失敗は `source_products.review_status=error` とエラー内容を確認し、その候補だけ再試行する。
- 同じ外部商品IDは `(data_source_id, external_product_id)` の一意制約で重複保存されない。

## 公開ルール

- API取得だけでは公開しない。
- `duplicate` と `needs_review` は人間が内容を確認する。
- 昇格した新規作品も `is_published=false` から始める。
- 公式画像・サンプル・URLはAPIレスポンス由来の値だけを保存する。
- 販売終了は削除せず、将来 `product_offers.availability_status` で管理する。
