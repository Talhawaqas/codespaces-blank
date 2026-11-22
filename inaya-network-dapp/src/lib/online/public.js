// src/lib/online/public.js -- what a shopper can see (no login). Every read is scoped to ONE store resolved from its slug or
// verified custom domain, and returns only public fields: title, description, images, price, availability wording.
// Internal cost, supplier prices, notes, other locations' stock and exact quantities (unless the store shows "low stock")
// are never returned (Master SOW 9.3). Unpublished stores and DRAFT/HIDDEN listings are invisible.
import { getOrgCollections } from "../orgs.js";
import { ccol, oid, sid, fromMinor, getSettings } from "../commerce/store.js";
import { OK, ensureOnlineIndexes } from "./stores.js";

export async function resolveStore({ slug = null, host = null, preview = false }) {
  await ensureOnlineIndexes(); const c = await ccol();
  const q = host ? { kind: OK.store, "domain.host": String(host).toLowerCase(), "domain.status": "LIVE" } : { kind: OK.store, slug: String(slug || "").toLowerCase() };
  const s = await c.findOne(q);
  if (!s) return null;
  if (!preview && s.status !== "PUBLISHED") return null;
  return s;
}

/** Public store header data (from the PUBLISHED snapshot, or the draft in preview). */
export function publicStore(s, { preview = false } = {}) {
  const content = (preview ? s.draft : s.published) || s.draft;
  const p = s.payments || {};
  return { id: sid(s._id), slug: s.slug, currency: s.currency, content, seo: s.seo || {}, preview,
    payments: { bankTransfer: !!p.bankTransfer?.enabled, cod: !!p.cod?.enabled, codMax: p.cod?.maxMinor ? fromMinor(p.cod.maxMinor) : null, stripe: !!p.stripe?.enabled, safepay: !!p.safepay?.enabled },
    shipping: { zones: (s.shipping?.zones || []).map((z) => ({ id: z.id, name: z.name, countries: z.countries, rateType: z.rateType, flat: fromMinor(z.flatMinor || 0), perKg: fromMinor(z.perKgMinor || 0), freeOver: z.freeOverMinor === null ? null : fromMinor(z.freeOverMinor), etaText: z.etaText, windows: z.windows || [] })), pickup: s.shipping?.pickup?.enabled ? { instructions: s.shipping.pickup.instructions || "", warehouseIds: s.shipping.pickup.warehouseIds } : null },
    checkout: { guest: s.checkout?.guest !== false, requirePhone: s.checkout?.requirePhone !== false, termsText: s.checkout?.termsText || "" } };
}

async function freeStock(orgId, warehouseId, products) {
  const { stockLevels } = await getOrgCollections(); const ids = []; for (const p of products) { if (p.productType === "KIT") for (const k of p.kitComponents || []) ids.push(oid(k.productId)); else ids.push(p._id); }
  const lv = new Map((await stockLevels.find({ orgId, warehouseId, productId: { $in: ids } }).toArray()).map((l) => [sid(l.productId), Math.max(0, (l.quantity || 0) - (l.reserved || 0))]));
  const out = new Map();
  for (const p of products) {
    const t = p.productType || "STOCK";
    if (t === "KIT") out.set(sid(p._id), Math.min(...(p.kitComponents || []).map((k) => Math.floor((lv.get(String(k.productId)) || 0) / (k.quantity || 1))), Infinity));
    else out.set(sid(p._id), t === "STOCK" ? lv.get(sid(p._id)) || 0 : Infinity); // services / non-stock are always available
  }
  return out;
}
function availability(store, free) {
  if (free === Infinity) return { inStock: true, label: "Available" };
  if (free <= 0) return { inStock: false, label: "Out of stock" };
  if (store.stockPolicy === "show_low_stock" && free <= (store.lowStockAt || 0)) return { inStock: true, label: `Only ${free} left`, low: true };
  return { inStock: true, label: "In stock" };
}

async function priceMap(store, productIds) {
  if (!store.priceListId) return new Map(); const c = await ccol();
  return new Map((await c.find({ orgId: store.orgId, kind: "c_price", priceListId: store.priceListId, productId: { $in: productIds } }).toArray()).map((x) => [sid(x.productId), x.priceMinor]));
}

function cardOf(l, p, price, avail, settings) {
  return { id: sid(l._id), slug: l.slug, title: l.title, image: (l.images || [])[0] || null, price, compareAtPrice: l.compareAtMinor ? fromMinor(l.compareAtMinor) : null, category: l.category || null, available: avail, featured: !!l.featured,
    variantGroupId: p.variantGroupId || null, variantGroupName: p.variantGroupName || null, variantAttributes: p.variantAttributes || null, priceNote: settings.taxMode === "exclusive" ? "plus tax" : "incl. tax" };
}

/** Product listing page data with search, category filter, sorting and paging. */
export async function publicCatalogue(store, { q = "", category = "", sort = "featured", page = 1, perPage = 24, ids = null } = {}) {
  const c = await ccol(); const { products } = await getOrgCollections(); const settings = await getSettings(store.orgId);
  const filter = { orgId: store.orgId, kind: OK.listing, storeId: store._id, status: "PUBLISHED" };
  if (category) filter.category = String(category).slice(0, 60);
  if (ids) filter._id = { $in: ids.map(oid).filter(Boolean) };
  let rows = await c.find(filter).limit(2000).toArray();
  const needle = String(q || "").trim().toLowerCase().slice(0, 80);
  if (needle) rows = rows.filter((l) => `${l.title} ${l.description || ""} ${l.category || ""}`.toLowerCase().includes(needle));
  const prods = new Map((await products.find({ _id: { $in: rows.map((r) => r.productId) }, orgId: store.orgId, deletedAt: null }).toArray()).filter((p) => !p.status || p.status === "ACTIVE").map((p) => [sid(p._id), p]));
  rows = rows.filter((l) => prods.has(sid(l.productId)) && (!prods.get(sid(l.productId)).availableWarehouseIds?.length || prods.get(sid(l.productId)).availableWarehouseIds.includes(String(store.warehouseId))));
  const free = await freeStock(store.orgId, store.warehouseId, [...prods.values()]); const prices = await priceMap(store, rows.map((r) => r.productId));
  let cards = rows.map((l) => { const p = prods.get(sid(l.productId)); const pm = prices.get(sid(p._id)) ?? (Number.isFinite(p.unitPrice) ? Math.round(p.unitPrice * 100) : null); return pm === null ? null : cardOf(l, p, fromMinor(pm), availability(store, free.get(sid(p._id))), settings); }).filter(Boolean);
  if (store.stockPolicy === "hide_out_of_stock") cards = cards.filter((x) => x.available.inStock);
  const sorters = { featured: (a, b) => Number(b.featured) - Number(a.featured) || a.title.localeCompare(b.title), price_asc: (a, b) => a.price - b.price, price_desc: (a, b) => b.price - a.price, name: (a, b) => a.title.localeCompare(b.title) };
  cards.sort(sorters[sort] || sorters.featured);
  // variants: one card per variant group (the cheapest variant represents the group)
  const seen = new Map(); const grouped = [];
  for (const x of cards) { if (!x.variantGroupId) { grouped.push(x); continue; } const g = seen.get(x.variantGroupId); if (!g) { const card = { ...x, title: x.variantGroupName || x.title, variants: 1 }; seen.set(x.variantGroupId, card); grouped.push(card); } else { g.variants += 1; if (x.price < g.price) g.price = x.price; if (x.available.inStock) g.available = x.available; } }
  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  const pp = Math.min(60, Math.max(1, perPage)); const pg = Math.max(1, Math.floor(page) || 1);
  return { items: grouped.slice((pg - 1) * pp, pg * pp), total: grouped.length, page: pg, pages: Math.max(1, Math.ceil(grouped.length / pp)), categories, currency: store.currency };
}

/** Product detail page: the listing, its variants (other published listings in the same variant group) and availability. */
export async function publicProduct(store, slug) {
  const c = await ccol(); const { products } = await getOrgCollections(); const settings = await getSettings(store.orgId);
  const l = await c.findOne({ orgId: store.orgId, kind: OK.listing, storeId: store._id, slug: String(slug || "").slice(0, 120), status: "PUBLISHED" });
  if (!l) return null;
  const p = await products.findOne({ _id: l.productId, orgId: store.orgId, deletedAt: null }); if (!p) return null;
  let siblings = [{ l, p }];
  if (p.variantGroupId) {
    const vps = await products.find({ orgId: store.orgId, variantGroupId: p.variantGroupId, deletedAt: null }).toArray();
    const vls = await c.find({ orgId: store.orgId, kind: OK.listing, storeId: store._id, status: "PUBLISHED", productId: { $in: vps.map((x) => x._id) } }).toArray();
    const byId = new Map(vps.map((x) => [sid(x._id), x])); siblings = vls.map((x) => ({ l: x, p: byId.get(sid(x.productId)) })).filter((x) => x.p);
  }
  const free = await freeStock(store.orgId, store.warehouseId, siblings.map((x) => x.p)); const prices = await priceMap(store, siblings.map((x) => x.p._id));
  const variants = siblings.map(({ l: vl, p: vp }) => { const pm = prices.get(sid(vp._id)) ?? (Number.isFinite(vp.unitPrice) ? Math.round(vp.unitPrice * 100) : null); return pm === null ? null : { listingId: sid(vl._id), slug: vl.slug, title: vl.title, attributes: vp.variantAttributes || null, price: fromMinor(pm), compareAtPrice: vl.compareAtMinor ? fromMinor(vl.compareAtMinor) : null, available: availability(store, free.get(sid(vp._id))), sku: vp.sku }; }).filter(Boolean);
  const self = variants.find((v) => v.listingId === sid(l._id)); if (!self) return null;
  return { id: sid(l._id), slug: l.slug, title: l.title, description: l.description || "", images: l.images || [], price: self.price, compareAtPrice: self.compareAtPrice, available: self.available, sku: p.sku, category: l.category || null,
    digital: !!l.digital, weightKg: l.weightKg ?? null, dimensionsCm: l.dimensionsCm || null, seoTitle: l.seoTitle || l.title, seoDescription: l.seoDescription || String(l.description || "").slice(0, 160), variantGroupName: p.variantGroupName || null, variants: variants.length > 1 ? variants : [], currency: store.currency, priceNote: settings.taxMode === "exclusive" ? "plus tax" : "incl. tax" };
}

/** schema.org Product structured data for a product page (Master SOW 9.9). */
export function productJsonLd(store, prod, url) {
  return { "@context": "https://schema.org", "@type": "Product", name: prod.title, description: prod.seoDescription, sku: prod.sku, image: prod.images, url,
    offers: { "@type": "Offer", priceCurrency: store.currency, price: prod.price.toFixed(2), availability: prod.available.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", url } };
}

/** All public URLs for the sitemap. */
export async function sitemapEntries(store, base) {
  const c = await ccol(); const rows = await c.find({ orgId: store.orgId, kind: OK.listing, storeId: store._id, status: "PUBLISHED" }, { projection: { slug: 1, updatedAt: 1 } }).toArray();
  const pages = ["", "/products", ...Object.entries(store.published?.pages || {}).filter(([, v]) => String(v || "").trim()).map(([k]) => `/pages/${k}`)];
  return [...pages.map((p) => ({ url: `${base}${p}`, lastModified: store.publishedAt })), ...rows.map((r) => ({ url: `${base}/p/${r.slug}`, lastModified: r.updatedAt }))];
}
