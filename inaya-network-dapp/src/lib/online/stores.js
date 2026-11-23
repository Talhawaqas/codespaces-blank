// src/lib/online/stores.js -- Inaya Online Commerce (Master SOW Initiative D, section 9; Phase 5).
//
// A company (Commerce add-on) runs ONE native Inaya-hosted store, plus connected Shopify / WooCommerce stores (channels.js).
// Everything lives in the existing `calendar_records` collection (production is at its collection limit) under `o_*` kinds:
//   o_store     the storefront: slug, branding/theme/nav/home/pages as a DRAFT and a PUBLISHED snapshot, fulfilling
//               location, price list, stock-visibility policy, shipping zones + pickup, payment options (the shop's OWN
//               Stripe / Safepay credentials, sealed), custom domain + verification, SEO.
//   o_listing   a product published online: title, description, images (public https URLs), online / compare-at price,
//               SEO, status. Internal cost, supplier prices, notes and stock numbers are never part of a public view.
//   o_checkout  one checkout attempt (idempotency key, totals, chosen payment) -> the sales order it created
//   o_payment   one provider payment attempt (provider reference, amount, currency, state history)
//   o_visit     daily storefront counters (views, product views, checkouts started, orders) for store analytics
// Orders themselves are `sales_orders` with channel "ONLINE" (or SHOPIFY / WOOCOMMERCE), sharing the lifecycle,
// reservations, payments and ledger postings of the sales-order engine.
//
// Plan limits (owner decision 22 Nov 2026, configurable, not public): the native store is included with the Commerce add-on;
// connected stores: Business 1 Shopify + 1 WooCommerce, Enterprise 3 connected stores in any mix; `commerceExtraStores` on the
// org (set by Inaya admin) adds more; synced orders per month: 1,000 (Business), unlimited (Enterprise).
import { randomBytes, createHmac } from "node:crypto";
import { getOrgCollections } from "../orgs.js";
import { ccol, oid, sid, clean, fail, nowIso, toMinor, fromMinor, audit, getSettings, canManageCommerce, commerceAccess, KINDS as CK } from "../commerce/store.js";
import { seal, last4 } from "./crypto.js";

export const OK = { store: "o_store", listing: "o_listing", checkout: "o_checkout", payment: "o_payment", visit: "o_visit", channel: "o_channel", map: "o_channel_map", corder: "o_channel_order", log: "o_channel_log", conflict: "o_conflict" };
export const STORE_STATES = ["DRAFT", "PUBLISHED", "UNPUBLISHED"];
export const STOCK_POLICIES = ["hide_out_of_stock", "show_out_of_stock", "show_low_stock"];
export const THEMES = { classic: "Classic (light, centred)", bold: "Bold (dark header, large images)", minimal: "Minimal (clean grid)" };
const RESERVED_SLUGS = new Set(["admin", "api", "www", "shop", "store", "inaya", "app", "mail", "support", "help", "static", "assets", "login", "checkout", "cart", "ping", "webhooks", "channels", "preview", "shopify", "_host"]);
export const PLAN_LIMITS = {
  professional: { connected: { SHOPIFY: 1, WOOCOMMERCE: 1 }, total: 1, monthlyOrders: 300 }, // Commerce Starter: ONE store, Shopify OR WooCommerce
  business: { connected: { SHOPIFY: 1, WOOCOMMERCE: 1 }, total: 2, monthlyOrders: 1000 },
  enterprise: { connected: null, total: 3, monthlyOrders: null },
};
export const PRICING_DEFAULTS = { extraStoreUsd: 12, extraStorePkr: 2500, threeStorePackUsd: 29, threeStorePackPkr: 6000, marketplaceConnectorUsd: 19, marketplaceConnectorPkr: 3500, annualFreeMonths: 2 };

let ready = null;
export async function ensureOnlineIndexes() {
  if (ready) return ready;
  ready = (async () => {
    const c = await ccol();
    await Promise.all([
      c.createIndex({ kind: 1, slug: 1 }, { unique: true, partialFilterExpression: { kind: OK.store }, name: "o_store_slug" }),
      c.createIndex({ kind: 1, "domain.host": 1 }, { unique: true, partialFilterExpression: { kind: OK.store, "domain.host": { $type: "string" } }, name: "o_store_domain" }),
      c.createIndex({ orgId: 1, kind: 1, storeId: 1, slug: 1 }, { unique: true, partialFilterExpression: { kind: OK.listing }, name: "o_listing_slug" }),
      c.createIndex({ orgId: 1, kind: 1, idem: 1 }, { unique: true, partialFilterExpression: { kind: { $in: [OK.checkout, OK.corder] } }, name: "o_idem_unique" }),
      // one live connection per Shopify/WooCommerce store (records made before this field existed are not covered by the index)
      c.createIndex({ orgId: 1, kind: 1, connectKey: 1 }, { unique: true, partialFilterExpression: { kind: OK.channel, connectKey: { $exists: true } }, name: "o_channel_connect_unique" }),
      c.createIndex({ kind: 1, provider: 1, providerRef: 1 }, { unique: true, partialFilterExpression: { kind: OK.payment, providerRef: { $type: "string" } }, name: "o_payment_ref" }),
    ]);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// ---------------------------------------------------------------- plan limits
export async function planLimits(orgId) {
  const { orgs } = await getOrgCollections(); const org = await orgs.findOne({ _id: oid(orgId) }, { projection: { plan: 1, commerceExtraStores: 1, commerceOrderCap: 1 } });
  const base = PLAN_LIMITS[org?.plan] || PLAN_LIMITS.business;
  const extra = Math.max(0, Math.floor(Number(org?.commerceExtraStores) || 0));
  return { plan: org?.plan || null, connected: base.connected, total: base.total + extra, extraStores: extra, monthlyOrders: org?.commerceOrderCap === "unlimited" ? null : base.monthlyOrders };
}

// ---------------------------------------------------------------- store views
const slugify = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
export const validSlug = (s) => /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(s) && !RESERVED_SLUGS.has(s);
const defaultContent = (name) => ({
  branding: { name, logoUrl: null, primaryColor: "#0f766e", accentColor: "#f59e0b", tagline: "" },
  theme: "classic",
  nav: [{ label: "All products", href: "/products" }],
  home: { heroTitle: `Welcome to ${name}`, heroText: "", heroImageUrl: null, sections: [{ type: "featured", title: "Featured products", productIds: [] }, { type: "categories", title: "Shop by category" }] },
  pages: { contact: "", shipping: "", returns: "", privacy: "", terms: "" },
});
const httpsUrl = (u) => { if (!u) return null; try { const x = new URL(String(u)); return x.protocol === "https:" ? x.toString().slice(0, 600) : null; } catch { return null; } };
const color = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v) : d);

function validateContent(input = {}, prev) {
  const base = prev || defaultContent("Store");
  const b = input.branding || {};
  const content = {
    branding: { name: clean(b.name ?? base.branding.name, 80) || base.branding.name, logoUrl: b.logoUrl !== undefined ? httpsUrl(b.logoUrl) : base.branding.logoUrl, primaryColor: color(b.primaryColor, base.branding.primaryColor), accentColor: color(b.accentColor, base.branding.accentColor), tagline: clean(b.tagline ?? base.branding.tagline, 160) },
    theme: THEMES[input.theme] ? input.theme : base.theme,
    nav: Array.isArray(input.nav) ? input.nav.slice(0, 12).map((n) => ({ label: clean(n.label, 40), href: /^\/[a-z0-9/_-]*$/i.test(String(n.href || "")) ? String(n.href).slice(0, 120) : "/products" })).filter((n) => n.label) : base.nav,
    home: input.home ? {
      heroTitle: clean(input.home.heroTitle, 120), heroText: clean(input.home.heroText, 500), heroImageUrl: httpsUrl(input.home.heroImageUrl),
      sections: (Array.isArray(input.home.sections) ? input.home.sections : []).slice(0, 10).map((s) => ({ type: ["featured", "categories", "text", "new"].includes(s.type) ? s.type : "text", title: clean(s.title, 80), text: clean(s.text, 1000), productIds: (Array.isArray(s.productIds) ? s.productIds : []).slice(0, 24).map(String) })),
    } : base.home,
    pages: { ...base.pages },
  };
  if (input.pages) for (const k of Object.keys(base.pages)) if (input.pages[k] !== undefined) content.pages[k] = String(input.pages[k] || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 20000);
  return content;
}

function zoneOk(z) {
  const rateType = ["flat", "weight", "free"].includes(z.rateType) ? z.rateType : "flat";
  return { id: clean(z.id, 24) || `z${randomBytes(4).toString("hex")}`, name: clean(z.name, 60) || "Delivery", countries: (Array.isArray(z.countries) ? z.countries : []).map((c) => String(c).toUpperCase().slice(0, 2)).filter((c) => /^[A-Z]{2}$/.test(c)), cities: (Array.isArray(z.cities) ? z.cities : []).map((c) => clean(c, 60).toLowerCase()).filter(Boolean).slice(0, 200),
    rateType, flatMinor: Math.max(0, toMinor(z.flat) || 0), perKgMinor: Math.max(0, toMinor(z.perKg) || 0), freeOverMinor: z.freeOver === null || z.freeOver === undefined || z.freeOver === "" ? null : Math.max(0, toMinor(z.freeOver) || 0), etaText: clean(z.etaText, 80), windows: (Array.isArray(z.windows) ? z.windows : []).map((w) => clean(w, 60)).filter(Boolean).slice(0, 12) };
}

/** The admin view of a store: never contains a secret, only whether one is set and its last 4 characters. */
export function storeView(s) {
  if (!s) return null;
  const p = s.payments || {};
  return {
    id: sid(s._id), slug: s.slug, status: s.status, name: s.draft?.branding?.name || s.slug, draft: s.draft, published: s.published || null, publishedAt: s.publishedAt || null, hasUnpublishedChanges: !!s.draftChangedAt && (!s.publishedAt || s.draftChangedAt > s.publishedAt),
    warehouseId: sid(s.warehouseId), departmentId: sid(s.departmentId), priceListId: sid(s.priceListId), currency: s.currency,
    stockPolicy: s.stockPolicy, lowStockAt: s.lowStockAt, holdHours: s.holdHours, checkout: s.checkout, shipping: s.shipping,
    payments: {
      bankTransfer: { enabled: !!p.bankTransfer?.enabled, instructions: p.bankTransfer?.instructions || "" },
      cod: { enabled: !!p.cod?.enabled, maxOrder: p.cod?.maxMinor ? fromMinor(p.cod.maxMinor) : null },
      stripe: { enabled: !!p.stripe?.enabled, mode: p.stripe?.mode || null, keySet: !!p.stripe?.secretSealed, keyHint: p.stripe?.keyHint || null, webhookSecretSet: !!p.stripe?.webhookSecretSealed },
      safepay: { enabled: !!p.safepay?.enabled, environment: p.safepay?.environment || null, apiKey: p.safepay?.apiKey || null, secretSet: !!p.safepay?.secretSealed, secretHint: p.safepay?.secretHint || null, webhookSecretSet: !!p.safepay?.webhookSecretSealed },
    },
    domain: s.domain ? { host: s.domain.host || null, txtName: s.domain.host ? `_inaya-store.${s.domain.host}` : null, txtValue: s.domain.token || null, verifiedAt: s.domain.verifiedAt || null, sslCheckedAt: s.domain.sslCheckedAt || null, status: s.domain.status || "PENDING", lastError: s.domain.lastError || null } : null,
    seo: s.seo || {}, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

async function getStoreDoc(orgId) { await ensureOnlineIndexes(); const c = await ccol(); return c.findOne({ orgId: oid(orgId), kind: OK.store }); }
export async function getStore({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const s = await getStoreDoc(orgId);
  return { store: storeView(s), previewPath: s ? `/shop/${s.slug}?preview=${previewToken(sid(s._id))}` : null, limits: await planLimits(orgId), themes: THEMES, stockPolicies: STOCK_POLICIES, pricingDefaults: PRICING_DEFAULTS };
}

/** Creates the company's store (one per company). */
export async function createStore({ orgId, membership, actorEmail, name, slug, warehouseId, departmentId }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  await ensureOnlineIndexes(); const c = await ccol();
  if (await c.findOne({ orgId: oid(orgId), kind: OK.store })) return fail("This company already has an online store.", 409);
  const nm = clean(name, 80); if (nm.length < 2) return fail("Give the store a name.");
  const sl = slugify(slug || nm); if (!validSlug(sl)) return fail("Choose a web address of 3-48 letters, numbers and dashes (not a reserved word).");
  const { warehouses, departments } = await getOrgCollections();
  const wh = warehouseId ? await warehouses.findOne({ _id: oid(warehouseId), orgId: oid(orgId) }) : await warehouses.findOne({ orgId: oid(orgId) }, { sort: { createdAt: 1 } });
  if (!wh) return fail("Add a location (warehouse) first; online orders are fulfilled from it.", 409);
  const dept = departmentId ? await departments.findOne({ _id: oid(departmentId), orgId: oid(orgId) }) : await departments.findOne({ orgId: oid(orgId) }, { sort: { createdAt: 1 } });
  if (!dept) return fail("Add a department first; online orders are filed under it.", 409);
  const settings = await getSettings(orgId); const now = nowIso();
  const doc = { orgId: oid(orgId), kind: OK.store, slug: sl, status: "DRAFT", draft: defaultContent(nm), published: null, publishedAt: null, draftChangedAt: now,
    warehouseId: wh._id, departmentId: dept._id, priceListId: null, currency: settings.currency, stockPolicy: "show_out_of_stock", lowStockAt: 3, holdHours: 48,
    checkout: { guest: true, requirePhone: true, termsText: "By placing this order you agree to the store's terms and privacy policy." },
    shipping: { zones: [], pickup: { enabled: true, warehouseIds: [String(wh._id)], instructions: "" } },
    payments: { bankTransfer: { enabled: false, instructions: "" }, cod: { enabled: false, maxMinor: null }, stripe: { enabled: false }, safepay: { enabled: false } },
    domain: null, seo: { title: nm, description: "", ogImageUrl: null, robots: "index", redirects: [] }, createdByEmail: actorEmail, createdAt: now, updatedAt: now };
  try { const r = await c.insertOne(doc); doc._id = r.insertedId; } catch (e) { if (e?.code === 11000) return fail("That web address is taken. Choose another.", 409); throw e; }
  await audit({ orgId, actorEmail, recordType: "ONLINE_STORE", recordId: doc._id, action: "STORE_CREATED", newState: "DRAFT", metadata: { slug: sl } });
  return { store: storeView(doc) };
}

/** Updates store settings. `content` edits the DRAFT only; customers see it after Publish. */
export async function updateStore({ orgId, membership, actorEmail, input = {} }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const s = await getStoreDoc(orgId); if (!s) return fail("Create the store first.", 404);
  const set = { updatedAt: nowIso() }; const c = await ccol(); const { warehouses, departments } = await getOrgCollections();
  if (input.content) { set.draft = validateContent(input.content, s.draft); set.draftChangedAt = set.updatedAt; }
  if (input.slug !== undefined && input.slug !== s.slug) { const sl = slugify(input.slug); if (!validSlug(sl)) return fail("Choose a web address of 3-48 letters, numbers and dashes (not a reserved word)."); set.slug = sl; }
  if (input.warehouseId) { const wh = await warehouses.findOne({ _id: oid(input.warehouseId), orgId: s.orgId }); if (!wh) return fail("Location not found.", 404); set.warehouseId = wh._id; }
  if (input.departmentId) { const d = await departments.findOne({ _id: oid(input.departmentId), orgId: s.orgId }); if (!d) return fail("Department not found.", 404); set.departmentId = d._id; }
  if (input.stockPolicy !== undefined) { if (!STOCK_POLICIES.includes(input.stockPolicy)) return fail("Unknown stock visibility policy."); set.stockPolicy = input.stockPolicy; }
  if (input.lowStockAt !== undefined) set.lowStockAt = Math.max(0, Math.min(1000, Math.floor(Number(input.lowStockAt) || 0)));
  if (input.holdHours !== undefined) { const h = Math.floor(Number(input.holdHours)); if (!(h >= 1 && h <= 240)) return fail("Hold unpaid bank-transfer orders for 1-240 hours."); set.holdHours = h; }
  if (input.checkout) set.checkout = { guest: input.checkout.guest !== false, requirePhone: input.checkout.requirePhone !== false, termsText: clean(input.checkout.termsText ?? s.checkout?.termsText, 500) };
  if (input.shipping) {
    const zones = (Array.isArray(input.shipping.zones) ? input.shipping.zones : []).slice(0, 50).map(zoneOk);
    const pk = input.shipping.pickup || {}; const pickupIds = (Array.isArray(pk.warehouseIds) ? pk.warehouseIds : []).map(String);
    for (const id of pickupIds) if (!await warehouses.findOne({ _id: oid(id), orgId: s.orgId })) return fail("A pickup location was not found.", 404);
    set.shipping = { zones, pickup: { enabled: pk.enabled === true && pickupIds.length > 0, warehouseIds: pickupIds, instructions: clean(pk.instructions, 500) } };
  }
  if (input.seo) set.seo = { title: clean(input.seo.title, 70), description: clean(input.seo.description, 170), ogImageUrl: httpsUrl(input.seo.ogImageUrl), robots: input.seo.robots === "noindex" ? "noindex" : "index",
    redirects: (Array.isArray(input.seo.redirects) ? input.seo.redirects : []).slice(0, 200).map((r) => ({ from: String(r.from || "").slice(0, 200), to: String(r.to || "").slice(0, 200) })).filter((r) => /^\/[^\s]*$/.test(r.from) && /^\/[^\s]*$/.test(r.to) && r.from !== r.to) };
  if (input.priceListId !== undefined) set.priceListId = input.priceListId ? oid(input.priceListId) : null;
  try { await c.updateOne({ _id: s._id }, { $set: set }); } catch (e) { if (e?.code === 11000) return fail("That web address is taken. Choose another.", 409); throw e; }
  await audit({ orgId, actorEmail, recordType: "ONLINE_STORE", recordId: s._id, action: "STORE_UPDATED", metadata: { fields: Object.keys(set).filter((k) => k !== "updatedAt") } });
  return { store: storeView(await c.findOne({ _id: s._id })) };
}

/** Payment options. Secrets are sealed on arrival and never echoed back. A provider can only be switched on once its keys are set. */
export async function updatePayments({ orgId, membership, actorEmail, input = {} }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const s = await getStoreDoc(orgId); if (!s) return fail("Create the store first.", 404);
  const p = structuredClone(s.payments || {}); const changed = [];
  if (input.bankTransfer) { const instr = clean(input.bankTransfer.instructions, 1000); if (input.bankTransfer.enabled && instr.length < 10) return fail("Add the bank transfer instructions customers will see (account name, bank, IBAN or account number)."); p.bankTransfer = { enabled: !!input.bankTransfer.enabled, instructions: instr }; changed.push("bank_transfer"); }
  if (input.cod) { const max = input.cod.maxOrder === null || input.cod.maxOrder === undefined || input.cod.maxOrder === "" ? null : toMinor(input.cod.maxOrder); if (max !== null && !(max > 0)) return fail("Cash-on-delivery limit must be positive."); p.cod = { enabled: !!input.cod.enabled, maxMinor: max }; changed.push("cod"); }
  if (input.stripe) {
    const x = input.stripe; const st = p.stripe || {};
    if (x.secretKey) { const k = String(x.secretKey).trim(); if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(k)) return fail("That doesn't look like a Stripe secret or restricted key (sk_test_… / sk_live_… / rk_…)."); st.secretSealed = seal(k); st.keyHint = last4(k); st.mode = k.includes("_live_") ? "live" : "test"; }
    if (x.webhookSecret) { const w = String(x.webhookSecret).trim(); if (!/^whsec_[A-Za-z0-9]{10,}$/.test(w)) return fail("The Stripe webhook signing secret starts with whsec_."); st.webhookSecretSealed = seal(w); }
    if (x.enabled !== undefined) { if (x.enabled && (!st.secretSealed || !st.webhookSecretSealed)) return fail("Add the Stripe secret key and the webhook signing secret before switching card payments on."); st.enabled = !!x.enabled; }
    p.stripe = st; changed.push("stripe");
  }
  if (input.safepay) {
    const x = input.safepay; const sp = p.safepay || {};
    if (x.environment) { if (!["sandbox", "production"].includes(x.environment)) return fail("Safepay environment is sandbox or production."); sp.environment = x.environment; }
    if (x.apiKey !== undefined) { const k = String(x.apiKey || "").trim(); if (k && !/^[A-Za-z0-9_-]{8,120}$/.test(k)) return fail("That doesn't look like a Safepay API key."); sp.apiKey = k || null; }
    if (x.secretKey) { const k = String(x.secretKey).trim(); if (k.length < 16) return fail("That doesn't look like a Safepay secret key."); sp.secretSealed = seal(k); sp.secretHint = last4(k); }
    if (x.webhookSecret) { const w = String(x.webhookSecret).trim(); if (w.length < 16) return fail("That doesn't look like a Safepay webhook shared secret."); sp.webhookSecretSealed = seal(w); }
    if (x.enabled !== undefined) { if (x.enabled && (!sp.apiKey || !sp.secretSealed || !sp.environment)) return fail("Add the Safepay API key, secret key and environment before switching it on."); sp.enabled = !!x.enabled; }
    p.safepay = sp; changed.push("safepay");
  }
  const c = await ccol(); await c.updateOne({ _id: s._id }, { $set: { payments: p, updatedAt: nowIso() } });
  await audit({ orgId, actorEmail, recordType: "ONLINE_STORE", recordId: s._id, action: "STORE_PAYMENTS_UPDATED", metadata: { changed } }); // never the secrets
  return { store: storeView(await c.findOne({ _id: s._id })) };
}

/** Publish (copy the draft to what customers see), unpublish, or take it back to draft. */
export async function publishStore({ orgId, membership, actorEmail, action }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const s = await getStoreDoc(orgId); if (!s) return fail("Create the store first.", 404); const c = await ccol(); const now = nowIso();
  if (action === "publish") {
    const p = s.payments || {};
    if (!p.bankTransfer?.enabled && !p.cod?.enabled && !p.stripe?.enabled && !p.safepay?.enabled) return fail("Switch on at least one way to pay (bank transfer, cash on delivery, Stripe or Safepay) before publishing.", 409);
    if (!(s.shipping?.zones?.length) && !s.shipping?.pickup?.enabled) return fail("Add a delivery zone or switch on pickup before publishing.", 409);
    if (!await c.countDocuments({ orgId: s.orgId, kind: OK.listing, storeId: s._id, status: "PUBLISHED" }, { limit: 1 })) return fail("Publish at least one product before publishing the store.", 409);
    for (const k of ["privacy", "terms"]) if (!String(s.draft?.pages?.[k] || "").trim()) return fail("Add a privacy policy and terms page before publishing (customers must see them at checkout).", 409);
    await c.updateOne({ _id: s._id }, { $set: { status: "PUBLISHED", published: s.draft, publishedAt: now, updatedAt: now } });
  } else if (action === "unpublish") {
    await c.updateOne({ _id: s._id }, { $set: { status: "UNPUBLISHED", updatedAt: now } });
  } else return fail("Unknown action.");
  await audit({ orgId, actorEmail, recordType: "ONLINE_STORE", recordId: s._id, action: action === "publish" ? "STORE_PUBLISHED" : "STORE_UNPUBLISHED", previousState: s.status, newState: action === "publish" ? "PUBLISHED" : "UNPUBLISHED" });
  return { store: storeView(await c.findOne({ _id: s._id })) };
}

// ---------------------------------------------------------------- custom domain (Master SOW 9.9: verified before live)
const hostOk = (h) => /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) && !h.endsWith("inayanetwork.com");
export async function setDomain({ orgId, membership, actorEmail, host }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const s = await getStoreDoc(orgId); if (!s) return fail("Create the store first.", 404); const c = await ccol();
  if (!host) { await c.updateOne({ _id: s._id }, { $set: { domain: null, updatedAt: nowIso() } }); return { store: storeView(await c.findOne({ _id: s._id })) }; }
  const h = String(host).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!hostOk(h)) return fail("Enter a domain you own, like shop.yourcompany.com.");
  try { await c.updateOne({ _id: s._id }, { $set: { domain: { host: h, token: `inaya-store-${randomBytes(12).toString("hex")}`, status: "PENDING", verifiedAt: null, sslCheckedAt: null, lastError: null }, updatedAt: nowIso() } }); }
  catch (e) { if (e?.code === 11000) return fail("That domain is already connected to another store.", 409); throw e; }
  await audit({ orgId, actorEmail, recordType: "ONLINE_STORE", recordId: s._id, action: "STORE_DOMAIN_SET", metadata: { host: h } });
  return { store: storeView(await c.findOne({ _id: s._id })) };
}
/** Checks the TXT record proves ownership, then that the domain serves THIS store over HTTPS (valid certificate). */
export async function verifyDomain({ orgId, membership, resolveTxt = null, fetchImpl = fetch }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const s = await getStoreDoc(orgId); if (!s?.domain?.host) return fail("Add a domain first.", 404); const c = await ccol(); const now = nowIso();
  const resolver = resolveTxt || (await import("node:dns/promises")).resolveTxt;
  let records = []; try { records = (await resolver(`_inaya-store.${s.domain.host}`)).map((r) => r.join("")); } catch { records = []; }
  if (!records.includes(s.domain.token)) { await c.updateOne({ _id: s._id }, { $set: { "domain.status": "PENDING", "domain.lastError": "The TXT record wasn't found yet. DNS changes can take up to an hour.", updatedAt: now } }); return { store: storeView(await c.findOne({ _id: s._id })) }; }
  let ssl = false, err = null;
  try { const r = await fetchImpl(`https://${s.domain.host}/api/shop/ping`, { redirect: "manual", signal: AbortSignal.timeout(10000) }); const j = r.ok ? await r.json().catch(() => null) : null; ssl = j?.storeId === sid(s._id); if (!ssl) err = "The domain answers, but not with this store yet. Point it (CNAME) to cname.vercel-dns.com and ask Inaya support to attach it."; }
  catch { err = "Couldn't reach the domain over HTTPS yet (no DNS pointing here or no certificate). Point it (CNAME) to cname.vercel-dns.com."; }
  await c.updateOne({ _id: s._id }, { $set: { "domain.status": ssl ? "LIVE" : "VERIFIED", "domain.verifiedAt": s.domain.verifiedAt || now, "domain.sslCheckedAt": ssl ? now : null, "domain.lastError": err, updatedAt: now } });
  return { store: storeView(await c.findOne({ _id: s._id })) };
}

// ---------------------------------------------------------------- listings (product publishing, Master SOW 9.3)
export function listingView(l, p = null) {
  return { id: sid(l._id), productId: sid(l.productId), slug: l.slug, title: l.title, description: l.description, images: l.images || [], onlinePrice: l.onlinePriceMinor === null || l.onlinePriceMinor === undefined ? null : fromMinor(l.onlinePriceMinor), compareAtPrice: l.compareAtMinor ? fromMinor(l.compareAtMinor) : null,
    seoTitle: l.seoTitle || "", seoDescription: l.seoDescription || "", status: l.status, digital: !!l.digital, weightKg: l.weightKg ?? null, dimensionsCm: l.dimensionsCm || null, category: l.category || p?.category || null, featured: !!l.featured, sort: l.sort || 0,
    ...(p ? { productName: p.name, sku: p.sku, productPrice: Number.isFinite(p.unitPrice) ? p.unitPrice : null, productType: p.productType || "STOCK" } : {}), updatedAt: l.updatedAt };
}
export async function listListings({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const s = await getStoreDoc(orgId); if (!s) return { listings: [] };
  const c = await ccol(); const rows = await c.find({ orgId: s.orgId, kind: OK.listing, storeId: s._id }).sort({ sort: 1, title: 1 }).toArray();
  const { products } = await getOrgCollections(); const prods = new Map((await products.find({ _id: { $in: rows.map((r) => r.productId) }, orgId: s.orgId }).toArray()).map((p) => [sid(p._id), p]));
  return { listings: rows.map((l) => listingView(l, prods.get(sid(l.productId)))) };
}
/** Create or update a listing. The online price is kept in the store's own price list, so checkout pricing (tax, promotions,
 *  members) runs through the same engine as the till. */
export async function saveListing({ orgId, membership, actorEmail, id = null, input = {} }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const s = await getStoreDoc(orgId); if (!s) return fail("Create the store first.", 404);
  const c = await ccol(); const { products } = await getOrgCollections();
  const existing = id ? await c.findOne({ _id: oid(id), orgId: s.orgId, kind: OK.listing }) : null; if (id && !existing) return fail("Listing not found.", 404);
  const productId = existing?.productId || oid(input.productId);
  const p = productId ? await products.findOne({ _id: productId, orgId: s.orgId, deletedAt: null }) : null; if (!p) return fail("Product not found.", 404);
  if (p.productType === "GIFT_CARD") return fail("Gift cards are sold at the till for now, not online.", 409);
  if (!existing && await c.findOne({ orgId: s.orgId, kind: OK.listing, storeId: s._id, productId })) return fail("This product is already listed. Edit its listing instead.", 409);
  const title = clean(input.title ?? existing?.title ?? p.name, 140); if (title.length < 2) return fail("Give the listing a title.");
  const status = input.status ?? existing?.status ?? "DRAFT"; if (!["DRAFT", "PUBLISHED", "HIDDEN"].includes(status)) return fail("Status is DRAFT, PUBLISHED or HIDDEN.");
  const price = input.onlinePrice === undefined ? existing?.onlinePriceMinor ?? null : input.onlinePrice === null || input.onlinePrice === "" ? null : toMinor(input.onlinePrice);
  if (price !== null && !(price >= 0)) return fail("Online price must be zero or more.");
  if (status === "PUBLISHED" && price === null && !Number.isFinite(p.unitPrice)) return fail("Set a price (on the product or an online price) before publishing.", 409);
  const compare = input.compareAtPrice === undefined ? existing?.compareAtMinor ?? null : input.compareAtPrice ? toMinor(input.compareAtPrice) : null;
  const images = input.images === undefined ? existing?.images || [] : (Array.isArray(input.images) ? input.images : []).map(httpsUrl).filter(Boolean).slice(0, 10);
  const slug = slugify(input.slug ?? existing?.slug ?? `${title}-${String(p.sku || "").toLowerCase()}`) || `item-${randomBytes(3).toString("hex")}`;
  const now = nowIso();
  const doc = { title, description: String(input.description ?? existing?.description ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 10000), images, onlinePriceMinor: price, compareAtMinor: compare && price !== null && compare > price ? compare : compare && Number.isFinite(p.unitPrice) && compare > toMinor(p.unitPrice) ? compare : null,
    seoTitle: clean(input.seoTitle ?? existing?.seoTitle, 70), seoDescription: clean(input.seoDescription ?? existing?.seoDescription, 170), status, slug,
    digital: input.digital === undefined ? !!existing?.digital : !!input.digital, weightKg: input.weightKg === undefined ? existing?.weightKg ?? null : Number(input.weightKg) >= 0 ? Math.round(Number(input.weightKg) * 1000) / 1000 : null,
    dimensionsCm: input.dimensionsCm === undefined ? existing?.dimensionsCm || null : clean(input.dimensionsCm, 40) || null, category: clean(input.category ?? existing?.category ?? p.category, 60) || null,
    featured: input.featured === undefined ? !!existing?.featured : !!input.featured, sort: Number.isFinite(Number(input.sort)) ? Math.floor(Number(input.sort)) : existing?.sort || 0, updatedAt: now };
  try {
    if (existing) await c.updateOne({ _id: existing._id }, { $set: doc });
    else { const r = await c.insertOne({ orgId: s.orgId, kind: OK.listing, storeId: s._id, productId, ...doc, createdAt: now, createdByEmail: actorEmail }); doc._id = r.insertedId; }
  } catch (e) { if (e?.code === 11000) return fail("Another listing already uses that web address. Change the title or address.", 409); throw e; }
  await syncOnlinePrice({ store: s, productId, priceMinor: price, membership, actorEmail });
  await audit({ orgId, actorEmail, recordType: "ONLINE_LISTING", recordId: existing?._id || doc._id, action: existing ? "LISTING_UPDATED" : "LISTING_CREATED", newState: status, metadata: { productId: sid(productId) } });
  const fresh = await c.findOne({ _id: existing?._id || doc._id });
  return { listing: listingView(fresh, p) };
}
/** Keeps the store's price list ("Online store") in step with listing prices; a listing without an online price uses the product price. */
async function syncOnlinePrice({ store, productId, priceMinor, actorEmail }) {
  const c = await ccol(); let listId = store.priceListId;
  if (!listId && priceMinor !== null) {
    const settings = await getSettings(store.orgId); const now = nowIso();
    const code = `ONLINE-${String(store._id).slice(-6).toUpperCase()}`;
    const existing = await c.findOne({ orgId: store.orgId, kind: CK.priceList, code });
    listId = existing?._id || (await c.insertOne({ orgId: store.orgId, kind: CK.priceList, code, name: "Online store", currency: settings.currency, isWholesale: false, active: true, createdByEmail: actorEmail, createdAt: now, updatedAt: now })).insertedId;
    await c.updateOne({ _id: store._id }, { $set: { priceListId: listId } }); store.priceListId = listId;
  }
  if (!listId) return;
  if (priceMinor === null) await c.deleteOne({ orgId: store.orgId, kind: CK.price, priceListId: listId, productId });
  else await c.updateOne({ orgId: store.orgId, kind: CK.price, priceListId: listId, productId }, { $set: { priceMinor, updatedAt: nowIso(), updatedByEmail: actorEmail }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
}
export async function bulkPublish({ orgId, membership, actorEmail, productIds = [], status = "PUBLISHED" }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const out = []; for (const pid of (Array.isArray(productIds) ? productIds : []).slice(0, 200)) {
    const s = await getStoreDoc(orgId); const c = await ccol(); const l = await c.findOne({ orgId: s.orgId, kind: OK.listing, storeId: s._id, productId: oid(pid) });
    const r = await saveListing({ orgId, membership, actorEmail, id: l ? sid(l._id) : null, input: l ? { status } : { productId: pid, status } });
    out.push({ productId: pid, ok: !r.error, error: r.error || null });
  }
  return { results: out };
}

// ---------------------------------------------------------------- analytics (Master SOW 9.2 store analytics)
export async function countVisit(storeId, orgId, field) {
  if (!["views", "productViews", "checkoutsStarted", "orders", "abandoned"].includes(field)) return;
  const c = await ccol(); const day = nowIso().slice(0, 10);
  await c.updateOne({ orgId: oid(orgId), kind: OK.visit, storeId: oid(storeId), day }, { $inc: { [field]: 1 }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true }).catch(() => {});
}
export async function storeAnalytics({ orgId, membership, days = 30 }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const s = await getStoreDoc(orgId); if (!s) return { days: [], totals: {} };
  const since = new Date(Date.now() - Math.min(365, Math.max(1, days)) * 86400000).toISOString().slice(0, 10);
  const c = await ccol(); const rows = await c.find({ orgId: s.orgId, kind: OK.visit, storeId: s._id, day: { $gte: since } }).sort({ day: 1 }).toArray();
  const { salesOrders } = await getOrgCollections();
  const orders = await salesOrders.find({ orgId: s.orgId, channel: "ONLINE", storeId: s._id, orderDate: { $gte: since }, deletedAt: null }, { projection: { total: 1, status: 1 } }).toArray();
  const t = rows.reduce((a, r) => { for (const k of ["views", "productViews", "checkoutsStarted", "orders", "abandoned"]) a[k] = (a[k] || 0) + (r[k] || 0); return a; }, {});
  const live = orders.filter((o) => o.status !== "CANCELLED");
  return { days: rows.map((r) => ({ day: r.day, views: r.views || 0, productViews: r.productViews || 0, checkoutsStarted: r.checkoutsStarted || 0, orders: r.orders || 0, abandoned: r.abandoned || 0 })),
    totals: { ...t, revenue: Math.round(live.reduce((n, o) => n + (o.total || 0), 0) * 100) / 100, orderCount: live.length, cancelled: orders.length - live.length, conversionPercent: t.views ? Math.round(((t.orders || 0) / t.views) * 10000) / 100 : 0, currency: s.currency } };
}

// ---------------------------------------------------------------- preview links (the draft, for staff only)
/** A preview link shows the DRAFT store; it is signed for the store and expires after 24 hours. Checkout is disabled in preview. */
export function previewToken(storeId, now = Date.now()) {
  const exp = Math.floor(now / 1000) + 86400; const key = process.env.INTEGRATION_ENCRYPTION_KEY || "";
  return `${exp}.${createHmac("sha256", key).update(`store-preview:${storeId}:${exp}`).digest("base64url").slice(0, 32)}`;
}
export function checkPreview(storeId, token, now = Date.now()) {
  const [exp, sig] = String(token || "").split("."); if (!exp || !sig || Number(exp) * 1000 < now) return false;
  const key = process.env.INTEGRATION_ENCRYPTION_KEY || ""; if (!key) return false;
  return sig === createHmac("sha256", key).update(`store-preview:${storeId}:${exp}`).digest("base64url").slice(0, 32);
}

export { getStoreDoc, slugify, canManageCommerce };
