// src/lib/ai-record-creation.js
//
// Business Workspace gap closure, Batch 2 — what an APPROVED AI proposal
// may create or change: a task, a task reassignment, a CRM contact. These
// run only from ai-action-requests.js's executor, i.e. after a human with
// the real permission approved the proposal and the 36h delay passed.
//
// The rules mirror the human routes exactly (POST /api/orgs/tasks, PATCH
// /api/orgs/tasks/:id, POST /api/orgs/crm/contacts): same validation, same
// stored shape. Those routes are deliberately left unchanged so this adds
// no risk to the paths people already use.

import { ObjectId } from "mongodb";
import { getOrgCollections, canAccessDepartment, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { notifyTaskAssigned } from "./business-notify.js";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const CONTACT_TYPES = ["LEAD", "CUSTOMER"];
const norm = (e) => (e ? String(e).trim().toLowerCase() : null);

async function assertAssignee(orgObjectId, email, departmentId) {
  if (!email) return null;
  const { orgMembers } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: orgObjectId, email, status: "active" });
  if (!m || !canAccessDepartment(m, departmentId)) return "The assignee must be an active member with access to this project's department.";
  return null;
}

export async function createTaskFromProposal({ orgId, projectId, title, description, priority, assigneeEmail, dueDate, actorEmail }) {
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return { error: "Task title is required.", status: 400 };
  if (!ObjectId.isValid(String(projectId))) return { error: "Invalid project.", status: 400 };
  const { projects, tasks } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const project = await projects.findOne({ _id: toObjectId(projectId), orgId: orgObjectId });
  if (!project) return { error: "Project not found.", status: 404 };
  const assignee = norm(assigneeEmail);
  const assigneeError = await assertAssignee(orgObjectId, assignee, project.departmentId);
  if (assigneeError) return { error: assigneeError, status: 400 };

  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId, departmentId: project.departmentId, projectId: project._id,
    title: cleanTitle, description: description ? String(description).trim() : null,
    status: "TODO", priority: PRIORITIES.includes(priority) ? priority : "MEDIUM",
    assigneeEmail: assignee, dueDate: dueDate || null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, completedAt: null, deletedAt: null,
  };
  const r = await tasks.insertOne(doc);
  const task = { ...doc, _id: r.insertedId };
  await logOrgActivity({ orgId: orgObjectId, recordType: "TASK", recordId: r.insertedId, actorEmail, action: "TASK_CREATED", previousState: null, newState: "TODO", metadata: { via: "approved AI action request" } });
  await notifyTaskAssigned({ orgId, task, actorEmail, assignedAt: now });
  return { task };
}

export async function reassignTaskFromProposal({ orgId, taskId, assigneeEmail, actorEmail }) {
  if (!ObjectId.isValid(String(taskId))) return { error: "Invalid task.", status: 400 };
  const { tasks } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const task = await tasks.findOne({ _id: toObjectId(taskId), orgId: orgObjectId, deletedAt: null });
  if (!task) return { error: "Task not found.", status: 404 };
  const assignee = norm(assigneeEmail);
  const assigneeError = await assertAssignee(orgObjectId, assignee, task.departmentId);
  if (assigneeError) return { error: assigneeError, status: 400 };
  const now = new Date().toISOString();
  await tasks.updateOne({ _id: task._id }, { $set: { assigneeEmail: assignee, updatedAt: now } });
  const updated = await tasks.findOne({ _id: task._id });
  await logOrgActivity({ orgId: orgObjectId, recordType: "TASK", recordId: task._id, actorEmail, action: "TASK_UPDATED", previousState: null, newState: null, metadata: { fields: ["assigneeEmail"], from: task.assigneeEmail || null, to: assignee, via: "approved AI action request" } });
  if (assignee && assignee !== task.assigneeEmail) await notifyTaskAssigned({ orgId, task: updated, actorEmail, assignedAt: now });
  return { task: updated };
}

export async function createContactFromProposal({ orgId, departmentId, type, name, email, phone, company, notes, actorEmail }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return { error: "Contact name is required.", status: 400 };
  if (!ObjectId.isValid(String(departmentId))) return { error: "Invalid department.", status: 400 };
  const { departments, crmContacts } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const department = await departments.findOne({ _id: toObjectId(departmentId), orgId: orgObjectId });
  if (!department) return { error: "Department not found.", status: 404 };
  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId, departmentId: department._id, type: CONTACT_TYPES.includes(type) ? type : "LEAD", name: cleanName,
    email: norm(email), phone: phone ? String(phone).trim() : null,
    company: company ? String(company).trim() : null, notes: notes ? String(notes).trim() : null,
    taxId: null, paymentTerms: null, billingAddress: null, shippingAddress: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const r = await crmContacts.insertOne(doc);
  await logOrgActivity({ orgId: orgObjectId, recordType: "CONTACT", recordId: r.insertedId, actorEmail, action: "CONTACT_CREATED", previousState: null, newState: doc.type, metadata: { via: "approved AI action request" } });
  return { contact: { ...doc, _id: r.insertedId } };
}
