import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerMatches, isAuthorizedCron } from "../src/lib/cronAuth.js";

test("accepts the exact bearer header", () => {
  assert.equal(bearerMatches("Bearer s3cret", "s3cret"), true);
});

test("rejects wrong, short, long and missing headers", () => {
  assert.equal(bearerMatches("Bearer s3creT", "s3cret"), false);
  assert.equal(bearerMatches("Bearer s3", "s3cret"), false);
  assert.equal(bearerMatches("Bearer s3cret-and-more", "s3cret"), false);
  assert.equal(bearerMatches(null, "s3cret"), false);
  assert.equal(bearerMatches(undefined, "s3cret"), false);
});

test("rejects everything when no secret is configured", () => {
  assert.equal(bearerMatches("Bearer ", ""), false);
  assert.equal(bearerMatches("Bearer undefined", undefined), false);
});

test("isAuthorizedCron reads CRON_SECRET from the environment", () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "abc123";
  assert.equal(isAuthorizedCron("Bearer abc123"), true);
  assert.equal(isAuthorizedCron("Bearer abc124"), false);
  delete process.env.CRON_SECRET;
  assert.equal(isAuthorizedCron("Bearer abc123"), false);
  if (prev !== undefined) process.env.CRON_SECRET = prev;
});
