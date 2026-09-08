// src/lib/institutional-attention.js
//
// Institutional Trust Infrastructure SOW, Phase 3 — "show me everything I
// am authorized to access that requires attention today," aggregated
// across modules into one list. This file adds NO new permission logic of
// its own: every item comes from a source that was already independently
// permission-filtered before this function ever saw it —
// listAiActionRequests()+resolveCanApprove() (the exact gate a real
// approval would require) for AI-proposed actions, and the existing
// list_tasks/list_documents AI tools (already scoped to ctx.scope,
// resolved once per request from the caller's real membership) for
// business items. The aggregator's only job is merging results that were
// each already safe to return on their own — it never widens visibility.
//
// Deliberately scoped to sources this codebase already has a precise,
// verified shape for (see this SOW's plan notes): AI action requests,
// overdue tasks, and documents pending review. Extending this to more
// verticals later is additive — add another already-permission-scoped
// source's results to `items`, nothing here needs to change.

import { listAiActionRequests } from "./ai-action-requests.js";
import { resolveCanApprove } from "./ai-action-approval-gate.js";
import { runBusinessTool } from "./ai-business-tools.js";

export async function getAttentionItems({ orgId, membership, email, businessCtx }) {
  const items = [];

  const requests = await listAiActionRequests({ orgId, status: "PENDING_APPROVAL" });
  for (const request of requests) {
    if (!request.targetRecordId) continue; // nothing concrete to re-check permission against
    const { canApprove } = await resolveCanApprove({
      orgId,
      targetRecordType: request.targetRecordType,
      targetRecordId: request.targetRecordId,
      proposedAction: request.proposedAction,
      membership,
      email,
    });
    if (!canApprove) continue;
    items.push({
      sourceModule: "ai-action-requests",
      recordType: request.targetRecordType,
      recordId: request.targetRecordId.toString(),
      title: `AI proposed: ${request.proposedAction} on ${request.targetRecordType}`,
      detail: request.requestedContextSummary || null,
      since: request.requestedAt,
      riskLevel: request.riskLevel,
    });
  }

  if (businessCtx) {
    const overdue = await runBusinessTool("list_tasks", { overdueOnly: true, assigneeEmail: email, limit: 25 }, businessCtx);
    for (const task of overdue.tasks || []) {
      items.push({
        sourceModule: "business-tasks",
        recordType: "TASK",
        recordId: null, // list_tasks' own summary shape carries no raw id -- title+project is the reference today
        title: `Overdue task: ${task.title}`,
        detail: [task.projectName, task.dueDate ? `due ${task.dueDate}` : null].filter(Boolean).join(" — "),
        since: task.dueDate,
      });
    }

    const pendingDocs = await runBusinessTool("list_documents", { status: ["PENDING", "UNDER_REVIEW"], limit: 25 }, businessCtx);
    for (const doc of pendingDocs.documents || []) {
      items.push({
        sourceModule: "business-documents",
        recordType: "DOCUMENT",
        recordId: null,
        title: `Document pending: ${doc.filename}`,
        detail: `${doc.status} — ${doc.departmentName}`,
        since: doc.createdAt,
      });
    }
  }

  items.sort((a, b) => new Date(b.since || 0).getTime() - new Date(a.since || 0).getTime());
  return { items, count: items.length };
}
