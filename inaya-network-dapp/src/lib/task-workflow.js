// src/lib/task-workflow.js
//
// Task lifecycle state machine — mirrors document-workflow.js's exact
// pattern (state enum + transition table + one atomic findOneAndUpdate
// per transition, no separate locking needed) with one generalization:
// `from` can be a single state OR an array of states (needed for
// `cancel`, which is valid from three different starting states), so the
// atomic filter becomes `status: Array.isArray(from) ? {$in: from} : from`.
//
// ACCESS: every transition only requires canAccessDepartment() — no
// requiresManage anywhere. Tasks are inherently collaborative (team
// members moving their own and each other's work through statuses),
// not confidential the way a specific document can be, so department-level
// access is the whole permission story for Phase 1 — no task_permissions
// grant table. Creating a task requires department access; editing the
// task's own fields (not just its status) or deleting it is further
// restricted to the creator, the current assignee, or owner/admin — see
// the [taskId] route, not this file, since that's a field-level rule on
// the record itself rather than a state-transition rule.
//
// ATOMICITY + REPLAY SAFETY: same as document-workflow.js — a duplicate
// or racing transition request finds the task's status has already moved
// and gets a clean 409, no double-transition, no duplicate activity entry.
//
// Activity is logged via org-activity-log.js's logOrgActivity(), not
// activity-log.js's logDocumentActivity() — see that file's own header
// comment for why this is a new, additive collection rather than a
// retrofit of the document-scoped one.

import { getOrgCollections, canAccessDepartment, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const TASK_STATES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"];

export const TRANSITIONS = {
  start: { from: "TODO", to: "IN_PROGRESS", activityAction: "TASK_STARTED" },
  block: { from: "IN_PROGRESS", to: "BLOCKED", activityAction: "TASK_BLOCKED" },
  resume: { from: "BLOCKED", to: "IN_PROGRESS", activityAction: "TASK_RESUMED" },
  complete: { from: "IN_PROGRESS", to: "DONE", activityAction: "TASK_COMPLETED" },
  reopen: { from: "DONE", to: "IN_PROGRESS", activityAction: "TASK_REOPENED" },
  cancel: { from: ["TODO", "IN_PROGRESS", "BLOCKED"], to: "CANCELLED", activityAction: "TASK_CANCELLED" },
};

/** The single enforcement point for every task state change. Returns
 *  { task } on success, or { error, status } on failure — callers return
 *  that pair directly as the HTTP response, same convention as
 *  requireMembership()/transitionDocument(). */
export async function transitionTask({ orgId, taskId, action, membership, actorEmail, note }) {
  const definition = TRANSITIONS[action];
  if (!definition) {
    return { error: `Unknown action "${action}".`, status: 400 };
  }

  const { tasks } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const taskObjectId = toObjectId(taskId);

  // Org isolation: same reasoning as transitionDocument() — the filter
  // includes orgId so a task belonging to a different org can never be
  // found here even if someone guesses a valid taskId.
  const task = await tasks.findOne({ _id: taskObjectId, orgId: orgObjectId, deletedAt: null });
  if (!task) {
    return { error: "Task not found.", status: 404 };
  }
  if (!canAccessDepartment(membership, task.departmentId)) {
    return { error: "You don't have permission to do that.", status: 403 };
  }

  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;
  const now = new Date().toISOString();
  const updateFields = { status: definition.to, updatedAt: now };
  if (definition.to === "DONE") updateFields.completedAt = now;
  if (task.status === "DONE" && definition.to !== "DONE") updateFields.completedAt = null; // reopen clears it

  const updated = await tasks.findOneAndUpdate(
    { _id: taskObjectId, orgId: orgObjectId, status: fromFilter },
    { $set: updateFields },
    { returnDocument: "after" }
  );
  if (!updated) {
    // Someone else already moved it (or this is a replay of a request
    // that already succeeded) — the task's real current status no
    // longer matches what this transition requires.
    const expected = Array.isArray(definition.from) ? definition.from.join("/") : definition.from;
    return { error: `This task isn't in ${expected} state (it's currently ${task.status}), so "${action}" can't be applied.`, status: 409 };
  }

  await logOrgActivity({
    orgId: orgObjectId,
    recordType: "TASK",
    recordId: taskObjectId,
    actorEmail,
    action: definition.activityAction,
    previousState: Array.isArray(definition.from) ? task.status : definition.from,
    newState: definition.to,
    metadata: note ? { note } : {},
  });

  return { task: updated };
}
