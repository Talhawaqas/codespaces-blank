// app/api/orgs/online/[[...path]]/route.js -- Inaya Commerce Phase 5 (Online Commerce, Master SOW section 9): the company's
// own online store, its product listings, payment options, domain, analytics, and connected Shopify / WooCommerce stores.
// Session + membership first (License Manager gate included); entitlement (Commerce add-on) and commerce roles are checked in
// src/lib/online/*. Credentials sent here are sealed on arrival and never returned.
//
//   GET  store                 POST store { name, slug, warehouseId?, departmentId? }      PUT store { content?, slug?, shipping?, seo?, ... }
//   PUT  store/payments { bankTransfer?, cod?, stripe?, safepay? }   POST store/{publish|unpublish}
//   PUT  store/domain { host }  POST store/domain/verify   GET analytics?days   GET payments?days
//   GET  listings   POST listings { productId, ... }   PUT listings/{id} {...}   POST listings/bulk { productIds, status }
//   GET  orders?status   POST orders/{id}/tracking { trackingRef }   POST orders/{id}/confirm-transfer { reference }
//   GET  channels   POST channels { platform, ... }   PUT channels/{id}   DELETE channels/{id}
//   POST channels/{id}/{webhooks|pull-products|push-products|import-products|sync-stock|sync-orders}
//   GET  sync-log?channelId&failed=1   POST sync-log/{id}/{retry|dismiss}   GET conflicts   POST conflicts/{id}/resolve { keep }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../../lib/orgs.js";
import * as ST from "../../../../../lib/online/stores.js";
import * as CH from "../../../../../lib/online/channels.js";
import { listPayments } from "../../../../../lib/online/payments.js";
import { commerceAccess } from "../../../../../lib/commerce/store.js";
import { transitionSalesOrder } from "../../../../../lib/sales-orders.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 400) : json(r));
const baseUrl = (req) => (process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin).replace(/\/+$/, "");
async function ctx(req, orgId) {
  if (!orgId) return { error: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: json({ error: auth.error }, auth.status) };
  return { membership: auth.membership, actorEmail: auth.session.email };
}

async function onlineOrders({ orgId, membership, status }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const { salesOrders, crmContacts } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), channel: { $in: ["ONLINE", "SHOPIFY", "WOOCOMMERCE"] }, deletedAt: null, ...(status ? { status } : {}) };
  const rows = await salesOrders.find(q).sort({ orderDate: -1 }).limit(300).toArray();
  const names = new Map((await crmContacts.find({ _id: { $in: rows.map((r) => r.contactId) } }, { projection: { name: 1 } }).toArray()).map((c) => [String(c._id), c.name]));
  return { orders: rows.map((o) => ({ id: String(o._id), orderNumber: o.orderNumber, channel: o.channel, externalOrderId: o.externalOrderId || null, orderDate: o.orderDate, customer: names.get(String(o.contactId)) || null, email: o.customerEmail, status: o.status, stage: o.stage, fulfilmentMethod: o.fulfilmentMethod, total: o.total, currency: o.currency,
    payment: o.onlinePayment || null, paid: (o.payments || []).reduce((n, p) => n + (p.kind === "REFUND" ? -p.amountMinor : p.amountMinor), 0) / 100, shipping: o.shipping ? { method: o.shipping.method, zone: o.shipping.zoneName, address: o.shipping.address, window: o.shipping.window, trackingRef: o.shipping.trackingRef || null, phone: o.shipping.phone || null } : null, lines: o.lines.map((l) => ({ description: l.description, sku: l.sku, quantity: l.quantity, reservedQty: l.reservedQty || 0 })) })) };
}

export async function GET(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const qs = new URL(req.url).searchParams; const orgId = qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership };
    if (path === "store") return out(await ST.getStore(b));
    if (path === "listings") return out(await ST.listListings(b));
    if (path === "analytics") return out(await ST.storeAnalytics({ ...b, days: Number(qs.get("days")) || 30 }));
    if (path === "payments") return out(await listPayments({ ...b, days: Number(qs.get("days")) || 60 }));
    if (path === "orders") return out(await onlineOrders({ ...b, status: qs.get("status") || null }));
    if (path === "channels") return out(await CH.listChannels(b));
    if (path === "sync-log") return out(await CH.syncLog({ ...b, channelId: qs.get("channelId") || null, failedOnly: qs.get("failed") === "1" }));
    if (path === "conflicts") return out(await CH.listConflicts(b));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("online GET failed:", e); return json({ error: "Something went wrong." }, 500); }
}

export async function POST(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const body = await req.json().catch(() => ({})); const orgId = body.orgId || new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (path === "store") return out(await ST.createStore({ ...b, ...body }));
    if (path === "store/publish" || path === "store/unpublish") return out(await ST.publishStore({ ...b, action: seg[1] }));
    if (path === "store/domain/verify") return out(await ST.verifyDomain(b));
    if (path === "listings") return out(await ST.saveListing({ ...b, input: body }));
    if (path === "listings/bulk") return out(await ST.bulkPublish({ ...b, productIds: body.productIds, status: body.status || "PUBLISHED" }));
    if (seg[0] === "orders" && seg[1] && seg[2] === "tracking") {
      const denied = await commerceAccess({ orgId, membership: c.membership, need: "supervise" }); if (denied) return out(denied);
      const { salesOrders } = await getOrgCollections(); const ref = String(body.trackingRef || "").trim().slice(0, 120);
      const r = await salesOrders.updateOne({ _id: toObjectId(seg[1]), orgId: toObjectId(orgId), channel: { $in: ["ONLINE", "SHOPIFY", "WOOCOMMERCE"] } }, { $set: { "shipping.trackingRef": ref || null, updatedAt: new Date().toISOString() }, $push: { history: { to: "TRACKING_SET", by: c.actorEmail, at: new Date().toISOString() } } });
      return r.matchedCount ? json({ ok: true }) : json({ error: "Order not found." }, 404);
    }
    if (seg[0] === "orders" && seg[1] && seg[2] === "confirm-transfer") {
      // explicit staff confirmation that the bank transfer arrived (Master SOW 9.5): finance access + a bank reference
      const { canAccessFinance } = await import("../../../../../lib/orgs.js"); if (!canAccessFinance(c.membership)) return json({ error: "Confirming payments needs finance access." }, 403);
      const { salesOrders } = await getOrgCollections(); const o = await salesOrders.findOne({ _id: toObjectId(seg[1]), orgId: toObjectId(orgId), channel: "ONLINE" });
      if (!o) return json({ error: "Order not found." }, 404);
      if (o.onlinePayment?.method !== "BANK_TRANSFER" && o.onlinePayment?.method !== "COD") return json({ error: "Card payments are confirmed by the provider, not by hand." }, 409);
      const ref = String(body.reference || "").trim(); if (ref.length < 3) return json({ error: "Enter the bank (or receipt) reference." }, 400);
      const due = Math.round(o.total * 100) - (o.payments || []).reduce((n, p) => n + (p.kind === "REFUND" ? -p.amountMinor : p.amountMinor), 0);
      if (due <= 0) return json({ error: "This order is already paid." }, 409);
      const r = await transitionSalesOrder({ orgId, orderId: seg[1], action: "payment", membership: c.membership, actorEmail: c.actorEmail, input: { method: o.onlinePayment.method === "COD" ? "CASH" : "BANK_TRANSFER", amount: due / 100, reference: ref } });
      if (r.error) return out(r);
      await salesOrders.updateOne({ _id: o._id }, { $set: { "onlinePayment.state": "PAID", "onlinePayment.paidAt": new Date().toISOString(), "onlinePayment.confirmedBy": c.actorEmail } });
      const { notifyCustomer } = await import("../../../../../lib/online/orders.js"); notifyCustomer({ orgId, orderId: seg[1], event: "paid" }).catch(() => {});
      return json({ ok: true });
    }
    if (path === "channels") return out(await CH.connectChannel({ ...b, input: body }));
    if (path === "channels/shopify/install") { const { startShopifyInstall } = await import("../../../../../lib/online/shopifyApp.js"); return out(await startShopifyInstall({ ...b, shopDomain: body.shopDomain, baseUrl: baseUrl(req) })); }
    if (seg[0] === "channels" && seg[1]) {
      const id = seg[1];
      if (seg[2] === "webhooks") return out(await CH.registerWebhooks({ ...b, id, baseUrl: baseUrl(req) }));
      if (seg[2] === "pull-products") return out(await CH.pullProducts({ ...b, id }));
      if (seg[2] === "push-products") return out(await CH.pushProducts({ ...b, id, productIds: body.productIds }));
      if (seg[2] === "import-products") return out(await CH.importUnmatched({ ...b, id, items: body.items }));
      if (seg[2] === "sync-stock") return out(await CH.syncStockNow({ ...b, id, force: body.force === true }));
      if (seg[2] === "sync-orders") return out(await CH.syncOrdersNow({ ...b, id }));
    }
    if (seg[0] === "sync-log" && seg[1] && seg[2] === "retry") return out(await CH.retryNow({ ...b, logId: seg[1] }));
    if (seg[0] === "sync-log" && seg[1] && seg[2] === "dismiss") return out(await CH.dismissFailure({ ...b, logId: seg[1] }));
    if (seg[0] === "conflicts" && seg[1] && seg[2] === "resolve") return out(await CH.resolveConflict({ ...b, id: seg[1], keep: body.keep }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("online POST failed:", e); return json({ error: "Something went wrong." }, 500); }
}

export async function PUT(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const body = await req.json().catch(() => ({})); const orgId = body.orgId || new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (path === "store") return out(await ST.updateStore({ ...b, input: body }));
    if (path === "store/payments") return out(await ST.updatePayments({ ...b, input: body }));
    if (path === "store/domain") return out(await ST.setDomain({ ...b, host: body.host || null }));
    if (seg[0] === "listings" && seg[1]) return out(await ST.saveListing({ ...b, id: seg[1], input: body }));
    if (seg[0] === "channels" && seg[1]) return out(await CH.updateChannel({ ...b, id: seg[1], input: body }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("online PUT failed:", e); return json({ error: "Something went wrong." }, 500); }
}

export async function DELETE(req, { params }) {
  params = await params; const seg = params.path || [];
  try {
    const qs = new URL(req.url).searchParams; const orgId = qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    if (seg[0] === "channels" && seg[1]) return out(await CH.disconnectChannel({ orgId, membership: c.membership, actorEmail: c.actorEmail, id: seg[1] }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("online DELETE failed:", e); return json({ error: "Something went wrong." }, 500); }
}
