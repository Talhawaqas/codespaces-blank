// test/docs-content.test.mjs
// Official Documentation Platform SOW.
// Run with: node --test test/docs-content.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { loadAllDocs, getDocBySlug, listAllProducts, buildSearchIndex, resolveRelatedDocs } from "../src/lib/docsContent.js";
import { API_ENDPOINTS } from "../src/lib/docsApiReference.js";
import { SDK_PACKAGES } from "../src/lib/docsSdkReference.js";
import { CLI_TOOLS } from "../src/lib/docsCliReference.js";

test("loadAllDocs finds every content/docs/**/*.md file and every one has a unique slug", () => {
  const docs = loadAllDocs();
  assert.ok(docs.length > 0, "expected at least one real content/docs page");
  const slugs = docs.map((d) => d.slug);
  assert.equal(new Set(slugs).size, slugs.length, "slugs must be unique");
});

test("every content/docs page has every required frontmatter field and a valid status", () => {
  const REQUIRED = ["slug", "title", "description", "product", "category", "contentType", "status"];
  const VALID_STATUSES = ["live", "testnet", "beta", "planned", "deprecated"];
  for (const doc of loadAllDocs()) {
    for (const field of REQUIRED) {
      assert.ok(doc[field], `${doc.filePath} is missing required field "${field}"`);
    }
    assert.ok(VALID_STATUSES.includes(doc.status), `${doc.filePath} has invalid status "${doc.status}"`);
  }
});

test("getDocBySlug resolves a real page and returns null for an unknown slug", () => {
  const doc = getDocBySlug("storage-control-plane");
  assert.ok(doc);
  assert.equal(doc.title, "Storage Control Plane & Terraform Provider");
  assert.equal(getDocBySlug("does-not-exist"), null);
});

test("every relatedDocs entry resolves to a real, existing slug -- no broken internal cross-references", () => {
  for (const doc of loadAllDocs()) {
    const resolved = resolveRelatedDocs(doc);
    assert.equal(resolved.length, (doc.relatedDocs || []).length, `${doc.filePath} has a relatedDocs entry that doesn't resolve to a real page`);
  }
});

test("headings are extracted from real ## / ### markdown, not hand-maintained separately", () => {
  const doc = getDocBySlug("s3-compatible-storage");
  assert.ok(doc.headings.length > 0);
  assert.ok(doc.headings.some((h) => h.text === "Overview"));
});

test("buildSearchIndex covers every loaded doc with no fs/server-only leakage into the shape", () => {
  const index = buildSearchIndex();
  assert.equal(index.length, loadAllDocs().length);
  for (const entry of index) {
    assert.ok(entry.slug && entry.title && entry.description);
    assert.equal(typeof entry.content, "undefined", "the search index must not carry full page content client-side");
  }
});

test("listAllProducts groups every doc under its real product field", () => {
  const products = listAllProducts();
  assert.ok(products.has("Storage"));
  assert.ok(products.get("Storage").length >= 3);
});

test("API/SDK/CLI reference data has no duplicate slugs within each reference type", () => {
  for (const [name, list] of [["API_ENDPOINTS", API_ENDPOINTS], ["SDK_PACKAGES", SDK_PACKAGES], ["CLI_TOOLS", CLI_TOOLS]]) {
    const slugs = list.map((x) => x.slug);
    assert.equal(new Set(slugs).size, slugs.length, `${name} has a duplicate slug`);
  }
});

test("every content/docs markdown file parses with gray-matter without throwing (a real frontmatter smoke test independent of the loader)", () => {
  const dir = path.join(process.cwd(), "content", "docs");
  function walk(d) {
    let out = [];
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) out = out.concat(walk(full));
      else if (entry.name.endsWith(".md")) out.push(full);
    }
    return out;
  }
  const files = walk(dir);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.doesNotThrow(() => matter(fs.readFileSync(file, "utf8")), `${file} has malformed YAML frontmatter`);
  }
});
