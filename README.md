# おかずDB

Xの「品番教えて」というリプに対し、品番・女優名・作品詳細URLを返すための作品検索サイトです。

本番公開の最短手順は [SETUP.md](./SETUP.md) を参照してください。

## 機能

- `/`：品番検索、人気作品、人気女優
- `/admin/import-csv`：認証済み管理者向けCSV一括インポート
- `/search?q=...`：品番・女優・メーカー・シリーズの横断検索
- `/actress/[name]`、`/maker/[name]`、`/series/[name]`：SEO一覧ページ
- `/work/[product_code]`：作品詳細、同じ女優の作品、類似作品、アフィリエイト導線
- `/ranking`：検索ログをもとにした人気作品ランキング
- `GET /api/work/[product_code]`：作品情報JSON
- `GET /api/search?code=IPX-123`：作品検索、検索ログ保存、詳細URL返却
- `GET /api/x-reply-text?code=IPX-123`：X返信文の生成

## Supabaseセットアップ

1. Supabaseでプロジェクトを作成します。
2. Supabase CLIでログインし、プロジェクトへ接続します。
3. マイグレーションを適用します。

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

既に旧MVPのスキーマを適用している場合も、`002_x_reply_pivot.sql` が既存データを保ちながら新スキーマへ移行します。

データはSupabaseのTable Editorから、次の順で登録します。

1. `actresses`
2. `makers`
3. `tags`
4. `works`
5. `work_tags`

CSVインポートを使う場合は、Supabase Dashboardの Authentication > Users で管理者ユーザーを作成してください。`003_create_videos.sql` により `videos` テーブルと管理者専用RLSポリシーが作成されます。

## CSVインポート

`/admin/import-csv` にアクセスし、Supabaseの管理者ユーザーでログインします。CSVはブラウザ内で4MBずつストリーミング解析し、1,000件ずつAPIへ送るため、100万件以上でもメモリへ一括展開しません。

- ファイル先頭・末尾・サイズから指紋を作り、`import_jobs` に再開位置を保存
- 通信失敗時は各チャンクを最大3回再送
- 同じチャンクの再送はオフセットで検出し、二重登録を防止
- 同じ `product_code` は更新せずスキップ
- 同じファイルを再選択すると処理済み行を読み飛ばして再開
- 完了後に処理・登録・重複・エラー件数を表示
- 進捗率から残り件数を逐次推定して表示
- エラーになった行だけを `import_errors` に保存
- 画面表示用のエラー明細は最大1,000件保持

必須列：

```csv
product_code,title
```

利用可能な全列：

```csv
product_code,title,actress_name,actress_name_kana,maker_name,series_name,label_name,genre,tags,duration,release_date,sample_images,thumbnail_url,video_url,affiliate_url,description,popularity,favorite_count
```

日本語ヘッダーにも対応しています。`duration` は分単位の0以上の整数、`popularity` と `favorite_count` は0以上の整数です。`sample_images` は `https://...|https://...` のような `|` 区切り、またはJSON配列で指定します。

CSV取込時に `actresses`、`makers`、`tags`、`video_tags`、女優かな別名も同期されます。ジャンルとシリーズは作品データから一覧・詳細ページを自動生成します。

## 必要な環境変数

`.env.example` を `.env.local` にコピーして設定します。

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_SITE_URL=http://localhost:3000
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-this-password
X_REPLY_API_KEY=generate-a-long-random-secret
INGEST_API_KEY=generate-another-long-random-secret
CRON_SECRET=generate-a-cron-secret
X_BEARER_TOKEN=your-x-app-bearer-token
X_COLLECTION_QUERY="品番 OR 女優 -is:retweet lang:ja"
OPENAI_API_KEY=your-openai-api-key
AI_EXTRACTION_MODEL=gpt-5.4-mini
```

`SUPABASE_SERVICE_ROLE_KEY` はSupabase DashboardのProject Settings > API Keysから取得します。この値は管理者Authユーザーの初期化だけに使用し、ブラウザには公開されません。本番環境では `NEXT_PUBLIC_SITE_URL` を公開サイトのURLに変更してください。

## ローカル起動

```bash
npm install
cp .env.example .env.local
npm run dev
```

`http://localhost:3000` を開きます。

## 本番反映

本番DB接続URLを `SUPABASE_DB_URL` に設定してMigrationを適用します。実行器は排他ロック、ファイルチェックサム、Migration単位のトランザクションを使用します。旧環境では既存の初期テーブルを検出し、不足スキーマを `005_5_legacy_baseline_repair.sql` で補完します。

```bash
npm run db:migrate
npm run import:videos -- /absolute/path/to/videos.csv
npm run preflight:production
npm run build
```

サーバー側CSV取込は1,000件単位でコミットし、品番重複をスキップして `.import-state` から再開します。`tags` の関連付けにも対応しています。

VercelへはSupabase、管理者、Cron、X、OpenAIの環境変数を登録してからデプロイします。`vercel.json` にX収集、AI整備、ランキング・分析・アフィリエイト更新の定期実行設定があります。

管理者アカウントの初回作成・認証情報の同期は `npm run seed:admin` で実行します。開発サーバーの起動とは分離されているため、Supabaseへの接続障害があっても `npm run dev` は起動できます。

## API使用例

```bash
curl "http://localhost:3000/api/work/IPX-123"
curl "http://localhost:3000/api/search?code=IPX-123&source=x-manual"
curl "http://localhost:3000/api/search?q=女優名&limit=24"
curl "http://localhost:3000/api/x-reply-text?code=IPX-123"
```

X Botなどのサーバー間連携では、認証・重複防止付きAPIを利用します。

```bash
curl -X POST "http://localhost:3000/api/x/reply" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $X_REPLY_API_KEY" \
  -d '{"code":"IPX-123","source_tweet_id":"1234567890"}'
```

同じ `source_tweet_id` の再送時は保存済み返信を返し、二重返信を防ぎます。

`/api/x-reply-text` のレスポンス例：

```json
{
  "text": "品番：IPX-123\n女優：〇〇〇〇\nこの女優の他の作品・類似作品はこちら\nhttps://example.com/work/IPX-123",
  "product_code": "IPX-123",
  "actress": "〇〇〇〇",
  "url": "https://example.com/work/IPX-123"
}
```

## 将来X自動返信Botへ接続する方法

1. X APIのWebhookまたは定期ポーリングでメンションを取得します。
2. 投稿本文から品番を抽出・正規化します。
3. Botのバックエンドから `GET /api/x-reply-text?code=品番` を呼びます。
4. 返却された `text` をX APIの返信投稿エンドポイントへ渡します。
5. Bot専用のAPIトークン、レート制限、重複返信防止IDを追加します。

X APIの秘密情報はこのNext.jsフロントエンドへ置かず、Bot用サーバーのサーバーサイド環境変数で管理してください。Botからは `POST /api/x/reply` を呼び出します。

## SEOとサイトマップ

作品ページはcanonical、Open Graph、Twitter Card、Movie構造化データを自動生成します。サイトマップは50,000 URL単位へ分割され、作品に加えて女優・メーカー・ジャンル・タグURLも出力します。

## アフィリエイト計測

作品詳細のボタンは `/go/[product_code]` を経由し、`affiliate_clicks` にクリックを記録してから `affiliate_url` へリダイレクトします。

管理画面でURLテンプレートを初回設定した後は、アフィリエイトIDを1つ登録するだけで新規作品へ自動付与され、既存未設定作品も一括更新できます。

## 公開ページ

- `/works` 作品一覧
- `/work/[product_code]` 作品詳細
- `/search` 品番・タイトル・女優・メーカー・シリーズ検索
- `/actress/[name]` 女優ページ
- `/makers` メーカー一覧
- `/maker/[name]` メーカーページ
- `/genres` ジャンル一覧
- `/genre/[name]` ジャンル別作品
- `/ranking` 人気・急上昇ランキング

## 検索ログとランキング

`/api/search` と `/api/x-reply-text` は `search_logs` に検索品番・流入元・User-Agent・Referrerを保存します。公開ユーザーはログ明細を読めず、ランキング集計関数の結果だけを取得できます。

## 外部データ収集

X API、提携先API、許可された取得処理からの候補データは `POST /api/admin/ingest` へ最大1,000件ずつ送信します。`X-Ingest-Key` に `INGEST_API_KEY` を指定してください。候補は `source_items` に冪等保存され、既存作品データと分離して確認できます。形式と運用方針は `docs/data-collection.md` を参照してください。

ランキング・CTRなどの事前集計は管理画面の「分析を再集計」から更新できます。本番ではSupabase Cronなどから `refresh_discovery_metrics()` を定期実行してください。

X候補収集は `/api/cron/collect-x`、分析更新は `/api/cron/refresh-metrics` です。Vercelでは `vercel.json` のCron設定が使用されます。候補レビューとCSV出力は `/admin/sources` から行います。

## AIデータ整備

`/api/cron/enrich-candidates` は未処理候補を最大20件ずつ排他的に取得し、投稿本文から品番・タイトル・女優・メーカー・シリーズと項目別信頼度を構造化抽出します。モデル障害時は決定論抽出へフォールバックし、候補処理を停止させません。

モデル利用量と失敗は `ai_extraction_runs`、管理者の修正前後は `ai_correction_examples` に保存されます。画像・動画URLは `media_analysis_jobs` に登録され、将来の非同期Vision解析から候補本体を分離しています。

候補は高・中・低信頼、重複、必須項目不足へ自動分類されます。`/admin/ai-quality` で閾値と品質ゲートを管理できます。自動承認は初期状態では無効で、最低評価件数・高信頼帯精度・重複なし・必須項目ありをすべて満たした場合だけ有効になります。
