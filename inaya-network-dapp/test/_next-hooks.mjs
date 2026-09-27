import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// Mirrors what Next's bundler does so plain Node can import route files: "next/server", the "@/" alias for src/, and
// extensionless relative imports inside src/.
function probe(base) {
  for (const c of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    try { if (fs.statSync(c).isFile()) return pathToFileURL(c).href; } catch { /* keep looking */ }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier.startsWith("@/")) { const hit = probe(path.join(SRC, specifier.slice(2))); if (hit) return nextResolve(hit, context); }
  if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(SRC)) { const hit = probe(path.resolve(path.dirname(parent), specifier)); if (hit) return nextResolve(hit, context); }
  }
  return nextResolve(specifier, context);
}
