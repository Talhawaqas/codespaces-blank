// app/api/shop/[slug]/[[...path]]/route.js -- public storefront API (no login). Rate-limited per IP; every read and write is
// scoped to the ONE published store named by the slug; only public fields leave the server (src/lib/online/public.js).
//   GET  /api/shop/{slug}                       store header (branding, payment + delivery options)
//   GET  /api/shop/{slug}/products?q&category&sort&page
//   GET  /api/shop/{slug}/p/{listingSlug}
//   GET  /api/shop/{slug}/order/{orderNumber}?t=token   order status (re-checks a pending card payment with the provider)
//   POST /api/shop/{slug}/cart      { lines, zoneId?, address?, fulfilment?, coupons? }  -> priced summary
//   POST /api/shop/{slug}/checkout  { idempotencyKey, lines, customer, address, fulfilment, zoneId, paymentMethod, acceptTerms, ... }
//   POST /api/shop/{slug}/view      { kind: "store" | "product" }   analytics counter
import { NextResponse } from "next/server";
import { resolveStore, publicStore, publicCatalogue, publicProduct } from "../../../../../lib/online/public.js";
import { cartSummary, placeCheckout } from "../../../../../lib/online/checkout.js";
import { orderByToken } from "../../../../../lib/online/orders.js";
import { countVisit, OK } from "../../../../../lib/online/stores.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { getClientIp } from "../../../../../lib/ipAddress.js";
import { ccol } from "../../../../../lib/commerce/store.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200, cache = "no-store") => NextResponse.json(d, { status: s, headers: { "Cache-Control": cache } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 400) : json(r));
async function limited(req, action, max, windowMs) { try { await checkRateLimit({ action, key: getClientIp(req) || "unknown", max, windowMs }); return null; } catch { return json({ error: "Too many requests. Please wait a moment and try again." }, 429); } }
function storeBase(req, slug) { const u = new URL(req.url); const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host).toLowerCase(); const base = (process.env.STORE_HOST_BASE || "").toLowerCase(); const proto = u.protocol === "http:" && /^localhost|^127\./.test(host) ? "http:" : "https:"; return base && host === `${slug}.${base}` ? `${proto}//${host}` : `${proto}//${host}/shop/${slug}`; }

export async function GET(req, { params }) {
  params = await params; const seg = params.path || [];
  try {
    const lim = await limited(req, "shop_read", 600, 60000); if (lim) return lim;
    const reqHost = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").toLowerCase().split(":")[0];
    const store = await resolveStore(params.slug === "_host" ? { host: reqHost } : { slug: params.slug }); if (!store) return json({ error: "Store not found." }, 404);
    const qs = new URL(req.url).searchParams;
    if (seg[0] === "sitemap.xml" || seg[0] === "robots.txt") {
      const base = (process.env.STORE_HOST_BASE || "").toLowerCase(); const atRoot = params.slug === "_host" || (base && reqHost === `${store.slug}.${base}`);
      const origin = `https://${reqHost}${atRoot ? "" : `/shop/${store.slug}`}`;
      const pre = atRoot ? "" : `/shop/${store.slug}`;
      const robots = store.seo?.robots === "noindex" ? ["User-agent: *", "Disallow: /"] : ["User-agent: *", "Allow: /", `Disallow: ${pre}/cart`, `Disallow: ${pre}/checkout`, `Disallow: ${pre}/order/`, `Sitemap: ${origin}/sitemap.xml`];
      if (seg[0] === "robots.txt") return new NextResponse(`${robots.join("\n")}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
      const { sitemapEntries } = await import("../../../../../lib/online/public.js"); const entries = await sitemapEntries(store, origin);
      const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const urls = entries.map((e) => `<url><loc>${esc(e.url)}</loc>${e.lastModified ? `<lastmod>${esc(String(e.lastModified).slice(0, 10))}</lastmod>` : ""}</url>`);
      const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, "</urlset>", ""].join("\n");
      return new NextResponse(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    }
    if (!seg.length) return json({ store: publicStore(store) }, 200, "public, max-age=30");
    if (seg[0] === "products") return json(await publicCatalogue(store, { q: qs.get("q") || "", category: qs.get("category") || "", sort: qs.get("sort") || "featured", page: Number(qs.get("page")) || 1 }), 200, "public, max-age=15");
    if (seg[0] === "p" && seg[1]) { const p = await publicProduct(store, seg[1]); return p ? json({ product: p }, 200, "public, max-age=15") : json({ error: "Product not found." }, 404); }
    if (seg[0] === "order" && seg[1]) {
      const lim2 = await limited(req, "shop_order_status", 60, 60000); if (lim2) return lim2;
      const t = qs.get("t") || ""; let o = await orderByToken({ orgId: String(store.orgId), orderNumber: seg[1], token: t });
      if (!o) return json({ error: "Order not found." }, 404);
      if (o.payment?.state === "AWAITING_PAYMENT") { // the redirect proves nothing: ask the provider
        const c = await ccol(); const { salesOrders } = await (await import("../../../../../lib/orgs.js")).getOrgCollections(); const so = await salesOrders.findOne({ orgId: store.orgId, orderNumber: o.orderNumber });
        const p = so ? await c.findOne({ kind: OK.payment, orderId: so._id }, { sort: { createdAt: -1 } }) : null;
        if (p) { const { reconcilePayment } = await import("../../../../../lib/online/payments.js"); await reconcilePayment({ paymentId: String(p._id) }).catch(() => null); o = await orderByToken({ orgId: String(store.orgId), orderNumber: seg[1], token: t }); }
      }
      return json({ order: o });
    }
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("shop GET failed:", e); return json({ error: "Something went wrong." }, 500); }
}

export async function POST(req, { params }) {
  params = await params; const seg = params.path || [];
  try {
    const store = await resolveStore({ slug: params.slug }); if (!store) return json({ error: "Store not found." }, 404);
    const body = await req.json().catch(() => ({}));
    if (seg[0] === "view") { const lim = await limited(req, "shop_view", 120, 60000); if (lim) return json({ ok: true }); await countVisit(store._id, store.orgId, body.kind === "product" ? "productViews" : "views"); return json({ ok: true }); }
    if (seg[0] === "cart") { const lim = await limited(req, "shop_cart", 120, 60000); if (lim) return lim; return out(await cartSummary(store, body)); }
    if (seg[0] === "checkout") { const lim = await limited(req, "shop_checkout", 10, 10 * 60000); if (lim) return lim; return out(await placeCheckout({ store, input: body, baseUrl: storeBase(req, store.slug) })); }
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("shop POST failed:", e); return json({ error: "Something went wrong." }, 500); }
}
