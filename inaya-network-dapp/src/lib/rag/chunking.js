// src/lib/rag/chunking.js
//
// Pure, dependency-free chunking helpers. No pdf-parse/cheerio/langchain
// needed: every Docs source is already structured content (Markdown with
// real headings, or JS objects with an explicit sections/blocks shape),
// so chunking is splitting-by-structure, not NLP-driven text splitting.
//
// Every helper returns the same shape, the one thing ingest.js and
// vectorStore.js actually care about:
//   { sourceId, domain, title, section, category, version, url, text, contentHash }
// `text` is what gets embedded and shown as context; contentHash is what
// ingest.js diffs against to decide insert/update/skip/remove.

import { createHash } from "node:crypto";

export function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeChunk({ sourceId, domain, title, section, category, version, url, text }) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return { sourceId, domain, title, section: section || null, category: category || null, version: version || null, url: url || null, text: trimmed, contentHash: hashText(trimmed) };
}

/** Splits Markdown by `##` headings (the level every real doc in this repo
 *  uses for its main sections — business-workspace-guide.md, SDK_GUIDE.md).
 *  A `#` title line (if present) becomes the shared `title`; each `##`
 *  section becomes its own chunk, further split by chars if it's long. */
export function chunkMarkdownByHeading(markdown, { sourceId, domain, category, version, url, maxChars = 1200 }) {
  const lines = markdown.split("\n");
  let title = null;
  const sections = [];
  let current = null;

  for (const line of lines) {
    const h1 = /^#\s+(.+)/.exec(line);
    const h2 = /^##\s+(.+)/.exec(line);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }
    if (h2) {
      if (current) sections.push(current);
      current = { heading: h2[1].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else if (!h1) {
      // Content before the first ## heading — keep it under a synthetic "Overview" section.
      if (!current) current = { heading: "Overview", body: [] };
      current.body.push(line);
    }
  }
  if (current) sections.push(current);

  const docTitle = title || sourceId;
  const chunks = [];
  for (const section of sections) {
    const bodyText = section.body.join(" ").replace(/\s+/g, " ").trim();
    if (!bodyText) continue;
    for (const part of splitLongText(bodyText, maxChars)) {
      chunks.push(makeChunk({ sourceId, domain, title: docTitle, section: section.heading, category, version, url, text: `${section.heading}: ${part}` }));
    }
  }
  return chunks;
}

/** For flat text with no real heading structure (e.g. a single FAQ answer,
 *  a knowledge-article body) — groups into ~maxChars chunks on paragraph
 *  boundaries so a chunk never cuts a sentence in half where avoidable. */
export function chunkParagraphs(text, { sourceId, domain, title, section, category, version, url, maxChars = 1200 }) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  return splitLongText(clean, maxChars).map((part) =>
    makeChunk({ sourceId, domain, title, section, category, version, url, text: part })
  );
}

function splitLongText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(". ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars; // no good sentence boundary — hard cut
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Extracts plain text from one fundraising-docs `block` object. Handles
 *  every block `type` used in scripts/fundraising-docs/content/*.js
 *  (lead, paragraphs, table, columns); unknown types are skipped rather
 *  than guessed at — a block this doesn't understand yet simply isn't
 *  ingested, safer than mis-extracting garbage text into the index. */
function extractBlockText(block) {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "lead":
    case "note":
      return typeof block.text === "string" ? block.text : "";
    case "paragraphs":
      return Array.isArray(block.text) ? block.text.join(" ") : "";
    case "table": {
      if (!Array.isArray(block.rows)) return "";
      const headers = Array.isArray(block.headers) ? block.headers : [];
      return block.rows.map((row) => headers.map((h, i) => `${h}: ${row[i]}`).join(", ")).join(". ");
    }
    case "columns": {
      if (!Array.isArray(block.items)) return "";
      return block.items.map((item) => [item.title, item.text || (Array.isArray(item.points) ? item.points.join(" ") : "")].filter(Boolean).join(" — ")).join(". ");
    }
    default:
      return "";
  }
}

/** For the fundraising-docs `{sections:[{number,title,blocks}]}` shape —
 *  one chunk per section (further split if long), title carried from the
 *  doc's own docId/cover so attribution reads e.g. "Inaya Whitepaper —
 *  Section 02: The Problem With Centralized Storage". */
export function chunkStructuredSections(sections, { sourceId, domain, title, category, version, url, maxChars = 1200 }) {
  const chunks = [];
  for (const section of sections || []) {
    const sectionText = (section.blocks || []).map(extractBlockText).filter(Boolean).join(" ");
    if (!sectionText) continue;
    const sectionLabel = `Section ${section.number || ""}: ${section.title || ""}`.trim();
    for (const part of splitLongText(sectionText, maxChars)) {
      chunks.push(makeChunk({ sourceId, domain, title, section: sectionLabel, category, version, url, text: `${sectionLabel}. ${part}` }));
    }
  }
  return chunks;
}

/** For a flat array of `{q, a}`-shaped FAQ objects — one chunk per Q&A pair. */
export function chunkQaPairs(items, { sourceId, domain, title, category, version, url }) {
  return (items || [])
    .filter((item) => item && item.q && item.a)
    .map((item) => makeChunk({ sourceId, domain, title, section: item.q, category, version, url, text: `Q: ${item.q} A: ${item.a}` }));
}
