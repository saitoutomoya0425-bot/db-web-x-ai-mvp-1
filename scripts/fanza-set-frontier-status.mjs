import { open, readFile, rename } from "node:fs/promises";

const values = new Map();
for (const argument of process.argv.slice(2)) {
  if (!argument.startsWith("--") || !argument.includes("=")) throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
  const [name, ...value] = argument.slice(2).split("=");
  values.set(name, value.join("="));
}
const directory = String(values.get("directory") ?? "");
const expected = String(values.get("from") ?? "");
const next = String(values.get("to") ?? "");
const safeNewTotal = Number(values.get("safe-new-total") ?? 0);
const safeNewPublished = Number(values.get("safe-new-published") ?? 0);
const safeNewUnfinished = Number(values.get("safe-new-unfinished") ?? 0);
const transitions = new Set(["FROZEN:PROCESSING", "PROCESSING:COMPLETE"]);
if (!directory || !transitions.has(`${expected}:${next}`)) throw new Error("FRONTIER_STATUS_TRANSITION_INVALID");
if (next === "COMPLETE" && (!Number.isInteger(safeNewTotal) || safeNewTotal < 0
  || safeNewPublished !== safeNewTotal || safeNewUnfinished !== 0)) {
  throw new Error("FRONTIER_COMPLETE_EVIDENCE_INVALID");
}
const summaryPath = `${directory}/summary.json`;
const summary = JSON.parse(await readFile(summaryPath, "utf8"));
if (summary.status !== expected) throw new Error(`FRONTIER_STATUS_EXPECTED_${expected}`);
const updated = {
  ...summary,
  status: next,
  status_updated_at: new Date().toISOString(),
  processing: next === "COMPLETE"
    ? { safe_new_total: safeNewTotal, safe_new_published: safeNewPublished, safe_new_unfinished: safeNewUnfinished }
    : summary.processing ?? null,
};
const temporaryPath = `${summaryPath}.tmp-${process.pid}`;
const handle = await open(temporaryPath, "wx", 0o600);
try {
  await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`);
  await handle.sync();
} finally {
  await handle.close();
}
await rename(temporaryPath, summaryPath);
const directoryHandle = await open(directory, "r");
try {
  await directoryHandle.sync();
} finally {
  await directoryHandle.close();
}
console.log(JSON.stringify({ directory, previous_status: expected, status: next }, null, 2));
