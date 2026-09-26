// src/lib/bookkeeper/workflow.js
//
// AI Bookkeeper SOW sections 33, 59: the bridge to the EXISTING AI Business Operations Manager. No second scheduler: the workflow engine's
// schedule trigger calls these two functions through two node types:
//   data.bookkeeping           READ ONLY summary for the executing identity (dashboard cards, review queue, validated metrics);
//   action.bookkeeping_run     runs the INTERNAL bookkeeping pass (categorize, match, queue exceptions). It never changes an invoice,
//                              expense or payment; anything consequential is only ever proposed through Controlled Actions.
// Both act as the executing identity: department scope and finance permission are the identity's own, checked on every run.

import { canAccessFinance, canManageFinance } from "../orgs.js";
import { fail } from "./common.js";
import { departmentScope } from "./api.js";
import { overview, bookkeepingInsights } from "./insights.js";
import { listQueue } from "./review.js";
import { reconcile } from "./reconcile.js";

export async function readBookkeeperSummary({ orgId, membership, email, cfg = {} }) {
  if (!canAccessFinance(membership)) throw Object.assign(new Error("The executing identity has no finance access."), { retryable: false, code: "PERMISSION_DENIED" });
  const deptIds = await departmentScope({ orgId, membership });
  const [o, q, ins] = await Promise.all([overview({ orgId, departmentIds: deptIds }), listQueue({ orgId, departmentIds: deptIds, status: "OPEN", limit: Math.min(Number(cfg.limit) || 20, 50) }), bookkeepingInsights({ orgId, departmentIds: deptIds })]);
  return { cards: o.cards, status: o.status, reviewQueue: q.items.map((i) => ({ type: i.type, reason: i.reason, severity: i.severity, confidence: i.confidence, itemId: i.itemId })), reviewCount: q.total, highSeverityCount: q.items.filter((i) => i.severity === "high").length, insights: ins, lastReconciliation: o.lastReconciliation, source: "AI Bookkeeper", email };
}

export async function runBookkeeperForWorkflow({ orgId, membership, email, cfg = {} }) {
  if (!canManageFinance(membership)) throw Object.assign(new Error("Running the bookkeeping pass needs a Finance Manager or owner/admin identity."), { retryable: false, code: "PERMISSION_DENIED" });
  const deptIds = await departmentScope({ orgId, membership });
  const r = await reconcile({ orgId, scope: { departmentIds: deptIds, limit: Math.min(Number(cfg.limit) || 500, 1000) }, actor: `workflow:${email}`, useAi: cfg.useAi !== false });
  if (r.error) return fail(r.error);
  return { reconciliation: r, note: "Internal pass only: nothing authoritative was changed. Consequential steps wait for a person." };
}
