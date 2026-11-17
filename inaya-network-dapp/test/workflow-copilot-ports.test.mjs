// test/workflow-copilot-ports.test.mjs — the copilot's port normaliser (src/lib/workflows/copilot.js, SQA 17 Nov 2026).
// A live Gemini draft named single-output connections "default" and failed validation; an unknown output on a
// single-output step can only mean that output. A condition's true/false outputs are never guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEdgePorts } from "../src/lib/workflows/copilot.js";
import { NODE_TYPES } from "../src/lib/workflows/nodes.js";

const single = (type) => NODE_TYPES[type].ports.length === 1 && NODE_TYPES[type].ports[0];

test("an unknown output on a single-output step becomes that step's only output", () => {
  const def = {
    nodes: [{ key: "triggerSchedule", type: "trigger.schedule" }, { key: "overdueInvoices", type: "data.overdue_invoices" }, { key: "tell", type: "notify.inaya" }],
    edges: [{ from: "triggerSchedule", to: "overdueInvoices", fromPort: "default" }, { from: "overdueInvoices", to: "tell", fromPort: "output" }],
  };
  normalizeEdgePorts(def);
  assert.equal(def.edges[0].fromPort, single("trigger.schedule"));
  assert.equal(def.edges[1].fromPort, single("data.overdue_invoices"));
});

test("a valid output is left exactly as it was", () => {
  const port = single("trigger.manual");
  const def = { nodes: [{ key: "a", type: "trigger.manual" }, { key: "b", type: "notify.inaya" }], edges: [{ from: "a", to: "b", fromPort: port }] };
  normalizeEdgePorts(def);
  assert.equal(def.edges[0].fromPort, port);
});

test("a condition's outputs are never guessed: an unknown one stays wrong so validation reports it", () => {
  const def = { nodes: [{ key: "c", type: "condition.if" }, { key: "b", type: "notify.inaya" }], edges: [{ from: "c", to: "b", fromPort: "default" }] };
  normalizeEdgePorts(def);
  assert.equal(def.edges[0].fromPort, "default");
});

test("edges from unknown steps and empty definitions are ignored safely", () => {
  assert.doesNotThrow(() => normalizeEdgePorts({ nodes: [], edges: [{ from: "ghost", to: "x", fromPort: "default" }] }));
  assert.doesNotThrow(() => normalizeEdgePorts(null));
  assert.doesNotThrow(() => normalizeEdgePorts({}));
});
