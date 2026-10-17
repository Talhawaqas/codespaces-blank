// app/api/orgs/tasks/[taskId]/route.js
//
// GET   /api/orgs/tasks/:taskId?orgId=...            -> single task, department-access-gated
// PATCH /api/orgs/tasks/:taskId  { orgId, title?, description?, priority?, assigneeEmail?, dueDate? }
//   -> field edits (not status — that's transition/route.js). Restricted to
//      the creator, the current assignee, or owner/admin, same "who's
//      allowed to touch this record's own fields" boundary task-workflow.js's
//      header comment describes.
// DELETE /api/orgs/tasks/:taskId?orgId=...  -> soft delete (deletedAt), same
//      restriction as PATCH.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canManageOrg, toObjectId } from "../../../../../lib/orgs.js";
import { logOrgActivity } from "../../../../../lib/org-activity-log.js";
import { validateRecurrence, recurrenceFieldsFor, setTaskDependencies, getTaskRelations } from "../../../../../lib/task-relations.js";
import { notifyTaskAssigned } from "../../../../../lib/business-notify.js";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

function serializeTask(t) {
  return {
    id: t._id.toString(),
    orgId: t.orgId.toString(),
    departmentId: t.departmentId.toString(),
    projectId: t.projectId.toString(),
    title: t.title,
    description: t.description || null,
    status: t.status,
    priority: t.priority,
    assigneeEmail: t.assigneeEmail || null,
    dueDate: t.dueDate || null,
    createdByEmail: t.createdByEmail,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt || null,
    parentTaskId: t.parentTaskId ? t.parentTaskId.toString() : null,
    blockedByTaskIds: (t.blockedByTaskIds || []).map((id) => id.toString()),
    recurrence: t.recurrence || null,
  };
}

function canEditTask(task, membership, email) {
  if (canManageOrg(membership)) return true;
  if (task.createdByEmail === email) return true;
  if (task.assigneeEmail && task.assigneeEmail === email) return true;
  return false;
}

export async function GET(req, { params }) {
  try {
    const { taskId } = params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { tasks } = await getOrgCollections();
    const task = await tasks.findOne({ _id: toObjectId(taskId), orgId: toObjectId(orgId), deletedAt: null });
    if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, task.departmentId)) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }

    return NextResponse.json({ ...serializeTask(task), ...(await getTaskRelations(task)) });
  } catch (err) {
    console.error("orgs/tasks/[taskId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the task." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { taskId } = params;
    const body = await req.json();
    const { orgId, title, description, priority, assigneeEmail: rawAssignee, dueDate, blockedByTaskIds, recurrence: rawRecurrence } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { tasks, orgMembers } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const taskObjectId = toObjectId(taskId);

    const task = await tasks.findOne({ _id: taskObjectId, orgId: orgObjectId, deletedAt: null });
    if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, task.departmentId)) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }
    if (!canEditTask(task, auth.membership, auth.session.email)) {
      return NextResponse.json({ error: "Only the task's creator, assignee, or an owner/admin can edit it." }, { status: 403 });
    }

    const updateFields = { updatedAt: new Date().toISOString() };
    if (title !== undefined) {
      const trimmed = String(title).trim();
      if (!trimmed) return NextResponse.json({ error: "Task title cannot be empty." }, { status: 400 });
      updateFields.title = trimmed;
    }
    if (description !== undefined) updateFields.description = description ? String(description).trim() : null;
    if (priority !== undefined) {
      if (!PRIORITIES.includes(priority)) return NextResponse.json({ error: "Invalid priority." }, { status: 400 });
      updateFields.priority = priority;
    }
    if (dueDate !== undefined) updateFields.dueDate = dueDate || null;
    if (rawAssignee !== undefined) {
      const normalized = rawAssignee ? String(rawAssignee).trim().toLowerCase() : null;
      if (normalized) {
        const assigneeMembership = await orgMembers.findOne({ orgId: orgObjectId, email: normalized, status: "active" });
        if (!assigneeMembership || !canAccessDepartment(assigneeMembership, task.departmentId)) {
          return NextResponse.json({ error: "The assignee must be an active member with access to this task's department." }, { status: 400 });
        }
      }
      updateFields.assigneeEmail = normalized;
    }
    if (rawRecurrence !== undefined) {
      const { recurrence, error: recurrenceError } = validateRecurrence(rawRecurrence);
      if (recurrenceError) return NextResponse.json({ error: recurrenceError }, { status: 400 });
      if (recurrence && task.parentTaskId) {
        return NextResponse.json({ error: "A subtask can't repeat on its own; make the parent task recurring instead." }, { status: 400 });
      }
      Object.assign(updateFields, recurrenceFieldsFor({ ...task, ...updateFields }, recurrence));
    }

    // Applied last, after every other field has validated, so a rejected
    // dependency change never leaves a half-applied edit.
    if (blockedByTaskIds !== undefined) {
      const dependencyResult = await setTaskDependencies({ orgId, taskId, blockedByTaskIds, actorEmail: auth.session.email });
      if (dependencyResult.error) return NextResponse.json({ error: dependencyResult.error }, { status: dependencyResult.status });
    }

    await tasks.updateOne({ _id: taskObjectId }, { $set: updateFields });
    const updated = await tasks.findOne({ _id: taskObjectId });

    if (updateFields.assigneeEmail && updateFields.assigneeEmail !== task.assigneeEmail) {
      await notifyTaskAssigned({ orgId, task: updated, actorEmail: auth.session.email, assignedAt: updateFields.updatedAt });
    }

    await logOrgActivity({
      orgId: orgObjectId,
      recordType: "TASK",
      recordId: taskObjectId,
      actorEmail: auth.session.email,
      action: "TASK_UPDATED",
      previousState: null,
      newState: null,
      metadata: { fields: Object.keys(updateFields).filter((k) => k !== "updatedAt") },
    });

    return NextResponse.json(serializeTask(updated));
  } catch (err) {
    console.error("orgs/tasks/[taskId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the task." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { taskId } = params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { tasks } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const taskObjectId = toObjectId(taskId);

    const task = await tasks.findOne({ _id: taskObjectId, orgId: orgObjectId, deletedAt: null });
    if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, task.departmentId)) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }
    if (!canEditTask(task, auth.membership, auth.session.email)) {
      return NextResponse.json({ error: "Only the task's creator, assignee, or an owner/admin can delete it." }, { status: 403 });
    }

    await tasks.updateOne({ _id: taskObjectId }, { $set: { deletedAt: new Date().toISOString() } });

    await logOrgActivity({
      orgId: orgObjectId,
      recordType: "TASK",
      recordId: taskObjectId,
      actorEmail: auth.session.email,
      action: "TASK_DELETED",
      previousState: task.status,
      newState: null,
      metadata: {},
    });

    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/tasks/[taskId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the task." }, { status: 500 });
  }
}
