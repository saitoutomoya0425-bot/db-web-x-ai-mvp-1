import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";

let value = "";
if (process.stdin.isTTY) {
  process.stdout.write("接続文字列を貼り付けてEnterを押してください（入力内容は表示されません）: ");
  value = await new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (character) => {
      if (character === "\u0003") {
        process.stdin.setRawMode(false);
        reject(new Error("cancelled"));
      } else if (character === "\r" || character === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(input.trim());
      } else if (character === "\u007f") {
        input = input.slice(0, -1);
      } else {
        input += character;
      }
    });
  }).catch(() => "");
} else {
  for await (const chunk of process.stdin) value += chunk;
  value = value.trim();
}
if (!/^postgres(?:ql)?:\/\//i.test(value)) {
  console.error("PostgreSQL接続文字列を取得できませんでした。");
  process.exit(1);
}

const schemeEnd = value.indexOf("://") + 3;
const authorityEnd = value.lastIndexOf("@");
const passwordStart = value.indexOf(":", schemeEnd);
if (passwordStart < schemeEnd || authorityEnd < passwordStart) {
  console.error("接続文字列のユーザー名またはパスワード部分を判定できません。");
  process.exit(1);
}

const rawPassword = value.slice(passwordStart + 1, authorityEnd);
let decodedPassword = rawPassword;
try {
  decodedPassword = decodeURIComponent(rawPassword);
} catch {
  // 未エンコードのパーセント記号を含む場合も、パスワード全体を安全に符号化する。
}
const normalized = `${value.slice(0, passwordStart + 1)}${encodeURIComponent(decodedPassword)}${value.slice(authorityEnd)}`;

let target;
try {
  target = new URL(normalized);
  if (!target.hostname || !target.pathname) throw new Error();
} catch {
  console.error("PostgreSQL URIとして解釈できません。ホスト名とDB名を確認してください。");
  process.exit(1);
}

const sql = postgres(normalized, {
  ssl: "require",
  max: 1,
  prepare: false,
  connect_timeout: 20,
});
try {
  const [result] = await sql`select current_database() as database, current_user as username`;
  console.log(`接続成功: ${target.hostname}${target.pathname} (${result.database})`);
} catch (error) {
  const code = typeof error === "object" && error ? error.code : undefined;
  console.error(`接続失敗${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}

if (process.exitCode) process.exit(process.exitCode);

const envPath = ".env.local";
let env = await readFile(envPath, "utf8").catch(() => "");
const line = `SUPABASE_DB_URL=${normalized}`;
if (/^SUPABASE_DB_URL=.*$/m.test(env)) {
  env = env.replace(/^SUPABASE_DB_URL=.*$/m, line);
} else {
  env = `${env.trimEnd()}\n${line}\n`;
}
await writeFile(envPath, env, { mode: 0o600 });
console.log(".env.localへSUPABASE_DB_URLを安全に反映しました。");
