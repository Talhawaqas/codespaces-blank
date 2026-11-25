// src/lib/ops/pm.js -- Manage Orders SOW 6.4: preventive maintenance. A template (asset, branch, every N days, checklist,
// skills, estimated labour, parts) generates Work Orders when due. Generation is idempotent: each (template, due date)
// creates at most one Work Order (unique opsKey2 "pm:<template>:<date>"), so a cron retry or two servers never duplicate.
// Runs from the existing cron infrastructure (/api/cron/ops); no second scheduler.
import { ccol, oid, sid, clean, fail, nowIso, K, opsAccess, audit, opsEntitled, isDate, iso, allowedLocation, denyLocation, scopeFilter } from "./core.js";
import { createJob, ensureOpsIndexes } from "./jobs.js";
import { getOrgCollections } from "../orgs.js";

const view = (t) => ({ id: sid(t._id), title: t.title, warehouseId: sid(t.warehouseId), assetId: sid(t.assetId), everyDays: t.everyDays, nextDue: t.nextDue, leadDays: t.leadDays, checklist: t.checklist || [], skills: t.skills || [], estMinutes: t.estMinutes, category: t.category, active: t.active !== false, autoApprove: !!t.autoApprove, lastGenerated: t.lastGenerated || null });
export async function savePmTemplate({ orgId, membership, actorEmail, id, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "create_wo" }); if (d) return d; await ensureOpsIndexes();
  const title = clean(input.title, 160); if (title.length < 3) return fail("Give the maintenance a title.");
  const every = Number(input.everyDays); if (!(Number.isInteger(every) && every >= 1 && every <= 3650)) return fail("Repeat every 1–3650 days.");
  if (!input.nextDue || !isDate(input.nextDue)) return fail("Set the next due date.");
  if (!allowedLocation(membership, input.warehouseId)) return denyLocation();
  const lead = input.leadDays === undefined ? 3 : Number(input.leadDays); if (!(Number.isInteger(lead) && lead >= 0 && lead <= 60)) return fail("Create it 0–60 days before it is due.");
  const est = input.estMinutes ? Number(input.estMinutes) : null; if (est !== null && !(Number.isInteger(est) && est > 0)) return fail("Estimated duration must be whole minutes.");
  const doc = { title, warehouseId: oid(input.warehouseId), assetId: oid(input.assetId), everyDays: every, nextDue: iso(input.nextDue).slice(0, 10), leadDays: lead, category: clean(input.category, 60) || "Preventive maintenance",
    checklist: (Array.isArray(input.checklist) ? input.checklist : []).slice(0, 60).map((x) => (typeof x === "string" ? x : x.text)).map((t) => clean(t, 200)).filter(Boolean), skills: (Array.isArray(input.skills) ? input.skills : []).map((s) => clean(s, 40).toLowerCase()).filter(Boolean).slice(0, 20), estMinutes: est, active: input.active !== false, autoApprove: !!input.autoApprove, updatedAt: nowIso() };
  const { warehouses } = await getOrgCollections(); if (!await warehouses.findOne({ _id: doc.warehouseId, orgId: oid(orgId) }, { projection: { _id: 1 } })) return fail("Branch not found.", 404);
  const c = await ccol();
  if (id) { const u = await c.findOneAndUpdate({ _id: oid(id), orgId: oid(orgId), kind: K.pm }, { $set: doc }, { returnDocument: "after" }); if (!u) return fail("Template not found.", 404); return { template: view(u) }; }
  const full = { orgId: oid(orgId), kind: K.pm, opsDoc: true, ...doc, createdBy: actorEmail, createdAt: doc.updatedAt };
  const r = await c.insertOne(full); full._id = r.insertedId;
  await audit({ orgId, actorEmail, recordType: "PM_TEMPLATE", recordId: r.insertedId, action: "OPS_PM_TEMPLATE_CREATED", metadata: { title, everyDays: every } });
  return { template: view(full) };
}
export async function listPmTemplates({ orgId, membership }) {
  const d = await opsAccess({ orgId, membership, need: "view_all" }); if (d) return d;
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: K.pm, ...scopeFilter(membership, "warehouseId") }).sort({ nextDue: 1 }).toArray();
  const today = new Date().toISOString().slice(0, 10);
  const overdue = [];
  for (const t of rows) if (t.active !== false && t.nextDue < today) overdue.push({ id: sid(t._id), title: t.title, nextDue: t.nextDue });
  // Generated work orders still open past their due date are overdue maintenance too.
  const late = await c.find({ orgId: oid(orgId), kind: K.job, pmTemplateId: { $ne: null }, dueAt: { $lt: new Date().toISOString() }, status: { $nin: ["COMPLETED", "CLOSED", "CANCELLED"] } }, { projection: { number: 1, title: 1, dueAt: 1 } }).limit(100).toArray();
  return { templates: rows.map(view), overdue, overdueOrders: late.map((j) => ({ id: sid(j._id), number: j.number, title: j.title, dueAt: j.dueAt })) };
}

/** Creates the due Work Orders for one company. System actor; branch/role checks are the template creator's. */
export async function generateDuePm(orgId, now = new Date()) {
  if (!(await opsEntitled(orgId))) return { skipped: true };
  await ensureOpsIndexes();
  const c = await ccol(); let created = 0;
  const templates = await c.find({ orgId: oid(orgId), kind: K.pm, active: { $ne: false } }).toArray();
  for (const t of templates) {
    let due = t.nextDue; let guard = 0;
    while (guard++ < 24) {
      const createBy = new Date(new Date(`${due}T00:00:00.000Z`).getTime() - (t.leadDays || 0) * 86400000);
      if (createBy > now) break;
      const sys = { role: "owner", email: "system:preventive-maintenance", orgId: oid(orgId) };
      const r = await createJob({ orgId, membership: sys, actorEmail: "system:preventive-maintenance", input: { type: "WO", title: `${t.title} (due ${due})`, warehouseId: sid(t.warehouseId), assetId: sid(t.assetId), category: t.category, checklist: t.checklist, skills: t.skills, estMinutes: t.estMinutes, dueAt: `${due}T17:00:00.000Z`, pmTemplateId: sid(t._id), pmKey: `pm:${sid(t._id)}:${due}`, description: `Preventive maintenance generated from template "${t.title}".` } });
      if (!r.error) {
        created++;
        if (t.autoApprove) await c.updateOne({ _id: oid(r.job.id), status: "DRAFT" }, { $set: { status: "READY" }, $push: { history: { from: "DRAFT", to: "READY", action: "auto_approve_pm", by: "system:preventive-maintenance", at: nowIso() } } });
        else await c.updateOne({ _id: oid(r.job.id), status: "DRAFT" }, { $set: { status: "AWAITING_APPROVAL" }, $push: { history: { from: "DRAFT", to: "AWAITING_APPROVAL", action: "submit", by: "system:preventive-maintenance", at: nowIso() } } });
      } else if (r.code !== "DUPLICATE") { console.error("pm generation failed:", r.error); break; }
      due = new Date(new Date(`${due}T00:00:00.000Z`).getTime() + t.everyDays * 86400000).toISOString().slice(0, 10);
    }
    if (due !== t.nextDue) await c.updateOne({ _id: t._id }, { $set: { nextDue: due, lastGenerated: nowIso() } });
  }
  return { created };
}
export async function generateAllPm(now = new Date()) {
  const { orgs } = await getOrgCollections(); const c = await ccol();
  const orgIds = await c.distinct("orgId", { kind: K.pm, active: { $ne: false } });
  let created = 0; for (const id of orgIds) { try { const r = await generateDuePm(sid(id), now); created += r.created || 0; } catch (e) { console.error("pm org failed:", e?.message); } }
  void orgs; return { orgs: orgIds.length, created };
}
