// scripts/sqa/await-params-codemod.mjs — SQA 17 Nov 2026. Next.js 15 passes route-handler `params` as a Promise;
// reading `params.x` synchronously still works but logs a deprecation error on every request and breaks in the next
// major version. This inserts `params = await params;` as the first statement of every exported route handler that
// receives `{ params }` (whether it reads params.x or destructures it), unless it already awaits it first. Idempotent; prints what it changed.
//   node scripts/sqa/await-params-codemod.mjs [--dry]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("src/app/api");
const DRY = process.argv.includes("--dry");
const HANDLER = /(export\s+async\s+function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*\{\s*params\s*\}\s*\)\s*\{)/g;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name === "route.js") yield p;
  }
}

let files = 0, handlers = 0;
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, "utf8");
  if (!/\{\s*params\s*\}/.test(src)) continue;
  let changed = 0;
  const out = src.replace(HANDLER, (m, head, offset) => {
    const after = src.slice(offset + m.length, offset + m.length + 200);
    if (/^\s*params\s*=\s*await\s+params\s*;/.test(after)) return m; // already done
    changed++;
    return `${head}\n  params = await params; // Next.js 15: params is a Promise (SQA 17 Nov 2026)`;
  });
  if (changed) {
    files++; handlers += changed;
    if (!DRY) fs.writeFileSync(file, out);
    console.log(`${DRY ? "would update" : "updated"} ${path.relative(process.cwd(), file)} (${changed})`);
  }
}
console.log(`${files} files, ${handlers} handlers${DRY ? " (dry run)" : ""}`);
