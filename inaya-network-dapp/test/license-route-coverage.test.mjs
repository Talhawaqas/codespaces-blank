// test/license-route-coverage.test.mjs -- License Manager SOW 9.3: every API route that reaches company data is covered
// by the company-license gate (or is listed, with a reason, as deliberately open). A new route that touches company data
// without the gate fails this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coverage, GATED_HELPERS, JUSTIFIED } from "../scripts/sqa/license-route-coverage.mjs";
import { isOpenWhenRestricted } from "../src/lib/licensing/gate.js";

test("no API route reaches company data without the license gate or a written justification", () => {
  const rows = coverage();
  assert.ok(rows.length > 900, `found ${rows.length} routes`);
  const review = rows.filter((r) => r.kind === "REVIEW").map((r) => r.route);
  assert.deepEqual(review, [], `routes needing a decision: ${review.join(", ")}`);
  for (const [route, reason] of Object.entries(JUSTIFIED)) assert.ok(reason.length > 10, `${route} has a reason`);
});

test("every shared helper that the coverage relies on really calls the gate", () => {
  for (const [fn, file] of Object.entries(GATED_HELPERS)) {
    const path = file.split(" ")[0];
    const src = readFileSync(path, "utf8");
    assert.ok(/companyMayOperate|licenseGate|requireSupportApiKey/.test(src), `${fn} (${path}) runs the license gate`);
  }
});

test("only Billing, license, export, document download and the session stay open when restricted", () => {
  const open = (p, m = "GET", mgr = true) => isOpenWhenRestricted(p, m, mgr);
  assert.ok(open("/api/orgs/billing")); assert.ok(open("/api/orgs/license")); assert.ok(open("/api/orgs/exports", "POST")); assert.ok(open("/api/orgs/export-zip"));
  assert.ok(open("/api/orgs/documents/abc/retrieve")); assert.ok(open("/api/orgs/session"));
  assert.ok(!open("/api/orgs/documents", "POST"), "no uploads"); assert.ok(!open("/api/orgs/documents/abc/retrieve", "DELETE"));
  assert.ok(!open("/api/orgs/crm/contacts")); assert.ok(!open("/api/orgs/ai/chat", "POST")); assert.ok(!open("/api/orgs/members", "POST"));
  assert.ok(!open("/api/orgs/billing", "GET", false), "members do not get Billing"); assert.ok(open("/api/orgs/license/status", "GET", false), "members get the neutral notice");
});
