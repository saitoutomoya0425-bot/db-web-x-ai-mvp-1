# おかずDB

作品情報、出演女優、メーカー、タグ、メディアURL、AI投稿用メモを管理するNext.js製の管理画面です。

## 必要環境

- Node.js 20以上
- npm
- Supabaseプロジェクト

## セットアップ

1. Supabaseで新しいプロジェクトを作成します。
2. SupabaseのSQL Editorで `supabase/migrations/001_initial_schema.sql` を実行します。
3. Supabase DashboardのAuthentication > Usersから管理ユーザーを作成します。
4. 環境変数を準備します。

```bash
cp .env.example .env.local
```

`.env.local` にSupabase DashboardのProject Settings > APIにある値を設定します。

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

5. 開発サーバーを起動します。

```bash
npm install
npm run dev
```

ブラウザで `http://localhost:3000` を開き、作成した管理ユーザーでログインします。

## マスターデータ

作品登録前にSupabaseのTable Editorで `makers`、`series`、`actresses`、`tags` に必要な候補を登録してください。管理画面内でのマスター編集は次フェーズで追加できます。

## 主な機能

- Supabase Authによる管理画面保護
- 作品一覧、登録、詳細
- 品番、女優名・読み、メーカー名による複合検索
- 複数女優・複数タグの関連付け
- サムネイルURL、動画URL、AI投稿用メモの保存
- 将来のAI接続用 `POST /api/ai/generate`

## コマンド

```bash
npm run dev
npm run build
npm run lint
```
