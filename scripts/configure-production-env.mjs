import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const siteUrl = process.argv[2]?.replace(/\/+$/, "");
if (!siteUrl || !siteUrl.startsWith("https://")) {
  console.error("HTTPSの本番URLを指定してください。");
  process.exit(1);
}

const envPath = ".env.local";
let env = await readFile(envPath, "utf8").catch(() => "");
function set(name, value, onlyWhenMissing = false) {
  const expression = new RegExp(`^${name}=(.*)$`, "m");
  const match = env.match(expression);
  if (onlyWhenMissing && match?.[1]?.trim()) return;
  const line = `${name}=${value}`;
  env = expression.test(env) ? env.replace(expression, line) : `${env.trimEnd()}\n${line}\n`;
}
set("NEXT_PUBLIC_SITE_URL", siteUrl);
for (const name of ["CRON_SECRET", "X_REPLY_API_KEY", "INGEST_API_KEY"]) {
  set(name, randomBytes(32).toString("base64url"), true);
}
await writeFile(envPath, env, { mode: 0o600 });
console.log("本番URLとサーバー間認証キーを.env.localへ設定しました。");
