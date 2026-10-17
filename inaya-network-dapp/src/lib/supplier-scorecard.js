// src/lib/supplier-scorecard.js
//
// Business Workspace gap closure, Batch 1 — supplier scorecards computed
// only from real purchase-order data, never estimated:
//   fill rate      Σ received ÷ Σ ordered, over POs that reached ORDERED
//   on-time rate   received on or before expectedDeliveryDate, over POs
//                  with both an expected date and a recorded full receipt
//   lead time      days from the PO_ORDERED event to the PO_RECEIVED event
//   cancel rate    POs CANCELLED or REJECTED ÷ all POs
// Order/receipt times come from the PO activity log (org_activity), which
// every PO has always written, so older POs are scored too. Each metric
// reports the sample size behind it and is null below MIN_SAMPLE, so a
// supplier with one order never gets a misleading percentage.
// Only POs in departments the caller can access are counted.

import { getOrgCollections, canAccessDepartment, toObjectId } from "./orgs.js";

export const MIN_SAMPLE = 1;
const ORDERED_OR_LATER = ["ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"];
const DAY_MS = 86400000;
const pct = (num, den) => (den >= MIN_SAMPLE ? Math.round((num / den) * 1000) / 10 : null);

export async function computeSupplierScorecard({ orgId, supplierId, membership }) {
  const { suppliers, purchaseOrders, orgActivity } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const supplier = await suppliers.findOne({ _id: toObjectId(supplierId), orgId: orgObjectId, deletedAt: null });
  if (!supplier) return { error: "Supplier not found.", status: 404 };
  if (!canAccessDepartment(membership, supplier.departmentId)) return { error: "Supplier not found.", status: 404 };

  const pos = (await purchaseOrders.find({ orgId: orgObjectId, supplierId: supplier._id, deletedAt: null }).toArray())
    .filter((po) => canAccessDepartment(membership, po.departmentId));

  const events = pos.length
    ? await orgActivity.find({
      orgId: orgObjectId, recordType: "PURCHASE_ORDER", recordId: { $in: pos.map((p) => p._id) },
      action: { $in: ["PO_ORDERED", "PO_RECEIVED"] },
    }).sort({ timestamp: 1 }).toArray()
    : [];
  const orderedAt = new Map();
  const receivedAt = new Map();
  for (const e of events) {
    const id = e.recordId.toString();
    if (e.action === "PO_ORDERED" && !orderedAt.has(id)) orderedAt.set(id, e.timestamp);
    if (e.action === "PO_RECEIVED") receivedAt.set(id, e.timestamp);
  }

  let ordered = 0;
  let received = 0;
  let fillSample = 0;
  let onTime = 0;
  let onTimeSample = 0;
  const leadTimes = [];
  let closedBad = 0;

  for (const po of pos) {
    const id = po._id.toString();
    if (["CANCELLED", "REJECTED"].includes(po.status)) closedBad++;
    if (ORDERED_OR_LATER.includes(po.status)) {
      fillSample++;
      for (const item of po.items || []) {
        ordered += Number(item.quantity) || 0;
        received += Number(item.receivedQuantity) || 0;
      }
    }
    const got = receivedAt.get(id);
    if (po.status === "RECEIVED" && got && po.expectedDeliveryDate) {
      onTimeSample++;
      if (got.slice(0, 10) <= String(po.expectedDeliveryDate).slice(0, 10)) onTime++;
    }
    const sent = orderedAt.get(id);
    if (po.status === "RECEIVED" && got && sent) {
      leadTimes.push((new Date(got).getTime() - new Date(sent).getTime()) / DAY_MS);
    }
  }

  return {
    supplier: { id: supplier._id.toString(), name: supplier.name },
    totalOrders: pos.length,
    fillRate: { percent: ordered > 0 && fillSample >= MIN_SAMPLE ? Math.round((received / ordered) * 1000) / 10 : null, sample: fillSample, unitsOrdered: ordered, unitsReceived: received },
    onTimeRate: { percent: pct(onTime, onTimeSample), sample: onTimeSample },
    averageLeadTimeDays: { days: leadTimes.length >= MIN_SAMPLE ? Math.round((leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) * 10) / 10 : null, sample: leadTimes.length },
    cancellationRate: { percent: pct(closedBad, pos.length), sample: pos.length },
  };
}
