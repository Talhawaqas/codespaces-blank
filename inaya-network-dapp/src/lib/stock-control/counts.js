// src/lib/stock-control/counts.js -- Inaya Commerce Phase 3 (Master SOW 7.6): stocktakes and cycle counts.
//
//   create (FULL = every stocked product at the location, CYCLE = a category or a chosen list; optionally BLIND = the
//   counter never sees the expected quantity) -> IN_PROGRESS: scan or enter quantities; each scan carries a client
//   scanId so a repeated submission (double-tap, retry, flaky network) is ignored -> SUBMITTED: the variance report
//   (counted vs expected, adjusted for stock that moved WHILE the count was running, valued at average cost) ->
//   APPROVED by an owner/admin (not the person who counted, when anything differs): one COUNT movement per difference,
//   with the reason and the count number as approval reference -- or REJECTED back to IN_PROGRESS for a recount.
// Everything is saved as it happens, so an interrupted count resumes where it stopped. Count sheets export/import as CSV.
// Stored in calendar_records (kind i_count).
import { getOrgCollections, toObjectId, canAccessDepartment, canManageOrg } from "../orgs.js";
import { recordStockMovement, withStockTransaction, StockError } from "../inventory.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ccol, nextNumber, ensureCommerceIndexes } from "../commerce/store.js";

export const COUNT_KIND = "i_count";
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const fail = (error, status = 400, code) => ({ error, status, ...(code ? { code } : {}) });
const nowIso = () => new Date().toISOString();
const load = async (orgId, id) => { const c = await ccol(); return c.findOne({ _id: toObjectId(id), orgId: toObjectId(orgId), kind: COUNT_KIND }); };

/** Expected = on hand when the count started + whatever moved in/out of the location since (sales during the count). */
async function expectedNow(orgId, count) {
  const { stockMovements } = await getOrgCollections();
  const moved = await stockMovements.aggregate([{ $match: { orgId: toObjectId(orgId), warehouseId: count.warehouseId, createdAt: { $gte: count.startedAt }, relatedCountId: { $ne: count._id } } }, { $group: { _id: "$productId", d: { $sum: "$delta" } } }]).toArray();
  const m = new Map(moved.map((x) => [String(x._id), x.d]));
  return (count.lines || []).map((l) => ({ ...l, expectedNow: r6(l.expectedAtStart + (m.get(String(l.productId)) || 0)) }));
}

export function countView(count, { blindFor = false } = {}) {
  const hide = count.blind && blindFor && count.status === "IN_PROGRESS";
  return { id: String(count._id), number: count.number, status: count.status, scope: count.scope, blind: !!count.blind, warehouseId: String(count.warehouseId), warehouse: count.warehouseName,
    startedAt: count.startedAt, startedBy: count.startedBy, submittedAt: count.submittedAt || null, approvedBy: count.approvedBy || null, note: count.note || null,
    lines: (count.lines || []).map((l) => ({ productId: String(l.productId), sku: l.sku, name: l.name, barcode: l.barcode || null, counted: l.counted ?? null, ...(hide ? {} : { expected: l.expectedNow ?? l.expectedAtStart, variance: l.counted == null ? null : r6(l.counted - (l.expectedNow ?? l.expectedAtStart)), varianceValue: l.varianceValue ?? null }) })),
    progress: { counted: (count.lines || []).filter((l) => l.counted != null).length, total: (count.lines || []).length }, history: (count.history || []).slice(-30) };
}

export async function createCount({ orgId, membership, actorEmail, input }) {
  const { warehouses, products, stockLevels } = await getOrgCollections(); const o = toObjectId(orgId);
  const wh = await warehouses.findOne({ _id: toObjectId(input.warehouseId), orgId: o }); if (!wh) return fail("Location not found.", 404);
  if (!canAccessDepartment(membership, wh.departmentId)) return fail("You don't have access to this location.", 403);
  const scope = input.scope === "CYCLE" ? "CYCLE" : "FULL";
  const q = { orgId: o, deletedAt: null, productType: { $nin: ["SERVICE", "NON_STOCK", "KIT"] } };
  if (scope === "CYCLE") {
    if (input.category) q.category = String(input.category);
    else if (Array.isArray(input.productIds) && input.productIds.length) q._id = { $in: input.productIds.slice(0, 2000).map(toObjectId) };
    else return fail("A cycle count needs a category or a list of products.");
  }
  const c = await ccol();
  if (await c.findOne({ orgId: o, kind: COUNT_KIND, warehouseId: wh._id, status: { $in: ["IN_PROGRESS", "SUBMITTED"] } })) return fail("This location already has a count in progress. Finish or cancel it first.", 409, "COUNT_OPEN");
  const prods = await products.find(q, { projection: { name: 1, sku: 1, barcode: 1 } }).limit(5000).toArray();
  if (!prods.length) return fail("No stocked products match.");
  const levels = new Map((await stockLevels.find({ orgId: o, warehouseId: wh._id, productId: { $in: prods.map((p) => p._id) } }).toArray()).map((l) => [String(l.productId), l.quantity]));
  await ensureCommerceIndexes(); const now = nowIso();
  const doc = { orgId: o, kind: COUNT_KIND, number: `CT-${String(await nextNumber(orgId, "stock_count")).padStart(5, "0")}`, status: "IN_PROGRESS", scope, blind: input.blind === true, warehouseId: wh._id, warehouseName: wh.name, note: String(input.note || "").slice(0, 300) || null,
    lines: prods.map((p) => ({ productId: p._id, sku: p.sku, name: p.name, barcode: p.barcode || null, expectedAtStart: levels.get(String(p._id)) || 0, counted: null })), scans: [], startedAt: now, startedBy: actorEmail, history: [{ to: "IN_PROGRESS", by: actorEmail, at: now }] };
  const r = await c.insertOne(doc);
  await logOrgActivity({ orgId: o, recordType: "STOCK_COUNT", recordId: r.insertedId, actorEmail, action: "COUNT_STARTED", previousState: null, newState: null, metadata: { number: doc.number, scope, blind: doc.blind, lines: doc.lines.length } }).catch(() => {});
  return { count: countView({ ...doc, _id: r.insertedId }, { blindFor: true }) };
}

export async function listCounts({ orgId }) {
  const c = await ccol();
  const rows = await c.find({ orgId: toObjectId(orgId), kind: COUNT_KIND }, { projection: { scans: 0 } }).sort({ startedAt: -1 }).limit(100).toArray();
  return { counts: rows.map((x) => ({ id: String(x._id), number: x.number, status: x.status, scope: x.scope, blind: !!x.blind, warehouse: x.warehouseName, startedAt: x.startedAt, startedBy: x.startedBy, progress: { counted: x.lines.filter((l) => l.counted != null).length, total: x.lines.length } })) };
}
export async function getCount({ orgId, membership, countId }) {
  const x = await load(orgId, countId); if (!x) return fail("Count not found.", 404);
  const view = x.status === "IN_PROGRESS" ? x : { ...x, lines: await expectedNow(orgId, x) };
  return { count: countView(view, { blindFor: !canManageOrg(membership) }) };
}

/** scan { scanId, barcode | sku | productId, quantity = 1 } adds; set { productId, counted } replaces (a recount of one line). */
export async function recordCount({ orgId, actorEmail, countId, input }) {
  const x = await load(orgId, countId); if (!x) return fail("Count not found.", 404);
  if (x.status !== "IN_PROGRESS") return fail("This count is no longer open for counting.", 409);
  const code = String(input.barcode || input.sku || "").trim().toLowerCase();
  const i = x.lines.findIndex((l) => (input.productId && String(l.productId) === String(input.productId)) || (code && ((l.barcode || "").toLowerCase() === code || l.sku.toLowerCase() === code)));
  if (i < 0) return fail(code ? `"${input.barcode || input.sku}" is not in this count.` : "Product not in this count.", 404, "NOT_IN_COUNT");
  const c = await ccol(); const now = nowIso();
  if (input.mode === "set") {
    const v = Number(input.counted); if (!(v >= 0)) return fail("Counted quantity must be zero or more.");
    await c.updateOne({ _id: x._id, status: "IN_PROGRESS" }, { $set: { [`lines.${i}.counted`]: v }, $push: { scans: { set: v, line: i, by: actorEmail, at: now } } });
  } else {
    const scanId = String(input.scanId || "").slice(0, 80); if (scanId.length < 8) return fail("scanId is required (one per scan).");
    const qty = Number(input.quantity ?? 1); if (!(qty > 0) || qty > 100000) return fail("Scan quantity must be positive.");
    // duplicate-scan protection: the same scanId is applied once, atomically (a first scan starts the line at zero)
    await c.updateOne({ _id: x._id, [`lines.${i}.counted`]: null }, { $set: { [`lines.${i}.counted`]: 0 } });
    const r = await c.updateOne({ _id: x._id, status: "IN_PROGRESS", "scans.scanId": { $ne: scanId } }, { $inc: { [`lines.${i}.counted`]: qty }, $push: { scans: { scanId, line: i, qty, by: actorEmail, at: now } } });
    if (!r.modifiedCount) { const again = await load(orgId, countId); if (again?.scans?.some((s) => s.scanId === scanId)) return { duplicate: true, line: { sku: x.lines[i].sku, counted: again.lines[i].counted } }; return fail("This count is no longer open.", 409); }
  }
  const after = await load(orgId, countId);
  return { line: { sku: after.lines[i].sku, name: after.lines[i].name, counted: after.lines[i].counted } };
}

export async function exportCountCsv({ orgId, membership, countId }) {
  const x = await load(orgId, countId); if (!x) return fail("Count not found.", 404);
  const blind = x.blind && !canManageOrg(membership);
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [["sku", "barcode", "name", ...(blind ? [] : ["expected"]), "counted"], ...x.lines.map((l) => [l.sku, l.barcode || "", l.name, ...(blind ? [] : [l.expectedAtStart]), l.counted ?? ""])];
  return { csv: rows.map((r) => r.map(esc).join(",")).join("\n"), filename: `${x.number}.csv` };
}
/** CSV with columns sku (or barcode) and counted; sets those lines (a second import replaces, never doubles). */
export async function importCountCsv({ orgId, actorEmail, countId, csv }) {
  const x = await load(orgId, countId); if (!x) return fail("Count not found.", 404);
  if (x.status !== "IN_PROGRESS") return fail("This count is no longer open for counting.", 409);
  const text = String(csv || ""); if (text.length > 2_000_000) return fail("The sheet is too large.");
  const lines = text.split(/\r?\n/).filter((l) => l.trim()); if (lines.length < 2) return fail("The sheet has no rows.");
  const split = (l) => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
  const head = split(lines[0]).map((h) => h.toLowerCase()); const iSku = head.indexOf("sku"), iBar = head.indexOf("barcode"), iCnt = head.indexOf("counted");
  if (iCnt < 0 || (iSku < 0 && iBar < 0)) return fail("The sheet needs a 'counted' column and a 'sku' or 'barcode' column.");
  const set = {}; const problems = []; let applied = 0;
  for (const [n, raw] of lines.slice(1).entries()) {
    const r = split(raw); if (r[iCnt] === "" || r[iCnt] === undefined) continue;
    const v = Number(r[iCnt]); if (!(v >= 0)) { problems.push(`row ${n + 2}: counted is not a number`); continue; }
    const code = (iSku >= 0 ? r[iSku] : "") || (iBar >= 0 ? r[iBar] : "");
    const i = x.lines.findIndex((l) => l.sku.toLowerCase() === String(code).toLowerCase() || (l.barcode || "").toLowerCase() === String(code).toLowerCase());
    if (i < 0) { problems.push(`row ${n + 2}: ${code} is not in this count`); continue; }
    set[`lines.${i}.counted`] = v; applied++;
  }
  const c = await ccol();
  if (applied) await c.updateOne({ _id: x._id, status: "IN_PROGRESS" }, { $set: set, $push: { scans: { import: applied, by: actorEmail, at: nowIso() } } });
  return { applied, problems: problems.slice(0, 50) };
}

/** submit | approve { reason } | reject { reason } | cancel */
export async function transitionCount({ orgId, membership, actorEmail, countId, action, input = {} }) {
  const x = await load(orgId, countId); if (!x) return fail("Count not found.", 404);
  const c = await ccol(); const now = nowIso(); const o = toObjectId(orgId);
  const logIt = (a, m = {}) => logOrgActivity({ orgId: o, recordType: "STOCK_COUNT", recordId: x._id, actorEmail, action: a, previousState: x.status, newState: null, metadata: { number: x.number, ...m } }).catch(() => {});
  if (action === "submit") {
    if (x.status !== "IN_PROGRESS") return fail("Only a count in progress can be submitted.", 409);
    const missing = x.lines.filter((l) => l.counted == null).length;
    if (missing && input.uncountedAsZero !== true) return fail(`${missing} product(s) haven't been counted. Count them, or submit treating them as zero.`, 409, "UNCOUNTED");
    const lines = (await expectedNow(orgId, x)).map((l) => ({ ...l, counted: l.counted ?? 0 }));
    const { products } = await getOrgCollections();
    const cost = new Map((await products.find({ _id: { $in: lines.map((l) => l.productId) } }, { projection: { avgCost: 1, costPrice: 1 } }).toArray()).map((p) => [String(p._id), p.avgCost ?? p.costPrice ?? null]));
    for (const l of lines) { const v = r6(l.counted - l.expectedNow); const u = cost.get(String(l.productId)); l.varianceValue = u == null ? null : Math.round(v * u * 100) / 100; }
    const r = await c.updateOne({ _id: x._id, status: "IN_PROGRESS" }, { $set: { status: "SUBMITTED", lines, submittedAt: now, submittedBy: actorEmail }, $push: { history: { to: "SUBMITTED", by: actorEmail, at: now } } });
    if (!r.modifiedCount) return fail("This count changed; reload.", 409);
    await logIt("COUNT_SUBMITTED", { variances: lines.filter((l) => Math.abs(l.counted - l.expectedNow) > 1e-9).length });
  } else if (action === "approve") {
    if (x.status !== "SUBMITTED") return fail("Only a submitted count can be approved.", 409);
    if (!canManageOrg(membership)) return fail("Count adjustments are approved by the owner or an admin.", 403);
    const reason = String(input.reason || "").trim(); if (reason.length < 3) return fail("Give a reason for the adjustment (e.g. 'Quarterly stocktake').");
    const fresh = await expectedNow(orgId, x); // stock may have moved between submit and approve
    const diffs = fresh.map((l) => ({ ...l, diff: r6(l.counted - l.expectedNow) })).filter((l) => Math.abs(l.diff) > 1e-9);
    if (diffs.length && [x.startedBy, x.submittedBy].includes(actorEmail) && x.scans.some((s) => s.by === actorEmail)) return fail("Someone other than the counter must approve adjustments.", 403, "SELF_APPROVAL");
    try {
      await withStockTransaction(async (session) => {
        for (const [i, l] of diffs.entries()) {
          const mv = await recordStockMovement({ orgId, productId: l.productId, warehouseId: x.warehouseId, delta: l.diff, type: "COUNT", relatedCountId: x._id, approvalRef: x.number, reason, note: `Stock count ${x.number}: counted ${l.counted}, expected ${l.expectedNow}`, defaultLotNumber: `COUNT-${x.number}`, actorEmail, session, idempotencyKey: `count:${x._id}:${i}` });
          if (mv.error) throw Object.assign(new Error(`${l.name}: ${mv.error}`), { status: mv.status || 409 });
        }
        const r = await c.updateOne({ _id: x._id, status: "SUBMITTED" }, { $set: { status: "APPROVED", lines: fresh, approvedBy: actorEmail, approvedAt: now, approvalReason: reason }, $push: { history: { to: "APPROVED", by: actorEmail, at: now } } }, { session });
        if (!r.modifiedCount) throw Object.assign(new Error("This count changed; reload."), { status: 409 });
      });
    } catch (e) { if (e instanceof StockError || e.status) return fail(e.message, e.status || 409); throw e; }
    await logIt("COUNT_APPROVED", { adjustments: diffs.map((l) => ({ sku: l.sku, diff: l.diff })) , reason });
  } else if (action === "reject") {
    if (x.status !== "SUBMITTED") return fail("Only a submitted count can be sent back.", 409);
    if (!canManageOrg(membership)) return fail("Only the owner or an admin can send a count back.", 403);
    await c.updateOne({ _id: x._id, status: "SUBMITTED" }, { $set: { status: "IN_PROGRESS" }, $push: { history: { to: "RECOUNT", by: actorEmail, at: now, reason: String(input.reason || "").slice(0, 300) } } });
    await logIt("COUNT_RECOUNT_REQUESTED", { reason: input.reason || null });
  } else if (action === "cancel") {
    if (!["IN_PROGRESS", "SUBMITTED"].includes(x.status)) return fail("This count is already closed.", 409);
    if (x.startedBy !== actorEmail && !canManageOrg(membership)) return fail("Only the person who started it or an admin can cancel.", 403);
    await c.updateOne({ _id: x._id }, { $set: { status: "CANCELLED" }, $push: { history: { to: "CANCELLED", by: actorEmail, at: now } } });
    await logIt("COUNT_CANCELLED");
  } else return fail("Unknown action.");
  return getCount({ orgId, membership, countId });
}
