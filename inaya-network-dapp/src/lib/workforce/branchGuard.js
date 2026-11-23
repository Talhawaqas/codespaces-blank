// src/lib/workforce/branchGuard.js -- Commerce Phase 6 (Master SOW 10.1 branch scoping). One check used by the POS, stock and
// sales-order routes before they act: every branch a request touches (directly, or through a register, shift or sale) must be one
// of the member's assigned branches. Owners/admins and members with no branches assigned are unrestricted (memberLocations null).
import { getOrgCollections } from "../orgs.js";
import { ccol, KINDS, oid, sid } from "../commerce/store.js";
import { memberLocations, denyLocation } from "./scope.js";

/** Returns null when allowed, or a { error, status, code } failure. Unknown ids are left to the handler (it returns 404). */
export async function branchGuard({ orgId, membership, warehouseIds = [], registerId = null, shiftId = null, saleId = null, saleNumber = null }) {
  const allowed = memberLocations(membership); if (!allowed) return null;
  const touched = warehouseIds.filter(Boolean).map(String);
  const o = oid(orgId);
  if (registerId || shiftId) {
    const c = await ccol();
    if (registerId) { const r = await c.findOne({ _id: oid(registerId), orgId: o, kind: KINDS.register }, { projection: { warehouseId: 1 } }); if (r) touched.push(sid(r.warehouseId)); }
    if (shiftId) { const s = await c.findOne({ _id: oid(shiftId), orgId: o, kind: KINDS.shift }, { projection: { warehouseId: 1 } }); if (s) touched.push(sid(s.warehouseId)); }
  }
  if (saleId || saleNumber) {
    const { salesOrders } = await getOrgCollections();
    const q = saleId ? { _id: oid(saleId), orgId: o } : { orgId: o, saleNumber: String(saleNumber) };
    const s = (saleId && !oid(saleId)) ? null : await salesOrders.findOne(q, { projection: { warehouseId: 1 } }); if (s?.warehouseId) touched.push(sid(s.warehouseId));
  }
  return touched.every((w) => allowed.includes(String(w))) ? null : denyLocation();
}
