// src/lib/identity/orphans.js
//
// SOW §32 (orphaned work), §33 (manager replacement analysis).
//
// ORPHAN DETECTION finds work whose owner no longer has active access: open tasks, support tickets, critical functions and risk entries,
// workflows, and temporary grants whose sponsor left. It never reassigns anything silently. Each orphan becomes a REMEDIATION item
// (identityRemediations) that names the record, the former owner, and a SUGGESTED successor (the department manager / most-loaded
// active member is NOT guessed: the suggestion is the person's department peers, listed for a human to choose). A human resolves the
// item by choosing a successor; that is audited. If a project is supplied, a real task is created for the reviewer too.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { fail, nowIso, normEmail } from "./common.js";
import { audit, notifyManagers } from "./record.js";
import { recordRun } from "./runs.js";

const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };
const MAX = 500;

/** Active-member lookup for a set of emails: returns Set of emails that are NOT active (or not members). */
async function inactiveAmong(orgId, emails) {
  const { orgMembers } = await getOrgCollections();
  const list = [...new Set(emails.filter(Boolean))];
  if (!list.length) return new Set();
  const active = await orgMembers.find({ orgId: toObjectId(orgId), email: { $in: list }, status: "active" }).project({ email: 1 }).toArray();
  const ok = new Set(active.map((a) => a.email));
  return new Set(list.filter((e) => !ok.has(e)));
}

/** Detects (and records) orphans. Idempotent per (kind, recordId). scope: { email } narrows to one former owner. */
export async function detectOrphans({ orgId, email = null, actor = "identity-worker" }) {
  const oid = toObjectId(orgId); const org = await getOrgCollections(); const { identityRemediations, identityGrants } = await getIdentityCollections();
  const only = email ? normEmail(email) : null;
  const found = [];

  const tasks = await org.tasks.find({ orgId: oid, deletedAt: null, status: { $nin: ["DONE", "CANCELLED"] }, assigneeEmail: only ? only : { $ne: null } }).limit(MAX).toArray();
  const gone1 = await inactiveAmong(orgId, tasks.map((t) => t.assigneeEmail));
  for (const t of tasks) if (gone1.has(t.assigneeEmail)) found.push({ kind: "TASK", recordId: String(t._id), title: t.title, formerOwner: t.assigneeEmail, departmentId: t.departmentId ? String(t.departmentId) : null, projectId: t.projectId ? String(t.projectId) : null, detail: `Open task (${t.status}${t.dueDate ? `, due ${String(t.dueDate).slice(0, 10)}` : ""})` });

  const tickets = await org.supportTickets.find({ orgId: oid, status: { $nin: ["CLOSED", "RESOLVED"] }, assigneeEmail: only ? only : { $ne: null } }).limit(MAX).toArray();
  const gone2 = await inactiveAmong(orgId, tickets.map((t) => t.assigneeEmail));
  for (const t of tickets) if (gone2.has(t.assigneeEmail)) found.push({ kind: "SUPPORT_TICKET", recordId: String(t._id), title: `${t.number || ""} ${t.subject || ""}`.trim(), formerOwner: t.assigneeEmail, detail: `Open support ticket (${t.status})` });

  const fns = await org.criticalFunctions.find({ orgId: oid, ownerEmail: only ? only : { $ne: null } }).limit(MAX).toArray();
  const gone3 = await inactiveAmong(orgId, fns.map((f) => f.ownerEmail));
  for (const f of fns) if (gone3.has(f.ownerEmail)) found.push({ kind: "CRITICAL_FUNCTION", recordId: String(f._id), title: f.name, formerOwner: f.ownerEmail, detail: "Critical function owner" });

  const risks = await org.riskRegister.find({ orgId: oid, status: { $nin: ["CLOSED", "RESOLVED"] }, ownerEmail: only ? only : { $ne: null } }).limit(MAX).toArray();
  const gone4 = await inactiveAmong(orgId, risks.map((r) => r.ownerEmail));
  for (const r of risks) if (gone4.has(r.ownerEmail)) found.push({ kind: "RISK", recordId: String(r._id), title: r.category || "Risk", formerOwner: r.ownerEmail, detail: "Open risk entry owner" });

  const wfs = await org.workflows.find({ orgId: oid, status: { $in: ["PUBLISHED", "ACTIVE", "DRAFT"] }, ownerEmail: only ? only : { $ne: null } }).limit(MAX).toArray();
  const gone5 = await inactiveAmong(orgId, wfs.map((w) => w.ownerEmail));
  for (const w of wfs) if (gone5.has(w.ownerEmail)) found.push({ kind: "WORKFLOW", recordId: String(w._id), title: w.name, formerOwner: w.ownerEmail, detail: `Workflow (${w.status}) runs as its owner` });

  const sponsored = await identityGrants.find({ orgId: oid, source: "TEMPORARY", status: "ACTIVE", owner: only ? only : { $ne: null } }).limit(MAX).toArray();
  const gone6 = await inactiveAmong(orgId, sponsored.map((g) => g.owner));
  for (const g of sponsored) if (gone6.has(g.owner)) found.push({ kind: "TEMPORARY_ACCESS_SPONSOR", recordId: String(g._id), title: `${g.email}: ${g.kind} ${g.label || g.value}`, formerOwner: g.owner, detail: `Temporary access sponsored by ${g.owner}, expires ${g.expiresAt ? g.expiresAt.slice(0, 10) : "n/a"}` });

  let created = 0;
  for (const f of found) {
    const r = await identityRemediations.updateOne({ orgId: oid, kind: f.kind, recordId: f.recordId, status: "OPEN" }, { $setOnInsert: { orgId: oid, ...f, status: "OPEN", createdAt: nowIso(), detectedBy: actor, suggested: [] } }, { upsert: true });
    if (r.upsertedCount) created++;
  }
  // items whose owner is active again (e.g. restored) close themselves
  const open = await identityRemediations.find({ orgId: oid, status: "OPEN", ...(only ? { formerOwner: only } : {}) }).limit(MAX).toArray();
  const stillGone = await inactiveAmong(orgId, open.map((o) => o.formerOwner));
  let autoClosed = 0;
  for (const o of open) if (!stillGone.has(o.formerOwner)) { await identityRemediations.updateOne({ _id: o._id, status: "OPEN" }, { $set: { status: "CLOSED", closedAt: nowIso(), resolution: "owner active again" } }); autoClosed++; }
  if (created) await notifyManagers({ orgId, title: `${created} orphaned item(s) need a new owner`, body: "Work owned by people who no longer have access. Nothing was reassigned automatically.", severity: "warning", dedupeKey: `identity:orphans:${new Date().toISOString().slice(0, 13)}` });
  return { detected: found.length, created, autoClosed };
}

export async function listRemediations({ orgId, status = "OPEN", limit = 200 }) {
  const { identityRemediations } = await getIdentityCollections();
  const rows = await identityRemediations.find({ orgId: toObjectId(orgId), ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(Math.min(500, limit)).toArray();
  return { remediations: rows.map(remView) };
}
const remView = (r) => ({ remediationId: String(r._id), kind: r.kind, recordId: r.recordId, title: r.title, detail: r.detail, formerOwner: r.formerOwner, status: r.status, createdAt: r.createdAt, resolvedBy: r.resolvedBy || null, newOwner: r.newOwner || null, resolution: r.resolution || null, taskId: r.taskId || null });

/** A human chooses the new owner; the record is reassigned and the decision audited. Nothing else changes. */
export async function resolveRemediation({ orgId, remediationId, newOwner, note = "", actor }) {
  const id = oidOf(remediationId); if (!id) return fail("Remediation not found.", 404);
  const { identityRemediations } = await getIdentityCollections(); const org = await getOrgCollections(); const oid = toObjectId(orgId);
  const r = await identityRemediations.findOne({ _id: id, orgId: oid, status: "OPEN" }); if (!r) return fail("Remediation not found or already resolved.", 404);
  const to = normEmail(newOwner);
  if (!(await org.orgMembers.findOne({ orgId: oid, email: to, status: "active" }))) return fail("The new owner must be an active member of this organization.", 400);
  const rid = oidOf(r.recordId);
  const set = { updatedAt: nowIso() };
  const map = { TASK: [org.tasks, { assigneeEmail: to }], SUPPORT_TICKET: [org.supportTickets, { assigneeEmail: to }], CRITICAL_FUNCTION: [org.criticalFunctions, { ownerEmail: to }], RISK: [org.riskRegister, { ownerEmail: to }], WORKFLOW: [org.workflows, { ownerEmail: to }] };
  if (r.kind === "TEMPORARY_ACCESS_SPONSOR") { const { identityGrants } = await getIdentityCollections(); await identityGrants.updateOne({ _id: rid, orgId: oid }, { $set: { owner: to } }); }
  else if (map[r.kind]) { const [col, patch] = map[r.kind]; const u = await col.updateOne({ _id: rid, orgId: oid, [Object.keys(patch)[0]]: r.formerOwner }, { $set: { ...patch, ...set } }); if (!u.matchedCount) return fail("The record changed in the meantime; re-run detection.", 409); }
  await identityRemediations.updateOne({ _id: id }, { $set: { status: "RESOLVED", resolvedAt: nowIso(), resolvedBy: normEmail(actor), newOwner: to, resolution: String(note).slice(0, 300) || "reassigned" } });
  await audit({ orgId, action: "IDENTITY_ORPHAN_REASSIGNED", actorEmail: actor, metadata: { kind: r.kind, recordId: r.recordId, from: r.formerOwner, to, note: String(note).slice(0, 100) } });
  await recordRun({ orgId, type: "ORPHAN_REMEDIATION", email: r.formerOwner, actor, plan: { ops: [{ op: "REASSIGN", kind: r.kind, recordId: r.recordId, to }] }, result: { newOwner: to }, reasonNote: note });
  return { resolved: true, newOwner: to };
}

/** Optional: turn open remediations into real tasks for a reviewer inside an existing project (never invents a project). */
export async function createRemediationTasks({ orgId, projectId, reviewer, actor }) {
  const org = await getOrgCollections(); const { identityRemediations } = await getIdentityCollections(); const oid = toObjectId(orgId);
  const pid = oidOf(projectId); const p = pid ? await org.projects.findOne({ _id: pid, orgId: oid }) : null;
  if (!p) return fail("Choose an existing project to hold the remediation tasks.", 404);
  const rv = normEmail(reviewer);
  if (!(await org.orgMembers.findOne({ orgId: oid, email: rv, status: "active" }))) return fail("The reviewer must be an active member.", 400);
  const open = await identityRemediations.find({ orgId: oid, status: "OPEN", taskId: { $exists: false } }).limit(100).toArray();
  let n = 0;
  for (const r of open) {
    const t = await org.tasks.insertOne({ orgId: oid, departmentId: p.departmentId, projectId: pid, title: `Find a new owner: ${r.kind.replace(/_/g, " ").toLowerCase()} "${String(r.title).slice(0, 80)}"`, description: `${r.detail}. Former owner ${r.formerOwner} no longer has access. Resolve it in Identity & Access > Orphans.`, status: "TODO", priority: "HIGH", assigneeEmail: rv, dueDate: null, createdByEmail: normEmail(actor), createdAt: nowIso(), updatedAt: nowIso(), completedAt: null, deletedAt: null });
    await identityRemediations.updateOne({ _id: r._id }, { $set: { taskId: String(t.insertedId) } }); n++;
  }
  await audit({ orgId, action: "IDENTITY_REMEDIATION_TASKS_CREATED", actorEmail: actor, metadata: { count: n, projectId: String(pid), reviewer: rv } });
  return { created: n };
}

// ---------------------------------------------------------------------------------------------------------------- manager replacement
/**
 * SOW §33: who (and what) depends on a manager, so a replacement can be chosen deliberately. READ-ONLY analysis: it never assigns.
 * Dependents: people in the same departments who hold a lower role, projects only they belong to, open work they own, temporary grants they sponsor.
 */
export async function analyzeManagerReplacement({ orgId, email: rawEmail }) {
  const email = normEmail(rawEmail); const oid = toObjectId(orgId); const org = await getOrgCollections(); const { identityGrants } = await getIdentityCollections();
  const m = await org.orgMembers.findOne({ orgId: oid, email }); if (!m) return fail("That person is not a member.", 404);
  const deptIds = m.departmentIds || [];
  const roleFields = ["financeRole", "hrRole", "supportRole", "storageRole", "escrowRole", "complianceRole"].filter((f) => m[f] === "manager");
  const peers = deptIds.length ? await org.orgMembers.find({ orgId: oid, status: "active", email: { $ne: email }, departmentIds: { $in: deptIds } }).project({ email: 1, role: 1, ...Object.fromEntries(roleFields.map((f) => [f, 1])) }).limit(200).toArray() : [];
  const candidates = peers.filter((p) => p.role === "admin" || roleFields.some((f) => p[f] === "manager")).map((p) => ({ email: p.email, why: p.role === "admin" ? "admin in the same department" : "already a manager in a matching area" }));
  const projectRows = await org.projectMembers.find({ orgId: oid, email }).toArray();
  const soleProjects = [];
  for (const pr of projectRows) { const others = await org.projectMembers.countDocuments({ orgId: oid, projectId: pr.projectId, email: { $ne: email } }); if (!others) { const p = await org.projects.findOne({ _id: pr.projectId }); soleProjects.push({ projectId: String(pr.projectId), name: p?.name || null }); } }
  const openTasks = await org.tasks.countDocuments({ orgId: oid, assigneeEmail: email, deletedAt: null, status: { $nin: ["DONE", "CANCELLED"] } });
  const openTickets = await org.supportTickets.countDocuments({ orgId: oid, assigneeEmail: email, status: { $nin: ["CLOSED", "RESOLVED"] } });
  const sponsored = await identityGrants.countDocuments({ orgId: oid, source: "TEMPORARY", owner: email, status: "ACTIVE" });
  const pendingApprovals = await org.aiActionRequests.countDocuments({ orgId: oid, status: "PENDING", requestedByEmail: email });
  return { subject: email, managerAreas: roleFields, departments: deptIds.map(String), directDependents: peers.length, soleProjects, openTasks, openTickets, sponsoredTemporaryAccess: sponsored, pendingApprovalsRequested: pendingApprovals, replacementCandidates: candidates, note: "This is analysis only. Nothing was reassigned. Choose a successor and resolve the orphaned items explicitly.", noChangesWereMade: true };
}
