// src/lib/online/channels.js -- Shopify and WooCommerce connectors (Master SOW 9.8 omnichannel sync; owner decision 22 Nov 2026:
// both platforms, products / prices / stock / orders both ways, sync INCLUDED in the Commerce add-on within plan limits).
//
// The shop connects its OWN store: Shopify = a custom app's Admin API access token (+ the app's API secret, which signs
// webhooks); WooCommerce = a REST API key pair (read/write) on an https site. Credentials are sealed (crypto.js).
//   o_channel        a connected store: platform, address, sealed credentials, fulfilment location, field masters, status
//   o_channel_map    Inaya product <-> channel product/variant (+ inventory item), with the last values pushed and seen
//   o_channel_order  one imported channel order (unique per channel + external id: duplicate orders are impossible)
//   o_channel_log    every sync job: ok / error, attempts, next retry (exponential back-off) -- the retry & reconciliation dashboard
//   o_conflict       a value changed on BOTH sides (e.g. price edited in Shopify while Inaya is the price master) for a person to resolve
// Directions: products and prices Inaya -> channel (publish / update) and channel -> Inaya (import & match by SKU, conflicts);
// stock Inaya -> channel (available = on hand - reserved - buffer at the channel's location); orders channel -> Inaya (webhook
// + polling), and fulfilment / cancellation Inaya -> channel. A channel order is never repriced: the channel charged the customer.
import { createHmac, randomBytes } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { ccol, oid, sid, clean, nowIso, toMinor, fromMinor, audit, fail, commerceAccess, getSettings, KINDS as CK } from "../commerce/store.js";
import { OK, ensureOnlineIndexes, planLimits } from "./stores.js";
import { seal, openSafe, last4, safeEqual } from "./crypto.js";
import { ensureCustomer, placeOrder, recordProviderPayment, systemMembership, SYSTEM_ACTOR } from "./orders.js";

export const PLATFORMS = ["SHOPIFY", "WOOCOMMERCE"];
const SHOPIFY_API = "2026-10"; // newest stable version (Dev Dashboard offered 2026-01..2026-10 on 22 Nov 2026); re-verify live on each bump
const MAX_ATTEMPTS = 8;
const retryable = (e) => Object.assign(e, { retryable: true });

// ---------------------------------------------------------------- platform clients (fetch is injectable for tests)
export function shopifyClient(ch, fetchImpl = fetch) {
  const token = openSafe(ch.tokenSealed); if (!token) throw new Error("The Shopify access token is missing. Reconnect the store.");
  const gql = async (query, variables = {}) => {
    const r = await fetchImpl(`https://${ch.shopDomain}/admin/api/${SHOPIFY_API}/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
    if (r.status === 429 || r.status >= 500) throw retryable(new Error(`Shopify is busy (${r.status}); will retry.`));
    if (r.status === 401 || r.status === 403) throw new Error("Shopify refused the access token (check the app's permissions or reinstall it).");
    const j = await r.json().catch(() => ({}));
    if (j.errors?.length) { const m = j.errors.map((e) => e.message).join("; "); if (/throttl/i.test(m)) throw retryable(new Error("Shopify rate limit; will retry.")); throw new Error(`Shopify: ${m}`); }
    return j.data;
  };
  const userErr = (x) => { const e = x?.userErrors?.filter(Boolean) || []; if (e.length) throw new Error(`Shopify: ${e.map((u) => u.message).join("; ")}`); return x; };
  return {
    async info() { const d = await gql(`{ shop { name currencyCode } locations(first: 20) { nodes { id name isActive } } }`); return { name: d.shop.name, currency: d.shop.currencyCode, locations: d.locations.nodes.filter((l) => l.isActive !== false).map((l) => ({ id: l.id, name: l.name })) }; },
    async listProducts() {
      const out = []; let after = null;
      for (let page = 0; page < 40; page++) {
        const d = await gql(`query($after: String) { products(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title status variants(first: 100) { nodes { id sku price title inventoryItem { id } } } } } }`, { after });
        for (const p of d.products.nodes) for (const v of p.variants.nodes) out.push({ externalProductId: p.id, externalVariantId: v.id, inventoryItemId: v.inventoryItem?.id || null, sku: v.sku || "", title: p.variants.nodes.length > 1 && v.title !== "Default Title" ? `${p.title} - ${v.title}` : p.title, priceMinor: toMinor(v.price), status: p.status });
        if (!d.products.pageInfo.hasNextPage) break; after = d.products.pageInfo.endCursor;
      }
      return out;
    },
    async createProduct({ title, description, sku, priceMinor }) {
      const d = await gql(`mutation($p: ProductCreateInput!) { productCreate(product: $p) { product { id variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { field message } } }`, { p: { title, descriptionHtml: description || "", status: "ACTIVE" } });
      const prod = userErr(d.productCreate).product; const v = prod.variants.nodes[0];
      const u = await gql(`mutation($id: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $v) { productVariants { id } userErrors { field message } } }`, { id: prod.id, v: [{ id: v.id, price: fromMinor(priceMinor).toFixed(2), inventoryItem: { sku, tracked: true } }] });
      userErr(u.productVariantsBulkUpdate);
      return { externalProductId: prod.id, externalVariantId: v.id, inventoryItemId: v.inventoryItem.id };
    },
    async updateProduct(m, { title, priceMinor }) {
      if (title) { const d = await gql(`mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id } userErrors { field message } } }`, { p: { id: m.externalProductId, title } }); userErr(d.productUpdate); }
      if (priceMinor !== undefined) { const d = await gql(`mutation($id: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $v) { productVariants { id } userErrors { field message } } }`, { id: m.externalProductId, v: [{ id: m.externalVariantId, price: fromMinor(priceMinor).toFixed(2) }] }); userErr(d.productVariantsBulkUpdate); }
    },
    async setStock(items) { // [{ inventoryItemId, quantity }]
      // 2026-xx API: inventory mutations need an @idempotent key (a retried request can never apply twice)
      for (const it of items) await gql(`mutation($i: ID!, $l: ID!, $key: String!) { inventoryActivate(inventoryItemId: $i, locationId: $l) @idempotent(key: $key) { userErrors { message } } }`, { i: it.inventoryItemId, l: ch.locationId, key: randomBytes(16).toString("hex") }).catch(() => null);
      for (let k = 0; k < items.length; k += 100) {
        const d = await gql(`mutation($in: InventorySetQuantitiesInput!, $key: String!) { inventorySetQuantities(input: $in) @idempotent(key: $key) { userErrors { field message } } }`, { key: randomBytes(16).toString("hex"), in: { name: "available", reason: "correction", quantities: items.slice(k, k + 100).map((it) => ({ inventoryItemId: it.inventoryItemId, locationId: ch.locationId, quantity: Math.max(0, Math.floor(it.quantity)), changeFromQuantity: null })) } }); // 2026-xx API: ignoreCompareQuantity was removed; changeFromQuantity null = set without a compare (Inaya is the stock master)
        userErr(d.inventorySetQuantities);
      }
    },
    // Shopify withholds customer names / addresses from self-made apps on its Basic plan (protected customer data): on that
    // refusal the order is read again without them, so it still imports; the shop ships from Shopify, which has the address.
    async orderGql(query, vars) {
      if (!ch.piiBlocked) { try { return await gql(query.replace(/__FIELDS__/g, SHOPIFY_ORDER_FIELDS), vars); } catch (e) { if (!/not approved to access|protected customer data|personally identifiable/i.test(e.message)) throw e; ch.piiBlocked = true; } }
      return gql(query.replace(/__FIELDS__/g, SHOPIFY_ORDER_FIELDS_NO_PII), vars);
    },
    async listOrders(sinceIso) {
      const out = []; let after = null; const q = `updated_at:>'${sinceIso}'`;
      for (let page = 0; page < 20; page++) {
        const d = await this.orderGql(`query($after: String, $q: String) { orders(first: 25, after: $after, query: $q, sortKey: UPDATED_AT) { pageInfo { hasNextPage endCursor } nodes { __FIELDS__ } } }`, { after, q });
        out.push(...d.orders.nodes.map(normShopifyOrder)); if (!d.orders.pageInfo.hasNextPage) break; after = d.orders.pageInfo.endCursor;
      }
      return out;
    },
    async getOrder(id) { const d = await this.orderGql(`query($id: ID!) { order(id: $id) { __FIELDS__ } }`, { id }); return d.order ? normShopifyOrder(d.order) : null; },
    async fulfil(externalId, trackingRef) {
      const d = await gql(`query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`, { id: externalId });
      const open = (d.order?.fulfillmentOrders?.nodes || []).filter((f) => ["OPEN", "IN_PROGRESS"].includes(f.status)); if (!open.length) return;
      const r = await gql(`mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { field message } } }`, { f: { lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })), notifyCustomer: true, ...(trackingRef ? { trackingInfo: { number: trackingRef } } : {}) } });
      userErr(r.fulfillmentCreate);
    },
    async cancel(externalId) { const d = await gql(`mutation($id: ID!) { orderCancel(orderId: $id, reason: OTHER, refund: false, restock: true, notifyCustomer: true) { orderCancelUserErrors { message } } }`, { id: externalId }); const e = d.orderCancel?.orderCancelUserErrors || []; if (e.length) throw new Error(`Shopify: ${e.map((x) => x.message).join("; ")}`); },
    async registerWebhooks(callbackUrl) {
      for (const topic of ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "PRODUCTS_UPDATE", "APP_UNINSTALLED"]) {
        const d = await gql(`mutation($t: WebhookSubscriptionTopic!, $w: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $t, webhookSubscription: $w) { webhookSubscription { id } userErrors { field message } } }`, { t: topic, w: { callbackUrl, format: "JSON" } });
        const e = d.webhookSubscriptionCreate?.userErrors || []; if (e.length && !e.some((x) => /already|taken/i.test(x.message))) throw new Error(`Shopify webhook ${topic}: ${e.map((x) => x.message).join("; ")}`);
      }
    },
  };
}
const SHOPIFY_ORDER_FIELDS = `id name email phone createdAt cancelledAt displayFinancialStatus currencyCode
  totalPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } }
  customer { firstName lastName email phone }
  shippingAddress { name address1 address2 city province zip countryCodeV2 phone }
  lineItems(first: 100) { nodes { id sku name quantity variant { id } discountedTotalSet { shopMoney { amount } } taxLines { rate priceSet { shopMoney { amount } } } } }`;
const SHOPIFY_ORDER_FIELDS_NO_PII = SHOPIFY_ORDER_FIELDS.replace("id name email phone ", "id name ").replace(/\s*customer \{[^}]*\}/, "").replace(/\s*shippingAddress \{[^}]*\}/, "");
export function normShopifyOrder(o) {
  const m = (x) => toMinor(x?.shopMoney?.amount ?? 0);
  return { externalId: o.id, number: o.name, createdAt: o.createdAt, currency: o.currencyCode, paid: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(o.displayFinancialStatus), refunded: o.displayFinancialStatus === "REFUNDED", cancelled: !!o.cancelledAt,
    customer: { name: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") || o.shippingAddress?.name || "", email: o.customer?.email || o.email || "", phone: o.customer?.phone || o.phone || o.shippingAddress?.phone || "" },
    address: o.shippingAddress ? { line1: o.shippingAddress.address1 || "", line2: o.shippingAddress.address2 || "", city: o.shippingAddress.city || "", region: o.shippingAddress.province || "", postcode: o.shippingAddress.zip || "", country: o.shippingAddress.countryCodeV2 || "" } : null,
    lines: o.lineItems.nodes.map((l) => { const tax = (l.taxLines || []).reduce((n, t) => n + m(t.priceSet), 0); return { externalLineId: l.id, externalVariantId: l.variant?.id || null, sku: l.sku || "", name: l.name, quantity: l.quantity, lineNetMinor: m(l.discountedTotalSet), taxMinor: tax, taxRate: Math.round(((l.taxLines || [])[0]?.rate || 0) * 10000) / 100 }; }),
    shippingMinor: m(o.totalShippingPriceSet), taxMinor: m(o.totalTaxSet), totalMinor: m(o.totalPriceSet) };
}

export function wooClient(ch, fetchImpl = fetch) {
  const key = openSafe(ch.keySealed), secret = openSafe(ch.secretSealed); if (!key || !secret) throw new Error("The WooCommerce API keys are missing. Reconnect the store.");
  const auth = `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
  const api = async (method, path, body = null) => {
    const r = await fetchImpl(`${ch.siteUrl}/wp-json/wc/v3/${path}`, { method, headers: { Authorization: auth, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (r.status === 429 || r.status >= 500) throw retryable(new Error(`WooCommerce is busy (${r.status}); will retry.`));
    if (r.status === 401 || r.status === 403) throw new Error("WooCommerce refused the API key (it needs Read/Write access).");
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`WooCommerce: ${j?.message || r.status}`);
    return j;
  };
  return {
    async info() { const s = await api("GET", "settings/general/woocommerce_currency"); return { name: ch.siteUrl.replace(/^https:\/\//, ""), currency: s?.value || null, locations: [] }; },
    async listProducts() {
      const out = [];
      for (let page = 1; page <= 50; page++) {
        const rows = await api("GET", `products?per_page=100&page=${page}`); if (!rows?.length) break;
        for (const p of rows) {
          if (p.type === "variable") { const vars = await api("GET", `products/${p.id}/variations?per_page=100`); for (const v of vars) out.push({ externalProductId: String(p.id), externalVariantId: String(v.id), inventoryItemId: null, sku: v.sku || "", title: `${p.name} - ${(v.attributes || []).map((a) => a.option).join(" / ")}`, priceMinor: toMinor(v.regular_price || v.price || 0), status: p.status }); }
          else out.push({ externalProductId: String(p.id), externalVariantId: null, inventoryItemId: null, sku: p.sku || "", title: p.name, priceMinor: toMinor(p.regular_price || p.price || 0), status: p.status });
        }
        if (rows.length < 100) break;
      }
      return out;
    },
    async createProduct({ title, description, sku, priceMinor, stock }) { const p = await api("POST", "products", { name: title, type: "simple", status: "publish", regular_price: fromMinor(priceMinor).toFixed(2), sku, description: description || "", manage_stock: true, stock_quantity: Math.max(0, Math.floor(stock || 0)) }); return { externalProductId: String(p.id), externalVariantId: null, inventoryItemId: null }; },
    async updateProduct(m, { title, priceMinor }) { const body = { ...(title ? { name: title } : {}), ...(priceMinor !== undefined ? { regular_price: fromMinor(priceMinor).toFixed(2) } : {}) }; if (!Object.keys(body).length) return; if (m.externalVariantId) { delete body.name; await api("PUT", `products/${m.externalProductId}/variations/${m.externalVariantId}`, body); } else await api("PUT", `products/${m.externalProductId}`, body); },
    async setStock(items) { // [{ externalProductId, externalVariantId, quantity }]
      const simple = items.filter((i) => !i.externalVariantId); for (let k = 0; k < simple.length; k += 100) await api("POST", "products/batch", { update: simple.slice(k, k + 100).map((i) => ({ id: Number(i.externalProductId), manage_stock: true, stock_quantity: Math.max(0, Math.floor(i.quantity)) })) });
      const byParent = new Map(); for (const i of items.filter((x) => x.externalVariantId)) byParent.set(i.externalProductId, [...(byParent.get(i.externalProductId) || []), i]);
      for (const [pid, vs] of byParent) await api("POST", `products/${pid}/variations/batch`, { update: vs.map((i) => ({ id: Number(i.externalVariantId), manage_stock: true, stock_quantity: Math.max(0, Math.floor(i.quantity)) })) });
    },
    async listOrders(sinceIso) { const out = []; for (let page = 1; page <= 20; page++) { const rows = await api("GET", `orders?per_page=100&page=${page}&modified_after=${encodeURIComponent(sinceIso)}&orderby=modified&order=asc`); if (!rows?.length) break; out.push(...rows.map(normWooOrder)); if (rows.length < 100) break; } return out; },
    async getOrder(id) { return normWooOrder(await api("GET", `orders/${encodeURIComponent(id)}`)); },
    async fulfil(externalId, trackingRef) { await api("PUT", `orders/${encodeURIComponent(externalId)}`, { status: "completed", ...(trackingRef ? { customer_note: `Tracking reference: ${trackingRef}` } : {}) }); },
    async cancel(externalId) { await api("PUT", `orders/${encodeURIComponent(externalId)}`, { status: "cancelled" }); },
    async registerWebhooks(callbackUrl, secretValue) {
      const existing = await api("GET", "webhooks?per_page=100").catch(() => []);
      for (const topic of ["order.created", "order.updated", "product.updated"]) {
        if ((existing || []).some((w) => w.topic === topic && w.delivery_url === callbackUrl && w.status === "active")) continue;
        await api("POST", "webhooks", { name: `Inaya ${topic}`, topic, delivery_url: callbackUrl, secret: secretValue, status: "active" });
      }
    },
  };
}
export function normWooOrder(o) {
  const m = (x) => toMinor(x || 0);
  return { externalId: String(o.id), number: `#${o.number || o.id}`, createdAt: o.date_created_gmt ? `${o.date_created_gmt}Z` : o.date_created, currency: o.currency, paid: !!o.date_paid || ["processing", "completed"].includes(o.status), refunded: o.status === "refunded", cancelled: ["cancelled", "failed"].includes(o.status), pendingPayment: ["pending", "on-hold"].includes(o.status),
    customer: { name: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" "), email: o.billing?.email || "", phone: o.billing?.phone || "" },
    address: o.shipping?.address_1 ? { line1: o.shipping.address_1, line2: o.shipping.address_2 || "", city: o.shipping.city || "", region: o.shipping.state || "", postcode: o.shipping.postcode || "", country: o.shipping.country || "" } : null,
    lines: (o.line_items || []).map((l) => ({ externalLineId: String(l.id), externalVariantId: l.variation_id ? String(l.variation_id) : null, externalProductId: String(l.product_id), sku: l.sku || "", name: l.name, quantity: Number(l.quantity), lineNetMinor: m(l.total), taxMinor: m(l.total_tax), taxRate: m(l.total) ? Math.round((m(l.total_tax) / m(l.total)) * 10000) / 100 : 0 })),
    shippingMinor: m(o.shipping_total) + m(o.shipping_tax), taxMinor: m(o.total_tax) - m(o.shipping_tax), totalMinor: m(o.total) };
}
const clientFor = (ch, fetchImpl) => (ch.platform === "SHOPIFY" ? shopifyClient(ch, fetchImpl) : wooClient(ch, fetchImpl));

// ---------------------------------------------------------------- webhook signatures
/** Shopify: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(app API secret, raw body)). WooCommerce: X-WC-Webhook-Signature = same with
 *  the webhook secret Inaya generated when registering. */
export function verifyChannelSignature(rawBody, header, secret) { if (!header || !secret) return false; return safeEqual(createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"), String(header).trim()); }

// ---------------------------------------------------------------- views & connection
export function channelView(ch) {
  if (!ch) return null;
  return { id: sid(ch._id), platform: ch.platform, name: ch.name, status: ch.status, address: ch.platform === "SHOPIFY" ? ch.shopDomain : ch.siteUrl, warehouseId: sid(ch.warehouseId), departmentId: sid(ch.departmentId), locationId: ch.locationId || null, locations: ch.locations || [], currency: ch.currency || null,
    masters: ch.masters, stockBuffer: ch.stockBuffer || 0, priceListId: sid(ch.priceListId), credentialsHint: ch.credHint || null, webhookSecretSet: !!ch.webhookSecretSealed, webhooksRegisteredAt: ch.webhooksRegisteredAt || null,
    lastOrderSyncAt: ch.lastOrderSyncAt || null, lastStockPushAt: ch.lastStockPushAt || null, lastProductSyncAt: ch.lastProductSyncAt || null, lastError: ch.lastError || null, createdAt: ch.createdAt };
}
async function channelDoc(orgId, id) { const c = await ccol(); return c.findOne({ _id: oid(id), orgId: oid(orgId), kind: OK.channel, deletedAt: null }); }
export async function listChannels({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  await ensureOnlineIndexes(); const c = await ccol();
  const rows = await c.find({ orgId: oid(orgId), kind: OK.channel, deletedAt: null }).sort({ createdAt: 1 }).toArray();
  const { shopifyAppConfig } = await import("./shopifyApp.js");
  return { channels: rows.map(channelView), limits: await planLimits(orgId), usage: await monthlyUsage(orgId), shopifyApp: { enabled: shopifyAppConfig().enabled } };
}
export async function monthlyUsage(orgId) { const c = await ccol(); const since = `${nowIso().slice(0, 7)}-01T00:00:00.000Z`; return { syncedOrdersThisMonth: await c.countDocuments({ orgId: oid(orgId), kind: OK.corder, importedAt: { $gte: since } }) }; }

const normShop = (s) => { const h = String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""); return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(h) ? h : null; };
const normSite = (s) => { try { const u = new URL(String(s || "").trim()); const testEnv = !!process.env.NODE_TEST_CONTEXT || process.env.INAYA_USE_TEST_DB === "1"; // local WooCommerce sites only in test environments
  if (u.protocol !== "https:" && !(testEnv && ["localhost", "127.0.0.1"].includes(u.hostname))) return null; return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`; } catch { return null; } };

/** null when the company may connect another store of this platform, otherwise the refusal. */
export async function checkChannelLimit(orgId, platform) {
  const c = await ccol(); const lim = await planLimits(orgId); const existing = await c.find({ orgId: oid(orgId), kind: OK.channel, deletedAt: null }).toArray();
  const samePlatform = existing.filter((x) => x.platform === platform).length;
  if (existing.length >= lim.total || (lim.connected && samePlatform >= (lim.connected[platform] || 0) + lim.extraStores)) return fail(lim.plan === "enterprise" ? `Your plan includes ${lim.total} connected stores. Contact Inaya to add more.` : `Your plan includes 1 Shopify and 1 WooCommerce store${lim.extraStores ? ` plus ${lim.extraStores} extra` : ""}. Enterprise includes 3 connected stores; extra stores can be added.`, 403, "CHANNEL_LIMIT");
  return null;
}

/** Connects a store: checks the plan limit, tests the credentials against the platform, then saves them sealed. `oauthGrant` is
 *  passed only by the Shopify install callback (shopifyApp.js), never from a request body. */
export async function connectChannel({ orgId, membership, actorEmail, input = {}, fetchImpl = fetch, oauthGrant = null }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  await ensureOnlineIndexes(); const c = await ccol();
  const platform = String(input.platform || "").toUpperCase(); if (!PLATFORMS.includes(platform)) return fail("Choose Shopify or WooCommerce.");
  const limited = await checkChannelLimit(orgId, platform); if (limited) return limited;
  const { warehouses, departments } = await getOrgCollections();
  const wh = input.warehouseId ? await warehouses.findOne({ _id: oid(input.warehouseId), orgId: oid(orgId) }) : await warehouses.findOne({ orgId: oid(orgId) }, { sort: { createdAt: 1 } }); if (!wh) return fail("Add a location first; channel orders are fulfilled from it.", 409);
  const dept = input.departmentId ? await departments.findOne({ _id: oid(input.departmentId), orgId: oid(orgId) }) : await departments.findOne({ orgId: oid(orgId) }, { sort: { createdAt: 1 } }); if (!dept) return fail("Add a department first.", 409);
  const doc = { orgId: oid(orgId), kind: OK.channel, platform, name: clean(input.name, 80), status: "ACTIVE", warehouseId: wh._id, departmentId: dept._id, masters: { price: "inaya", title: "inaya", stock: "inaya" }, stockBuffer: 0, priceListId: null, deletedAt: null };
  if (platform === "SHOPIFY") {
    const shop = normShop(input.shopDomain); if (!shop) return fail("Enter the store's myshopify.com address (e.g. yourshop.myshopify.com).");
    if (await c.findOne({ orgId: oid(orgId), kind: OK.channel, platform: "SHOPIFY", shopDomain: shop, deletedAt: null })) return fail("That Shopify store is already connected.", 409);
    const token = oauthGrant ? String(oauthGrant.token) : String(input.accessToken || "").trim(); if (!oauthGrant && !/^shpat_[A-Za-z0-9]{20,}$/.test(token)) return fail("Paste the Admin API access token from the custom app (starts with shpat_).");
    const appSecret = oauthGrant ? String(oauthGrant.secret) : String(input.apiSecret || "").trim(); if (appSecret.length < 16) return fail("Paste the custom app's API secret key (Shopify uses it to sign webhooks).");
    Object.assign(doc, { shopDomain: shop, tokenSealed: seal(token), webhookSecretSealed: seal(appSecret), credHint: last4(token), connectMethod: oauthGrant ? "inaya_app" : "custom_app", grantedScopes: oauthGrant?.scope || null });
  } else {
    const site = normSite(input.siteUrl); if (!site) return fail("Enter the shop's https web address (e.g. https://shop.example.com).");
    const ck = String(input.consumerKey || "").trim(), cs = String(input.consumerSecret || "").trim();
    if (!/^ck_[a-f0-9]{20,}$/i.test(ck) || !/^cs_[a-f0-9]{20,}$/i.test(cs)) return fail("Paste the WooCommerce REST API consumer key (ck_…) and secret (cs_…).");
    Object.assign(doc, { siteUrl: site, keySealed: seal(ck), secretSealed: seal(cs), webhookSecretSealed: seal(randomBytes(24).toString("base64url")), credHint: last4(ck) });
  }
  let info; try { info = await clientFor(doc, fetchImpl).info(); } catch (e) { return fail(`Couldn't connect: ${e.message}`, 400, "CHANNEL_AUTH"); }
  const now = nowIso();
  Object.assign(doc, { name: doc.name || info.name, currency: info.currency, locations: info.locations, locationId: platform === "SHOPIFY" ? (info.locations.find((l) => l.id === input.locationId) || info.locations[0])?.id || null : null, orderSyncFrom: input.importOrdersFrom ? new Date(input.importOrdersFrom).toISOString() : now, createdByEmail: actorEmail, createdAt: now, updatedAt: now });
  const r = await c.insertOne(doc); doc._id = r.insertedId;
  await audit({ orgId, actorEmail, recordType: "SALES_CHANNEL", recordId: doc._id, action: "CHANNEL_CONNECTED", metadata: { platform, address: doc.shopDomain || doc.siteUrl } });
  const settings = await getSettings(orgId);
  return { channel: channelView(doc), warning: info.currency && info.currency !== settings.currency ? `This store sells in ${info.currency}; Inaya Commerce is set to ${settings.currency}. Orders keep the store's currency.` : null };
}
export async function updateChannel({ orgId, membership, actorEmail, id, input = {} }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const ch = await channelDoc(orgId, id); if (!ch) return fail("Connected store not found.", 404); const set = { updatedAt: nowIso() };
  if (input.status) { if (!["ACTIVE", "PAUSED"].includes(input.status)) return fail("Status is ACTIVE or PAUSED."); set.status = input.status; }
  if (input.masters) set.masters = { price: input.masters.price === "channel" ? "channel" : "inaya", title: input.masters.title === "channel" ? "channel" : "inaya", stock: "inaya" };
  if (input.stockBuffer !== undefined) set.stockBuffer = Math.max(0, Math.min(1000, Math.floor(Number(input.stockBuffer) || 0)));
  if (input.locationId && ch.platform === "SHOPIFY") { if (!(ch.locations || []).some((l) => l.id === input.locationId)) return fail("Unknown Shopify location."); set.locationId = input.locationId; }
  if (input.warehouseId) { const { warehouses } = await getOrgCollections(); if (!await warehouses.findOne({ _id: oid(input.warehouseId), orgId: oid(orgId) })) return fail("Location not found.", 404); set.warehouseId = oid(input.warehouseId); }
  if (input.priceListId !== undefined) set.priceListId = input.priceListId ? oid(input.priceListId) : null;
  if (input.accessToken && ch.platform === "SHOPIFY") { if (!/^shpat_[A-Za-z0-9]{20,}$/.test(input.accessToken)) return fail("That isn't a Shopify access token."); set.tokenSealed = seal(input.accessToken); set.credHint = last4(input.accessToken); }
  const c = await ccol(); await c.updateOne({ _id: ch._id }, { $set: set });
  await audit({ orgId, actorEmail, recordType: "SALES_CHANNEL", recordId: ch._id, action: "CHANNEL_UPDATED", metadata: { fields: Object.keys(set) } });
  return { channel: channelView(await c.findOne({ _id: ch._id })) };
}
export async function disconnectChannel({ orgId, membership, actorEmail, id }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const ch = await channelDoc(orgId, id); if (!ch) return fail("Connected store not found.", 404); const c = await ccol();
  await c.updateOne({ _id: ch._id }, { $set: { deletedAt: nowIso(), status: "DISCONNECTED", tokenSealed: null, keySealed: null, secretSealed: null, webhookSecretSealed: null } }); // credentials destroyed
  await audit({ orgId, actorEmail, recordType: "SALES_CHANNEL", recordId: ch._id, action: "CHANNEL_DISCONNECTED", metadata: { platform: ch.platform } });
  return { ok: true };
}
export async function registerWebhooks({ orgId, membership, actorEmail, id, baseUrl, fetchImpl = fetch }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const ch = await channelDoc(orgId, id); if (!ch) return fail("Connected store not found.", 404);
  const url = `${baseUrl}/api/shop/channels/${ch.platform === "SHOPIFY" ? "shopify" : "woocommerce"}/${sid(ch._id)}`;
  try { await clientFor(ch, fetchImpl).registerWebhooks(url, openSafe(ch.webhookSecretSealed)); } catch (e) { return fail(`Couldn't register webhooks: ${e.message}`, 400); }
  const c = await ccol(); await c.updateOne({ _id: ch._id }, { $set: { webhooksRegisteredAt: nowIso(), updatedAt: nowIso() } });
  await audit({ orgId, actorEmail, recordType: "SALES_CHANNEL", recordId: ch._id, action: "CHANNEL_WEBHOOKS_REGISTERED" });
  return { channel: channelView(await c.findOne({ _id: ch._id })), callbackUrl: url };
}

// ---------------------------------------------------------------- job log + retry (reconciliation dashboard)
async function logJob(ch, type, ref, fn, { payload = null } = {}) {
  const c = await ccol(); const now = nowIso();
  const key = { orgId: ch.orgId, kind: OK.log, channelId: ch._id, type, ref: ref ? String(ref) : null };
  try {
    const out = await fn();
    await c.insertOne({ ...key, ok: true, attempts: 1, createdAt: now, updatedAt: now, summary: out?.summary || null });
    if (ref) await c.updateMany({ ...key, ok: false, resolvedAt: null }, { $set: { resolvedAt: now, updatedAt: now } }); // a later success clears earlier failures
    return out;
  } catch (e) {
    // one open failure per job+reference: repeats (webhook + poll) bump the attempt count instead of piling up
    await c.updateOne({ ...key, ok: false, resolvedAt: null }, { $set: { error: String(e.message).slice(0, 500), retryable: !!e.retryable || type === "IMPORT_ORDER" || type === "PUSH_STATUS", nextAttemptAt: new Date(Date.now() + 60000).toISOString(), payload, updatedAt: now }, $inc: { attempts: 1 }, $setOnInsert: { createdAt: now } }, { upsert: true });
    await c.updateOne({ _id: ch._id }, { $set: { lastError: { at: now, type, message: String(e.message).slice(0, 300) } } });
    throw e;
  }
}
export async function syncLog({ orgId, membership, channelId = null, failedOnly = false, limit = 200 }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const c = await ccol(); const q = { orgId: oid(orgId), kind: OK.log, ...(channelId ? { channelId: oid(channelId) } : {}), ...(failedOnly ? { ok: false, resolvedAt: null } : {}) };
  const rows = await c.find(q).sort({ createdAt: -1 }).limit(Math.min(500, limit)).toArray();
  const open = await c.countDocuments({ orgId: oid(orgId), kind: OK.log, ok: false, resolvedAt: null, ...(channelId ? { channelId: oid(channelId) } : {}) });
  return { entries: rows.map((r) => ({ id: sid(r._id), channelId: sid(r.channelId), type: r.type, ref: r.ref, ok: r.ok, error: r.error || null, attempts: r.attempts, nextAttemptAt: r.ok || r.resolvedAt ? null : r.nextAttemptAt || null, resolvedAt: r.resolvedAt || null, summary: r.summary || null, createdAt: r.createdAt })), openFailures: open };
}
/** Retries failed jobs that are due (or one job now). Gives up after MAX_ATTEMPTS and leaves it on the dashboard. */
export async function retryFailed({ orgId = null, logId = null, fetchImpl = fetch } = {}) {
  const c = await ccol(); const now = nowIso(); let retried = 0, fixed = 0;
  const q = logId ? { _id: oid(logId), kind: OK.log, ok: false, resolvedAt: null } : { kind: OK.log, ok: false, resolvedAt: null, retryable: true, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now }, ...(orgId ? { orgId: oid(orgId) } : {}) };
  for (const j of await c.find(q).limit(100).toArray()) {
    const ch = await c.findOne({ _id: j.channelId, kind: OK.channel, deletedAt: null }); if (!ch || ch.status !== "ACTIVE") continue; retried++;
    try {
      if (j.type === "IMPORT_ORDER") await importOrder({ ch, externalId: j.ref, fetchImpl, fromRetry: true });
      else if (j.type === "PUSH_STATUS") await pushStatusFor({ ch, orderId: j.payload?.orderId, action: j.payload?.action, fetchImpl, fromRetry: true });
      else if (j.type === "PUSH_STOCK") await pushStock({ ch, fetchImpl, fromRetry: true });
      else continue;
      await c.updateOne({ _id: j._id }, { $set: { resolvedAt: nowIso(), updatedAt: nowIso() } }); fixed++;
    } catch (e) { const a = (j.attempts || 1) + 1; await c.updateOne({ _id: j._id }, { $set: { attempts: a, error: String(e.message).slice(0, 500), nextAttemptAt: new Date(Date.now() + Math.min(24 * 3600000, 60000 * 2 ** a)).toISOString(), updatedAt: nowIso() } }); }
  }
  return { retried, fixed };
}

// ---------------------------------------------------------------- products & prices
async function priceFor(ch, p) { if (ch.priceListId) { const c = await ccol(); const x = await c.findOne({ orgId: ch.orgId, kind: CK.price, priceListId: ch.priceListId, productId: p._id }); if (x) return x.priceMinor; } return Number.isFinite(p.unitPrice) ? toMinor(p.unitPrice) : null; }
async function freeQty(ch, productIds) { const { stockLevels } = await getOrgCollections(); return new Map((await stockLevels.find({ orgId: ch.orgId, warehouseId: ch.warehouseId, productId: { $in: productIds } }).toArray()).map((l) => [sid(l.productId), Math.max(0, (l.quantity || 0) - (l.reserved || 0))])); }

/** Reads the channel's catalogue and matches it to Inaya products by SKU (case-insensitive). Unmatched items are returned so a
 *  person can create them in Inaya; prices that changed on the channel while Inaya is the master become conflicts. */
export async function pullProducts({ orgId, membership, id, fetchImpl = fetch }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const ch = await channelDoc(orgId, id); if (!ch) return fail("Connected store not found.", 404);
  try {
    return await logJob(ch, "PULL_PRODUCTS", null, async () => {
      const items = await clientFor(ch, fetchImpl).listProducts(); const c = await ccol(); const { products } = await getOrgCollections();
      const bySku = new Map((await products.find({ orgId: ch.orgId, deletedAt: null, sku: { $in: [...new Set(items.map((i) => i.sku).filter(Boolean))] } }).toArray()).map((p) => [String(p.sku).toLowerCase(), p]));
      const allSkus = new Map((await products.find({ orgId: ch.orgId, deletedAt: null }, { projection: { sku: 1, name: 1, unitPrice: 1 } }).toArray()).map((p) => [String(p.sku || "").toLowerCase(), p]));
      let matched = 0, conflicts = 0; const unmatched = [];
      for (const it of items) {
        const p = bySku.get(String(it.sku).toLowerCase()) || allSkus.get(String(it.sku).toLowerCase());
        if (!it.sku || !p) { unmatched.push({ sku: it.sku || null, title: it.title, price: fromMinor(it.priceMinor || 0), externalProductId: it.externalProductId, externalVariantId: it.externalVariantId, inventoryItemId: it.inventoryItemId || null }); continue; }
        matched++;
        const prev = await c.findOne({ orgId: ch.orgId, kind: OK.map, channelId: ch._id, productId: p._id });
        await c.updateOne({ orgId: ch.orgId, kind: OK.map, channelId: ch._id, productId: p._id }, { $set: { externalProductId: it.externalProductId, externalVariantId: it.externalVariantId, inventoryItemId: it.inventoryItemId, sku: it.sku, lastSeen: { priceMinor: it.priceMinor, title: it.title, at: nowIso() }, updatedAt: nowIso() }, $setOnInsert: { createdAt: nowIso(), lastPushed: { priceMinor: it.priceMinor, title: it.title } } }, { upsert: true });
        const inayaPrice = await priceFor(ch, p);
        const channelChanged = prev?.lastPushed?.priceMinor !== undefined && it.priceMinor !== prev.lastPushed.priceMinor;
        if (ch.masters?.price === "channel" && it.priceMinor !== inayaPrice) await applyChannelPrice(ch, p, it.priceMinor);
        else if (channelChanged && it.priceMinor !== inayaPrice) { await openConflict(ch, p, "price", inayaPrice, it.priceMinor); conflicts++; }
      }
      await c.updateOne({ _id: ch._id }, { $set: { lastProductSyncAt: nowIso() } });
      return { matched, unmatched, conflicts, total: items.length, summary: `${matched} matched, ${unmatched.length} unmatched, ${conflicts} conflicts` };
    });
  } catch (e) { return fail(e.message, 400); }
}
async function applyChannelPrice(ch, p, priceMinor) {
  const c = await ccol();
  if (ch.priceListId) await c.updateOne({ orgId: ch.orgId, kind: CK.price, priceListId: ch.priceListId, productId: p._id }, { $set: { priceMinor, updatedAt: nowIso(), updatedByEmail: SYSTEM_ACTOR }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  else { const { products } = await getOrgCollections(); await products.updateOne({ _id: p._id }, { $set: { unitPrice: fromMinor(priceMinor), updatedAt: nowIso() } }); }
  await c.updateOne({ orgId: ch.orgId, kind: OK.map, channelId: ch._id, productId: p._id }, { $set: { "lastPushed.priceMinor": priceMinor } });
  await audit({ orgId: ch.orgId, actorEmail: SYSTEM_ACTOR, recordType: "PRODUCT", recordId: p._id, action: "PRICE_FROM_CHANNEL", metadata: { channel: ch.platform, price: fromMinor(priceMinor) } });
}
async function openConflict(ch, p, field, inayaValue, channelValue) {
  const c = await ccol();
  await c.updateOne({ orgId: ch.orgId, kind: OK.conflict, channelId: ch._id, productId: p._id, field, status: "OPEN" }, { $set: { inayaValue, channelValue, updatedAt: nowIso() }, $setOnInsert: { createdAt: nowIso(), sku: p.sku, name: p.name } }, { upsert: true });
}
export async function listConflicts({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: OK.conflict, status: "OPEN" }).sort({ createdAt: -1 }).limit(500).toArray();
  return { conflicts: rows.map((r) => ({ id: sid(r._id), channelId: sid(r.channelId), productId: sid(r.productId), sku: r.sku, name: r.name, field: r.field, inayaValue: r.field === "price" ? fromMinor(r.inayaValue ?? 0) : r.inayaValue, channelValue: r.field === "price" ? fromMinor(r.channelValue ?? 0) : r.channelValue, createdAt: r.createdAt })) };
}
/** keep: "inaya" pushes Inaya's value to the channel; "channel" adopts the channel's value in Inaya. */
export async function resolveConflict({ orgId, membership, actorEmail, id, keep, fetchImpl = fetch }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const c = await ccol(); const cf = await c.findOne({ _id: oid(id), orgId: oid(orgId), kind: OK.conflict, status: "OPEN" }); if (!cf) return fail("Conflict not found.", 404);
  const ch = await c.findOne({ _id: cf.channelId, kind: OK.channel, deletedAt: null }); if (!ch) return fail("Connected store not found.", 404);
  const { products } = await getOrgCollections(); const p = await products.findOne({ _id: cf.productId, orgId: oid(orgId) }); if (!p) return fail("Product not found.", 404);
  if (keep === "channel") await applyChannelPrice(ch, p, cf.channelValue);
  else if (keep === "inaya") { const m = await c.findOne({ orgId: ch.orgId, kind: OK.map, channelId: ch._id, productId: p._id }); try { await clientFor(ch, fetchImpl).updateProduct(m, { priceMinor: cf.inayaValue }); } catch (e) { return fail(e.message, 400); } await c.updateOne({ _id: m._id }, { $set: { "lastPushed.priceMinor": cf.inayaValue } }); }
  else return fail("Choose which value to keep.");
  await c.updateOne({ _id: cf._id }, { $set: { status: "RESOLVED", resolution: keep, resolvedBy: actorEmail, resolvedAt: nowIso() } });
  await audit({ orgId, actorEmail, recordType: "SALES_CHANNEL", recordId: ch._id, action: "CONFLICT_RESOLVED", metadata: { productId: sid(p._id), field: cf.field, keep } });
  return { ok: true };
}
/** Publishes Inaya products to the channel (create if not mapped, otherwise update title/price per the field masters) and pushes their stock. */
export async function pushProducts({ orgId, membership, actorEmail, id, productIds = [], fetchImpl = fetch }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const ch = await channelDoc(orgId, id); if (!ch) return fail("Connected store not found.", 404); if (ch.status !== "ACTIVE") return fail("This connection is paused.", 409);
  const c = await ccol(); const { products } = await getOrgCollections(); const cli = clientFor(ch, fetchImpl);
  const prods = await products.find({ _id: { $in: (Array.isArray(productIds) ? productIds : []).slice(0, 200).map(oid).filter(Boolean) }, orgId: ch.orgId, deletedAt: null }).toArray();
  const free = await freeQty(ch, prods.map((p) => p._id)); const results = [];
  for (const p of prods) {
    if (!p.sku) { results.push({ productId: sid(p._id), ok: false, error: "Give the product a SKU first (products are matched by SKU)." }); continue; }
    if (["GIFT_CARD", "SERVICE"].includes(p.productType)) { results.push({ productId: sid(p._id), ok: false, error: "Gift cards and services aren't published to online stores." }); continue; }
    const price = await priceFor(ch, p); if (price === null) { results.push({ productId: sid(p._id), ok: false, error: "No price." }); continue; }
    try {
      await logJob(ch, "PUSH_PRODUCT", p.sku, async () => {
        let m = await c.findOne({ orgId: ch.orgId, kind: OK.map, channelId: ch._id, productId: p._id });
        if (!m) {
          const made = await cli.createProduct({ title: p.name, description: p.description || "", sku: p.sku, priceMinor: price, stock: Math.max(0, (free.get(sid(p._id)) || 0) - (ch.stockBuffer || 0)) });
          m = { orgId: ch.orgId, kind: OK.map, channelId: ch._id, productId: p._id, ...made, sku: p.sku, lastPushed: { priceMinor: price, title: p.name }, createdAt: nowIso(), updatedAt: nowIso() };
          await c.insertOne(m);
        } else {
          const upd = {}; if (ch.masters?.price !== "channel" && m.lastPushed?.priceMinor !== price) upd.priceMinor = price; if (ch.masters?.title !== "channel" && m.lastPushed?.title !== p.name) upd.title = p.name;
          if (Object.keys(upd).length) { await cli.updateProduct(m, upd); await c.updateOne({ _id: m._id }, { $set: { ...(upd.priceMinor !== undefined ? { "lastPushed.priceMinor": upd.priceMinor } : {}), ...(upd.title ? { "lastPushed.title": upd.title } : {}), updatedAt: nowIso() } }); }
        }
        return { summary: "published" };
      });
      results.push({ productId: sid(p._id), ok: true });
    } catch (e) { results.push({ productId: sid(p._id), ok: false, error: e.message }); }
  }
  await audit({ orgId, actorEmail, recordType: "SALES_CHANNEL", recordId: ch._id, action: "CHANNEL_PRODUCTS_PUSHED", metadata: { count: results.filter((r) => r.ok).length } });
  if (results.some((r) => r.ok)) await pushStock({ ch, fetchImpl }).catch(() => {});
  return { results };
}
/** Creates Inaya products for channel items that have no match (by SKU), then maps them. */
export async function importUnmatched({ orgId, membership, actorEmail, id, items = [] }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const ch = await channelDoc(orgId, id); if (!ch) return fail("Connected store not found.", 404);
  const c = await ccol(); const { products } = await getOrgCollections(); const out = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 200)) {
    const sku = clean(it.sku, 64); if (!sku) { out.push({ ok: false, error: "Item has no SKU in the channel; add one there first." }); continue; }
    if (await products.findOne({ orgId: ch.orgId, sku, deletedAt: null })) { out.push({ sku, ok: false, error: "A product with this SKU already exists." }); continue; }
    const now = nowIso(); const r = await products.insertOne({ orgId: ch.orgId, departmentId: ch.departmentId, name: clean(it.title, 200) || sku, sku, unit: "each", unitPrice: Number(it.price) || 0, productType: "STOCK", status: "ACTIVE", createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null });
    await c.insertOne({ orgId: ch.orgId, kind: OK.map, channelId: ch._id, productId: r.insertedId, externalProductId: String(it.externalProductId), externalVariantId: it.externalVariantId ? String(it.externalVariantId) : null, inventoryItemId: it.inventoryItemId || null, sku, lastPushed: { priceMinor: toMinor(it.price || 0), title: it.title }, createdAt: now, updatedAt: now });
    out.push({ sku, ok: true, productId: sid(r.insertedId) });
  }
  await audit({ orgId, actorEmail, recordType: "SALES_CHANNEL", recordId: ch._id, action: "CHANNEL_PRODUCTS_IMPORTED", metadata: { count: out.filter((x) => x.ok).length } });
  return { results: out };
}

// ---------------------------------------------------------------- stock (Inaya -> channel)
export async function pushStock({ ch, fetchImpl = fetch, force = false }) {
  if (ch.status !== "ACTIVE") return { pushed: 0 };
  if (ch.platform === "SHOPIFY" && !ch.locationId) throw new Error("Choose the Shopify location that Inaya's stock is published to.");
  return logJob(ch, "PUSH_STOCK", null, async () => {
    const c = await ccol(); const maps = await c.find({ orgId: ch.orgId, kind: OK.map, channelId: ch._id }).toArray(); if (!maps.length) return { pushed: 0, summary: "nothing mapped" };
    const { products } = await getOrgCollections(); const prods = new Map((await products.find({ _id: { $in: maps.map((m) => m.productId) }, orgId: ch.orgId }).toArray()).map((p) => [sid(p._id), p]));
    const free = await freeQty(ch, [...new Set(maps.flatMap((m) => { const p = prods.get(sid(m.productId)); return p?.productType === "KIT" ? (p.kitComponents || []).map((k) => oid(k.productId)) : [m.productId]; }))]);
    const changes = [];
    for (const m of maps) {
      const p = prods.get(sid(m.productId)); if (!p) continue;
      let qty = p.productType === "KIT" ? Math.min(...(p.kitComponents || []).map((k) => Math.floor((free.get(String(k.productId)) || 0) / (k.quantity || 1)))) : free.get(sid(p._id)) || 0;
      if (!Number.isFinite(qty)) qty = 0; qty = Math.max(0, Math.floor(qty) - (ch.stockBuffer || 0));
      if (force || m.lastPushed?.stock !== qty) changes.push({ m, quantity: qty });
    }
    const skipped = ch.platform === "SHOPIFY" ? changes.filter((x) => !x.m.inventoryItemId).length : 0;
    if (skipped) changes.splice(0, changes.length, ...changes.filter((x) => x.m.inventoryItemId));
    if (changes.length) {
      await clientFor(ch, fetchImpl).setStock(changes.map((x) => ({ inventoryItemId: x.m.inventoryItemId, externalProductId: x.m.externalProductId, externalVariantId: x.m.externalVariantId, quantity: x.quantity })));
      for (const x of changes) await c.updateOne({ _id: x.m._id }, { $set: { "lastPushed.stock": x.quantity, "lastPushed.stockAt": nowIso() } });
    }
    await c.updateOne({ _id: ch._id }, { $set: { lastStockPushAt: nowIso() } });
    return { pushed: changes.length, skipped, summary: `${changes.length} stock levels updated${skipped ? `; ${skipped} skipped (no Shopify inventory link yet: run Import & match products)` : ""}` };
  });
}
export async function syncStockNow({ orgId, membership, id, force = false, fetchImpl = fetch }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const ch = await channelDoc(orgId, id); if (!ch) return fail("Connected store not found.", 404);
  try { return await pushStock({ ch, fetchImpl, force }); } catch (e) { return fail(e.message, 400); }
}

// ---------------------------------------------------------------- orders (channel -> Inaya, and status back)
/** Imports (or updates) one channel order. Idempotent: the same external order is imported once (unique index), later calls only
 *  apply payment / cancellation changes. A line whose SKU isn't mapped fails the import and stays on the retry dashboard. */
export async function importOrder({ ch, externalId = null, order = null, fetchImpl = fetch, fromRetry = false }) {
  const run = async () => {
    const o = order || (await clientFor(ch, fetchImpl).getOrder(externalId)); if (!o) throw new Error("Order not found on the channel.");
    const c = await ccol(); const idem = `${sid(ch._id)}:${o.externalId}`;
    const existing = await c.findOne({ orgId: ch.orgId, kind: OK.corder, idem });
    if (existing) return applyOrderChanges(ch, existing, o);
    if (o.cancelled) return { summary: "cancelled before import; skipped" };
    if (o.pendingPayment) throw retryable(new Error("The order is waiting for payment on the channel; it will be imported when paid or processing."));
    const lim = await planLimits(sid(ch.orgId)); if (lim.monthlyOrders !== null && (await monthlyUsage(sid(ch.orgId))).syncedOrdersThisMonth >= lim.monthlyOrders) throw retryable(new Error(`The plan's ${lim.monthlyOrders} synced orders this month are used. Upgrade or add capacity; the order will import automatically.`));
    const maps = await c.find({ orgId: ch.orgId, kind: OK.map, channelId: ch._id }).toArray();
    const { products } = await getOrgCollections(); const lines = []; const invoiceLines = [];
    for (const l of o.lines) {
      const m = maps.find((x) => (l.externalVariantId && x.externalVariantId === l.externalVariantId) || (!l.externalVariantId && l.externalProductId && x.externalProductId === l.externalProductId && !x.externalVariantId)) || (l.sku ? maps.find((x) => String(x.sku).toLowerCase() === String(l.sku).toLowerCase()) : null);
      const p = m ? await products.findOne({ _id: m.productId, orgId: ch.orgId, deletedAt: null }) : l.sku ? await products.findOne({ orgId: ch.orgId, sku: l.sku, deletedAt: null }) : null;
      if (!p) throw new Error(`"${l.name}" (SKU ${l.sku || "none"}) isn't linked to an Inaya product. Import & match products, then retry.`);
      const unit = l.lineNetMinor / l.quantity;
      lines.push({ productId: p._id, sku: p.sku, description: l.name, quantity: l.quantity, unitPrice: Math.round(unit) / 100, unit: p.unit || "each", productType: p.productType || "STOCK", ...(p.productType === "KIT" ? { kitComponents: (p.kitComponents || []).map((k) => ({ productId: toObjectId(k.productId), quantity: k.quantity })) } : {}), netMinor: l.lineNetMinor, taxMinor: l.taxMinor, grossMinor: l.lineNetMinor + l.taxMinor, taxRate: l.taxRate, externalLineId: l.externalLineId });
      invoiceLines.push(Number.isInteger(unit) ? { description: l.name, quantity: l.quantity, unitPrice: unit / 100, taxPercent: l.taxRate || 0, sku: p.sku } : { description: `${l.quantity} × ${l.name}`, quantity: 1, unitPrice: l.lineNetMinor / 100, taxPercent: l.taxRate || 0, sku: p.sku });
    }
    // claim the idempotency key BEFORE placing, so two webhooks for the same order can't both import it
    try { await c.insertOne({ orgId: ch.orgId, kind: OK.corder, channelId: ch._id, idem, externalId: o.externalId, number: o.number, state: "IMPORTING", importedAt: nowIso() }); }
    catch (e) { if (e?.code === 11000) return { summary: "already imported" }; throw e; }
    try {
      const email = o.customer.email || `${String(o.number).replace(/[^a-z0-9]/gi, "").toLowerCase()}@${ch.platform.toLowerCase()}.customer.invalid`;
      const cr = await ensureCustomer({ orgId: sid(ch.orgId), departmentId: sid(ch.departmentId), name: o.customer.name, email, phone: o.customer.phone, address: o.address, source: ch.platform === "SHOPIFY" ? "Shopify" : "WooCommerce" }); if (cr.error) throw new Error(cr.error);
      const goods = o.lines.reduce((n, l) => n + l.lineNetMinor + l.taxMinor, 0);
      const placed = await placeOrder({ orgId: sid(ch.orgId), departmentId: sid(ch.departmentId), warehouseId: sid(ch.warehouseId), currency: o.currency, contact: cr.contact, channel: ch.platform, channelId: sid(ch._id), externalOrderId: o.externalId,
        lines, invoiceLines, goodsTotalMinor: goods, taxMinor: o.taxMinor, shipping: { method: o.address ? "DELIVERY" : "PICKUP", amountMinor: Math.max(0, o.totalMinor - goods), address: o.address, name: o.customer.name, phone: o.customer.phone },
        onlinePayment: { method: ch.platform, state: o.paid ? "PAID_ON_CHANNEL" : "PENDING_ON_CHANNEL" }, notes: `${ch.platform === "SHOPIFY" ? "Shopify" : "WooCommerce"} order ${o.number}`, allowBackorder: true, externalPaid: o.paid });
      if (placed.error) throw new Error(placed.error);
      await c.updateOne({ orgId: ch.orgId, kind: OK.corder, idem }, { $set: { state: "IMPORTED", orderId: oid(placed.orderId), paidRecorded: !!o.paid, updatedAt: nowIso() } });
      if (placed.order?.status === "BACKORDERED") await audit({ orgId: ch.orgId, actorEmail: SYSTEM_ACTOR, recordType: "SALES_ORDER", recordId: oid(placed.orderId), action: "CHANNEL_ORDER_BACKORDERED", metadata: { number: o.number } });
      return { summary: `imported as ${placed.orderNumber}${placed.order?.status === "BACKORDERED" ? " (backordered: not enough stock)" : ""}`, orderId: placed.orderId };
    } catch (e) { await c.deleteOne({ orgId: ch.orgId, kind: OK.corder, idem, state: "IMPORTING" }); throw e; }
  };
  if (fromRetry) return run();
  return logJob(ch, "IMPORT_ORDER", externalId || order?.externalId, run, { payload: null });
}
async function applyOrderChanges(ch, rec, o) {
  if (!rec.orderId) return { summary: "import in progress" };
  const c = await ccol(); const orgId = sid(ch.orgId); const orderId = sid(rec.orderId);
  if (o.paid && !rec.paidRecorded) { const total = o.totalMinor; await recordProviderPayment({ orgId, orderId, method: "MANUAL_REFERENCE", amountMinor: total, reference: `${ch.platform} order ${o.externalId}`, provider: ch.platform }); await c.updateOne({ _id: rec._id }, { $set: { paidRecorded: true } }); }
  if (o.cancelled && rec.state !== "CANCELLED") {
    const { transitionSalesOrder } = await import("../sales-orders.js"); const { salesOrders } = await getOrgCollections(); const so = await salesOrders.findOne({ _id: rec.orderId });
    const paidMinor = (so?.payments || []).reduce((n, p) => n + (p.kind === "REFUND" ? -p.amountMinor : p.amountMinor), 0);
    if (paidMinor > 0) await transitionSalesOrder({ orgId, orderId, action: "refund", membership: systemMembership(), actorEmail: SYSTEM_ACTOR, input: { method: "MANUAL_REFERENCE", amount: paidMinor / 100, reference: `${ch.platform} order ${o.externalId} cancelled`, reason: `Cancelled on ${ch.platform}` } });
    const r = await transitionSalesOrder({ orgId, orderId, action: "cancel", membership: systemMembership(), actorEmail: SYSTEM_ACTOR, input: { reason: `Cancelled on ${ch.platform}` } });
    if (r.error) { await salesOrders.updateOne({ _id: rec.orderId }, { $set: { "onlinePayment.attention": `Cancelled on ${ch.platform}, but couldn't be cancelled here: ${r.error}` } }); throw new Error(`Couldn't cancel ${o.number}: ${r.error}`); }
    await c.updateOne({ _id: rec._id }, { $set: { state: "CANCELLED", updatedAt: nowIso() } });
    return { summary: `${o.number} cancelled` };
  }
  return { summary: "no changes" };
}
/** Polls each active channel for orders changed since the last sync (catches anything a webhook missed). */
export async function pollOrders({ ch, fetchImpl = fetch }) {
  if (ch.status !== "ACTIVE") return { imported: 0 };
  const since = new Date(new Date(ch.lastOrderSyncAt || ch.orderSyncFrom || ch.createdAt).getTime() - 5 * 60000).toISOString(); const started = nowIso();
  const orders = await clientFor(ch, fetchImpl).listOrders(since); let imported = 0, failed = 0;
  for (const o of orders) { try { const r = await importOrder({ ch, order: o, fetchImpl }); if (/imported as/.test(r?.summary || "")) imported++; } catch { failed++; } }
  const c = await ccol(); await c.updateOne({ _id: ch._id }, { $set: { lastOrderSyncAt: started } });
  return { imported, failed, seen: orders.length };
}
export async function syncOrdersNow({ orgId, membership, id, fetchImpl = fetch }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const ch = await channelDoc(orgId, id); if (!ch) return fail("Connected store not found.", 404);
  try { return await pollOrders({ ch, fetchImpl }); } catch (e) { return fail(e.message, 400); }
}
async function pushStatusFor({ ch, orderId, action, fetchImpl = fetch, fromRetry = false }) {
  const run = async () => { const { salesOrders } = await getOrgCollections(); const so = await salesOrders.findOne({ _id: oid(orderId), orgId: ch.orgId }); if (!so?.externalOrderId) return { summary: "not a channel order" };
    const cli = clientFor(ch, fetchImpl); if (action === "fulfil") await cli.fulfil(so.externalOrderId, so.shipping?.trackingRef || null); else if (action === "cancel") { if (/^Cancelled on /.test(so.cancelReason || "")) return { summary: "cancelled by the channel" }; await cli.cancel(so.externalOrderId); }
    return { summary: `${action} sent for ${so.orderNumber}` }; };
  if (fromRetry) return run();
  return logJob(ch, "PUSH_STATUS", orderId, run, { payload: { orderId, action } });
}
export async function pushOrderStatus({ orgId, orderId, action, fetchImpl = fetch }) {
  const { salesOrders } = await getOrgCollections(); const so = await salesOrders.findOne({ _id: oid(orderId), orgId: oid(orgId) }); if (!so?.channelId) return;
  const c = await ccol(); const ch = await c.findOne({ _id: so.channelId, kind: OK.channel, deletedAt: null }); if (!ch || ch.status !== "ACTIVE") return;
  await pushStatusFor({ ch, orderId, action, fetchImpl }).catch(() => {}); // failures stay on the retry dashboard
  if (action === "fulfil" || action === "cancel") pushStock({ ch, fetchImpl }).catch(() => {});
}

// ---------------------------------------------------------------- inbound webhooks
export async function channelWebhook({ platform, channelId, rawBody, headers, fetchImpl = fetch }) {
  const c = await ccol(); const ch = await c.findOne({ _id: oid(channelId), kind: OK.channel, deletedAt: null, platform });
  if (!ch) return fail("Unknown connection.", 404);
  const sig = platform === "SHOPIFY" ? headers.get("x-shopify-hmac-sha256") : headers.get("x-wc-webhook-signature");
  // WooCommerce sends an unsigned "webhook_id=…" ping when a webhook is created
  if (platform === "WOOCOMMERCE" && !sig && /^webhook_id=\d+$/.test(String(rawBody).trim())) return { received: true, ping: true };
  if (!verifyChannelSignature(rawBody, sig, openSafe(ch.webhookSecretSealed))) return fail("Invalid signature.", 401);
  if (ch.status !== "ACTIVE") return { received: true, paused: true };
  const topic = platform === "SHOPIFY" ? headers.get("x-shopify-topic") : headers.get("x-wc-webhook-topic");
  let body; try { body = JSON.parse(rawBody); } catch { return fail("Invalid payload.", 400); }
  if (/^orders?[./]/.test(String(topic || ""))) {
    // never trust the webhook body for money: re-read the order from the channel's API
    const ext = platform === "SHOPIFY" ? body.admin_graphql_api_id || (body.id ? `gid://shopify/Order/${body.id}` : null) : String(body.id || "");
    if (!ext) return { received: true, ignored: true };
    try { const r = await importOrder({ ch, externalId: ext, fetchImpl }); return { received: true, summary: r?.summary || null }; } catch (e) { return { received: true, queued: true, error: e.message }; } // logged for retry; 200 so the platform doesn't hammer
  }
  if (topic === "app/uninstalled") { await c.updateOne({ _id: ch._id }, { $set: { deletedAt: nowIso(), status: "DISCONNECTED", tokenSealed: null, disconnectReason: "app/uninstalled" } }); await audit({ orgId: ch.orgId, actorEmail: "shopify", recordType: "SALES_CHANNEL", recordId: ch._id, action: "SHOPIFY_APP_UNINSTALLED" }); return { received: true, disconnected: true }; }
  if (/^products?[./]/.test(String(topic || ""))) { await c.updateOne({ _id: ch._id }, { $set: { productsChangedAt: nowIso() } }); return { received: true, productsChanged: true }; }
  return { received: true, ignored: topic || null };
}

/** Scheduled work for every active channel: poll orders, push stock, retry failures. */
export async function runChannelJobs({ fetchImpl = fetch } = {}) {
  const c = await ccol(); const chans = await c.find({ kind: OK.channel, deletedAt: null, status: "ACTIVE" }).limit(500).toArray(); const out = { channels: chans.length, imported: 0, stockPushed: 0, errors: 0 };
  for (const ch of chans) {
    try { const r = await pollOrders({ ch, fetchImpl }); out.imported += r.imported; } catch { out.errors++; }
    try { const r = await pushStock({ ch, fetchImpl }); out.stockPushed += r.pushed || 0; } catch { out.errors++; }
  }
  const rr = await retryFailed({ fetchImpl }); return { ...out, retried: rr.retried, fixed: rr.fixed };
}
export async function retryNow({ orgId, membership, logId, fetchImpl = fetch }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const c = await ccol(); if (!await c.findOne({ _id: oid(logId), orgId: oid(orgId), kind: OK.log })) return fail("Job not found.", 404);
  return retryFailed({ logId, fetchImpl });
}
export async function dismissFailure({ orgId, membership, actorEmail, logId }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const c = await ccol(); const r = await c.updateOne({ _id: oid(logId), orgId: oid(orgId), kind: OK.log, ok: false }, { $set: { resolvedAt: nowIso(), resolvedBy: actorEmail, dismissed: true } });
  return r.matchedCount ? { ok: true } : fail("Job not found.", 404);
}
