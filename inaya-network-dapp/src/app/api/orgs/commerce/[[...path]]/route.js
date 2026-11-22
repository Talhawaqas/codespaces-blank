// app/api/orgs/commerce/[[...path]]/route.js -- Inaya Commerce (Master SOW Initiative A). Session + membership first
// (requireMembership also applies the License Manager gate), then the commerce entitlement and role checks inside
// src/lib/commerce/* before any commerce logic runs. orgId comes from the query or body and is never trusted on its own.
//
//   GET  settings                       PUT settings { ...fields }
//   GET  staff                          PUT staff { email, commerceRole: manager|supervisor|cashier|null }
//   GET  tax-categories                 POST tax-categories { id?, code, name, rate, isDefault }
//   PUT  tax-rates { categoryId, warehouseId, rate|null }
//   GET  price-lists                    POST price-lists { id?, code, name, currency, isWholesale }
//   PUT  prices { priceListId | customerId, productId, price|null }
//   POST price-preview { lines, orderDiscount, customerId, priceListId, warehouseId }   (server-side pricing for the register)
//   GET  stock-reconciliation           POST stock-reconciliation { repair: true }   (manager; ledger vs balances, audited repair)
//   POST sales { idempotencyKey, warehouseId, registerId?, customerId?, priceListId?, lines, orderDiscount?, tenders, approvalId?, parkedId?, notes? }
//   GET  sales (?from&to&warehouseId&shiftId)   GET sales/{id}   GET sales/{id}/receipt   GET sales/by-number/{saleNumber}
//   POST approvals { cart }  (cashier asks)     GET approvals (supervisor: pending)   GET approvals/{id}   POST approvals/{id}/decide { approve, reason }
//   GET  parked   POST parked { cart, label }   DELETE parked/{id}
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import * as S from "../../../../../lib/commerce/store.js";
import * as TAX from "../../../../../lib/commerce/tax.js";
import * as PR from "../../../../../lib/commerce/pricing.js";
import { reconcileStockLevels } from "../../../../../lib/inventory.js";
import * as SALE from "../../../../../lib/commerce/sale.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 400) : json(r));

async function ctx(req, orgId) {
  if (!orgId) return { error: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: json({ error: auth.error }, auth.status) };
  return { auth, membership: auth.membership, actorEmail: auth.session.email };
}

export async function GET(req, { params }) {
  params = await params; const path = (params.path || []).join("/");
  try {
    const orgId = new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const gate = await S.commerceAccess({ orgId, membership: c.membership, need: "sell" }); if (gate) return out(gate);
    if (path === "settings") return json({ settings: await S.getSettings(orgId), role: S.commerceRoleOf(c.membership) });
    if (path === "staff") return out(await S.listCommerceStaff({ orgId, membership: c.membership }));
    if (path === "tax-categories") return json({ categories: await TAX.listTaxCategories(orgId) });
    if (path === "price-lists") return json({ priceLists: await PR.listPriceLists(orgId) });
    const qs = new URL(req.url).searchParams; const seg = params.path || [];
    if (path === "sales") return out(await SALE.listSales({ orgId, membership: c.membership, from: qs.get("from"), to: qs.get("to"), warehouseId: qs.get("warehouseId"), shiftId: qs.get("shiftId") }));
    if (seg[0] === "sales" && seg[1] === "by-number" && seg[2]) return out(await SALE.findSaleByNumber({ orgId, membership: c.membership, saleNumber: seg[2] }));
    if (seg[0] === "sales" && seg[1] && seg[2] === "receipt") return out(await SALE.receiptFor({ orgId, membership: c.membership, saleId: seg[1] }));
    if (seg[0] === "sales" && seg[1] && !seg[2]) return out(await SALE.getSale({ orgId, membership: c.membership, saleId: seg[1] }));
    if (path === "approvals") return out(await SALE.listPendingApprovals({ orgId, membership: c.membership }));
    if (seg[0] === "approvals" && seg[1]) return out(await SALE.getApprovalStatus({ orgId, membership: c.membership, approvalId: seg[1] }));
    if (path === "parked") return out(await SALE.listParked({ orgId, membership: c.membership }));
    if (path === "stock-reconciliation") { const g = await S.commerceAccess({ orgId, membership: c.membership, need: "manage" }); if (g) return out(g); return json(await reconcileStockLevels({ orgId })); }
    return json({ error: "Not found." }, 404);
  } catch (err) { console.error("orgs/commerce GET failed:", path, err?.message); return json({ error: "Could not load commerce data." }, 500); }
}

async function write(req, params, method) {
  params = await params; const path = (params.path || []).join("/");
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const orgId = body.orgId || new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const base = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (method === "PUT" && path === "settings") return out(await S.updateSettings({ ...base, input: body }));
    if (method === "PUT" && path === "staff") return out(await S.setCommerceRole({ ...base, email: body.email, commerceRole: body.commerceRole ?? null }));
    if (method === "POST" && path === "tax-categories") return out(await TAX.saveTaxCategory({ ...base, id: body.id, code: body.code, name: body.name, rate: Number(body.rate), isDefault: body.isDefault === true, active: body.active !== false }));
    if (method === "PUT" && path === "tax-rates") return out(await TAX.setLocationRate({ ...base, categoryId: body.categoryId, warehouseId: body.warehouseId, rate: body.rate === null ? null : Number(body.rate) }));
    if (method === "POST" && path === "price-lists") return out(await PR.savePriceList({ ...base, id: body.id, code: body.code, name: body.name, currency: body.currency, isWholesale: body.isWholesale === true, active: body.active !== false }));
    if (method === "PUT" && path === "prices") return out(await PR.setPrice({ ...base, priceListId: body.priceListId || null, customerId: body.customerId || null, productId: body.productId, price: body.price === null ? null : Number(body.price) }));
    if (method === "POST" && path === "stock-reconciliation") {
      const g = await S.commerceAccess({ orgId, membership: c.membership, need: "manage" }); if (g) return out(g);
      return json(await reconcileStockLevels({ orgId, repair: body.repair === true, actorEmail: c.actorEmail }));
    }
    const seg = params.path || [];
    if (method === "POST" && path === "sales") return out(await SALE.completeSale({ ...base, input: body }));
    if (method === "POST" && path === "approvals") return out(await SALE.requestApproval({ ...base, input: body.cart || {} }));
    if (method === "POST" && seg[0] === "approvals" && seg[1] && seg[2] === "decide") return out(await SALE.decideApproval({ ...base, approvalId: seg[1], approve: body.approve === true, reason: body.reason }));
    if (method === "POST" && path === "parked") return out(await SALE.parkSale({ ...base, input: body.cart || {}, label: body.label }));
    if (method === "DELETE" && seg[0] === "parked" && seg[1]) return out(await SALE.discardParked({ ...base, parkedId: seg[1] }));
    if (method === "POST" && path === "price-preview") {
      const gate = await S.commerceAccess({ orgId, membership: c.membership, need: "sell" }); if (gate) return out(gate);
      const r = await PR.priceCart({ orgId, membership: c.membership, input: body });
      if (r.error) return out(r);
      return json({ ...r, lines: r.lines.map(({ _minor, ...l }) => l) });
    }
    return json({ error: "Not found." }, 404);
  } catch (err) { console.error(`orgs/commerce ${method} failed:`, path, err?.message); return json({ error: "Could not save." }, 500); }
}
export const POST = (req, ctxArg) => write(req, ctxArg.params, "POST");
export const PUT = (req, ctxArg) => write(req, ctxArg.params, "PUT");
export const DELETE = (req, ctxArg) => write(req, ctxArg.params, "DELETE");
