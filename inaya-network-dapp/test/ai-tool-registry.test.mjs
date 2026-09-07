// test/ai-tool-registry.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 6 (§91) — asserts
// the AI Tool Registry actually covers every tool declared in each
// domain's own *_TOOL_DECLARATIONS. This is the drift check: adding a new
// tool to ai-compliance-tools.js (or audit/regulatory/investment/private-
// capital) without a matching registry entry must fail this test, the
// same "can't silently drift" discipline as vertical-lock-wiring.test.mjs.
//
// Run with: node --env-file=.env.local --test test/ai-tool-registry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { findUnregisteredTools, AI_TOOL_REGISTRY } from "../src/lib/ai-tool-registry.js";
import { COMPLIANCE_TOOL_DECLARATIONS } from "../src/lib/ai-compliance-tools.js";
import { INVESTMENT_TOOL_DECLARATIONS } from "../src/lib/ai-investment-tools.js";
import { PRIVATE_CAPITAL_TOOL_DECLARATIONS } from "../src/lib/ai-private-capital-tools.js";
import { AUDIT_TOOL_DECLARATIONS } from "../src/lib/ai-audit-tools.js";
import { REGULATORY_TOOL_DECLARATIONS } from "../src/lib/ai-regulatory-tools.js";

const DOMAINS = [
  { domain: "compliance", declarations: COMPLIANCE_TOOL_DECLARATIONS },
  { domain: "investment", declarations: INVESTMENT_TOOL_DECLARATIONS },
  { domain: "private_capital", declarations: PRIVATE_CAPITAL_TOOL_DECLARATIONS },
  { domain: "audit", declarations: AUDIT_TOOL_DECLARATIONS },
  { domain: "regulatory", declarations: REGULATORY_TOOL_DECLARATIONS },
];

for (const { domain, declarations } of DOMAINS) {
  test(`AI Tool Registry: every ${domain} tool declaration has a matching registry entry`, () => {
    const declaredNames = declarations.map((d) => d.name);
    const missing = findUnregisteredTools(domain, declaredNames);
    assert.deepEqual(missing, [], `these ${domain} tools are declared but have no registry entry: ${missing.join(", ")}`);
  });
}

test("AI Tool Registry: every entry declares all 11 required §91 fields", () => {
  const requiredFields = ["name", "domain", "permissions", "risk", "readWrite", "requiredRole", "requiredScope", "approvalRequirement", "auditBehavior", "rateLimit", "idempotencyBehavior"];
  for (const entry of AI_TOOL_REGISTRY) {
    for (const field of requiredFields) {
      assert.notEqual(entry[field], undefined, `registry entry "${entry.name}" is missing required field "${field}"`);
    }
  }
});

test("AI Tool Registry: the only write tool (propose_policy_amendment) requires human approval, every read tool requires none", () => {
  const writeTools = AI_TOOL_REGISTRY.filter((t) => t.readWrite === "write");
  assert.equal(writeTools.length, 1, "expected exactly one write-capable tool in this registry pass");
  assert.equal(writeTools[0].name, "propose_policy_amendment");
  assert.match(writeTools[0].approvalRequirement, /human approval required/i);

  const readTools = AI_TOOL_REGISTRY.filter((t) => t.readWrite === "read");
  for (const tool of readTools) {
    assert.equal(tool.approvalRequirement, "none", `read-only tool "${tool.name}" should not require approval`);
  }
});
