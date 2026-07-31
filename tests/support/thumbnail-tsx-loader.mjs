import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const nextImageModuleUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("next/image.js"),
).href;

async function sourceModulePath(specifier) {
  const base = path.join(root, "src", specifier.slice(2));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next exact TypeScript module candidate.
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/image") {
    return { url: "thumbnail-test:next-image", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const candidate = await sourceModulePath(specifier);
    if (!candidate) throw new Error(`UNRESOLVED_TEST_ALIAS:${specifier}`);
    return { url: pathToFileURL(candidate).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === "thumbnail-test:next-image") {
    return {
      format: "module",
      source: `import nextImageModule from ${JSON.stringify(nextImageModuleUrl)}; export default nextImageModule.default;`,
      shortCircuit: true,
    };
  }
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const source = await fs.readFile(fileURLToPath(url), "utf8");
    const output = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      reportDiagnostics: true,
    });
    const errors = (output.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length) {
      throw new Error(
        `TEST_TYPESCRIPT_TRANSPILE_FAILED:${errors
          .map((diagnostic) => diagnostic.messageText)
          .join("|")}`,
      );
    }
    return {
      format: "module",
      source: output.outputText,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
