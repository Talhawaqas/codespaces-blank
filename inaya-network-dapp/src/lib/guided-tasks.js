// src/lib/guided-tasks.js
//
// AI-Powered Business Workspace SOW — the guided-task state machine. A
// guided task is bookkeeping only: it tracks which step of a
// guided-workflow-catalog.js workflow a specific user is on. It never
// mutates a real business record itself — that only ever happens when the
// user performs the real action through the real UI (or, for Action Mode,
// through the existing propose_*/ai-action-requests.js pipeline
// unchanged). This keeps the read-only-by-default discipline every other
// AI surface in this codebase already follows: a new capability that
// shouldn't touch real business data simply has no path to do so, rather
// than being trusted not to.
//
// Same {from,to,requiresManage,activityAction}-table shape as
// purchase-order-workflow.js is used here where it fits (ACTIVE-only
// gating for most transitions), with one addition specific to this
// collection: every mutating filter includes BOTH orgId and userEmail —
// a guided task is scoped to one specific user's walkthrough, not to the
// whole org the way a purchase order is. That same filter also makes
// advanceGuidedTaskStep idempotent: a duplicate client event carrying a
// stale fromStepIndex is a no-op, not a double-advance or an error — the
// concrete mechanism behind the SOW's "wait for user action" and
// "no hallucinated skipping" requirements.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { getGuidedWorkflow, getGuidedStep } from "./guided-workflow-catalog.js";

export const GUIDED_TASK_STATES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED", "ABANDONED"];

function serialize(task) {
  if (!task) return null;
  return {
    taskId: task._id.toString(),
    orgId: task.orgId.toString(),
    userEmail: task.userEmail,
    workflowKey: task.workflowKey,
    currentStepIndex: task.currentStepIndex,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function currentStepFor(task) {
  if (!task || task.status === "COMPLETED" || task.status === "CANCELLED" || task.status === "ABANDONED") return null;
  return getGuidedStep(task.workflowKey, task.currentStepIndex);
}

/** Starts a new guided task for this user. Returns { task, currentStep } or
 *  { error, status }. Does not check for an already-active task itself —
 *  callers (the AI tool, or the API route) that want the "you already have
 *  one in progress" prompt should call listActiveGuidedTasksForUser first
 *  and decide what to do with the result; this function always starts a
 *  fresh row. */
export async function startGuidedTask({ orgId, userEmail, workflowKey, context }) {
  const workflow = getGuidedWorkflow(workflowKey);
  if (!workflow) return { error: `Unknown guided workflow "${workflowKey}".`, status: 400 };

  const { guidedTasks } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();

  const doc = {
    orgId: orgObjectId,
    userEmail,
    workflowKey,
    currentStepIndex: 0,
    status: "ACTIVE",
    context: context || {},
    stepEvents: [{ stepIndex: 0, event: "STARTED", at: now }],
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await guidedTasks.insertOne(doc);
  const task = { ...doc, _id: insertedId };

  await logOrgActivity({
    orgId: orgObjectId,
    recordType: "GUIDED_TASK",
    recordId: insertedId,
    actorEmail: userEmail,
    action: "GUIDED_TASK_STARTED",
    previousState: null,
    newState: "ACTIVE",
    metadata: { workflowKey },
  });

  return { task: serialize(task), currentStep: currentStepFor(task), totalSteps: workflow.steps.length, label: workflow.label };
}

/** Advances a task from fromStepIndex to fromStepIndex+1, atomically and
 *  idempotently: the Mongo filter requires the task to still be ACTIVE
 *  AND still be sitting at fromStepIndex, so a duplicate/late-arriving
 *  completion signal for a step that already advanced is a harmless no-op
 *  ({ alreadyAdvanced: true }) rather than skipping a step or erroring. */
export async function advanceGuidedTaskStep({ orgId, userEmail, taskId, fromStepIndex, source }) {
  const { guidedTasks } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const taskObjectId = toObjectId(taskId);

  const existing = await guidedTasks.findOne({ _id: taskObjectId, orgId: orgObjectId, userEmail });
  if (!existing) return { error: "Guided task not found.", status: 404 };
  if (existing.status !== "ACTIVE") {
    return { error: `This guided task isn't active (it's currently ${existing.status}).`, status: 409 };
  }
  if (existing.currentStepIndex !== fromStepIndex) {
    if (existing.currentStepIndex > fromStepIndex) {
      return { alreadyAdvanced: true, task: serialize(existing), currentStep: currentStepFor(existing) };
    }
    return { error: `This guided task is at step ${existing.currentStepIndex}, not ${fromStepIndex} — reload its current state and try again.`, status: 409 };
  }

  const workflow = getGuidedWorkflow(existing.workflowKey);
  const nextIndex = fromStepIndex + 1;
  const isComplete = nextIndex >= workflow.steps.length;
  const now = new Date().toISOString();

  const updated = await guidedTasks.findOneAndUpdate(
    { _id: taskObjectId, orgId: orgObjectId, userEmail, status: "ACTIVE", currentStepIndex: fromStepIndex },
    {
      $set: { currentStepIndex: nextIndex, status: isComplete ? "COMPLETED" : "ACTIVE", updatedAt: now },
      $push: { stepEvents: { stepIndex: fromStepIndex, event: "STEP_COMPLETED", source: source || "unknown", at: now } },
    },
    { returnDocument: "after" }
  );
  if (!updated) {
    // Lost a race against a concurrent advance of the same step — treat
    // exactly like the already-advanced case above rather than erroring.
    const reloaded = await guidedTasks.findOne({ _id: taskObjectId, orgId: orgObjectId, userEmail });
    return { alreadyAdvanced: true, task: serialize(reloaded), currentStep: currentStepFor(reloaded) };
  }

  await logOrgActivity({
    orgId: orgObjectId,
    recordType: "GUIDED_TASK",
    recordId: taskObjectId,
    actorEmail: userEmail,
    action: isComplete ? "GUIDED_TASK_COMPLETED" : "GUIDED_TASK_STEP_ADVANCED",
    previousState: `step:${fromStepIndex}`,
    newState: isComplete ? "COMPLETED" : `step:${nextIndex}`,
    metadata: { workflowKey: existing.workflowKey, source: source || "unknown" },
  });

  return { task: serialize(updated), currentStep: currentStepFor(updated) };
}

async function setStatus({ orgId, userEmail, taskId, fromStatuses, toStatus, activityAction }) {
  const { guidedTasks } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const taskObjectId = toObjectId(taskId);

  const existing = await guidedTasks.findOne({ _id: taskObjectId, orgId: orgObjectId, userEmail });
  if (!existing) return { error: "Guided task not found.", status: 404 };
  if (!fromStatuses.includes(existing.status)) {
    return { error: `This guided task isn't ${fromStatuses.join("/")} (it's currently ${existing.status}).`, status: 409 };
  }

  const now = new Date().toISOString();
  const updated = await guidedTasks.findOneAndUpdate(
    { _id: taskObjectId, orgId: orgObjectId, userEmail, status: { $in: fromStatuses } },
    { $set: { status: toStatus, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This guided task changed since it was loaded — reload and try again.", status: 409 };

  await logOrgActivity({
    orgId: orgObjectId,
    recordType: "GUIDED_TASK",
    recordId: taskObjectId,
    actorEmail: userEmail,
    action: activityAction,
    previousState: existing.status,
    newState: toStatus,
    metadata: { workflowKey: existing.workflowKey },
  });

  return { task: serialize(updated), currentStep: currentStepFor(updated) };
}

export async function pauseGuidedTask({ orgId, userEmail, taskId }) {
  return setStatus({ orgId, userEmail, taskId, fromStatuses: ["ACTIVE"], toStatus: "PAUSED", activityAction: "GUIDED_TASK_PAUSED" });
}

export async function resumeGuidedTask({ orgId, userEmail, taskId }) {
  return setStatus({ orgId, userEmail, taskId, fromStatuses: ["PAUSED"], toStatus: "ACTIVE", activityAction: "GUIDED_TASK_RESUMED" });
}

export async function cancelGuidedTask({ orgId, userEmail, taskId }) {
  return setStatus({ orgId, userEmail, taskId, fromStatuses: ["ACTIVE", "PAUSED"], toStatus: "CANCELLED", activityAction: "GUIDED_TASK_CANCELLED" });
}

/** Cancels the existing task (if it's still active/paused — a no-op error
 *  is ignored, restarting a completed/already-cancelled task is fine) and
 *  starts a brand new row for the same workflow. Never rewinds a terminal
 *  row's currentStepIndex back to 0 — org_activity's append-only history
 *  stays intact, exactly like every other workflow file's "new attempt,
 *  new row" convention in this codebase. */
export async function restartGuidedTask({ orgId, userEmail, taskId }) {
  const { guidedTasks } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const taskObjectId = toObjectId(taskId);

  const existing = await guidedTasks.findOne({ _id: taskObjectId, orgId: orgObjectId, userEmail });
  if (!existing) return { error: "Guided task not found.", status: 404 };

  if (["ACTIVE", "PAUSED"].includes(existing.status)) {
    await cancelGuidedTask({ orgId, userEmail, taskId });
  }
  return startGuidedTask({ orgId, userEmail, workflowKey: existing.workflowKey, context: existing.context });
}

export async function getGuidedTask({ orgId, userEmail, taskId }) {
  const { guidedTasks } = await getOrgCollections();
  const task = await guidedTasks.findOne({ _id: toObjectId(taskId), orgId: toObjectId(orgId), userEmail });
  if (!task) return { error: "Guided task not found.", status: 404 };
  const workflow = getGuidedWorkflow(task.workflowKey);
  return { task: serialize(task), currentStep: currentStepFor(task), totalSteps: workflow?.steps.length || 0, label: workflow?.label || task.workflowKey };
}

export async function listActiveGuidedTasksForUser({ orgId, userEmail }) {
  const { guidedTasks } = await getOrgCollections();
  const rows = await guidedTasks
    .find({ orgId: toObjectId(orgId), userEmail, status: { $in: ["ACTIVE", "PAUSED"] } })
    .sort({ updatedAt: -1 })
    .toArray();
  return {
    tasks: rows.map((task) => {
      const workflow = getGuidedWorkflow(task.workflowKey);
      return { ...serialize(task), currentStep: currentStepFor(task), totalSteps: workflow?.steps.length || 0, label: workflow?.label || task.workflowKey };
    }),
  };
}
