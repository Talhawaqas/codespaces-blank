// src/lib/ops/registers.js -- Manage Orders SOW sections 12 and 17: the Purchase Order register (a READ view over the
// existing Procurement records; creating, approving and receiving stay in Procurement) and the reports/dashboards.
// Every report reads authoritative data and applies company, branch and department scoping.
import { getOrgCollections } from "../orgs.js";
import { canAccessDepartment, canManageOrg } from "../orgGates.js";
import { ccol, oid, sid, fail, K, opsAccess, can, scopeFilter, allowedLocation, denyLocation, minutesBetween } from "./core.js";
import { labourFromEvents } from "./activity.js";

export async function poRegister({ orgId, membership, q, status, supplierId, from, to, limit = 50, skip = 0 }) {
  const d = await opsAccess({ orgId, membership, need: "view_all" }); if (d) return d;
  const { purchaseOrders, suppliers } = await getOrgCollections();
  const f = { orgId: oid(orgId), deletedAt: null };
  if (!canManageOrg(membership)) { const depts = (membership.departmentIds || []).map((x) => oid(x)).filter(Boolean); f.departmentId = { $in: depts }; }
  if (status) f.status = { $in: String(status).split(",") }; if (supplierId) f.supplierId = oid(supplierId);
  if (from || to) f.createdAt = { ...(from ? { $gte: new Date(from).toISOString() } : {}), ...(to ? { $lte: new Date(to).toISOString() } : {}) };
  let supplierIds = null;
  if (q) { const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i"); supplierIds = (await suppliers.find({ orgId: oid(orgId), name: rx }, { projection: { _id: 1 } }).limit(50).toArray()).map((s) => s._id); f.$or = [{ poNumber: rx }, { supplierId: { $in: supplierIds } }, { "items.description": rx }]; }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const [rows, total] = await Promise.all([purchaseOrders.find(f).sort({ createdAt: -1 }).skip(Math.max(Number(skip) || 0, 0)).limit(lim).toArray(), purchaseOrders.countDocuments(f)]);
  const names = new Map((await suppliers.find({ _id: { $in: rows.map((r) => r.supplierId).filter(Boolean) } }, { projection: { name: 1 } }).toArray()).map((s) => [sid(s._id), s.name]));
  const c = await ccol(); const linked = await c.find({ orgId: oid(orgId), kind: K.job, poIds: { $in: rows.map((r) => r._id) } }, { projection: { number: 1, poIds: 1 } }).toArray();
  return { orders: rows.map((po) => {
    const qty = (po.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0); const rec = (po.items || []).reduce((s, i) => s + (Number(i.receivedQuantity) || 0), 0);
    const totalAmt = po.total ?? (po.items || []).reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0);
    return { id: sid(po._id), number: po.poNumber || `PO-${sid(po._id).slice(-6).toUpperCase()}`, supplier: names.get(sid(po.supplierId)) || null, supplierId: sid(po.supplierId), departmentId: sid(po.departmentId), status: po.status, createdAt: po.createdAt, expectedDeliveryDate: po.expectedDeliveryDate || null, currency: po.currency, total: Math.round(totalAmt * 100) / 100, receivedPct: qty ? Math.round((rec / qty) * 100) : 0, linkedOrders: linked.filter((j) => (j.poIds || []).some((x) => sid(x) === sid(po._id))).map((j) => ({ id: sid(j._id), number: j.number })), overdue: !!(po.expectedDeliveryDate && new Date(po.expectedDeliveryDate) < new Date() && !["RECEIVED", "CANCELLED", "REJECTED"].includes(po.status)) };
  }), total };
}

/** Operations manager dashboard (SOW 17). */
export async function opsDashboard({ orgId, membership, warehouseId, from, to }) {
  const d = await opsAccess({ orgId, membership, need: "view_all" }); if (d) return d;
  if (warehouseId && !allowedLocation(membership, warehouseId)) return denyLocation();
  const c = await ccol(); const now = new Date();
  const base = { orgId: oid(orgId), kind: K.job, ...scopeFilter(membership, "warehouseId"), ...(warehouseId ? { warehouseId: oid(warehouseId) } : {}) };
  const jobs = await c.find(base, { projection: { history: 0, notes: 0, evidence: 0 } }).limit(5000).toArray();
  const open = jobs.filter((j) => !["CLOSED", "CANCELLED", "INVOICED", "COMPLETED"].includes(j.status));
  const today = now.toISOString().slice(0, 10);
  const range = (j) => (!from || j.createdAt >= new Date(from).toISOString()) && (!to || j.createdAt <= new Date(to).toISOString());
  const done = jobs.filter((j) => ["COMPLETED", "CLOSED", "INVOICED"].includes(j.status) && range(j));
  const turnaround = done.map((j) => { const end = (j.history || []).find((h) => ["COMPLETED", "READY_FOR_COLLECTION"].includes(h.to))?.at || j.updatedAt; return minutesBetween(j.createdAt, end); }).filter((x) => x > 0);
  const reworked = done.filter((j) => (j.history || []).some((h) => ["inspect_fail", "qc_fail"].includes(h.action))).length;
  const assetsDone = done.filter((j) => j.assetId); const repeats = assetsDone.filter((j) => assetsDone.some((o) => o !== j && sid(o.assetId) === sid(j.assetId) && Math.abs(new Date(o.createdAt) - new Date(j.createdAt)) < 30 * 86400000)).length;
  const est = done.reduce((s, j) => s + (j.estMinutes || 0), 0); const act = done.reduce((s, j) => s + (j.workers || []).reduce((t, w) => t + (w.minutes || 0), 0), 0);
  const byTech = {}; for (const j of open) for (const a of (j.assignments || []).filter((x) => x.active)) byTech[a.email] = (byTech[a.email] || 0) + 1;
  const showCost = can(membership, "costs");
  return {
    open: open.length, openWO: open.filter((j) => j.type === "WO").length, openRO: open.filter((j) => j.type === "RO").length,
    unassigned: open.filter((j) => !(j.assigneeEmails || []).length).length,
    scheduledToday: open.filter((j) => (j.plannedStart || "").slice(0, 10) === today).length,
    inProgress: open.filter((j) => (j.workers || []).some((w) => w.state === "ACTIVE")).length,
    awaitingParts: open.filter((j) => j.status === "AWAITING_PARTS").length,
    awaitingCustomerApproval: open.filter((j) => j.status === "AWAITING_APPROVAL" && j.type === "RO").length,
    awaitingInspection: open.filter((j) => ["AWAITING_INSPECTION", "QUALITY_CHECK"].includes(j.status)).length,
    overdue: open.filter((j) => j.dueAt && new Date(j.dueAt) < now).length,
    completed: done.length, averageTurnaroundHours: turnaround.length ? Math.round(turnaround.reduce((a, b) => a + b, 0) / turnaround.length / 6) / 10 : null,
    reworkRatePct: done.length ? Math.round((reworked / done.length) * 100) : null, repeatRepairRatePct: assetsDone.length ? Math.round((repeats / assetsDone.length) * 100) : null,
    labour: { estimatedMinutes: est, actualMinutes: act, variancePct: est ? Math.round(((act - est) / est) * 100) : null },
    cost: showCost ? { estimated: Math.round(done.reduce((s, j) => s + (j.estCost || 0), 0) * 100) / 100, partsUsed: Math.round(done.reduce((s, j) => s + (j.parts || []).reduce((t, p) => t + (p.consumed - p.returned) * (p.unitCost || 0), 0), 0) * 100) / 100 } : null,
    workloadByTechnician: byTech,
  };
}

/** Technician report: attendance hours (from attendance punches) vs job labour hours (from job activity), kept apart. */
export async function technicianReport({ orgId, membership, email, from, to }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const who = String(email || membership.email).toLowerCase();
  if (who !== membership.email && !can(membership, "view_all")) return fail("You can see only your own figures.", 403);
  const start = from ? new Date(from) : new Date(Date.now() - 7 * 86400000); const end = to ? new Date(to) : new Date();
  const { computeTimesheet, getTimeSettings, K: WK } = await import("../workforce/time.js");
  const c = await ccol();
  const punches = await c.find({ orgId: oid(orgId), kind: WK.punch, email: who, at: { $gte: start.toISOString(), $lte: end.toISOString() }, voided: { $ne: true } }).sort({ at: 1 }).toArray();
  const sheet = computeTimesheet(punches, [], await getTimeSettings(orgId));
  const acts = await c.find({ orgId: oid(orgId), kind: K.act, email: who, at: { $gte: start.toISOString(), $lte: end.toISOString() } }).toArray();
  const byJob = new Map(); for (const a of acts) { const k = sid(a.jobId); byJob.set(k, [...(byJob.get(k) || []), a]); }
  const jobs = await c.find({ orgId: oid(orgId), kind: K.job, _id: { $in: [...byJob.keys()].map(oid) } }, { projection: { number: 1, category: 1, status: 1, dueAt: 1 } }).toArray();
  const labourBy = jobs.map((j) => ({ number: j.number, category: j.category, minutes: (labourFromEvents(byJob.get(sid(j._id)) || [], end)[who] || { minutes: 0 }).minutes }));
  const byType = labourBy.reduce((m, x) => { m[x.category] = (m[x.category] || 0) + x.minutes; return m; }, {});
  const assigned = await c.find({ orgId: oid(orgId), kind: K.job, assigneeEmails: who }, { projection: { status: 1, dueAt: 1 } }).toArray();
  const corrections = await c.countDocuments({ orgId: oid(orgId), kind: WK.corr, email: who, createdAt: { $gte: start.toISOString() } });
  const exc = await c.countDocuments({ orgId: oid(orgId), kind: K.exc, email: who, createdAt: { $gte: start.toISOString() } });
  return { email: who, from: start.toISOString(), to: end.toISOString(), attendanceMinutes: Number.isFinite(sheet?.totalHours) ? Math.round(sheet.totalHours * 60) : null, labourMinutes: labourBy.reduce((s, x) => s + x.minutes, 0), jobs: labourBy, minutesByJobType: byType, completed: assigned.filter((j) => ["COMPLETED", "CLOSED", "INVOICED"].includes(j.status)).length, overdue: assigned.filter((j) => j.dueAt && new Date(j.dueAt) < new Date() && !["COMPLETED", "CLOSED", "INVOICED", "CANCELLED"].includes(j.status)).length, corrections, reviewItems: exc };
}
export { canAccessDepartment };

/** Small pickers for the Manage Orders screens (tenant-scoped, minimal fields, role-checked). */
export async function lookups({ orgId, membership, kind, q }) {
  const need = { products: "any", contacts: "view_all", members: "view_all", departments: "any", expenses: "finance", branches: "any" }[kind];
  if (!need) return fail("Unknown lookup.");
  const d = await opsAccess({ orgId, membership, need }); if (d) return d;
  const col = await getOrgCollections(); const o = oid(orgId);
  const rx = q ? new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i") : null;
  if (kind === "products") return { items: (await col.products.find({ orgId: o, deletedAt: null, ...(rx ? { $or: [{ name: rx }, { sku: rx }] } : {}) }, { projection: { name: 1, sku: 1, unitPrice: 1 } }).limit(30).toArray()).map((p) => ({ id: sid(p._id), name: p.name, sku: p.sku || null, unitPrice: p.unitPrice ?? null })) };
  if (kind === "contacts") return { items: (await col.crmContacts.find({ orgId: o, deletedAt: null, ...(rx ? { $or: [{ name: rx }, { email: rx }, { phone: rx }] } : {}) }, { projection: { name: 1, email: 1, phone: 1 } }).limit(30).toArray()).map((x) => ({ id: sid(x._id), name: x.name, email: x.email || null, phone: x.phone || null })) };
  if (kind === "members") return { items: (await col.orgMembers.find({ orgId: o, status: "active" }, { projection: { email: 1, role: 1, opsRole: 1, financeRole: 1 } }).limit(500).toArray()).map((m) => ({ email: m.email, role: m.role, opsRole: m.opsRole || null, financeRole: m.financeRole || null })) };
  if (kind === "departments") return { items: (await col.departments.find({ orgId: o }, { projection: { name: 1 } }).toArray()).filter((x) => canAccessDepartment(membership, sid(x._id))).map((x) => ({ id: sid(x._id), name: x.name })) };
  if (kind === "branches") { const ids = (await import("./core.js")).memberLocations(membership); return { items: (await col.warehouses.find({ orgId: o, ...(ids ? { _id: { $in: ids.map(oid) } } : {}) }, { projection: { name: 1 } }).toArray()).map((w) => ({ id: sid(w._id), name: w.name })) }; }
  if (kind === "expenses") return { items: (await col.expenses.find({ orgId: o, deletedAt: null, status: "APPROVED", ...(rx ? { vendor: rx } : {}) }, { projection: { vendor: 1, amount: 1, currency: 1, departmentId: 1, expenseDate: 1 } }).sort({ createdAt: -1 }).limit(50).toArray()).filter((x) => canAccessDepartment(membership, sid(x.departmentId))).map((x) => ({ id: sid(x._id), vendor: x.vendor, amount: x.amount, currency: x.currency, date: x.expenseDate })) };
}
