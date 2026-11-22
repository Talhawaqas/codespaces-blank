// app/api/orgs/stock/[[...path]]/route.js -- Inaya Commerce Phase 3: Advanced Inventory Intelligence (Master SOW 7.x).
// Session + membership first (requireMembership also applies the License Manager gate); department and role checks are
// inside src/lib/stock-control/*. Available to every Business Workspace company (stock control is core inventory, not
// part of the paid POS add-on).
//
//   GET  availability (?warehouseId&productId)                    (on hand / reserved / available / in transit / incoming / backordered / ATP)
//   GET  transfers (?status)   POST transfers { fromWarehouseId, toWarehouseId, lines:[{productId,quantity}], neededBy?, note? }
//   POST transfers/{id}/approve | dispatch { lines? } | receive { lines:[{lineIndex,received,short?,damaged?,reason?}] } | cancel { reason } | reverse { reason }
//   GET  counts   GET counts/{id}   GET counts/{id}/export (CSV)
//   POST counts { warehouseId, scope: FULL|CYCLE, category? | productIds?, blind?, note? }
//   POST counts/{id}/scan { scanId, barcode|sku|productId, quantity? }   POST counts/{id}/set { productId, counted }   POST counts/{id}/import { csv }
//   POST counts/{id}/submit { uncountedAsZero? } | approve { reason } | reject { reason } | cancel
//   GET  settings   PUT settings { poApprovalLevels?, overReceiptPercent?, duplicatePoWindowHours? }
//   GET  supplier-items (?supplierId&productId)   PUT supplier-items { supplierId, productId, supplierSku?, price?, currency?, leadTimeDays?, moq?, orderMultiple?, preferred? }
//   POST purchase-orders/{id}/landed-charges { charges:[{type,amount,allocation,note?}] }   POST purchase-orders/{id}/amend { items?, expectedDeliveryDate?, reason }
//   GET  supplier-returns (?supplierId)   POST supplier-returns { supplierId, warehouseId, lines, reason, poId? }   POST supplier-returns/{id}/send | credit | cancel
//   POST supplier-documents/{docId}/proposal { supplierId? }   POST supplier-documents/{docId}/match { poId }   POST supplier-documents/{docId}/draft-po { supplierId, departmentId?, warehouseId, currency, lines }
//   GET  replenishment (?windowDays&warehouseId)   GET replenishment/accuracy   POST replenishment/override { productId, warehouseId, quantity, suggested, reason }
//   POST replenishment/request { productId, warehouseId, quantity, supplierId?, unitPrice?, explanation? }
//   GET  valuation
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { availability } from "../../../../../lib/stock-control/availability.js";
import * as TR from "../../../../../lib/stock-control/transfers.js";
import * as CT from "../../../../../lib/stock-control/counts.js";
import * as PU from "../../../../../lib/stock-control/purchasing.js";
import * as RP from "../../../../../lib/stock-control/replenish.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 400) : json(r));

async function ctx(req, orgId) {
  if (!orgId) return { error: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: json({ error: auth.error }, auth.status) };
  return { membership: auth.membership, actorEmail: auth.session.email };
}

export async function GET(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const qs = new URL(req.url).searchParams; const orgId = qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const base = { orgId, membership: c.membership };
    if (path === "availability") return json(await availability({ orgId, warehouseId: qs.get("warehouseId"), productIds: qs.get("productId") ? [qs.get("productId")] : null }));
    if (path === "transfers") return json(await TR.listTransfers({ orgId, status: qs.get("status") }));
    if (path === "counts") return json(await CT.listCounts({ orgId }));
    if (seg[0] === "counts" && seg[1] && seg[2] === "export") { const r = await CT.exportCountCsv({ ...base, countId: seg[1] }); if (r.error) return out(r); return new NextResponse(r.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${r.filename}"`, "Cache-Control": "no-store" } }); }
    if (seg[0] === "counts" && seg[1] && !seg[2]) return out(await CT.getCount({ ...base, countId: seg[1] }));
    if (path === "settings") return json({ settings: await PU.getStockSettings(orgId) });
    if (path === "supplier-items") return json(await PU.listSupplierItems({ orgId, supplierId: qs.get("supplierId"), productId: qs.get("productId") }));
    if (path === "supplier-returns") return json(await PU.listSupplierReturns({ orgId, supplierId: qs.get("supplierId") }));
    if (path === "replenishment") return json(await RP.recommendations({ orgId, windowDays: qs.get("windowDays"), warehouseId: qs.get("warehouseId"), record: true }));
    if (path === "replenishment/accuracy") return json(await RP.forecastAccuracy({ orgId }));
    if (path === "valuation") return json(await RP.valuation({ orgId }));
    return json({ error: "Not found." }, 404);
  } catch (err) { console.error("orgs/stock GET failed:", path, err?.message); return json({ error: "Could not load stock data." }, 500); }
}

async function write(req, params, method) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const orgId = body.orgId || new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const base = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (method === "POST" && path === "transfers") return out(await TR.createTransfer({ ...base, input: body }));
    if (method === "POST" && seg[0] === "transfers" && seg[1] && seg[2]) return out(await TR.transitionTransfer({ ...base, transferId: seg[1], action: seg[2], input: body }));
    if (method === "POST" && path === "counts") return out(await CT.createCount({ ...base, input: body }));
    if (method === "POST" && seg[0] === "counts" && seg[1] && seg[2] === "scan") return out(await CT.recordCount({ ...base, countId: seg[1], input: { ...body, mode: "scan" } }));
    if (method === "POST" && seg[0] === "counts" && seg[1] && seg[2] === "set") return out(await CT.recordCount({ ...base, countId: seg[1], input: { ...body, mode: "set" } }));
    if (method === "POST" && seg[0] === "counts" && seg[1] && seg[2] === "import") return out(await CT.importCountCsv({ ...base, countId: seg[1], csv: body.csv }));
    if (method === "POST" && seg[0] === "counts" && seg[1] && seg[2]) return out(await CT.transitionCount({ ...base, countId: seg[1], action: seg[2], input: body }));
    if (method === "PUT" && path === "settings") return out(await PU.updateStockSettings({ ...base, input: body }));
    if (method === "PUT" && path === "supplier-items") return out(await PU.saveSupplierItem({ ...base, input: body }));
    if (method === "POST" && seg[0] === "purchase-orders" && seg[1] && seg[2] === "landed-charges") { const r = await PU.setLandedCharges({ ...base, poId: seg[1], charges: body.charges }); return r.error ? out(r) : json({ ok: true, landedCharges: r.po.landedCharges, allocationPerUnit: r.allocation }); }
    if (method === "POST" && seg[0] === "purchase-orders" && seg[1] && seg[2] === "amend") { const r = await PU.amendPurchaseOrder({ ...base, poId: seg[1], input: body }); return r.error ? out(r) : json({ ok: true, status: r.po.status, amendments: r.po.amendments }); }
    if (method === "POST" && path === "supplier-returns") return out(await PU.createSupplierReturn({ ...base, input: body }));
    if (method === "POST" && seg[0] === "supplier-returns" && seg[1] && seg[2]) return out(await PU.transitionSupplierReturn({ ...base, returnId: seg[1], action: seg[2], input: body }));
    if (method === "POST" && seg[0] === "supplier-documents" && seg[1] && seg[2] === "proposal") return out(await PU.proposeFromSupplierDocument({ ...base, documentId: seg[1], supplierId: body.supplierId }));
    if (method === "POST" && seg[0] === "supplier-documents" && seg[1] && seg[2] === "match") return out(await PU.matchInvoiceToPo({ ...base, documentId: seg[1], poId: body.poId }));
    if (method === "POST" && seg[0] === "supplier-documents" && seg[1] && seg[2] === "draft-po") return out(await PU.draftPoFromProposal({ ...base, documentId: seg[1], input: body }));
    if (method === "POST" && path === "replenishment/override") return out(await RP.overrideRecommendation({ ...base, input: body }));
    if (method === "POST" && path === "replenishment/request") return out(await RP.requestFromRecommendation({ ...base, input: body }));
    return json({ error: "Not found." }, 404);
  } catch (err) { console.error(`orgs/stock ${method} failed:`, path, err?.message); return json({ error: "Could not save." }, 500); }
}
export const POST = (req, a) => write(req, a.params, "POST");
export const PUT = (req, a) => write(req, a.params, "PUT");
