# Production Request Safety

本番Vercelの Edge Requests を不用意に増やさないための運用ルールです。

## 基本方針

- 大量確認は本番URLでは行わない。
- 画像確認、詳細ページ確認、検索確認、スマホ/PC確認は原則 `localhost` またはローカル生成物で行う。
- 本番確認はデプロイ後の代表確認に限定する。

## DRY_RUN

大きな処理の前には必ず以下を付けて予定リクエストだけ確認します。

```bash
DRY_RUN=true npm run fanza:promote-safe
```

`DRY_RUN=true` では以下だけを行います。

- 本番URLへアクセスしない
- 予定URL一覧を出力
- 予定リクエスト数を表示
- JSONレポートを `tmp/production-access/` に保存

## 本番URLを使う条件

本番URLを使う場合は、明示的に以下を指定します。

```bash
PRODUCTION_ACCESS_CONFIRMED=true PROMOTE_SITE_URL=https://example.vercel.app npm run fanza:promote-safe
```

安全ゲートの制限:

- 予定リクエスト数は最大100
- 並列数は最大3
- retryは最大1
- 同一URLへの重複アクセスは禁止
- 実行前に予定URL一覧を保存
- 実行後に実リクエスト数を保存

## 本番確認の上限

通常の本番確認は以下までにします。

- トップページ: 1回
- 検索: 1回
- 詳細ページ: 最大5件
- 画像: 最大5件
- スマホ代表確認: 最大3件
- PC代表確認: 最大3件

通常の開発作業中に Edge Requests が1時間で1,000件以上増えた場合は作業を停止し、原因確認まで本番確認を禁止します。
