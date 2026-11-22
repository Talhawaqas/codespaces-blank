// app/shop/[slug]/[[...path]]/page.js -- the public storefront of a company's Inaya-hosted store (Commerce Phase 5).
// Served at /shop/<slug>/..., at <slug>.<STORE_HOST_BASE> and on a verified custom domain (middleware rewrites those to
// /shop/<slug>/... or /shop/_host/<host>/...). Pages: home, /products, /p/<item>, /pages/<contact|shipping|returns|privacy|terms>,
// /cart, /checkout, /order/<number>?t=<token>. Server-rendered for SEO (title, description, canonical, Open Graph, robots,
// schema.org Product data); the cart, checkout and order status run in the browser against /api/shop/<slug>/...
// A signed ?preview= link shows the DRAFT to staff (checkout disabled).
import { notFound, permanentRedirect } from "next/navigation";
import { headers } from "next/headers";
import { resolveStore, publicStore, publicCatalogue, publicProduct, productJsonLd } from "../../../../lib/online/public.js";
import { checkPreview } from "../../../../lib/online/stores.js";
import StorefrontClient from "../../../../components/shop/StorefrontClient.js";

export const dynamic = "force-dynamic";
const PAGE_TITLES = { contact: "Contact us", shipping: "Delivery", returns: "Returns", privacy: "Privacy policy", terms: "Terms" };

async function load(params, searchParams) {
  const { slug } = await params; const path = (await params).path || []; const sp = await searchParams;
  const isHost = slug === "_host"; const host = isHost ? String(path[0] || "").toLowerCase() : null; const route = isHost ? path.slice(1) : path;
  let store = await resolveStore(isHost ? { host } : { slug, preview: true });
  if (!store) return null;
  const preview = !isHost && store.status !== "PUBLISHED" ? checkPreview(String(store._id), sp?.preview) : !!(sp?.preview && checkPreview(String(store._id), sp.preview));
  if (store.status !== "PUBLISHED" && !preview) return null;
  const h = await headers(); const reqHost = (h.get("x-forwarded-host") || h.get("host") || "").toLowerCase().split(":")[0];
  const base = (process.env.STORE_HOST_BASE || "").toLowerCase();
  const atRoot = isHost || (base && reqHost === `${store.slug}.${base}`);
  const linkBase = atRoot ? "" : `/shop/${store.slug}`;
  const origin = `https://${reqHost || "www.inayanetwork.com"}`;
  return { store, preview, route, sp, linkBase, canonicalBase: `${origin}${linkBase}` };
}

export async function generateMetadata({ params, searchParams }) {
  const ctx = await load(params, searchParams); if (!ctx) return { title: "Store not found" };
  const { store, route, canonicalBase, preview } = ctx; const pub = publicStore(store, { preview }); const name = pub.content.branding.name;
  const robots = preview || store.seo?.robots === "noindex" ? { index: false, follow: false } : { index: true, follow: true };
  let title = store.seo?.title || name; let description = store.seo?.description || pub.content.branding.tagline || `Shop online at ${name}.`; let image = store.seo?.ogImageUrl || pub.content.home?.heroImageUrl || null; let path = "";
  if (route[0] === "p" && route[1]) { const p = await publicProduct(store, route[1]); if (p) { title = `${p.seoTitle} | ${name}`; description = p.seoDescription || description; image = p.images[0] || image; path = `/p/${p.slug}`; } }
  else if (route[0] === "products") { title = `All products | ${name}`; path = "/products"; }
  else if (route[0] === "pages" && PAGE_TITLES[route[1]]) { title = `${PAGE_TITLES[route[1]]} | ${name}`; path = `/pages/${route[1]}`; }
  else if (["cart", "checkout", "order"].includes(route[0])) return { title: `${route[0] === "order" ? "Your order" : route[0] === "cart" ? "Cart" : "Checkout"} | ${name}`, robots: { index: false, follow: false } };
  return { title, description, robots, alternates: { canonical: `${canonicalBase}${path}` }, openGraph: { title, description, url: `${canonicalBase}${path}`, siteName: name, type: route[0] === "p" ? "website" : "website", ...(image ? { images: [{ url: image }] } : {}) }, twitter: { card: image ? "summary_large_image" : "summary", title, description } };
}

export default async function StorePage({ params, searchParams }) {
  const ctx = await load(params, searchParams); if (!ctx) notFound();
  const { store, route, sp, linkBase, canonicalBase, preview } = ctx;
  // redirect management (Master SOW 9.9)
  const here = `/${route.join("/")}`; const redir = (store.seo?.redirects || []).find((r) => r.from === here);
  if (redir && !preview) permanentRedirect(`${linkBase}${redir.to}`);
  const pub = publicStore(store, { preview }); let data = null; let view = "home"; let jsonLd = null;
  if (!route.length) { view = "home"; const featuredIds = (pub.content.home?.sections || []).flatMap((s) => s.productIds || []); data = { featured: await publicCatalogue(store, { sort: "featured", perPage: 12, ...(featuredIds.length ? { ids: featuredIds } : {}) }), all: await publicCatalogue(store, { perPage: 8 }) }; }
  else if (route[0] === "products") { view = "products"; data = await publicCatalogue(store, { q: sp?.q || "", category: sp?.category || "", sort: sp?.sort || "featured", page: Number(sp?.page) || 1 }); }
  else if (route[0] === "p" && route[1]) { view = "product"; data = await publicProduct(store, route[1]); if (!data) notFound(); jsonLd = productJsonLd(store, data, `${canonicalBase}/p/${data.slug}`); }
  else if (route[0] === "pages" && PAGE_TITLES[route[1]]) { view = "page"; data = { key: route[1], title: PAGE_TITLES[route[1]], text: pub.content.pages?.[route[1]] || "" }; if (!data.text.trim()) notFound(); }
  else if (route[0] === "cart") view = "cart";
  else if (route[0] === "checkout") view = "checkout";
  else if (route[0] === "order" && route[1]) { view = "order"; data = { orderNumber: route[1] }; }
  else notFound();
  return (
    <>
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />}
      <StorefrontClient store={pub} view={view} data={data} linkBase={linkBase} apiBase={`/api/shop/${store.slug}`} preview={preview} query={{ q: sp?.q || "", category: sp?.category || "", sort: sp?.sort || "featured", t: sp?.t || "", paid: sp?.paid || "", cancelled: sp?.cancelled || "" }} />
    </>
  );
}
