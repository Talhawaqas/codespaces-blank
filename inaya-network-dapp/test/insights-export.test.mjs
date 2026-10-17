// test/insights-export.test.mjs
//
// Business Workspace gap closure, Batch 2 — insights CSV export and the
// weekly KPI digest Automations template. Pure: no database.
//
// Run with: node --test test/insights-export.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { insightsToCsv, insightsToRows } from "../src/lib/insights-export.js";
import { buildTemplateDefinition, listTemplates } from "../src/lib/workflows/templates.js";
import { validateWorkflowDefinition } from "../src/lib/workflows/nodes.js";
import { validateSchedule } from "../src/lib/workflows/schedule.js";

const SAMPLE = {
  periodDays: 30, generatedAt: "2026-10-17T00:00:00.000Z",
  kpis: { revenue: { value: 1250.5, label: "Total Revenue (Paid Invoices)" }, overdueTasks: { value: 3, label: "Overdue Tasks" }, odd: { value: 1, label: 'Has "quotes", commas' } },
  comparison: { revenue: { current: 500, previous: 400, changePct: 25 }, dealsWon: { current: 0, previous: 0, changePct: null } },
};

test("insights CSV: one row per KPI plus comparison rows, safely quoted", () => {
  const rows = insightsToRows(SAMPLE);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { section: "KPI", metric: "Total Revenue (Paid Invoices)", value: 1250.5, previous: "", changePct: "" });
  assert.deepEqual(rows[3], { section: "Comparison", metric: "Revenue in period", value: 500, previous: 400, changePct: 25 });
  const csv = insightsToCsv(SAMPLE).split("\n");
  assert.equal(csv[0], "# periodDays=30,generatedAt=2026-10-17T00:00:00.000Z");
  assert.equal(csv[1], "section,metric,value,previous,changePct");
  assert.ok(csv.includes('KPI,"Has ""quotes"", commas",1,,'));
  assert.ok(csv.includes("Comparison,Deals won in period,0,0,"));
});

test("weekly KPI digest template: valid definition built only from existing nodes", () => {
  const def = buildTemplateDefinition("weekly-kpi-digest");
  const v = validateWorkflowDefinition(def);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(validateSchedule(def.nodes[0].config.schedule), []);
  assert.deepEqual(def.nodes.map((x) => x.type), ["trigger.schedule", "kpi.snapshot", "action.report", "notify.email", "notify.inaya"]);
  assert.ok(listTemplates().some((t) => t.id === "weekly-kpi-digest"));
});
