// SQA-026 regression guard. Production failure (found by the first live PDF generation, 27 Sep 2026):
//   "The document could not be rendered: Cannot find module '#standard-fonts/Helvetica'"
// Cause: pdfkit was inlined into the server bundle but loads its built-in fonts at runtime through a path frozen at build time, and the font data
// files were not shipped to the serverless function. This test cannot run Vercel, so it pins the two settings that fix it, and checks that what the
// settings point at really exists in the installed package (a pdfkit upgrade that moves the files would otherwise break production silently).
//
// Next.js 15 upgrade (September 2026): both options moved from experimental.* to top-level config keys
// (Next's own build now warns "Unrecognized key(s) ... at experimental" and silently ignores the old
// nested location -- an unrecognized experimental key is a no-op, not an error, so this would have
// silently reintroduced the exact bug above without ever failing a build). This test now reads the new
// top-level location -- the whole point of a regression test is to break loudly the moment the real
// config stops matching what it asserts, not to keep passing against a shape that no longer does anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = (await import(new URL("../next.config.mjs", import.meta.url).href)).default;
const pdfkitDir = path.join(APP, "node_modules", "pdfkit");

test("pdfkit is kept out of the server bundle, so Vercel ships the real package", () => {
  assert.ok(config.serverExternalPackages.includes("pdfkit"));
});

test("the file-tracing root is pinned to this app's own directory, not inferred from the monorepo", () => {
  // This repo sits inside a monorepo with sibling packages that carry their own lockfiles -- Next's own
  // root-inference picked the OUTER monorepo folder, which would make every relative path in
  // outputFileTracingIncludes above resolve from the wrong directory (silently breaking this exact fix).
  assert.equal(config.outputFileTracingRoot, APP);
});

test("every API route ships pdfkit's built-in font data", () => {
  const globs = config.outputFileTracingIncludes["/api/**/*"] || [];
  assert.ok(globs.includes("./node_modules/pdfkit/js/standard-fonts/**/*.cjs"), "the #standard-fonts/* alias targets AND their shared chunks/ helper must be listed explicitly");
  assert.ok(fs.readdirSync(path.join(pdfkitDir, "js", "standard-fonts", "chunks")).some((f) => f.endsWith(".cjs")), "the fonts require a shared helper in chunks/");
  const fonts = fs.readdirSync(path.join(pdfkitDir, "js", "standard-fonts")).filter((f) => f.endsWith(".cjs"));
  assert.ok(fonts.length >= 14, `the 14 standard PDF fonts exist in the installed package (found ${fonts.length})`);
  assert.ok(fonts.includes("Helvetica.cjs") && fonts.includes("HelveticaBold.cjs"), "the fonts the renderer falls back to");
});

test("the alias in pdfkit's package.json still points where the trace expects", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pdfkitDir, "package.json"), "utf8"));
  assert.equal(pkg.imports["#standard-fonts/*"], "./js/standard-fonts/*.cjs", "if pdfkit changes this alias, update the tracing include in next.config.mjs");
});

test("the bundled Noto fonts stay listed for the document routes (Arabic and Urdu depend on them)", () => {
  const inc = config.outputFileTracingIncludes;
  for (const key of ["/api/orgs/documents-automation/**/*", "/api/orgs/finance/invoices/**/*", "/api/cron/document-automation"]) assert.ok((inc[key] || []).some((g) => g.includes("documentAutomation/fonts")), key);
  const dir = path.join(APP, "src/lib/documentAutomation/fonts");
  assert.ok(fs.readdirSync(dir).some((f) => /Arabic/i.test(f)), "an Arabic-script font is bundled");
});
