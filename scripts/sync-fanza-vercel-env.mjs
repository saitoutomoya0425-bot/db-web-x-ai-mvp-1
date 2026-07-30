import { spawnSync } from "node:child_process";
import path from "node:path";

const keys = ["FANZA_API_ID", "FANZA_AFFILIATE_ID"];
const home = path.resolve(".vercel-cli");
const cache = path.resolve(".npm-cache");

for (const key of keys) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is missing`);
  const result = spawnSync(
    "npx",
    ["--yes", "vercel", "env", "add", key, "production", "--value", value, "--force", "--sensitive", "--yes", "--no-color"],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, npm_config_cache: cache },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(`${key}のVercel設定に失敗しました。`);
  }
  console.log(`configured ${key} for production`);
}
