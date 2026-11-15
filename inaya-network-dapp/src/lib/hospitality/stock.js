// src/lib/hospitality/stock.js
//
// Ingredient stock for a restaurant location (SOW 11, 12): overview, stock counts, wastage, reorder suggestions,
// supplier preferences and delivery discrepancies. Inventory stays the system of record: every quantity change
// goes through recordStockMovement(), purchase requests go through the existing reorder + approval flow, and
// receiving itself stays in Procurement. Nothing here creates or submits a purchase order.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { recordStockMovement, isLowStock } from "../inventory.js";
import { suggestedReorderQuantity, findOpenReorderRequest, draftReorderRequest } from "../inventory-reorder.js";
import { hcol, KINDS, CAN, fail, clean, nowIso, oid, sid, intIn, logH, emitH, notifyRoles, requireLocation, nextNumber } from "./store.js";

export const WASTAGE_REASONS = ["spoilage", "preparation_loss", "damage", "expired", "other"];
export const SUPPLIER_CATEGORIES = ["produce", "meat", "seafood", "dairy", "bakery", "dry_goods", "beverages", "packaging", "cleaning", "other"];
export const DEFAULT_STOCK_SETTINGS = { wastageApprovalQuantity: null, countVarianceApprovalPercent: 10 };

async function stockLocation(orgId, membership, locationId) {
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  if (!got.location.warehouseId) return fail("This location isn't linked to a stock location yet. A manager can link one in Settings > Locations.", 409);
  return got;
}

async function getStockSettings(orgId) {
  const c = await hcol();
  const s = await c.findOne({ orgId: toObjectId(orgId), kind: KINDS.settings });
  return { ...DEFAULT_STOCK_SETTINGS, ...(s?.stock || {}) };
}

export async function updateStockSettings({ orgId, membership, actorEmail, wastageApprovalQuantity, countVarianceApprovalPercent }) {
  if (!CAN.manage(membership)) return fail("Only a manager can change stock rules.", 403);
  const set = {};
  if (wastageApprovalQuantity !== undefined) { const n = wastageApprovalQuantity === null || wastageApprovalQuantity === "" ? null : Number(wastageApprovalQuantity); if (n !== null && !(Number.isFinite(n) && n > 0)) return fail("The wastage approval quantity must be a positive number, or empty for none."); set["stock.wastageApprovalQuantity"] = n; }
  if (countVarianceApprovalPercent !== undefined) { const n = intIn(countVarianceApprovalPercent, 0, 100); if (n === null) return fail("The count variance percentage must be from 0 to 100."); set["stock.countVarianceApprovalPercent"] = n; }
  await (await hcol()).updateOne({ orgId: toObjectId(orgId), kind: KINDS.settings }, { $set: { ...set, updatedAt: nowIso() }, $setOnInsert: { orgId: toObjectId(orgId), kind: KINDS.settings, createdAt: nowIso() } }, { upsert: true });
  await logH({ orgId, recordType: "SETTINGS", recordId: null, actorEmail, action: "STOCK_RULES_CHANGED", metadata: set });
  return { settings: await getStockSettings(orgId) };
}

/** Stock at this location's warehouse with low-stock flags, open reorder requests and supplier preferences. */
export async function stockOverview({ orgId, membership, locationId, q, lowOnly }) {
  if (!CAN.stockRead(membership)) return fail("You don't have access to stock.", 403);
  const got = await stockLocation(orgId, membership, locationId);
  if (got.error) return got;
  const { products, stockLevels, purchaseRequests, stockLots } = await getOrgCollections();
  const org = toObjectId(orgId), wh = got.location.warehouseId;
  const filter = { orgId: org, deletedAt: null, status: { $ne: "ARCHIVED" } };
  if (q) { const s = clean(q, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); filter.$or = [{ name: new RegExp(s, "i") }, { sku: new RegExp(s, "i") }]; }
  const list = await products.find(filter).sort({ name: 1 }).limit(1000).toArray();
  const ids = list.map((p) => p._id);
  const c = await hcol();
  const [levels, open, prefs, lots] = await Promise.all([
    stockLevels.find({ orgId: org, warehouseId: wh, productId: { $in: ids } }).toArray(),
    purchaseRequests.find({ orgId: org, deletedAt: null, reorderForProductId: { $in: ids }, status: { $in: ["DRAFT", "SUBMITTED", "APPROVED"] } }).project({ reorderForProductId: 1, status: 1 }).toArray(),
    c.find({ orgId: org, kind: KINDS.supplierPref, productId: { $in: ids } }).toArray(),
    stockLots.find({ orgId: org, warehouseId: wh, productId: { $in: ids }, quantity: { $gt: 0 }, expiryDate: { $ne: null } }).project({ productId: 1, expiryDate: 1 }).sort({ expiryDate: 1 }).toArray(),
  ]);
  const lv = new Map(levels.map((l) => [String(l.productId), l.quantity])), op = new Map(open.map((r) => [String(r.reorderForProductId), r])), pf = new Map(prefs.map((p) => [String(p.productId), p]));
  const exp = new Map(); for (const l of lots) if (!exp.has(String(l.productId))) exp.set(String(l.productId), l.expiryDate);
  const rows = list.map((p) => { const on = lv.get(String(p._id)) || 0; const low = isLowStock(p, on); const pr = pf.get(String(p._id)); const o = op.get(String(p._id)); return { productId: String(p._id), sku: p.sku, name: p.name, unit: p.unit || "unit", onHand: on, reorderThreshold: p.reorderThreshold || 0, low, suggestedReorderQuantity: low ? suggestedReorderQuantity(p, on) : null, openRequest: o ? { id: String(o._id), status: o.status } : null, nextExpiry: exp.get(String(p._id)) || null, supplier: pr ? { supplierId: sid(pr.supplierId), category: pr.category || null, leadTimeDays: pr.leadTimeDays ?? null, minOrderQuantity: pr.minOrderQuantity ?? null, deliveryDays: pr.deliveryDays || null } : null }; });
  return { warehouseId: String(wh), products: lowOnly ? rows.filter((r) => r.low) : rows, lowCount: rows.filter((r) => r.low).length, legend: { onHand: "Actual stock at this location", suggestedReorderQuantity: "A suggestion from the reorder level, not an order" } };
}

/** Drafts a purchase request through the existing reorder flow (which then goes to the existing approval). */
export async function draftReorder({ orgId, membership, actorEmail, locationId, productId }) {
  if (!CAN.reorder(membership)) return fail("You don't have permission to raise purchase requests.", 403);
  const got = await stockLocation(orgId, membership, locationId);
  if (got.error) return got;
  const r = await draftReorderRequest({ orgId, productId, actorEmail, source: "hospitality" });
  if (r.error) return r;
  const c = await hcol();
  const pref = await c.findOne({ orgId: toObjectId(orgId), kind: KINDS.supplierPref, productId: oid(productId) });
  if (r.created && pref?.supplierId) { const { purchaseRequests } = await getOrgCollections(); await purchaseRequests.updateOne({ _id: r.request._id, orgId: toObjectId(orgId), status: "DRAFT" }, { $set: { supplierId: pref.supplierId } }); }
  await logH({ orgId, recordType: "REORDER", recordId: r.request._id, actorEmail, action: r.created ? "REORDER_REQUEST_DRAFTED" : "REORDER_REQUEST_ALREADY_OPEN", metadata: { productId: String(productId), locationId: String(got.location._id) } });
  return { request: { id: String(r.request._id), title: r.request.title, status: r.request.status, quantity: r.request.reorderQuantity ?? null }, created: r.created, note: "This is a draft purchase request. It still has to be submitted and approved in Procurement." };
}

export async function saveSupplierPreference({ orgId, membership, actorEmail, productId, supplierId, category, leadTimeDays, minOrderQuantity, deliveryDays, notes }) {
  if (!CAN.reorder(membership)) return fail("You don't have permission to change supplier details.", 403);
  const { products, suppliers } = await getOrgCollections();
  const org = toObjectId(orgId);
  const p = await products.findOne({ _id: oid(productId), orgId: org, deletedAt: null });
  if (!p) return fail("Product not found.", 404);
  let sup = null;
  if (supplierId) { sup = await suppliers.findOne({ _id: oid(supplierId), orgId: org, deletedAt: null }); if (!sup) return fail("Supplier not found.", 404); }
  if (category && !SUPPLIER_CATEGORIES.includes(category)) return fail(`Category must be one of: ${SUPPLIER_CATEGORIES.join(", ")}.`);
  const set = { supplierId: sup?._id || null, category: category || null, leadTimeDays: leadTimeDays === "" || leadTimeDays === null || leadTimeDays === undefined ? null : intIn(leadTimeDays, 0, 365), minOrderQuantity: minOrderQuantity === "" || minOrderQuantity === null || minOrderQuantity === undefined ? null : Number(minOrderQuantity) > 0 ? Number(minOrderQuantity) : null, deliveryDays: clean(deliveryDays, 120) || null, notes: clean(notes, 500) || null, updatedAt: nowIso(), updatedByEmail: actorEmail };
  await (await hcol()).updateOne({ orgId: org, kind: KINDS.supplierPref, productId: p._id }, { $set: set, $setOnInsert: { orgId: org, kind: KINDS.supplierPref, productId: p._id, createdAt: nowIso() } }, { upsert: true });
  return { ok: true };
}

// ---- wastage ----
/** Pure: does this wastage record need a manager's approval before stock is reduced? */
export const wastageNeedsApproval = (quantity, settings) => settings?.wastageApprovalQuantity !== null && settings?.wastageApprovalQuantity !== undefined && quantity >= settings.wastageApprovalQuantity;

const wasteView = (w, names) => ({ id: sid(w._id), ref: w.ref, locationId: sid(w.locationId), productId: sid(w.productId), productName: names?.get(String(w.productId))?.name || null, unit: w.unit, quantity: w.quantity, reason: w.reason, note: w.note || null, imageDocumentId: sid(w.imageDocumentId), status: w.status, at: w.at, recordedByEmail: w.recordedByEmail, decidedByEmail: w.decidedByEmail || null, decidedAt: w.decidedAt || null, decisionNote: w.decisionNote || null });

async function applyWastage(orgId, w, actorEmail) {
  return recordStockMovement({ orgId, productId: w.productId, warehouseId: w.warehouseId, delta: -w.quantity, type: "ADJUSTMENT", note: `Wastage ${w.ref}: ${w.reason.replace(/_/g, " ")}${w.note ? ` (${w.note})` : ""}`, actorEmail });
}

export async function recordWastage({ orgId, membership, actorEmail, locationId, productId, quantity, reason, note, imageDocumentId, at }) {
  if (!CAN.stockWrite(membership)) return fail("You don't have permission to record wastage.", 403);
  const got = await stockLocation(orgId, membership, locationId);
  if (got.error) return got;
  const { products } = await getOrgCollections();
  const p = await products.findOne({ _id: oid(productId), orgId: toObjectId(orgId), deletedAt: null });
  if (!p) return fail("Ingredient not found.", 404);
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return fail("Quantity must be more than zero.");
  if (!WASTAGE_REASONS.includes(reason)) return fail(`Reason must be one of: ${WASTAGE_REASONS.join(", ")}.`);
  if (reason === "other" && !clean(note, 300)) return fail("Add a note explaining the reason.");
  const when = at && !isNaN(new Date(at)) && new Date(at) <= new Date() ? new Date(at).toISOString() : nowIso();
  const settings = await getStockSettings(orgId);
  const pending = wastageNeedsApproval(q, settings);
  const seq = await nextNumber(orgId, "wastage");
  const doc = { orgId: toObjectId(orgId), kind: KINDS.wastage, locationId: got.location._id, warehouseId: got.location.warehouseId, ref: `W-${String(seq).padStart(5, "0")}`, productId: p._id, unit: p.unit || "unit", quantity: q, reason, note: clean(note, 300) || null, imageDocumentId: oid(imageDocumentId), at: when, date: when.slice(0, 10), status: pending ? "PENDING_APPROVAL" : "RECORDED", recordedByEmail: actorEmail, createdAt: nowIso(), updatedAt: nowIso() };
  const c = await hcol();
  if (!pending) {
    const mv = await applyWastage(orgId, doc, actorEmail);
    if (mv.error) return mv;
    doc.movementId = mv.movement._id;
  }
  doc._id = (await c.insertOne(doc)).insertedId;
  await logH({ orgId, recordType: "WASTAGE", recordId: doc._id, actorEmail, action: pending ? "WASTAGE_SUBMITTED_FOR_APPROVAL" : "WASTAGE_RECORDED", metadata: { ref: doc.ref, productId: String(p._id), quantity: q, unit: doc.unit, reason, locationId: String(got.location._id) } });
  emitH(orgId, "wastage.recorded", doc._id, { wastage: { id: String(doc._id), ref: doc.ref, productName: p.name, quantity: q, unit: doc.unit, reason, status: doc.status, locationId: String(got.location._id) } });
  if (pending) await notifyRoles({ orgId, locationId: got.location._id, roles: [], type: "wastage_approval", sourceId: doc._id, title: "Wastage is waiting for approval", body: `${doc.ref}: ${q} ${doc.unit} of ${p.name} (${reason.replace(/_/g, " ")}).`, severity: "warning" });
  return { wastage: wasteView(doc, new Map([[String(p._id), p]])), stockReduced: !pending };
}

export async function decideWastage({ orgId, membership, actorEmail, id, approve, note }) {
  if (!CAN.stockApprove(membership)) return fail("Only a manager can approve wastage.", 403);
  const c = await hcol();
  const w = await c.findOne({ _id: oid(id), orgId: toObjectId(orgId), kind: KINDS.wastage });
  if (!w) return fail("Wastage record not found.", 404);
  const got = await requireLocation(orgId, membership, w.locationId);
  if (got.error) return fail("Wastage record not found.", 404);
  if (w.status !== "PENDING_APPROVAL") return fail("This record has already been decided.", 409);
  if (w.recordedByEmail === actorEmail) return fail("Someone else has to approve wastage you recorded.", 403);
  // Claim the decision first so two approvers can't both reduce stock.
  const claim = await c.updateOne({ _id: w._id, status: "PENDING_APPROVAL" }, { $set: { status: approve ? "APPROVED" : "REJECTED", decidedByEmail: actorEmail, decidedAt: nowIso(), decisionNote: clean(note, 300) || null, updatedAt: nowIso() } });
  if (!claim.modifiedCount) return fail("This record has just been decided by someone else.", 409);
  if (approve) {
    const mv = await applyWastage(orgId, w, actorEmail);
    if (mv.error) { await c.updateOne({ _id: w._id }, { $set: { status: "PENDING_APPROVAL" }, $unset: { decidedByEmail: "", decidedAt: "", decisionNote: "" } }); return mv; }
    await c.updateOne({ _id: w._id }, { $set: { movementId: mv.movement._id } });
  }
  await logH({ orgId, recordType: "WASTAGE", recordId: w._id, actorEmail, action: approve ? "WASTAGE_APPROVED" : "WASTAGE_REJECTED", previousState: "PENDING_APPROVAL", newState: approve ? "APPROVED" : "REJECTED", metadata: { ref: w.ref, quantity: w.quantity } });
  return { ok: true, status: approve ? "APPROVED" : "REJECTED", stockReduced: !!approve };
}

export async function listWastage({ orgId, membership, locationId, from, to, status }) {
  if (!CAN.stockRead(membership)) return fail("You don't have access to stock.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const filter = { orgId: toObjectId(orgId), kind: KINDS.wastage, locationId: got.location._id };
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || "")) filter.date = { $gte: from, ...(/^\d{4}-\d{2}-\d{2}$/.test(to || "") ? { $lte: to } : {}) };
  if (status) filter.status = status;
  const rows = await (await hcol()).find(filter).sort({ at: -1 }).limit(300).toArray();
  const { products } = await getOrgCollections();
  const names = new Map((await products.find({ _id: { $in: rows.map((r) => r.productId) }, orgId: toObjectId(orgId) }).project({ name: 1 }).toArray()).map((p) => [String(p._id), p]));
  return { wastage: rows.map((w) => wasteView(w, names)), reasons: WASTAGE_REASONS, settings: await getStockSettings(orgId) };
}

// ---- stock counts ----
/** Pure: variance lines for a count; `needsApproval` when any line differs by more than the allowed percentage. */
export function countVariance(lines, thresholdPercent) {
  const out = lines.map((l) => { const diff = l.counted - l.system; const pct = l.system === 0 ? (diff === 0 ? 0 : 100) : Math.abs(diff / l.system) * 100; return { ...l, difference: diff, variancePercent: Math.round(pct * 10) / 10 }; });
  return { lines: out, needsApproval: out.some((l) => l.difference !== 0 && l.variancePercent > thresholdPercent), changed: out.filter((l) => l.difference !== 0).length };
}

export async function submitStockCount({ orgId, membership, actorEmail, locationId, lines, note }) {
  if (!CAN.stockWrite(membership)) return fail("You don't have permission to count stock.", 403);
  const got = await stockLocation(orgId, membership, locationId);
  if (got.error) return got;
  if (!Array.isArray(lines) || !lines.length) return fail("Enter at least one counted quantity.");
  if (lines.length > 500) return fail("A count may have at most 500 lines.");
  const { products, stockLevels } = await getOrgCollections();
  const org = toObjectId(orgId);
  const ids = lines.map((l) => oid(l?.productId)).filter(Boolean);
  if (new Set(ids.map(String)).size !== lines.length) return fail("Each product may appear once in a count.");
  const [ps, lv] = await Promise.all([products.find({ _id: { $in: ids }, orgId: org, deletedAt: null }).toArray(), stockLevels.find({ orgId: org, warehouseId: got.location.warehouseId, productId: { $in: ids } }).toArray()]);
  if (ps.length !== ids.length) return fail("One of the counted products wasn't found.", 404);
  const sys = new Map(lv.map((l) => [String(l.productId), l.quantity]));
  const clean2 = [];
  for (const l of lines) { const n = Number(l.counted); if (!Number.isFinite(n) || n < 0) return fail("Counted quantities must be zero or more."); const p = ps.find((x) => String(x._id) === String(l.productId)); clean2.push({ productId: p._id, name: p.name, unit: p.unit || "unit", system: sys.get(String(p._id)) || 0, counted: n }); }
  const settings = await getStockSettings(orgId);
  const v = countVariance(clean2, settings.countVarianceApprovalPercent);
  const seq = await nextNumber(orgId, "count");
  const doc = { orgId: org, kind: KINDS.count, locationId: got.location._id, warehouseId: got.location.warehouseId, ref: `C-${String(seq).padStart(5, "0")}`, lines: v.lines, note: clean(note, 300) || null, status: v.changed === 0 ? "NO_CHANGE" : v.needsApproval ? "PENDING_APPROVAL" : "SUBMITTED", countedByEmail: actorEmail, date: nowIso().slice(0, 10), createdAt: nowIso(), updatedAt: nowIso() };
  const c = await hcol();
  doc._id = (await c.insertOne(doc)).insertedId;
  await logH({ orgId, recordType: "STOCK_COUNT", recordId: doc._id, actorEmail, action: "STOCK_COUNT_SUBMITTED", metadata: { ref: doc.ref, lines: v.lines.length, changed: v.changed, needsApproval: v.needsApproval } });
  if (doc.status === "SUBMITTED") return applyStockCount({ orgId, membership, actorEmail, id: doc._id, auto: true });
  if (doc.status === "PENDING_APPROVAL") await notifyRoles({ orgId, locationId: got.location._id, roles: [], type: "count_approval", sourceId: doc._id, title: "A stock count is waiting for approval", body: `${doc.ref}: ${v.changed} line${v.changed === 1 ? "" : "s"} differ from the system.`, severity: "warning" });
  return { count: countView(doc) };
}

const countView = (d) => ({ id: sid(d._id), ref: d.ref, locationId: sid(d.locationId), status: d.status, date: d.date, note: d.note || null, countedByEmail: d.countedByEmail, approvedByEmail: d.approvedByEmail || null, lines: d.lines.map((l) => ({ ...l, productId: String(l.productId) })) });

/** Applies a count's differences as ADJUSTMENT movements. Large variances need a manager who didn't do the count. */
export async function applyStockCount({ orgId, membership, actorEmail, id, auto = false, reject = false }) {
  const c = await hcol();
  const d = await c.findOne({ _id: oid(id), orgId: toObjectId(orgId), kind: KINDS.count });
  if (!d) return fail("Stock count not found.", 404);
  const got = await requireLocation(orgId, membership, d.locationId);
  if (got.error) return fail("Stock count not found.", 404);
  const from = auto ? "SUBMITTED" : "PENDING_APPROVAL";
  if (d.status !== from) return fail("This count has already been dealt with.", 409);
  if (!auto) {
    if (!CAN.stockApprove(membership)) return fail("Only a manager can approve a stock count.", 403);
    if (d.countedByEmail === actorEmail) return fail("Someone else has to approve a count you did.", 403);
  }
  const claim = await c.updateOne({ _id: d._id, status: from }, { $set: { status: reject ? "REJECTED" : "APPLYING", approvedByEmail: auto ? null : actorEmail, updatedAt: nowIso() } });
  if (!claim.modifiedCount) return fail("This count has just been dealt with by someone else.", 409);
  if (reject) { await logH({ orgId, recordType: "STOCK_COUNT", recordId: d._id, actorEmail, action: "STOCK_COUNT_REJECTED", metadata: { ref: d.ref } }); return { count: countView({ ...d, status: "REJECTED" }) }; }
  const errors = [];
  for (const l of d.lines.filter((x) => x.difference !== 0)) {
    const mv = await recordStockMovement({ orgId, productId: l.productId, warehouseId: d.warehouseId, delta: l.difference, type: "ADJUSTMENT", note: `Stock count ${d.ref}`, actorEmail });
    if (mv.error) errors.push({ productId: String(l.productId), error: mv.error });
  }
  const status = errors.length ? "APPLIED_WITH_ERRORS" : "APPLIED";
  await c.updateOne({ _id: d._id }, { $set: { status, errors, appliedAt: nowIso() } });
  await logH({ orgId, recordType: "STOCK_COUNT", recordId: d._id, actorEmail, action: "STOCK_COUNT_APPLIED", metadata: { ref: d.ref, adjusted: d.lines.filter((x) => x.difference !== 0).length - errors.length, errors: errors.length } });
  return { count: countView({ ...d, status, approvedByEmail: auto ? null : actorEmail }), errors };
}

export async function listStockCounts({ orgId, membership, locationId }) {
  if (!CAN.stockRead(membership)) return fail("You don't have access to stock.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const rows = await (await hcol()).find({ orgId: toObjectId(orgId), kind: KINDS.count, locationId: got.location._id }).sort({ createdAt: -1 }).limit(60).toArray();
  return { counts: rows.map(countView) };
}

// ---- delivery receiving: checklist and discrepancies (SOW 12) ----
export const RECEIVING_CHECKS = ["quantities_match", "packaging_intact", "temperature_ok", "use_by_dates_ok", "invoice_matches_order"];

export async function recordReceiving({ orgId, membership, actorEmail, locationId, purchaseOrderId, checks, discrepancies, note }) {
  if (!CAN.stockWrite(membership)) return fail("You don't have permission to record deliveries.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const { purchaseOrders } = await getOrgCollections();
  const org = toObjectId(orgId);
  const po = await purchaseOrders.findOne({ _id: oid(purchaseOrderId), orgId: org, deletedAt: null });
  if (!po) return fail("Purchase order not found.", 404);
  const checklist = Object.fromEntries(RECEIVING_CHECKS.map((k) => [k, checks?.[k] === true ? true : checks?.[k] === false ? false : null]));
  const issues = [];
  for (const d of Array.isArray(discrepancies) ? discrepancies.slice(0, 100) : []) {
    const desc = clean(d?.description, 200);
    const expected = Number(d?.expectedQuantity), received = Number(d?.receivedQuantity), damaged = Number(d?.damagedQuantity || 0);
    if (!desc || ![expected, received, damaged].every((n) => Number.isFinite(n) && n >= 0)) return fail("Each discrepancy needs a description and quantities of zero or more.");
    issues.push({ productId: oid(d.productId), description: desc, expectedQuantity: expected, receivedQuantity: received, damagedQuantity: damaged, note: clean(d.note, 300) || null });
  }
  const failed = Object.values(checklist).some((v) => v === false);
  const seq = await nextNumber(orgId, "receiving");
  const doc = { orgId: org, kind: KINDS.receiving, locationId: got.location._id, ref: `D-${String(seq).padStart(5, "0")}`, purchaseOrderId: po._id, supplierId: po.supplierId || null, checklist, discrepancies: issues, note: clean(note, 500) || null, status: issues.length || failed ? "OPEN" : "CLEAN", recordedByEmail: actorEmail, date: nowIso().slice(0, 10), createdAt: nowIso(), updatedAt: nowIso() };
  const c = await hcol();
  doc._id = (await c.insertOne(doc)).insertedId;
  await logH({ orgId, recordType: "RECEIVING", recordId: doc._id, actorEmail, action: doc.status === "OPEN" ? "DELIVERY_DISCREPANCY_RECORDED" : "DELIVERY_CHECKED", metadata: { ref: doc.ref, purchaseOrderId: String(po._id), discrepancies: issues.length } });
  if (doc.status === "OPEN") {
    emitH(orgId, "delivery.discrepancy", doc._id, { receiving: { id: String(doc._id), ref: doc.ref, purchaseOrderId: String(po._id), supplierId: sid(po.supplierId), discrepancies: issues.length, locationId: String(got.location._id) } });
    await notifyRoles({ orgId, locationId: got.location._id, roles: ["stock"], type: "delivery_discrepancy", sourceId: doc._id, title: "A delivery has a discrepancy", body: `${doc.ref}: ${issues.length || "A checklist"} issue${issues.length === 1 ? "" : "s"} recorded against a purchase order.`, severity: "warning" });
  }
  return { receiving: receivingView(doc), note: "Receiving the goods into stock is still done on the purchase order in Procurement." };
}

const receivingView = (d) => ({ id: sid(d._id), ref: d.ref, locationId: sid(d.locationId), purchaseOrderId: sid(d.purchaseOrderId), supplierId: sid(d.supplierId), checklist: d.checklist, discrepancies: d.discrepancies.map((x) => ({ ...x, productId: sid(x.productId) })), note: d.note || null, status: d.status, date: d.date, recordedByEmail: d.recordedByEmail, resolution: d.resolution || null, resolvedByEmail: d.resolvedByEmail || null });

export async function listReceiving({ orgId, membership, locationId, status }) {
  if (!CAN.stockRead(membership)) return fail("You don't have access to stock.", 403);
  const got = await requireLocation(orgId, membership, locationId);
  if (got.error) return got;
  const rows = await (await hcol()).find({ orgId: toObjectId(orgId), kind: KINDS.receiving, locationId: got.location._id, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(200).toArray();
  return { receiving: rows.map(receivingView), checks: RECEIVING_CHECKS };
}

export async function resolveReceiving({ orgId, membership, actorEmail, id, resolution }) {
  if (!CAN.reorder(membership)) return fail("You don't have permission to resolve delivery issues.", 403);
  const text = clean(resolution, 500);
  if (!text) return fail("Describe how this was resolved (credit note, replacement, accepted as is).");
  const c = await hcol();
  const d = await c.findOne({ _id: oid(id), orgId: toObjectId(orgId), kind: KINDS.receiving });
  if (!d) return fail("Delivery record not found.", 404);
  const got = await requireLocation(orgId, membership, d.locationId);
  if (got.error) return fail("Delivery record not found.", 404);
  if (d.status !== "OPEN") return fail("This delivery record isn't open.", 409);
  await c.updateOne({ _id: d._id }, { $set: { status: "RESOLVED", resolution: text, resolvedByEmail: actorEmail, resolvedAt: nowIso(), updatedAt: nowIso() } });
  await logH({ orgId, recordType: "RECEIVING", recordId: d._id, actorEmail, action: "DELIVERY_DISCREPANCY_RESOLVED", metadata: { ref: d.ref } });
  return { ok: true };
}

export { findOpenReorderRequest };

/** Recent purchase orders and suppliers, for the delivery check and supplier preferences. Read-only links into Procurement. */
export async function listPurchaseOrders({ orgId, membership }) {
  if (!CAN.stockRead(membership)) return fail("You don't have access to stock.", 403);
  const { purchaseOrders, suppliers } = await getOrgCollections();
  const org = toObjectId(orgId);
  const [pos, sups] = await Promise.all([
    purchaseOrders.find({ orgId: org, deletedAt: null, status: { $nin: ["DRAFT", "CANCELLED"] } }).sort({ updatedAt: -1 }).limit(60).project({ supplierId: 1, status: 1, items: 1, createdAt: 1, poNumber: 1 }).toArray(),
    suppliers.find({ orgId: org, deletedAt: null }).project({ name: 1 }).sort({ name: 1 }).limit(500).toArray(),
  ]);
  const names = new Map(sups.map((s) => [String(s._id), s.name]));
  return {
    suppliers: sups.map((s) => ({ supplierId: String(s._id), name: s.name })),
    orders: pos.map((po) => ({ id: String(po._id), number: po.poNumber || String(po._id).slice(-6).toUpperCase(), supplier: names.get(String(po.supplierId)) || "Unknown supplier", status: po.status, createdAt: po.createdAt, items: (po.items || []).map((i) => ({ productId: sid(i.productId), description: i.description, quantity: i.quantity, receivedQuantity: i.receivedQuantity || 0 })) })),
  };
}
