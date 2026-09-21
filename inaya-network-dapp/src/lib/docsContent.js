// src/lib/docsContent.js
//
// Official Documentation Platform SOW -- the content loader for
// content/docs/**/*.md. Reads real markdown files with YAML frontmatter
// (gray-matter), validates the required schema fields (Information
// Architecture doc, docs/architecture/information-architecture.md), and
// builds an in-memory index used by the homepage, sidebar, search, and
// individual page renderer.
//
// Server-only (uses node:fs) -- never imported from a client component.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const CONTENT_DIR = path.join(process.cwd(), "content", "docs");

const REQUIRED_FIELDS = ["slug", "title", "description", "product", "category", "contentType", "status"];
const VALID_STATUSES = ["live", "testnet", "beta", "planned", "deprecated"];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Extracts a table of contents from markdown h2/h3 headings -- a real,
 *  derived TOC, not hand-maintained separately from the content. */
function extractHeadings(markdown) {
  const headings = [];
  const lines = markdown.split("\n");
  for (const line of lines) {
    const m2 = line.match(/^##\s+(.+)$/);
    const m3 = line.match(/^###\s+(.+)$/);
    if (m2) {
      const text = m2[1].trim();
      headings.push({ level: 2, text, id: slugifyHeading(text) });
    } else if (m3) {
      const text = m3[1].trim();
      headings.push({ level: 3, text, id: slugifyHeading(text) });
    }
  }
  return headings;
}

function slugifyHeading(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

let cache = null;

/** Loads and validates every content/docs/**\/*.md file once per server
 *  process (Next.js dev/build already re-executes modules per request in
 *  dev, so this is a soft cache, not a stale-forever one). Throws loudly
 *  on a missing required field or a duplicate slug, per the SOW's own
 *  "frontmatter validation must fail" rule (Section 56) -- this is not a
 *  best-effort loader. */
export function loadAllDocs() {
  if (cache) return cache;
  if (!fs.existsSync(CONTENT_DIR)) {
    cache = [];
    return cache;
  }

  const files = walk(CONTENT_DIR);
  const docs = [];
  const seenSlugs = new Set();

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const { data, content } = matter(raw);

    for (const field of REQUIRED_FIELDS) {
      if (!data[field]) {
        throw new Error(`docsContent: ${file} is missing required frontmatter field "${field}".`);
      }
    }
    if (!VALID_STATUSES.includes(data.status)) {
      throw new Error(`docsContent: ${file} has invalid status "${data.status}". Must be one of: ${VALID_STATUSES.join(", ")}.`);
    }
    if (seenSlugs.has(data.slug)) {
      throw new Error(`docsContent: duplicate slug "${data.slug}" (${file}).`);
    }
    seenSlugs.add(data.slug);

    docs.push({
      ...data,
      audience: data.audience || [],
      tags: data.tags || [],
      relatedDocs: data.relatedDocs || [],
      content,
      headings: extractHeadings(content),
      filePath: path.relative(process.cwd(), file),
    });
  }

  cache = docs;
  return docs;
}

export function getDocBySlug(slug) {
  return loadAllDocs().find((d) => d.slug === slug) || null;
}

export function listDocsByProduct(product) {
  return loadAllDocs().filter((d) => d.product === product);
}

export function listAllProducts() {
  const products = new Map();
  for (const doc of loadAllDocs()) {
    if (!products.has(doc.product)) products.set(doc.product, []);
    products.get(doc.product).push(doc);
  }
  return products;
}

/** A small, real keyword index -- title/description/tags/heading text --
 *  for the client-side search page. Deliberately not the semantic RAG
 *  pipeline; see the Information Architecture doc for why the two are
 *  kept separate. Safe to serialize directly into a client component. */
export function buildSearchIndex() {
  return loadAllDocs().map((d) => ({
    slug: d.slug,
    title: d.title,
    description: d.description,
    product: d.product,
    contentType: d.contentType,
    status: d.status,
    tags: d.tags,
    headings: d.headings.map((h) => h.text),
  }));
}

export function resolveRelatedDocs(doc) {
  const all = loadAllDocs();
  return (doc.relatedDocs || [])
    .map((slug) => all.find((d) => d.slug === slug))
    .filter(Boolean)
    .map((d) => ({ slug: d.slug, title: d.title, description: d.description, contentType: d.contentType }));
}
