import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadLocalEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

loadLocalEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;

const missing = [
  !url && "NEXT_PUBLIC_SUPABASE_URL",
  !serviceRoleKey && "SUPABASE_SERVICE_ROLE_KEY",
  !email && "ADMIN_EMAIL",
  !password && "ADMIN_PASSWORD",
].filter(Boolean);

if (missing.length) {
  console.error(`管理者の初期化に必要な環境変数がありません: ${missing.join(", ")}`);
  console.error(".env.local を設定してから、もう一度 npm run dev を実行してください。");
  process.exit(1);
}
if (password.length < 8) {
  console.error("ADMIN_PASSWORD は8文字以上にしてください。");
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let target = null;
for (let page = 1; page <= 100 && !target; page += 1) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw new Error(`管理者ユーザー一覧の取得に失敗しました: ${error.message}`);
  target = data.users.find((user) => user.email?.toLowerCase() === email) ?? null;
  if (data.users.length < 1000) break;
}

if (target) {
  const { error } = await supabase.auth.admin.updateUserById(target.id, {
    email,
    password,
    email_confirm: true,
    app_metadata: { ...target.app_metadata, role: "admin" },
  });
  if (error) throw new Error(`管理者ユーザーの更新に失敗しました: ${error.message}`);
  console.log(`管理者ユーザーを更新しました: ${email}`);
} else {
  const { error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "admin" },
  });
  if (error) throw new Error(`管理者ユーザーの作成に失敗しました: ${error.message}`);
  console.log(`管理者ユーザーを作成しました: ${email}`);
}
