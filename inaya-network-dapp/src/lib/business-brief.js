// src/lib/business-brief.js
//
// Daily/Weekly/Monthly/Yearly Brief — a periodic recap built entirely on
// top of business-insights.js's computeBusinessInsights(), the SAME
// permission-scoped data every other Business Workspace surface already
// reads. No new collections, no new writes.
//
// Two layers, deliberately separated:
//   1. `highlights` — deterministic, always-available bullet strings built
//      straight from the real numbers computeBusinessInsights() returns.
//      This is the reliable core of the Brief; it never fails and never
//      depends on an external AI call.
//   2. `summary` — a best-effort, one-paragraph natural-language narrative
//      generated on top of those SAME real numbers (never invents a
//      figure not already in `highlights`). If GEMINI_API_KEY isn't
//      configured, or the call fails or times out, `summary` is simply
//      null — the Brief still returns with its real highlights, exactly
//      the same non-blocking, best-effort discipline
//      notifyApproversOfSubmission() (document-workflow.js) and
//      appendAuditEntry's caller (activity-log.js) already use elsewhere
//      in this codebase.

import { GoogleGenAI } from "@google/genai";
import { computeBusinessInsights } from "./business-insights.js";

export const BRIEF_PERIODS = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
const PERIOD_LABELS = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
const NARRATIVE_TIMEOUT_MS = 8000;

function pctLabel(n) {
  return `${n > 0 ? "+" : ""}${n}%`;
}

function money(n) {
  return `$${Math.round(n).toLocaleString()}`;
}

/** Deterministic, always-available — no LLM involved. */
function buildHighlights(insights, periodLabel) {
  const { comparison, kpis, pendingApprovals } = insights;
  const highlights = [
    `Revenue: ${money(comparison.revenue.current)} (${pctLabel(comparison.revenue.changePct)} vs. the previous ${periodLabel}).`,
    `Expenses: ${money(comparison.expenses.current)} (${pctLabel(comparison.expenses.changePct)} vs. the previous ${periodLabel}).`,
    `${comparison.tasksCompleted.current} task${comparison.tasksCompleted.current === 1 ? "" : "s"} completed (${pctLabel(comparison.tasksCompleted.changePct)} vs. the previous ${periodLabel}).`,
    `${comparison.dealsWon.current} deal${comparison.dealsWon.current === 1 ? "" : "s"} won (${pctLabel(comparison.dealsWon.changePct)} vs. the previous ${periodLabel}).`,
  ];

  const totalPending = pendingApprovals.documents + pendingApprovals.purchaseRequests + pendingApprovals.purchaseOrders + pendingApprovals.expenses;
  if (totalPending > 0) highlights.push(`${totalPending} item${totalPending === 1 ? "" : "s"} awaiting approval.`);
  if (kpis.overdueTasks.value > 0) highlights.push(`${kpis.overdueTasks.value} task${kpis.overdueTasks.value === 1 ? "" : "s"} overdue.`);
  if (kpis.overdueInvoices.value > 0) highlights.push(`${kpis.overdueInvoices.value} invoice${kpis.overdueInvoices.value === 1 ? "" : "s"} overdue.`);
  if (kpis.lowStockCount.value > 0) highlights.push(`${kpis.lowStockCount.value} product${kpis.lowStockCount.value === 1 ? "" : "s"} at or below reorder threshold.`);

  return highlights;
}

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

/** Best-effort narrative paragraph on top of the real highlights. Returns
 *  null (never throws) on any failure, timeout, or missing config. */
async function generateNarrative({ periodLabel, orgName, highlights, alerts }) {
  const ai = getGeminiClient();
  if (!ai) return null;

  const prompt = `Write a single short paragraph (2-3 sentences, plain prose, no bullet points, no markdown) summarizing this ${periodLabel} business brief for "${orgName}". Use ONLY the facts below — do not invent any number, name, or event not listed here.

Facts:
${highlights.map((h) => `- ${h}`).join("\n")}
${alerts.length ? `\nAlerts:\n${alerts.map((a) => `- ${a.message}`).join("\n")}` : ""}`;

  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 400, thinkingConfig: { thinkingLevel: "low" } },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("business-brief: narrative call timed out")), NARRATIVE_TIMEOUT_MS)),
    ]);
    return response.text?.trim() || null;
  } catch (err) {
    console.warn("business-brief: narrative generation failed (non-fatal):", err.message);
    return null;
  }
}

/** The Brief: real computeBusinessInsights() data for the period, the
 *  deterministic highlights above, and (best-effort) a short narrative on
 *  top. `includeNarrative:false` skips the Gemini call entirely — used by
 *  the get_business_brief AI tool, whose own OUTER model call already
 *  narrates this data conversationally, so a nested narrative call would
 *  be redundant latency and cost for no benefit. */
export async function generateBusinessBrief({ orgId, membership, email, period, orgName, includeNarrative = true }) {
  if (!BRIEF_PERIODS[period]) {
    return { error: `Unknown period "${period}". Valid periods: ${Object.keys(BRIEF_PERIODS).join(", ")}.` };
  }

  const periodLabel = PERIOD_LABELS[period];
  const insights = await computeBusinessInsights({ orgId, membership, email, periodDays: BRIEF_PERIODS[period] });
  const highlights = buildHighlights(insights, periodLabel);

  const summary = includeNarrative
    ? await generateNarrative({ periodLabel, orgName: orgName || "your company", highlights, alerts: insights.alerts })
    : null;

  return {
    period, periodDays: insights.periodDays, generatedAt: insights.generatedAt,
    summary, highlights, alerts: insights.alerts, kpis: insights.kpis, comparison: insights.comparison,
  };
}
