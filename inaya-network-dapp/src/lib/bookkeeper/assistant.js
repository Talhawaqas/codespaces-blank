// src/lib/bookkeeper/assistant.js
//
// AI Bookkeeper SOW section 32: the finance question tool for the EXISTING AI Business Assistant. One read-only tool; it uses the caller's own
// membership (finance access + department scope) like every other assistant tool, returns no secrets, and never performs an action.
// "Why was this payment matched to this invoice?" is answered from the stored, deterministic explanation (signals and rule results), not
// from a fresh model guess.

import { canAccessFinance } from "../orgs.js";
import { departmentScope } from "./api.js";
import { overview, listTransactions, buildReport, bookkeepingInsights } from "./insights.js";
import { listQueue } from "./review.js";
import { scanPeriod } from "./period.js";
import { getBookkeeperCollections } from "./db.js";
import { toObjectId } from "../orgs.js";

export const ASSISTANT_TOPICS = ["overview", "unmatched", "review_queue", "explain_match", "category_spend", "missing_documents", "metrics"];

export async function bookkeeperAssistantTool(args, ctx) {
  if (!canAccessFinance(ctx.membership)) return { error: "You don't have finance access, so I can't show bookkeeping data." };
  const topic = ASSISTANT_TOPICS.includes(args?.topic) ? args.topic : "overview";
  const deptIds = await departmentScope({ orgId: ctx.orgId, membership: ctx.membership });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(args?.from || "") ? args.from : null; const to = /^\d{4}-\d{2}-\d{2}$/.test(args?.to || "") ? args.to : null;
  if (topic === "overview") { const o = await overview({ orgId: ctx.orgId, departmentIds: deptIds }); return { topic, cards: o.cards, status: o.status, lastReconciliation: o.lastReconciliation, note: o.note }; }
  if (topic === "metrics") return { topic, ...(await bookkeepingInsights({ orgId: ctx.orgId, departmentIds: deptIds, from, to })) };
  if (topic === "unmatched") { const r = await listTransactions({ orgId: ctx.orgId, departmentIds: deptIds, from, to, status: "UNMATCHED", limit: 20 }); const e = await listTransactions({ orgId: ctx.orgId, departmentIds: deptIds, from, to, status: "EXCEPTION", limit: 20 }); return { topic, total: r.total + e.total, transactions: [...r.transactions, ...e.transactions].slice(0, 20).map((t) => ({ date: t.date, description: t.description, amount: t.amount, currency: t.currency, direction: t.direction, status: t.status })) }; }
  if (topic === "review_queue") { const q = await listQueue({ orgId: ctx.orgId, departmentIds: deptIds, status: "OPEN", limit: 20 }); return { topic, total: q.total, items: q.items.map((i) => ({ type: i.type, reason: i.reason, severity: i.severity, confidence: i.confidence })) }; }
  if (topic === "category_spend") { const r = await buildReport({ orgId: ctx.orgId, type: "category_spend", departmentIds: deptIds, from, to, actorEmail: ctx.email }); return { topic, rows: r.rows.slice(0, 15), period: r.meta.period }; }
  if (topic === "missing_documents") { const period = /^\d{4}-\d{2}$/.test(args?.period || "") ? args.period : new Date().toISOString().slice(0, 7); const s = await scanPeriod({ orgId: ctx.orgId, period, departmentIds: deptIds }); return { topic, period, missingDocuments: s.checklist.find((k) => k.key === "missing_documents"), unmatched: s.checklist.find((k) => k.key === "unmatched_transactions")?.count }; }
  if (topic === "explain_match") {
    const { bkTransactions, bkMatches } = await getBookkeeperCollections();
    const q = { orgId: toObjectId(ctx.orgId), ...(deptIds ? { departmentId: { $in: deptIds } } : {}) };
    let t = null;
    if (/^[0-9a-f]{24}$/i.test(args?.transactionId || "")) t = await bkTransactions.findOne({ ...q, _id: toObjectId(args.transactionId) });
    else if (args?.search) t = await bkTransactions.find({ ...q, description: { $regex: String(args.search).replace(/[^\w \-]/g, "").slice(0, 40), $options: "i" }, status: { $ne: "UNMATCHED" } }).sort({ date: -1 }).limit(1).next();
    if (!t) return { topic, notFound: true };
    const ms = await bkMatches.find({ orgId: q.orgId, transactionId: t._id, status: { $in: ["SUGGESTED", "AUTO_MATCHED", "CONFIRMED", "RECONCILED"] } }).toArray();
    return { topic, transaction: { date: t.date, description: t.description, amount: t.amount, currency: t.currency, status: t.status, category: t.category, categoryMethod: t.categoryMethod, decision: t.decision, reasons: t.decisionReasons }, matches: ms.map((m) => ({ target: m.targetNumber || m.targetKind, party: m.targetParty, type: m.matchType, confidence: m.confidence, status: m.status, explanation: m.explanation, discrepancy: m.discrepancy })) };
  }
  return { error: "Unknown topic." };
}
