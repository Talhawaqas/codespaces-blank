// test/learn.test.mjs
//
// Covers Inaya Learn's validate*Input guards, cache-key normalization, and
// the ISO-8601 duration parser. Pure function tests, no HTTP layer and no
// live YouTube API calls (those need a real key and aren't deterministic
// to unit-test) — same convention as the other test files in this dir.
//
// Run with: node --test test/learn.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  validateSaveInput,
  validateProgressInput,
  validateReportInput,
  validateAnalyticsInput,
  buildSearchCacheKey,
  normalizeWallet,
  LEARN_STATUSES,
  LEARN_REPORT_REASONS,
} from "../src/lib/learn.js";
import { parseIsoDurationToSeconds } from "../src/lib/youtube.js";
import mongoClientPromise from "../src/lib/mongodb.js";

// learn.js imports mongodb.js, which opens a MongoClient connection as a
// module-load side effect regardless of whether any test here actually
// queries the DB — without closing it, node --test hangs after the last
// test instead of exiting (same fix already applied to the other suites).
after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

const WALLET = "0x1234567890AbCdEf1234567890aBcDeF12345678";
const WALLET_LOWER = WALLET.toLowerCase();

// ---------------------------------------------------------------
// validateSaveInput
// ---------------------------------------------------------------

test("validateSaveInput: accepts a well-formed save and normalizes the wallet", () => {
  const clean = validateSaveInput({
    walletAddress: WALLET,
    videoId: "dQw4w9WgXcQ",
    title: "Python for Beginners",
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    channelTitle: "Some Channel",
    categoryId: "programming",
  });
  assert.equal(clean.walletAddress, WALLET_LOWER);
  assert.equal(clean.videoId, "dQw4w9WgXcQ");
  assert.equal(clean.categoryId, "programming");
});

test("validateSaveInput: rejects an invalid wallet address", () => {
  assert.throws(() => validateSaveInput({ walletAddress: "not-a-wallet", videoId: "x", title: "y" }), /valid wallet address/i);
  assert.throws(() => validateSaveInput({ walletAddress: "", videoId: "x", title: "y" }), /valid wallet address/i);
});

test("validateSaveInput: rejects a missing videoId or title", () => {
  assert.throws(() => validateSaveInput({ walletAddress: WALLET, videoId: "", title: "y" }), /videoId is required/i);
  assert.throws(() => validateSaveInput({ walletAddress: WALLET, videoId: "x", title: "" }), /title is required/i);
});

test("validateSaveInput: optional fields default to null when omitted", () => {
  const clean = validateSaveInput({ walletAddress: WALLET, videoId: "x", title: "y" });
  assert.equal(clean.thumbnailUrl, null);
  assert.equal(clean.channelTitle, null);
  assert.equal(clean.categoryId, null);
});

// ---------------------------------------------------------------
// validateProgressInput
// ---------------------------------------------------------------

const baseProgress = {
  walletAddress: WALLET,
  videoId: "abc123",
  title: "Solidity Fundamentals",
  positionSeconds: 120,
  durationSeconds: 600,
  status: "watching",
};

test("validateProgressInput: accepts a well-formed watching record", () => {
  const clean = validateProgressInput(baseProgress);
  assert.equal(clean.status, "watching");
  assert.equal(clean.positionSeconds, 120);
});

test("validateProgressInput: accepts every declared status", () => {
  for (const status of LEARN_STATUSES) {
    assert.doesNotThrow(() => validateProgressInput({ ...baseProgress, status }));
  }
});

test("validateProgressInput: rejects an unknown status", () => {
  assert.throws(() => validateProgressInput({ ...baseProgress, status: "abandoned" }), /status must be one of/i);
});

test("validateProgressInput: rejects negative or non-numeric position/duration", () => {
  assert.throws(() => validateProgressInput({ ...baseProgress, positionSeconds: -1 }), /positionSeconds/i);
  assert.throws(() => validateProgressInput({ ...baseProgress, positionSeconds: "120" }), /positionSeconds/i);
  assert.throws(() => validateProgressInput({ ...baseProgress, durationSeconds: -1 }), /durationSeconds/i);
});

test("validateProgressInput: rejects an invalid wallet", () => {
  assert.throws(() => validateProgressInput({ ...baseProgress, walletAddress: "nope" }), /valid wallet address/i);
});

// ---------------------------------------------------------------
// validateReportInput
// ---------------------------------------------------------------

test("validateReportInput: accepts a minimal report with no wallet", () => {
  const clean = validateReportInput({ videoId: "x", reason: "not_educational" });
  assert.equal(clean.videoId, "x");
  assert.equal(clean.walletAddress, null);
  assert.equal(clean.detail, null);
});

test("validateReportInput: accepts every declared reason", () => {
  for (const reason of LEARN_REPORT_REASONS) {
    assert.doesNotThrow(() => validateReportInput({ videoId: "x", reason }));
  }
});

test("validateReportInput: rejects an unknown reason", () => {
  assert.throws(() => validateReportInput({ videoId: "x", reason: "spam" }), /reason must be one of/i);
});

test("validateReportInput: rejects an invalid wallet when one is provided", () => {
  assert.throws(() => validateReportInput({ videoId: "x", reason: "other", walletAddress: "nope" }), /valid address/i);
});

// ---------------------------------------------------------------
// validateAnalyticsInput
// ---------------------------------------------------------------

test("validateAnalyticsInput: accepts a known event with no PII fields", () => {
  const clean = validateAnalyticsInput({ event: "search_performed", categoryId: "ai" });
  assert.equal(clean.event, "search_performed");
  assert.equal(clean.categoryId, "ai");
  assert.equal(clean.videoId, null);
});

test("validateAnalyticsInput: rejects an unrecognized event name", () => {
  assert.throws(() => validateAnalyticsInput({ event: "user_logged_in" }), /event must be one of/i);
});

// ---------------------------------------------------------------
// buildSearchCacheKey / normalizeWallet
// ---------------------------------------------------------------

test("buildSearchCacheKey: normalizes whitespace and casing so equivalent queries collide", () => {
  const a = buildSearchCacheKey({ query: "Learn Python", categoryId: "programming", pageToken: null });
  const b = buildSearchCacheKey({ query: "  learn   python  ", categoryId: "Programming", pageToken: null });
  assert.equal(a, b);
});

test("buildSearchCacheKey: different pageTokens produce different keys", () => {
  const a = buildSearchCacheKey({ query: "python", categoryId: "programming", pageToken: null });
  const b = buildSearchCacheKey({ query: "python", categoryId: "programming", pageToken: "CAUQAA" });
  assert.notEqual(a, b);
});

test("normalizeWallet: lowercases and trims", () => {
  assert.equal(normalizeWallet("  " + WALLET + "  "), WALLET_LOWER);
  assert.equal(normalizeWallet(null), "");
});

// ---------------------------------------------------------------
// parseIsoDurationToSeconds
// ---------------------------------------------------------------

test("parseIsoDurationToSeconds: parses hours/minutes/seconds combinations", () => {
  assert.equal(parseIsoDurationToSeconds("PT15M33S"), 15 * 60 + 33);
  assert.equal(parseIsoDurationToSeconds("PT1H2M3S"), 3600 + 120 + 3);
  assert.equal(parseIsoDurationToSeconds("PT45S"), 45);
  assert.equal(parseIsoDurationToSeconds("PT10M"), 600);
});

test("parseIsoDurationToSeconds: returns 0 for missing or malformed input", () => {
  assert.equal(parseIsoDurationToSeconds(""), 0);
  assert.equal(parseIsoDurationToSeconds(null), 0);
  assert.equal(parseIsoDurationToSeconds("not-a-duration"), 0);
});
