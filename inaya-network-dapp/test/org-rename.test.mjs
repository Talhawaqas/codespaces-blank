// test/org-rename.test.mjs -- company rename validation (Settings > Company name).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOrgName, ORG_NAME_MAX } from "../src/lib/industry-config.js";

test("accepts a normal name and tidies whitespace", () => {
  assert.deepEqual(validateOrgName("  SNT   Solutions  (Pvt) Ltd "), { name: "SNT Solutions (Pvt) Ltd" });
});

test("rejects empty, too short and too long names", () => {
  assert.ok(validateOrgName("").error);
  assert.ok(validateOrgName("   ").error);
  assert.ok(validateOrgName(null).error);
  assert.ok(validateOrgName("A").error);
  assert.ok(validateOrgName("x".repeat(ORG_NAME_MAX + 1)).error);
  assert.deepEqual(validateOrgName("x".repeat(ORG_NAME_MAX)), { name: "x".repeat(ORG_NAME_MAX) });
});

test("rejects markup and control characters", () => {
  assert.ok(validateOrgName("<script>Acme").error);
  assert.ok(validateOrgName("Acme\u0007Ltd").error);
});
