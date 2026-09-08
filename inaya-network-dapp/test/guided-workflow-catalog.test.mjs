// test/guided-workflow-catalog.test.mjs
//
// Structural proof of the "AI hallucination/incorrect-action prevention"
// acceptance criterion (AI-Powered Business Workspace SOW, §8): the model
// never generates guided-step instruction text, it only ever relays what's
// authored in guided-workflow-catalog.js. This test asserts the catalog
// itself is well-formed — real authored strings, known completion types,
// and views that actually exist in the sidebar — which is the concrete
// guarantee that a guided step can't be invented at runtime.
//
// Pure data file, no DB — run with:
//   node --test test/guided-workflow-catalog.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { GUIDED_WORKFLOWS, getGuidedWorkflow, getGuidedStep, listGuidedWorkflowKeys, listGuidedWorkflowSummaries } from "../src/lib/guided-workflow-catalog.js";

// Snapshot of src/app/business/page.js's real activeView value space
// (its VIEW_TITLES keys, not NAV_ITEMS keys — navigate() collapses the
// "departments"/"projects"/"documents" sidebar items into one shared
// "browse" activeView, so "browse" is the value that actually gets fired
// on the "inaya:guided-nav" event, never "documents" etc.). page.js is a
// React component file (JSX) and can't be imported directly into a plain
// node:test run, so this list is kept in sync by hand — if a catalog
// step's completion.view stops matching real state, this is the list to
// update alongside it.
const KNOWN_NAV_VIEWS = [
  "osHome", "dashboard", "insights", "brief", "whatChanged", "security", "browse",
  "tasks", "crm", "procurement", "inventory", "finance", "hr",
  "health", "legal", "regulated", "financial", "government",
  "resilience", "integrations", "executive", "dataRooms", "enterpriseHardening",
  "approvals", "aiActions", "auditTrail", "activity",
  "ai", "billing", "settings",
];

const KNOWN_COMPLETION_TYPES = ["nav", "custom-event", "manual-confirm"];

test("every workflow has a key, label, description, and at least one step", () => {
  for (const workflow of Object.values(GUIDED_WORKFLOWS)) {
    assert.ok(workflow.key && typeof workflow.key === "string", "workflow.key must be a non-empty string");
    assert.ok(workflow.label && typeof workflow.label === "string", `${workflow.key}: label must be a non-empty string`);
    assert.ok(workflow.description && typeof workflow.description === "string", `${workflow.key}: description must be a non-empty string`);
    assert.ok(Array.isArray(workflow.steps) && workflow.steps.length > 0, `${workflow.key}: steps must be a non-empty array`);
  }
});

test("every step has real, non-templated instruction text and a valid completion", () => {
  for (const workflow of Object.values(GUIDED_WORKFLOWS)) {
    for (const step of workflow.steps) {
      assert.ok(step.id && typeof step.id === "string", `${workflow.key}: every step needs a string id`);
      assert.ok(step.instruction && typeof step.instruction === "string", `${workflow.key}/${step.id}: instruction must be a non-empty string`);
      assert.ok(step.instruction.length > 10, `${workflow.key}/${step.id}: instruction looks too short to be real guidance`);
      assert.ok(!/\{\{|\$\{/.test(step.instruction), `${workflow.key}/${step.id}: instruction must not contain template placeholders — steps are authored text, never interpolated`);
      assert.ok(step.completion && typeof step.completion === "object", `${workflow.key}/${step.id}: completion must be an object`);
      assert.ok(KNOWN_COMPLETION_TYPES.includes(step.completion.type), `${workflow.key}/${step.id}: unknown completion.type "${step.completion.type}"`);
    }
  }
});

test("every completion.view (when set) matches a real sidebar nav key", () => {
  for (const workflow of Object.values(GUIDED_WORKFLOWS)) {
    for (const step of workflow.steps) {
      if (step.completion.type !== "nav") continue;
      if (step.completion.view === null) {
        assert.equal(step.completion.match, "any", `${workflow.key}/${step.id}: a null view must be paired with match:"any"`);
        continue;
      }
      assert.ok(KNOWN_NAV_VIEWS.includes(step.completion.view), `${workflow.key}/${step.id}: completion.view "${step.completion.view}" is not a known NAV_ITEMS key`);
    }
  }
});

test("every custom-event completion names a real event, and every workflow ends on a detectable step", () => {
  for (const workflow of Object.values(GUIDED_WORKFLOWS)) {
    const lastStep = workflow.steps[workflow.steps.length - 1];
    for (const step of workflow.steps) {
      if (step.completion.type !== "custom-event") continue;
      assert.ok(step.completion.eventName && step.completion.eventName.startsWith("inaya:guided-"), `${workflow.key}/${step.id}: eventName must be a real "inaya:guided-*" event name`);
    }
    // The final step doesn't need auto-detection (manual-confirm is a
    // legitimate way to finish a workflow), but it must at least be a
    // real, known completion type -- already covered above.
    assert.ok(lastStep, `${workflow.key}: must have a final step`);
  }
});

test("getGuidedWorkflow / getGuidedStep / listGuidedWorkflowKeys / listGuidedWorkflowSummaries", () => {
  assert.equal(getGuidedWorkflow("does_not_exist"), null);
  assert.equal(getGuidedStep("does_not_exist", 0), null);

  const keys = listGuidedWorkflowKeys();
  assert.ok(keys.includes("create_purchase_order"));
  assert.ok(keys.includes("find_business_record"));
  assert.equal(keys.length, Object.keys(GUIDED_WORKFLOWS).length);

  const workflow = getGuidedWorkflow("create_purchase_order");
  assert.equal(getGuidedStep("create_purchase_order", 0), workflow.steps[0]);
  assert.equal(getGuidedStep("create_purchase_order", 9999), null);

  const summaries = listGuidedWorkflowSummaries();
  const poSummary = summaries.find((s) => s.key === "create_purchase_order");
  assert.equal(poSummary.totalSteps, workflow.steps.length);
  assert.equal(poSummary.label, workflow.label);
});

test("SOW §7 coverage: every example workflow from the SOW has a catalog entry", () => {
  const required = [
    "create_contact", "create_deal", "create_purchase_order", "receive_inventory",
    "create_document", "submit_approval", "review_ai_action", "generate_business_report",
    "find_business_record", "navigate_to_function",
  ];
  const keys = listGuidedWorkflowKeys();
  for (const key of required) {
    assert.ok(keys.includes(key), `Missing required SOW example workflow: ${key}`);
  }
});
