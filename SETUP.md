# 本番公開までにあなたが行うこと

こちらで実行できない、アカウント本人の操作だけをまとめています。

## 1. `.env.local` を完成させる

`.env.example` をコピーし、次の値をサービス画面から取得して設定します。

- Supabase: URL、anon key、service role key、DB接続URL
- 公開予定URL: `NEXT_PUBLIC_SITE_URL`
- 管理者メールアドレスと12文字以上のパスワード
- ランダムな `CRON_SECRET`、`X_REPLY_API_KEY`、`INGEST_API_KEY`
- 必要になった時点でOpenAI、X、FANZAのキー

## 2. DBと管理者を自動セットアップする

```bash
npm run setup:production
```

このコマンドがMigration適用、管理者作成、Supabase読み書き確認を行います。

サンプルデータも入れる場合：

```bash
npm run import:videos -- samples/videos.sample.csv
```

## 3. 公開前チェック

```bash
npm run check:release
```

すべて `PASS` になればコードとDBの準備は完了です。

## 4. Vercel

Vercelへログインし、このフォルダをデプロイします。`.env.local` と同じ本番環境変数をVercelにも登録します。Hobbyプランで失敗しないようCronは1日1回に設定済みです。

## 5. 独自ドメインを使う場合

Vercelが表示するDNSレコードをドメイン管理会社へ設定し、`NEXT_PUBLIC_SITE_URL` を独自ドメインへ変更して再デプロイします。
