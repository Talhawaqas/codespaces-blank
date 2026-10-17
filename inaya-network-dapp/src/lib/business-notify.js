// src/lib/business-notify.js
//
// Business Workspace gap closure, Batch 1 — notifications for Business
// Operations (tasks, procurement approvals, leave approvals, reorders).
// Everything is sent through the existing notification router
// (notify/router.js), so each person's own per-event channel preferences
// apply, protected details (task titles, amounts) stay out of email, and
// the in-app feed is deduped.
//
// A notification failure must never fail the business action that caused
// it: every exported sender swallows and logs its own errors.
//
// Approvers are computed with the exact same predicates the workflows use
// to allow approval (canManageOrg for purchase requests/orders;
// canManageHR + department access for leave), so nobody is asked to
// approve something they can't actually approve.

import { notifyEvent } from "./notify/router.js";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageOrg, canManageHR, canAccessDepartment } from "./orgGates.js";

const norm = (e) => String(e || "").trim().toLowerCase();
const TASKS_LINK = "/business?view=tasks";
const PROCUREMENT_LINK = "/business?view=procurement";
const HR_LINK = "/business?view=hr";

async function safely(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`business-notify(${label}) failed (non-fatal):`, err.message);
    return null;
  }
}

async function activeMembers(orgId) {
  const { orgMembers } = await getOrgCollections();
  return orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).toArray();
}

/** Who may approve: "procurement" -> owner/admin; "leave" -> HR managers and
 *  owner/admin with access to the employee's department. */
export async function listApprovers({ orgId, kind, departmentId = null, excludeEmail = null }) {
  const members = await activeMembers(orgId);
  const allowed = members.filter((m) => {
    if (kind === "procurement") return canManageOrg(m);
    if (kind === "leave") return canManageHR(m) && (!departmentId || canAccessDepartment(m, departmentId));
    return false;
  });
  const exclude = norm(excludeEmail);
  return [...new Set(allowed.map((m) => norm(m.email)).filter((e) => e && e !== exclude))];
}

export async function notifyTaskAssigned({ orgId, task, actorEmail, assignedAt, sender }) {
  const assignee = norm(task.assigneeEmail);
  if (!assignee || assignee === norm(actorEmail)) return null;
  return safely("task.assigned", () => notifyEvent({
    orgId, event: "task.assigned", targetEmail: assignee,
    title: `Task assigned to you: ${task.title}`,
    body: `${actorEmail || "Someone"} assigned this task to you${task.dueDate ? `, due ${String(task.dueDate).slice(0, 10)}` : ""}.`,
    link: TASKS_LINK, sourceId: String(task._id),
    dedupeKey: `${orgId}:task.assigned:${task._id}:${assignee}:${assignedAt || task.updatedAt || task.createdAt}`,
    ...(sender ? { sender } : {}),
  }));
}

/** recordType: "PURCHASE_REQUEST" | "PURCHASE_ORDER" | "LEAVE_REQUEST". */
export async function notifyApprovalNeeded({ orgId, recordType, recordId, label, departmentId, requesterEmail, sender }) {
  const kind = recordType === "LEAVE_REQUEST" ? "leave" : "procurement";
  return safely(`${kind}.approval`, async () => {
    const approvers = await listApprovers({ orgId, kind, departmentId, excludeEmail: requesterEmail });
    for (const email of approvers) {
      await notifyEvent({
        orgId, event: `${kind}.approval`, targetEmail: email,
        title: `Approval needed: ${label}`,
        body: `Submitted by ${requesterEmail || "a team member"}. Review it and approve or reject.`,
        link: kind === "leave" ? HR_LINK : PROCUREMENT_LINK, sourceId: String(recordId),
        dedupeKey: `${orgId}:${kind}.approval:${recordType}:${recordId}`,
        ...(sender ? { sender } : {}),
      });
    }
    return approvers;
  });
}

export async function notifyDecision({ orgId, recordType, recordId, label, targetEmail, decision, actorEmail, sender }) {
  const target = norm(targetEmail);
  if (!target || target === norm(actorEmail)) return null;
  const kind = recordType === "LEAVE_REQUEST" ? "leave" : "procurement";
  return safely(`${kind}.decided`, () => notifyEvent({
    orgId, event: `${kind}.decided`, targetEmail: target,
    title: `${label} was ${String(decision).toLowerCase()}`,
    body: `Decided by ${actorEmail || "an approver"}.`,
    link: kind === "leave" ? HR_LINK : PROCUREMENT_LINK, sourceId: String(recordId),
    dedupeKey: `${orgId}:${kind}.decided:${recordType}:${recordId}:${decision}`,
    ...(sender ? { sender } : {}),
  }));
}

export async function notifyReorderDrafted({ orgId, product, requestId, departmentId, sender }) {
  return safely("inventory.reorder_drafted", async () => {
    const members = await activeMembers(orgId);
    const targets = members.filter((m) => canAccessDepartment(m, departmentId)).map((m) => norm(m.email));
    for (const email of [...new Set(targets)]) {
      await notifyEvent({
        orgId, event: "inventory.reorder_drafted", targetEmail: email,
        title: `Reorder drafted: ${product.sku} — ${product.name}`,
        body: "Stock fell to its reorder threshold. Review and submit the draft purchase request.",
        link: PROCUREMENT_LINK, sourceId: String(requestId),
        dedupeKey: `${orgId}:inventory.reorder_drafted:${requestId}`,
        ...(sender ? { sender } : {}),
      });
    }
    return targets.length;
  });
}

const dayString = (ms) => new Date(ms).toISOString().slice(0, 10);
const OVERDUE_LOOKBACK_DAYS = 7;

/** Daily job: one "due tomorrow" and one "overdue" notice per task per due
 *  date. Overdue notices only cover the last OVERDUE_LOOKBACK_DAYS so the
 *  first run after deploy doesn't flood people about long-stale tasks.
 *  Already-sent notices are skipped before calling the router, so a
 *  person who turned email on for reminders gets one email, not one a day. */
export async function runTaskReminders({ now = Date.now(), limit = 2000, sender, orgIds } = {}) {
  const { tasks, db } = await getOrgCollections();
  // The router records every send here, keyed by dedupeKey, whichever
  // channels the recipient has enabled (30-day TTL, longer than any window
  // below).
  const deliveries = db.collection("notification_deliveries");
  const today = dayString(now);
  const tomorrow = dayString(now + 86400000);
  const dayAfter = dayString(now + 2 * 86400000);
  const lookback = dayString(now - OVERDUE_LOOKBACK_DAYS * 86400000);

  const candidates = await tasks.find({
    ...(orgIds ? { orgId: { $in: orgIds.map((id) => toObjectId(id)) } } : {}),
    deletedAt: null,
    status: { $nin: ["DONE", "CANCELLED"] },
    assigneeEmail: { $nin: [null, ""] },
    dueDate: { $gte: lookback, $lt: dayAfter },
  }).limit(limit).toArray();

  let dueSoon = 0;
  let overdue = 0;
  for (const task of candidates) {
    const due = String(task.dueDate).slice(0, 10);
    const kind = due === tomorrow ? "due_soon" : due < today ? "overdue" : null;
    if (!kind) continue;
    const assignee = norm(task.assigneeEmail);
    const dedupeKey = `${task.orgId}:task.${kind}:${task._id}:${due}`;
    if (await deliveries.findOne({ dedupeKey }, { projection: { _id: 1 } })) continue;
    const sent = await safely(`task.${kind}`, () => notifyEvent({
      orgId: task.orgId.toString(), event: `task.${kind}`, targetEmail: assignee,
      title: kind === "due_soon" ? `Due tomorrow: ${task.title}` : `Overdue: ${task.title}`,
      body: kind === "due_soon" ? `This task is due ${due}.` : `This task was due ${due}.`,
      link: TASKS_LINK, sourceId: String(task._id), dedupeKey,
      ...(sender ? { sender } : {}),
    }));
    if (sent) kind === "due_soon" ? dueSoon++ : overdue++;
  }
  return { scanned: candidates.length, dueSoon, overdue };
}
