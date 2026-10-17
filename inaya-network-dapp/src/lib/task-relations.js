// src/lib/task-relations.js
//
// Business Workspace gap closure, Batch 1 — task depth: subtasks,
// dependencies ("blocked by"), and recurring tasks. Every field here is
// optional and absent on pre-existing tasks, which therefore behave exactly
// as before: no parent, no blockers, no recurrence.
//
// - Subtasks are one level deep and live in the parent's project.
// - Dependencies stay inside one project; a cycle is rejected rather than
//   silently accepted, since a cycle would make every task in it
//   permanently un-startable.
// - Recurrence is completion-based: completing a recurring task creates
//   exactly one next occurrence. The partial unique index on
//   (recurrenceSeriesId, recurrenceOccurrence) in orgs.js makes that
//   idempotent even if the same completion is retried or raced.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const RECURRENCE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"];
const CLOSED_STATES = ["DONE", "CANCELLED"];
const MAX_BLOCKERS = 20;

/** Returns { recurrence } (null clears it) or { error }. */
export function validateRecurrence(input) {
  if (input === null || input === undefined || input === "") return { recurrence: null };
  if (typeof input !== "object") return { error: "recurrence must be an object or null." };
  const frequency = String(input.frequency || "").toUpperCase();
  if (!RECURRENCE_FREQUENCIES.includes(frequency)) {
    return { error: `recurrence.frequency must be one of ${RECURRENCE_FREQUENCIES.join(", ")}.` };
  }
  const interval = input.interval === undefined ? 1 : Number(input.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 12) {
    return { error: "recurrence.interval must be a whole number from 1 to 12." };
  }
  return { recurrence: { frequency, interval } };
}

function daysInMonthUTC(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Next due date after `from` (a "YYYY-MM-DD" or ISO string). MONTHLY keeps
 *  the series' anchor day (so Jan 31 -> Feb 28 -> Mar 31, never drifting to
 *  the 28th), clamped to the target month's length. Returns the same
 *  string shape it was given. */
export function nextDueDate(from, recurrence, anchorDay = null) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(from);
  const base = new Date(dateOnly ? `${from}T00:00:00.000Z` : from);
  if (Number.isNaN(base.getTime())) throw new Error(`Invalid date: ${from}`);
  const { frequency, interval } = recurrence;
  let next;
  if (frequency === "DAILY") {
    next = new Date(base.getTime() + interval * 86400000);
  } else if (frequency === "WEEKLY") {
    next = new Date(base.getTime() + interval * 7 * 86400000);
  } else {
    const day = anchorDay || base.getUTCDate();
    const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + interval, 1,
      base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds()));
    target.setUTCDate(Math.min(day, daysInMonthUTC(target.getUTCFullYear(), target.getUTCMonth())));
    next = target;
  }
  return dateOnly ? next.toISOString().slice(0, 10) : next.toISOString();
}

/** Validates a prospective parent for a new subtask in `projectId`.
 *  Returns { parent } or { error, status }. */
export async function validateParentTask({ orgId, parentTaskId, projectId }) {
  const { tasks } = await getOrgCollections();
  if (!ObjectId.isValid(parentTaskId)) return { error: "Invalid parent task.", status: 400 };
  const parent = await tasks.findOne({ _id: toObjectId(parentTaskId), orgId: toObjectId(orgId), deletedAt: null });
  if (!parent) return { error: "Parent task not found.", status: 404 };
  if (parent.projectId.toString() !== String(projectId)) {
    return { error: "A subtask must be in the same project as its parent.", status: 400 };
  }
  if (parent.parentTaskId) return { error: "Subtasks can't have their own subtasks.", status: 400 };
  return { parent };
}

/** Replaces a task's blocker list after validating every entry and rejecting
 *  cycles. Returns { task } or { error, status }. */
export async function setTaskDependencies({ orgId, taskId, blockedByTaskIds, actorEmail }) {
  if (!Array.isArray(blockedByTaskIds)) return { error: "blockedByTaskIds must be an array.", status: 400 };
  const unique = [...new Set(blockedByTaskIds.map(String))];
  if (unique.length > MAX_BLOCKERS) return { error: `A task can have at most ${MAX_BLOCKERS} blockers.`, status: 400 };
  if (unique.some((id) => !ObjectId.isValid(id))) return { error: "Invalid task id in blockedByTaskIds.", status: 400 };
  if (unique.includes(String(taskId))) return { error: "A task can't block itself.", status: 400 };

  const { tasks } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const task = await tasks.findOne({ _id: toObjectId(taskId), orgId: orgObjectId, deletedAt: null });
  if (!task) return { error: "Task not found.", status: 404 };

  const projectTasks = await tasks.find(
    { orgId: orgObjectId, projectId: task.projectId, deletedAt: null },
    { projection: { _id: 1, blockedByTaskIds: 1, title: 1 } }
  ).toArray();
  const byId = new Map(projectTasks.map((t) => [t._id.toString(), t]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) return { error: "Every blocker must be an existing task in the same project.", status: 400 };

  // The new edges are task -> each blocker. A cycle exists if, following
  // existing blocker edges, any blocker can reach back to this task.
  const target = String(taskId);
  const seen = new Set();
  const stack = [...unique];
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return { error: "That would create a circular dependency.", status: 400 };
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of byId.get(id)?.blockedByTaskIds || []) stack.push(next.toString());
  }

  const now = new Date().toISOString();
  const blockerObjectIds = unique.map((id) => toObjectId(id));
  await tasks.updateOne({ _id: task._id }, { $set: { blockedByTaskIds: blockerObjectIds, updatedAt: now } });
  await logOrgActivity({
    orgId: orgObjectId, recordType: "TASK", recordId: task._id, actorEmail,
    action: "TASK_DEPENDENCIES_SET", previousState: null, newState: null,
    metadata: { blockedByTaskIds: unique },
  });
  return { task: await tasks.findOne({ _id: task._id }) };
}

/** Blockers of `task` that are still open (deleted blockers don't block). */
export async function findOpenBlockers(task) {
  const ids = task.blockedByTaskIds || [];
  if (!ids.length) return [];
  const { tasks } = await getOrgCollections();
  return tasks.find(
    { _id: { $in: ids }, orgId: task.orgId, deletedAt: null, status: { $nin: CLOSED_STATES } },
    { projection: { _id: 1, title: 1, status: 1 } }
  ).toArray();
}

export async function findOpenSubtasks(task) {
  const { tasks } = await getOrgCollections();
  return tasks.find(
    { orgId: task.orgId, parentTaskId: task._id, deletedAt: null, status: { $nin: CLOSED_STATES } },
    { projection: { _id: 1, title: 1, status: 1 } }
  ).toArray();
}

/** Subtasks and blockers of a task, with statuses, for the detail view. */
export async function getTaskRelations(task) {
  const { tasks } = await getOrgCollections();
  const [subtasks, blockers] = await Promise.all([
    tasks.find({ orgId: task.orgId, parentTaskId: task._id, deletedAt: null }).sort({ createdAt: 1 }).toArray(),
    (task.blockedByTaskIds || []).length
      ? tasks.find({ _id: { $in: task.blockedByTaskIds }, orgId: task.orgId, deletedAt: null }).toArray()
      : [],
  ]);
  const brief = (t) => ({ id: t._id.toString(), title: t.title, status: t.status, assigneeEmail: t.assigneeEmail || null, dueDate: t.dueDate || null });
  return { subtasks: subtasks.map(brief), blockers: blockers.map(brief) };
}

/** Fields to $set on a task when recurrence is set or cleared. A task that
 *  becomes recurring starts its own series at occurrence 0. */
export function recurrenceFieldsFor(task, recurrence) {
  if (!recurrence) return { recurrence: null };
  const fields = { recurrence };
  if (!task.recurrenceSeriesId) {
    fields.recurrenceSeriesId = task._id.toString();
    fields.recurrenceOccurrence = 0;
  }
  if (recurrence.frequency === "MONTHLY" && task.dueDate) {
    fields.recurrenceAnchorDay = new Date(/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) ? `${task.dueDate}T00:00:00.000Z` : task.dueDate).getUTCDate();
  }
  return fields;
}

/** Creates the next occurrence of a just-completed recurring task. Returns
 *  { nextTask, created } — created:false when this occurrence already
 *  existed (a retried or raced completion), never a duplicate. */
export async function spawnNextOccurrence({ task, actorEmail }) {
  if (!task.recurrence || !task.recurrenceSeriesId) return { nextTask: null, created: false };
  const { tasks } = await getOrgCollections();
  const occurrence = (task.recurrenceOccurrence || 0) + 1;
  const baseDate = task.dueDate || (task.completedAt || new Date().toISOString()).slice(0, 10);
  const dueDate = nextDueDate(baseDate, task.recurrence, task.recurrenceAnchorDay || null);
  const now = new Date().toISOString();
  const doc = {
    orgId: task.orgId, departmentId: task.departmentId, projectId: task.projectId,
    title: task.title, description: task.description || null,
    status: "TODO", priority: task.priority, assigneeEmail: task.assigneeEmail || null,
    dueDate, createdByEmail: task.createdByEmail,
    recurrence: task.recurrence, recurrenceSeriesId: task.recurrenceSeriesId, recurrenceOccurrence: occurrence,
    recurrenceAnchorDay: task.recurrenceAnchorDay || null,
    createdAt: now, updatedAt: now, completedAt: null, deletedAt: null,
  };
  try {
    const result = await tasks.insertOne(doc);
    await logOrgActivity({
      orgId: task.orgId, recordType: "TASK", recordId: result.insertedId, actorEmail,
      action: "TASK_RECURRENCE_SPAWNED", previousState: null, newState: "TODO",
      metadata: { fromTaskId: task._id.toString(), occurrence },
    });
    return { nextTask: { ...doc, _id: result.insertedId }, created: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const existing = await tasks.findOne({ recurrenceSeriesId: task.recurrenceSeriesId, recurrenceOccurrence: occurrence });
    return { nextTask: existing, created: false };
  }
}
