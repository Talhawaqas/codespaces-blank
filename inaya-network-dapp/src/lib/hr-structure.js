// src/lib/hr-structure.js
//
// Business Workspace gap closure, Batch 1 — reporting lines (org chart)
// and an onboarding checklist.
//
// Reporting lines: an optional managerEmployeeId on an employee. Self-
// management and cycles are rejected. The org chart is built only from
// employees the caller can already see, so it never reveals anyone the
// Employees list wouldn't.
//
// Onboarding: one editable checklist template per org (a sensible default
// until someone edits it), copied into per-employee items when an employee
// is in ONBOARDING. Copying is idempotent: an atomic flag on the employee
// guarantees the items are created exactly once, so concurrent requests
// can't duplicate them. Completing every item never changes the employee's
// status by itself; that stays a deliberate HR action.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const DEFAULT_ONBOARDING_ITEMS = [
  "Employment contract signed",
  "ID and right-to-work documents collected",
  "Equipment issued",
  "Workspace and email accounts created",
  "Company policies acknowledged",
  "Introduced to the team and manager",
];
const MAX_TEMPLATE_ITEMS = 30;
const MAX_TITLE = 120;

export async function setEmployeeManager({ orgId, employeeId, managerEmployeeId, actorEmail }) {
  const { employees } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const employee = await employees.findOne({ _id: toObjectId(employeeId), orgId: orgObjectId, deletedAt: null });
  if (!employee) return { error: "Employee not found.", status: 404 };

  let managerObjectId = null;
  if (managerEmployeeId) {
    if (!ObjectId.isValid(managerEmployeeId)) return { error: "Invalid manager.", status: 400 };
    if (String(managerEmployeeId) === String(employeeId)) return { error: "An employee can't be their own manager.", status: 400 };
    managerObjectId = toObjectId(managerEmployeeId);
    const manager = await employees.findOne({ _id: managerObjectId, orgId: orgObjectId, deletedAt: null });
    if (!manager) return { error: "Manager not found.", status: 404 };

    // Walk up from the proposed manager; reaching this employee means a cycle.
    const seen = new Set();
    let cursor = manager;
    while (cursor?.managerEmployeeId) {
      const next = cursor.managerEmployeeId.toString();
      if (next === String(employeeId)) return { error: "That would create a circular reporting line.", status: 400 };
      if (seen.has(next)) break;
      seen.add(next);
      cursor = await employees.findOne({ _id: cursor.managerEmployeeId, orgId: orgObjectId, deletedAt: null }, { projection: { managerEmployeeId: 1 } });
    }
  }

  const now = new Date().toISOString();
  await employees.updateOne({ _id: employee._id }, { $set: { managerEmployeeId: managerObjectId, updatedAt: now } });
  await logOrgActivity({
    orgId: orgObjectId, recordType: "EMPLOYEE", recordId: employee._id, actorEmail,
    action: "EMPLOYEE_MANAGER_SET", previousState: null, newState: null,
    metadata: { managerEmployeeId: managerObjectId ? managerObjectId.toString() : null },
  });
  return { employee: await employees.findOne({ _id: employee._id }) };
}

/** Pure: nests `employees` by managerEmployeeId. Anyone whose manager isn't
 *  in the list (no manager, or one the caller can't see) is a root. */
export function buildOrgChart(employees) {
  const nodes = new Map(employees.map((e) => [e._id.toString(), {
    id: e._id.toString(), fullName: e.fullName, jobTitle: e.jobTitle || null,
    departmentId: e.departmentId.toString(), employmentStatus: e.employmentStatus, reports: [],
  }]));
  const roots = [];
  for (const e of employees) {
    const node = nodes.get(e._id.toString());
    const managerId = e.managerEmployeeId ? e.managerEmployeeId.toString() : null;
    if (managerId && managerId !== node.id && nodes.has(managerId)) nodes.get(managerId).reports.push(node);
    else roots.push(node);
  }
  // Defensive: a cycle written before validation existed would leave its
  // members unreachable from any root — surface them as roots instead.
  const reachable = new Set();
  const walk = (n) => { if (reachable.has(n.id)) return; reachable.add(n.id); n.reports.forEach(walk); };
  roots.forEach(walk);
  for (const node of nodes.values()) {
    if (!reachable.has(node.id)) { roots.push({ ...node, reports: [] }); reachable.add(node.id); }
  }
  const sortTree = (list) => { list.sort((a, b) => a.fullName.localeCompare(b.fullName)); list.forEach((n) => sortTree(n.reports)); };
  sortTree(roots);
  return roots;
}

export async function getOnboardingTemplate(orgId) {
  const { hrOnboardingTemplates } = await getOrgCollections();
  const row = await hrOnboardingTemplates.findOne({ orgId: toObjectId(orgId) });
  return { items: row?.items || DEFAULT_ONBOARDING_ITEMS, isDefault: !row };
}

export async function setOnboardingTemplate({ orgId, items, actorEmail }) {
  if (!Array.isArray(items)) return { error: "items must be an array.", status: 400 };
  const clean = items.map((t) => String(t || "").trim()).filter(Boolean);
  if (!clean.length) return { error: "The checklist needs at least one item.", status: 400 };
  if (clean.length > MAX_TEMPLATE_ITEMS) return { error: `At most ${MAX_TEMPLATE_ITEMS} items.`, status: 400 };
  if (clean.some((t) => t.length > MAX_TITLE)) return { error: `Each item can be at most ${MAX_TITLE} characters.`, status: 400 };
  const { hrOnboardingTemplates } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();
  await hrOnboardingTemplates.updateOne(
    { orgId: orgObjectId },
    { $set: { items: clean, updatedByEmail: actorEmail, updatedAt: now }, $setOnInsert: { orgId: orgObjectId, createdAt: now } },
    { upsert: true }
  );
  await logOrgActivity({
    orgId: orgObjectId, recordType: "HR_ONBOARDING_TEMPLATE", recordId: orgObjectId, actorEmail,
    action: "ONBOARDING_TEMPLATE_UPDATED", previousState: null, newState: null, metadata: { itemCount: clean.length },
  });
  return { items: clean, isDefault: false };
}

/** Creates the employee's checklist from the template, exactly once, if
 *  they're ONBOARDING. Returns { created }. */
export async function ensureOnboardingChecklist({ orgId, employee, actorEmail }) {
  if (employee.employmentStatus !== "ONBOARDING" || employee.onboardingChecklistCreatedAt) return { created: false };
  const { employees, hrOnboardingItems } = await getOrgCollections();
  const now = new Date().toISOString();
  const claimed = await employees.findOneAndUpdate(
    { _id: employee._id, orgId: employee.orgId, onboardingChecklistCreatedAt: null },
    { $set: { onboardingChecklistCreatedAt: now } },
    { returnDocument: "after" }
  );
  if (!claimed) return { created: false };
  let items;
  try {
    ({ items } = await getOnboardingTemplate(orgId));
    await hrOnboardingItems.insertMany(items.map((title, position) => ({
      orgId: employee.orgId, employeeId: employee._id, title, position,
      done: false, doneByEmail: null, doneAt: null, createdAt: now,
    })));
  } catch (err) {
    // Release the claim so a later request can retry instead of leaving the
    // employee permanently marked as having a checklist they don't have.
    await hrOnboardingItems.deleteMany({ orgId: employee.orgId, employeeId: employee._id, createdAt: now });
    await employees.updateOne({ _id: employee._id }, { $set: { onboardingChecklistCreatedAt: null } });
    throw err;
  }
  await logOrgActivity({
    orgId: employee.orgId, recordType: "EMPLOYEE", recordId: employee._id, actorEmail,
    action: "ONBOARDING_CHECKLIST_CREATED", previousState: null, newState: null, metadata: { itemCount: items.length },
  });
  return { created: true };
}

export async function listOnboardingItems(orgId, employeeId) {
  const { hrOnboardingItems } = await getOrgCollections();
  const items = await hrOnboardingItems.find({ orgId: toObjectId(orgId), employeeId: toObjectId(employeeId) }).sort({ position: 1 }).toArray();
  return items.map((i) => ({ id: i._id.toString(), title: i.title, done: i.done, doneByEmail: i.doneByEmail, doneAt: i.doneAt }));
}

export async function setOnboardingItemDone({ orgId, employeeId, itemId, done, actorEmail }) {
  if (!ObjectId.isValid(itemId)) return { error: "Invalid checklist item.", status: 400 };
  const { hrOnboardingItems } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await hrOnboardingItems.findOneAndUpdate(
    { _id: toObjectId(itemId), orgId: toObjectId(orgId), employeeId: toObjectId(employeeId) },
    { $set: done ? { done: true, doneByEmail: actorEmail, doneAt: now } : { done: false, doneByEmail: null, doneAt: null } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Checklist item not found.", status: 404 };
  await logOrgActivity({
    orgId: toObjectId(orgId), recordType: "EMPLOYEE", recordId: toObjectId(employeeId), actorEmail,
    action: done ? "ONBOARDING_ITEM_DONE" : "ONBOARDING_ITEM_REOPENED", previousState: null, newState: null,
    metadata: { itemId: String(itemId), title: updated.title },
  });
  return { items: await listOnboardingItems(orgId, employeeId) };
}

export async function addOnboardingItem({ orgId, employeeId, title, actorEmail }) {
  const clean = String(title || "").trim();
  if (!clean) return { error: "Item title is required.", status: 400 };
  if (clean.length > MAX_TITLE) return { error: `Item title can be at most ${MAX_TITLE} characters.`, status: 400 };
  const { hrOnboardingItems } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const employeeObjectId = toObjectId(employeeId);
  const last = await hrOnboardingItems.find({ orgId: orgObjectId, employeeId: employeeObjectId }).sort({ position: -1 }).limit(1).toArray();
  await hrOnboardingItems.insertOne({
    orgId: orgObjectId, employeeId: employeeObjectId, title: clean, position: (last[0]?.position ?? -1) + 1,
    done: false, doneByEmail: null, doneAt: null, createdAt: new Date().toISOString(),
  });
  await logOrgActivity({
    orgId: orgObjectId, recordType: "EMPLOYEE", recordId: employeeObjectId, actorEmail,
    action: "ONBOARDING_ITEM_ADDED", previousState: null, newState: null, metadata: { title: clean },
  });
  return { items: await listOnboardingItems(orgId, employeeId) };
}
