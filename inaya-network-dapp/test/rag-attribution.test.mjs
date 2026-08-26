// test/rag-attribution.test.mjs
//
// formatAttribution() end-to-end: a chunk's title/section metadata,
// ingested and retrieved for real, must produce the exact "Source: X — Y"
// line shown to the user — never a fabricated or mismatched source.
//
// Run with: node --env-file=.env.local --test test/rag-attribution.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { formatAttribution } from "../src/lib/rag/retrieve.js";
import mongoClientPromise from "../src/lib/mongodb.js";

// This file's own tests are pure (no DB calls), but importing retrieve.js
// transitively imports mongodb.js, which opens a connection at module-load
// time — must be closed or node --test never exits.
after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

test("formatAttribution: renders 'Source: Title — Section' for each distinct chunk", () => {
  const chunks = [
    { title: "Inaya Whitepaper", section: "Section 02: The Problem With Centralized Storage" },
    { title: "Inaya Whitepaper", section: "Section 03: The Inaya Protocol" },
  ];
  const output = formatAttribution(chunks);
  assert.match(output, /Source: Inaya Whitepaper — Section 02: The Problem With Centralized Storage/);
  assert.match(output, /Source: Inaya Whitepaper — Section 03: The Inaya Protocol/);
});

test("formatAttribution: a chunk with no section falls back to just the title", () => {
  const output = formatAttribution([{ title: "Security Layer", section: null }]);
  assert.match(output, /Source: Security Layer$/m);
});

test("formatAttribution: deduplicates identical source labels rather than repeating them", () => {
  const chunks = [
    { title: "FAQ", section: "What is Inaya Network?" },
    { title: "FAQ", section: "What is Inaya Network?" },
  ];
  const output = formatAttribution(chunks);
  const occurrences = output.match(/Source: FAQ/g) || [];
  assert.equal(occurrences.length, 1);
});

test("formatAttribution: an empty chunk list produces an empty string — never a fabricated 'Source:' line", () => {
  assert.equal(formatAttribution([]), "");
  assert.equal(formatAttribution(null), "");
});

test("formatAttribution: never lists a source not actually present in the chunk list", () => {
  const chunks = [{ title: "Real Source", section: "Real Section" }];
  const output = formatAttribution(chunks);
  assert.doesNotMatch(output, /Fabricated/);
  assert.equal((output.match(/Source:/g) || []).length, 1);
});
