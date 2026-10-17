// src/lib/insights-export.js
//
// Business Workspace gap closure, Batch 2 — CSV export of the business
// insights payload (computeBusinessInsights). Pure: one row per KPI, plus
// the period-over-period comparison rows, so a spreadsheet gets exactly
// the numbers the dashboard shows.

const COMPARISON_LABELS = { revenue: "Revenue in period", expenses: "Expenses in period", dealsWon: "Deals won in period", tasksCompleted: "Tasks completed in period" };

export function insightsToRows(insights) {
  const rows = Object.entries(insights.kpis || {}).map(([key, k]) => ({ section: "KPI", metric: k.label || key, value: k.value, previous: "", changePct: "" }));
  for (const [key, c] of Object.entries(insights.comparison || {})) {
    rows.push({ section: "Comparison", metric: COMPARISON_LABELS[key] || key, value: c.current, previous: c.previous, changePct: c.changePct ?? "" });
  }
  return rows;
}

export function insightsToCsv(insights) {
  const columns = ["section", "metric", "value", "previous", "changePct"];
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const meta = `# periodDays=${insights.periodDays ?? ""},generatedAt=${insights.generatedAt ?? ""}`;
  return [meta, columns.join(","), ...insightsToRows(insights).map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n");
}
