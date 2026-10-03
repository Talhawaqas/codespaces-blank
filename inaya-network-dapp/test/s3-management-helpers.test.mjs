import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, parseTagInput } from "../src/components/business/s3ManagementHelpers.js";

test("formatBytes picks a sensible unit and never throws on junk", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 ** 2), "5.0 MB");
  assert.equal(formatBytes(3 * 1024 ** 4), "3.0 TB");
  assert.equal(formatBytes(1024 ** 6), "1048576.0 TB", "units stop at TB");
  assert.equal(formatBytes(NaN), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(undefined), "0 B");
});

test("parseTagInput reads key=value pairs, trims, keeps '=' inside values, and skips empties", () => {
  assert.deepEqual(parseTagInput("project=apollo, tier=gold"), { project: "apollo", tier: "gold" });
  assert.deepEqual(parseTagInput("  a = b  ,c=d=e,, ,=nokey,flag"), { a: "b", c: "d=e", flag: "" });
  assert.deepEqual(parseTagInput(""), {});
  assert.deepEqual(parseTagInput(null), {});
});
