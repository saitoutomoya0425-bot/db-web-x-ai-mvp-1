import fs from "node:fs";
import path from "node:path";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const auth = readJson(path.resolve(".vercel-cli/data/com.vercel.cli/auth.json"));
const project = readJson(path.resolve(".vercel/project.json"));
const token = auth.token;

if (!token || !project.projectId || !project.orgId) {
  throw new Error("Vercelの認証情報またはプロジェクト情報が見つかりません。");
}

const keys = ["FANZA_API_ID", "FANZA_AFFILIATE_ID"];
const values = Object.fromEntries(
  keys.map((key) => {
    const value = process.env[key]?.trim();
    if (!value) throw new Error(`${key} is missing`);
    return [key, value];
  }),
);

const base = `https://api.vercel.com/v10/projects/${encodeURIComponent(project.projectId)}/env`;
const query = `?teamId=${encodeURIComponent(project.orgId)}`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

const listResponse = await fetch(`${base}${query}`, { headers });
if (!listResponse.ok) {
  throw new Error(`Vercel環境変数の確認に失敗しました (${listResponse.status})`);
}
const listed = await listResponse.json();
const existing = Array.isArray(listed.envs) ? listed.envs : [];

for (const key of keys) {
  const matches = existing.filter(
    (item) => item.key === key && (item.target ?? []).includes("production"),
  );

  for (const match of matches) {
    const deleteResponse = await fetch(
      `${base}/${encodeURIComponent(match.id)}${query}`,
      { method: "DELETE", headers },
    );
    if (!deleteResponse.ok) {
      throw new Error(`${key}の旧設定削除に失敗しました (${deleteResponse.status})`);
    }
  }

  const createResponse = await fetch(`${base}${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      key,
      value: values[key],
      type: "sensitive",
      target: ["production"],
    }),
  });
  if (!createResponse.ok) {
    throw new Error(`${key}の本番設定に失敗しました (${createResponse.status})`);
  }
  console.log(`configured ${key} for production`);
}
