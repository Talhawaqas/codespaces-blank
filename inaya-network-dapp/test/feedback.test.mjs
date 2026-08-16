// test/feedback.test.mjs
//
// Covers validateFeedbackInput's fraud/malformed-input guards. Modeled on
// the other test files in this directory: pure function tests, no HTTP
// layer (Next's route export map isn't resolvable by plain `node --test`).
//
// Run with: node --test test/feedback.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { validateFeedbackInput, cleanContextFields, FEEDBACK_CATEGORIES } from "../src/lib/feedback.js";
import mongoClientPromise from "../src/lib/mongodb.js";

// feedback.js imports mongodb.js, which opens a MongoClient connection as a
// module-load side effect regardless of whether any test here actually
// queries the DB — without closing it, node --test hangs after the last
// test instead of exiting (same fix already applied to the other suites).
after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

const base = {
  type: "bug",
  title: "Upload button does nothing",
  description: "Tapping upload on Android does nothing after picking a file.",
  category: "File Upload",
  severity: "High",
  reproductionSteps: "1. Open Upload\n2. Pick a file\n3. Nothing happens",
};

test("validateFeedbackInput: accepts a well-formed bug report", () => {
  const clean = validateFeedbackInput(base);
  assert.equal(clean.type, "bug");
  assert.equal(clean.severity, "High");
  assert.equal(clean.reproductionSteps, base.reproductionSteps);
});

test("validateFeedbackInput: accepts a well-formed idea with no severity/steps", () => {
  const clean = validateFeedbackInput({ type: "idea", title: "Dark/light toggle", description: "Would like a theme switch.", category: "Other" });
  assert.equal(clean.type, "idea");
  assert.equal(clean.severity, null);
  assert.equal(clean.reproductionSteps, null);
});

test("validateFeedbackInput: rejects an unknown type", () => {
  assert.throws(() => validateFeedbackInput({ ...base, type: "complaint" }), /type must be/i);
});

test("validateFeedbackInput: rejects a missing/empty title", () => {
  assert.throws(() => validateFeedbackInput({ ...base, title: "" }), /Title is required/i);
  assert.throws(() => validateFeedbackInput({ ...base, title: undefined }), /Title is required/i);
});

test("validateFeedbackInput: rejects a title over the length cap", () => {
  assert.throws(() => validateFeedbackInput({ ...base, title: "x".repeat(201) }), /Title is required/i);
});

test("validateFeedbackInput: rejects an unknown category", () => {
  assert.throws(() => validateFeedbackInput({ ...base, category: "Nonsense" }), /Category must be one of/i);
});

test("validateFeedbackInput: every declared category is actually accepted", () => {
  for (const category of FEEDBACK_CATEGORIES) {
    assert.doesNotThrow(() => validateFeedbackInput({ ...base, category }));
  }
});

test("validateFeedbackInput: bug reports require a valid severity", () => {
  assert.throws(() => validateFeedbackInput({ ...base, severity: undefined }), /Severity must be one of/i);
  assert.throws(() => validateFeedbackInput({ ...base, severity: "Extreme" }), /Severity must be one of/i);
});

test("validateFeedbackInput: ideas must not carry severity or reproduction steps", () => {
  assert.throws(
    () => validateFeedbackInput({ type: "idea", title: "x", description: "y", category: "Other", severity: "High" }),
    /only apply to bug reports/i
  );
  assert.throws(
    () => validateFeedbackInput({ type: "idea", title: "x", description: "y", category: "Other", reproductionSteps: "1. do a thing" }),
    /only apply to bug reports/i
  );
});

test("validateFeedbackInput: rejects reproduction steps over the length cap", () => {
  assert.throws(() => validateFeedbackInput({ ...base, reproductionSteps: "x".repeat(3001) }), /Steps to reproduce/i);
});

test("cleanContextFields: trims valid fields and drops malformed/oversized ones to null", () => {
  const result = cleanContextFields({
    attachmentUrl: "  https://gateway.pinata.cloud/ipfs/abc  ",
    route: "Network Home",
    walletAddress: "0x1234",
    device: "Android",
    browser: "Chrome",
    network: "x".repeat(600), // over the cap
  });
  assert.equal(result.attachmentUrl, "https://gateway.pinata.cloud/ipfs/abc");
  assert.equal(result.route, "Network Home");
  assert.equal(result.walletAddress, "0x1234");
  assert.equal(result.network, null);
});
