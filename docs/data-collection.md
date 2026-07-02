# データ収集基盤

収集処理は `collector → source_items → review/normalize → videos` の4段階に分けます。X API、提携先API、許可されたWeb取得処理は同じ受信APIへ送り、取得元固有のJSONは `payload` に保存します。

## 正規化レコード（JSON Lines / CSV共通）

必須: `source`, `source_key`。候補項目: `source_url`, `observed_at`, `product_code`, `title`, `actress_name`, `maker_name`, `series_name`, `tags`, `payload`。

CSVでは `tags` を `|` 区切り、`payload` をJSON文字列にします。X収集では投稿IDを `source_key`、投稿URLを `source_url` とし、本文から品番候補を抽出して `product_code` に格納します。利用規約・robots.txt・APIレート制限・削除要求を必ず順守し、個人情報は収集しません。

## X収集の推奨フロー

1. X APIのRecent Searchで許可された検索語を取得
2. 投稿IDで冪等化
3. 品番正規表現、登録済み女優・メーカー辞書で候補抽出
4. `/api/admin/ingest` に最大1000件ずつ送信
5. 管理画面で確認後、作品CSVまたは昇格ジョブへ渡す

認証には管理者セッション、またはサーバー間通信用 `INGEST_API_KEY` を使用します。

## 定期実行

`/api/cron/collect-x` は `since_id` を保存してRecent Searchを差分取得します。1回100件、最大5ページで処理し、投稿IDと品番の組み合わせで冪等化します。429時は `x-rate-limit-reset` を保存し、その時刻まで実行を見送ります。

Vercel Cronは30分間隔で収集、毎時15分に分析指標を更新します。両APIは `Authorization: Bearer $CRON_SECRET` が必須です。Xのプラン料金、検索演算子、取得可能期間、レート制限は変更される可能性があるため、公開前にDeveloper Consoleと公式ドキュメントを確認してください。

管理画面 `/admin/sources` では未処理候補をレビューし、タイトルと品番が揃った候補だけを作品へ昇格できます。全候補CSVは1000件ずつ読み出すストリーミングレスポンスです。

## AI整備

収集候補は20件単位で構造化抽出され、全体・項目別の信頼度、重複候補、使用モデルを保存します。管理者は抽出値を直接修正してから承認でき、修正前後は将来の評価・プロンプト改善・ファインチューニング用データとして保持されます。通常は管理者レビューを経て作品DBへ昇格します。

品質管理画面では信頼度閾値、最低評価サンプル数、必要精度を管理します。自動承認は既定で無効です。有効化後も最新評価がゲートを通過しなければ動作せず、重複・必須項目不足は常にレビューへ送られます。
