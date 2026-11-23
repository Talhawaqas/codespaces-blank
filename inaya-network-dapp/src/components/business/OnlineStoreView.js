"use client";

// src/components/business/OnlineStoreView.js -- Inaya Commerce Phase 5 (Master SOW section 9): the company's own online store
// and its connected Shopify / WooCommerce stores. Every action is checked again on the server (src/lib/online/*). Secrets
// typed here (Stripe / Safepay keys, Shopify token, WooCommerce keys) are sealed on the server and never shown again.

import { useState, useEffect, useCallback } from "react";

const f = "w-full min-h-[38px] bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-lg px-2.5 text-sm text-[var(--inaya-text-primary)]";
const pb = "min-h-[38px] px-3 rounded-lg text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-40";
const gb = "min-h-[38px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] disabled:opacity-40";
const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl p-3";
const mu = "text-[var(--inaya-text-muted)]";
const money = (v, c = "") => (v === null || v === undefined ? "–" : `${c ? `${c} ` : ""}${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
async function api(path, { orgId, method = "GET", body } = {}) {
  const r = await fetch(`/api/orgs/online/${path}${method === "GET" || method === "DELETE" ? `${path.includes("?") ? "&" : "?"}orgId=${orgId}` : ""}`, { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify({ orgId, ...body }) } : {}) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { code: d.code }); return d;
}
const Msg = ({ ok, err }) => <>{ok && <p className="text-sm text-emerald-600">{ok}</p>}{err && <p className="text-sm text-red-500" role="alert">{err}</p>}</>;
const H = ({ children }) => <h3 className="font-bold text-sm text-[var(--inaya-text-primary)] mb-2">{children}</h3>;
const L = ({ t, children }) => <label className="block text-xs font-semibold text-[var(--inaya-text-secondary)] space-y-1"><span>{t}</span>{children}</label>;
function useAction() { const [ok, setOk] = useState(""); const [err, setErr] = useState(""); const run = async (fn, msg) => { setOk(""); setErr(""); try { const r = await fn(); if (msg) setOk(typeof msg === "function" ? msg(r) : msg); return r; } catch (e) { setErr(e.message); return null; } }; return { ok, err, run }; }

export default function OnlineStoreView({ orgId }) {
  const [tab, setTab] = useState(() => (typeof window !== "undefined" && /[?&]shopify(=|_error=)/.test(window.location.search) ? "channels" : "store")); const [data, setData] = useState(null); const [err, setErr] = useState("");
  const reload = useCallback(() => api("store", { orgId }).then(setData).catch((e) => setErr(e.message)), [orgId]);
  useEffect(() => { reload(); }, [reload]);
  if (err) return <p className="text-sm text-red-500">{err}</p>; if (!data) return <p className={`text-sm ${mu}`}>Loading…</p>;
  if (!data.store) return <CreateStore orgId={orgId} onDone={reload} />;
  const tabs = [["store", "Store"], ["products", "Products"], ["orders", "Orders"], ["delivery", "Delivery"], ["payments", "Payments"], ["channels", "Shopify & WooCommerce"], ["sync", "Sync log"], ["analytics", "Analytics"]];
  const s = data.store;
  return <div className="space-y-3">
    <div className={`${card} flex flex-wrap items-center gap-3`}>
      <div className="min-w-0"><p className="font-bold">{s.name}</p><p className={`text-xs ${mu}`}>/shop/{s.slug} · <b>{s.status}</b>{s.hasUnpublishedChanges ? " · unpublished changes" : ""}{s.domain?.host ? ` · ${s.domain.host} (${s.domain.status})` : ""}</p></div>
      <div className="ml-auto flex flex-wrap gap-2">
        <a className={gb + " inline-flex items-center"} href={data.previewPath} target="_blank" rel="noreferrer">Preview draft</a>
        {s.status === "PUBLISHED" && <a className={gb + " inline-flex items-center"} href={`/shop/${s.slug}`} target="_blank" rel="noreferrer">View live store</a>}
        <PublishButtons orgId={orgId} s={s} onDone={reload} />
      </div>
    </div>
    <div className="flex flex-wrap gap-2" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? pb : gb} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === "store" && <StoreSetup orgId={orgId} data={data} onDone={reload} />}
    {tab === "products" && <Products orgId={orgId} store={s} />}
    {tab === "orders" && <Orders orgId={orgId} />}
    {tab === "delivery" && <Delivery orgId={orgId} s={s} onDone={reload} />}
    {tab === "payments" && <Payments orgId={orgId} s={s} onDone={reload} />}
    {tab === "channels" && <Channels orgId={orgId} />}
    {tab === "sync" && <SyncLog orgId={orgId} />}
    {tab === "analytics" && <Analytics orgId={orgId} />}
  </div>;
}

function CreateStore({ orgId, onDone }) {
  const [x, setX] = useState({ name: "", slug: "" }); const a = useAction();
  return <div className={`${card} max-w-lg space-y-3`}>
    <H>Open your online store</H>
    <p className={`text-sm ${mu}`}>Your store uses the same products, prices, stock, customers and books as the rest of Inaya. Customers pay by bank transfer, cash on delivery, or card through your own Stripe (UK) or Safepay (Pakistan) account.</p>
    <L t="Store name"><input className={f} value={x.name} onChange={(e) => setX({ ...x, name: e.target.value })} /></L>
    <L t="Web address (letters, numbers, dashes)"><input className={f} value={x.slug} placeholder="my-shop" onChange={(e) => setX({ ...x, slug: e.target.value.toLowerCase() })} /></L>
    <button className={pb} onClick={() => a.run(() => api("store", { orgId, method: "POST", body: x }).then(onDone))}>Create store</button><Msg {...a} />
  </div>;
}

function PublishButtons({ orgId, s, onDone }) {
  const a = useAction();
  return <span className="inline-flex flex-col gap-1">
    <span className="flex gap-2">
      <button className={pb} onClick={() => a.run(() => api("store/publish", { orgId, method: "POST", body: {} }).then(onDone), "Published.")}>{s.status === "PUBLISHED" ? "Publish changes" : "Publish store"}</button>
      {s.status === "PUBLISHED" && <button className={gb} onClick={() => window.confirm("Take the store offline? Customers won't be able to visit or order.") && a.run(() => api("store/unpublish", { orgId, method: "POST", body: {} }).then(onDone), "Store is offline.")}>Unpublish</button>}
    </span><Msg {...a} />
  </span>;
}

function StoreSetup({ orgId, data, onDone }) {
  const s = data.store; const d = s.draft; const a = useAction();
  const [x, setX] = useState({ branding: { ...d.branding }, theme: d.theme, home: { ...d.home, sections: d.home.sections || [] }, pages: { ...d.pages }, nav: d.nav, seo: { ...s.seo, redirects: s.seo?.redirects || [] }, stockPolicy: s.stockPolicy, lowStockAt: s.lowStockAt, holdHours: s.holdHours, checkout: { ...s.checkout }, domain: s.domain?.host || "" });
  const B = (k) => (e) => setX({ ...x, branding: { ...x.branding, [k]: e.target.value } });
  const save = () => a.run(() => api("store", { orgId, method: "PUT", body: { content: { branding: x.branding, theme: x.theme, home: x.home, pages: x.pages, nav: x.nav }, seo: x.seo, stockPolicy: x.stockPolicy, lowStockAt: Number(x.lowStockAt), holdHours: Number(x.holdHours), checkout: x.checkout } }).then(onDone), "Saved to the draft. Publish to show customers.");
  return <div className="grid lg:grid-cols-2 gap-3">
    <div className={`${card} space-y-2`}><H>Branding & theme</H>
      <L t="Store name"><input className={f} value={x.branding.name} onChange={B("name")} /></L>
      <L t="Tagline"><input className={f} value={x.branding.tagline} onChange={B("tagline")} /></L>
      <L t="Logo image (https URL)"><input className={f} value={x.branding.logoUrl || ""} onChange={B("logoUrl")} /></L>
      <div className="grid grid-cols-3 gap-2"><L t="Main colour"><input type="color" className="w-full h-9" value={x.branding.primaryColor} onChange={B("primaryColor")} /></L><L t="Accent"><input type="color" className="w-full h-9" value={x.branding.accentColor} onChange={B("accentColor")} /></L>
        <L t="Theme"><select className={f} value={x.theme} onChange={(e) => setX({ ...x, theme: e.target.value })}>{Object.entries(data.themes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></L></div>
      <H>Home page</H>
      <L t="Headline"><input className={f} value={x.home.heroTitle} onChange={(e) => setX({ ...x, home: { ...x.home, heroTitle: e.target.value } })} /></L>
      <L t="Intro text"><textarea className={f} rows={2} value={x.home.heroText} onChange={(e) => setX({ ...x, home: { ...x.home, heroText: e.target.value } })} /></L>
      <L t="Banner image (https URL)"><input className={f} value={x.home.heroImageUrl || ""} onChange={(e) => setX({ ...x, home: { ...x.home, heroImageUrl: e.target.value } })} /></L>
      <p className={`text-xs ${mu}`}>Sections: {x.home.sections.map((sec) => sec.title || sec.type).join(" · ") || "none"}. Mark products as Featured in the Products tab to show them on the home page.</p>
    </div>
    <div className={`${card} space-y-2`}><H>Pages (privacy and terms are required to publish)</H>
      {Object.entries({ contact: "Contact", shipping: "Delivery information", returns: "Returns policy", privacy: "Privacy policy", terms: "Terms" }).map(([k, t]) => <L key={k} t={t}><textarea className={f} rows={k === "privacy" || k === "terms" ? 4 : 2} value={x.pages[k] || ""} onChange={(e) => setX({ ...x, pages: { ...x.pages, [k]: e.target.value } })} /></L>)}
    </div>
    <div className={`${card} space-y-2`}><H>Stock and checkout</H>
      <L t="Stock shown to customers"><select className={f} value={x.stockPolicy} onChange={(e) => setX({ ...x, stockPolicy: e.target.value })}><option value="show_out_of_stock">In stock / Out of stock</option><option value="show_low_stock">Also "Only N left" when low</option><option value="hide_out_of_stock">Hide out-of-stock products</option></select></L>
      {x.stockPolicy === "show_low_stock" && <L t="Low when at or below"><input type="number" className={f} value={x.lowStockAt} onChange={(e) => setX({ ...x, lowStockAt: e.target.value })} /></L>}
      <L t="Hold unpaid bank-transfer orders for (hours)"><input type="number" className={f} value={x.holdHours} onChange={(e) => setX({ ...x, holdHours: e.target.value })} /></L>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={x.checkout.requirePhone !== false} onChange={(e) => setX({ ...x, checkout: { ...x.checkout, requirePhone: e.target.checked } })} />Ask for a phone number</label>
      <L t="Text next to the terms tick box"><input className={f} value={x.checkout.termsText || ""} onChange={(e) => setX({ ...x, checkout: { ...x.checkout, termsText: e.target.value } })} /></L>
    </div>
    <div className={`${card} space-y-2`}><H>Search engines</H>
      <L t="Title (up to 70 characters)"><input className={f} value={x.seo.title || ""} onChange={(e) => setX({ ...x, seo: { ...x.seo, title: e.target.value } })} /></L>
      <L t="Description (up to 170)"><textarea className={f} rows={2} value={x.seo.description || ""} onChange={(e) => setX({ ...x, seo: { ...x.seo, description: e.target.value } })} /></L>
      <L t="Sharing image (https URL)"><input className={f} value={x.seo.ogImageUrl || ""} onChange={(e) => setX({ ...x, seo: { ...x.seo, ogImageUrl: e.target.value } })} /></L>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={x.seo.robots === "noindex"} onChange={(e) => setX({ ...x, seo: { ...x.seo, robots: e.target.checked ? "noindex" : "index" } })} />Hide from search engines</label>
      <L t="Redirects (one per line: /old-path /new-path)"><textarea className={f} rows={2} value={x.seo.redirects.map((r) => `${r.from} ${r.to}`).join("\n")} onChange={(e) => setX({ ...x, seo: { ...x.seo, redirects: e.target.value.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([from, to]) => ({ from, to })) } })} /></L>
      <p className={`text-xs ${mu}`}>A sitemap is published at /shop/{s.slug}/sitemap.xml and product pages carry structured product data.</p>
    </div>
    <div className="lg:col-span-2 flex items-center gap-3"><button className={pb} onClick={save}>Save draft</button><Msg {...a} /></div>
    <Domain orgId={orgId} s={s} onDone={onDone} />
  </div>;
}

function Domain({ orgId, s, onDone }) {
  const [host, setHost] = useState(s.domain?.host || ""); const a = useAction();
  return <div className={`${card} space-y-2 lg:col-span-2`}><H>Your own domain (optional)</H>
    <p className={`text-xs ${mu}`}>1) Enter a domain you own. 2) Add the TXT record shown below at your DNS provider. 3) Point the domain (CNAME) to cname.vercel-dns.com and ask Inaya support to attach it. 4) Verify. The store is served on your domain only after both checks pass (ownership and HTTPS).</p>
    <div className="flex gap-2 flex-wrap"><input className={f + " max-w-xs"} placeholder="shop.yourcompany.com" value={host} onChange={(e) => setHost(e.target.value)} /><button className={gb} onClick={() => a.run(() => api("store/domain", { orgId, method: "PUT", body: { host } }).then(onDone), "Domain saved.")}>Save domain</button>{s.domain?.host && <button className={gb} onClick={() => a.run(() => api("store/domain/verify", { orgId, method: "POST", body: {} }).then(onDone), "Checked.")}>Verify</button>}</div>
    {s.domain?.host && <div className="text-xs font-mono break-all"><p>TXT name: {s.domain.txtName}</p><p>TXT value: {s.domain.txtValue}</p><p className="font-sans">Status: <b>{s.domain.status}</b>{s.domain.lastError ? ` — ${s.domain.lastError}` : ""}</p></div>}
    <Msg {...a} />
  </div>;
}

function Products({ orgId, store }) {
  const [rows, setRows] = useState(null); const [prods, setProds] = useState([]); const [edit, setEdit] = useState(null); const a = useAction();
  const load = useCallback(async () => { const r = await api("listings", { orgId }); setRows(r.listings); const p = await fetch(`/api/orgs/inventory/products?orgId=${orgId}`, { credentials: "include" }).then((x) => x.json()).catch(() => ({})); setProds(p.products || []); }, [orgId]);
  useEffect(() => { load().catch((e) => a.run(() => Promise.reject(e))); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows) return <p className={`text-sm ${mu}`}>Loading…</p>;
  const listed = new Set(rows.map((r) => r.productId)); const unlisted = prods.filter((p) => !listed.has(p.id) && !["GIFT_CARD"].includes(p.productType));
  return <div className="space-y-3">
    {unlisted.length > 0 && <div className={card}><H>Add products to the store</H><div className="flex flex-wrap gap-2">{unlisted.slice(0, 60).map((p) => <button key={p.id} className={gb} onClick={() => a.run(() => api("listings", { orgId, method: "POST", body: { productId: p.id, status: "DRAFT" } }).then(load), `${p.name} added as a draft listing.`)}>+ {p.name}</button>)}</div>
      <button className={`${pb} mt-2`} onClick={() => a.run(() => api("listings/bulk", { orgId, method: "POST", body: { productIds: unlisted.map((p) => p.id), status: "PUBLISHED" } }).then(load), (r) => `${r.results.filter((x) => x.ok).length} published.`)}>Publish all of these</button></div>}
    <Msg {...a} />
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className={`text-left ${mu}`}><th className="py-1">Product</th><th>SKU</th><th>Price</th><th>Online price</th><th>Status</th><th /></tr></thead><tbody>
      {rows.map((l) => <tr key={l.id} className="border-t border-[var(--inaya-border)]"><td className="py-1.5">{l.title}{l.featured ? " ★" : ""}</td><td>{l.sku}</td><td>{money(l.productPrice)}</td><td>{l.onlinePrice === null ? "same" : money(l.onlinePrice)}</td><td>{l.status}</td><td className="text-right"><button className={gb} onClick={() => setEdit(l)}>Edit</button></td></tr>)}
    </tbody></table></div>
    {edit && <ListingEditor orgId={orgId} l={edit} store={store} onClose={() => { setEdit(null); load(); }} />}
  </div>;
}

function ListingEditor({ orgId, l, onClose }) {
  const [x, setX] = useState({ title: l.title, description: l.description, images: (l.images || []).join("\n"), onlinePrice: l.onlinePrice ?? "", compareAtPrice: l.compareAtPrice ?? "", status: l.status, category: l.category || "", featured: l.featured, weightKg: l.weightKg ?? "", dimensionsCm: l.dimensionsCm || "", digital: l.digital, seoTitle: l.seoTitle, seoDescription: l.seoDescription, slug: l.slug });
  const a = useAction(); const S = (k) => (e) => setX({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  return <div className={`${card} space-y-2`}><H>Listing: {l.productName}</H>
    <div className="grid md:grid-cols-2 gap-2">
      <L t="Title"><input className={f} value={x.title} onChange={S("title")} /></L><L t="Web address"><input className={f} value={x.slug} onChange={S("slug")} /></L>
      <L t="Online price (empty = product price)"><input className={f} value={x.onlinePrice} onChange={S("onlinePrice")} /></L><L t="Was price (shown crossed out)"><input className={f} value={x.compareAtPrice} onChange={S("compareAtPrice")} /></L>
      <L t="Category"><input className={f} value={x.category} onChange={S("category")} /></L>
      <L t="Status"><select className={f} value={x.status} onChange={S("status")}><option value="DRAFT">Draft</option><option value="PUBLISHED">Published</option><option value="HIDDEN">Hidden</option></select></L>
      <L t="Weight (kg, for weight-based delivery)"><input className={f} value={x.weightKg} onChange={S("weightKg")} /></L><L t="Size (cm)"><input className={f} value={x.dimensionsCm} onChange={S("dimensionsCm")} /></L>
    </div>
    <L t="Description"><textarea className={f} rows={4} value={x.description} onChange={S("description")} /></L>
    <L t="Images (one https URL per line, first is the main image)"><textarea className={f} rows={3} value={x.images} onChange={S("images")} /></L>
    <div className="grid md:grid-cols-2 gap-2"><L t="Search title"><input className={f} value={x.seoTitle} onChange={S("seoTitle")} /></L><L t="Search description"><input className={f} value={x.seoDescription} onChange={S("seoDescription")} /></L></div>
    <div className="flex gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={x.featured} onChange={S("featured")} />Featured on the home page</label><label className="flex items-center gap-2"><input type="checkbox" checked={x.digital} onChange={S("digital")} />Digital (no delivery)</label></div>
    <div className="flex gap-2"><button className={pb} onClick={() => a.run(() => api(`listings/${l.id}`, { orgId, method: "PUT", body: { ...x, images: x.images.split("\n").map((u) => u.trim()).filter(Boolean), onlinePrice: x.onlinePrice === "" ? null : Number(x.onlinePrice), compareAtPrice: x.compareAtPrice === "" ? null : Number(x.compareAtPrice), weightKg: x.weightKg === "" ? null : Number(x.weightKg) } }).then(onClose))}>Save</button><button className={gb} onClick={onClose}>Close</button></div><Msg {...a} />
  </div>;
}

function Orders({ orgId }) {
  const [rows, setRows] = useState(null); const [status, setStatus] = useState(""); const a = useAction();
  const load = useCallback(() => api(`orders${status ? `?status=${status}` : ""}`, { orgId }).then((r) => setRows(r.orders)), [orgId, status]);
  useEffect(() => { load().catch(() => {}); }, [load]);
  return <div className="space-y-2">
    <div className="flex gap-2 items-center"><select className={f + " max-w-[200px]"} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All orders</option>{["CONFIRMED", "BACKORDERED", "FULFILLED", "INVOICED", "CANCELLED"].map((s) => <option key={s}>{s}</option>)}</select><p className={`text-xs ${mu}`}>Pick, pack, dispatch, invoice, refund and returns: CRM → Sales orders (same orders).</p></div>
    <Msg {...a} />
    {!rows ? <p className={`text-sm ${mu}`}>Loading…</p> : rows.length === 0 ? <p className={`text-sm ${mu}`}>No online orders yet.</p> : rows.map((o) => <div key={o.id} className={card}>
      <div className="flex flex-wrap gap-x-3 items-baseline"><b>{o.orderNumber}</b><span className={`text-xs ${mu}`}>{o.channel}{o.externalOrderId ? ` ${o.externalOrderId.replace(/^gid:\/\/shopify\/Order\//, "#")}` : ""} · {new Date(o.orderDate).toLocaleString()}</span><span className="ml-auto font-bold">{money(o.total, o.currency)}</span></div>
      <p className="text-sm">{o.customer} {o.email ? `· ${o.email}` : ""} · <b>{o.status}</b>{o.stage ? `/${o.stage}` : ""} · payment {o.payment?.method} {o.payment?.state} · paid {money(o.paid)}</p>
      {o.payment?.attention && <p className="text-sm text-amber-600">{o.payment.attention}</p>}
      {o.shipping?.address && <p className={`text-xs ${mu}`}>{[o.shipping.address.line1, o.shipping.address.city, o.shipping.address.country].filter(Boolean).join(", ")}{o.shipping.window ? ` · ${o.shipping.window}` : ""}{o.shipping.phone ? ` · ${o.shipping.phone}` : ""}</p>}
      <p className={`text-xs ${mu}`}>{o.lines.map((l) => `${l.quantity} × ${l.description}`).join(", ")}</p>
      <div className="flex flex-wrap gap-2 mt-2">
        {o.channel === "ONLINE" && ["PENDING_BANK_TRANSFER", "COD_DUE"].includes(o.payment?.state) && o.status !== "CANCELLED" && <button className={gb} onClick={() => { const ref = window.prompt(o.payment.state === "COD_DUE" ? "Cash received on delivery: receipt / rider reference" : "Bank transfer received: bank reference"); if (ref) a.run(() => api(`orders/${o.id}/confirm-transfer`, { orgId, method: "POST", body: { reference: ref } }).then(load), "Payment recorded."); }}>{o.payment.state === "COD_DUE" ? "Cash received" : "Transfer received"}</button>}
        <button className={gb} onClick={() => { const ref = window.prompt("Tracking reference", o.shipping?.trackingRef || ""); if (ref !== null) a.run(() => api(`orders/${o.id}/tracking`, { orgId, method: "POST", body: { trackingRef: ref } }).then(load), "Tracking saved."); }}>Tracking</button>
      </div>
    </div>)}
  </div>;
}

function Delivery({ orgId, s, onDone }) {
  const [zones, setZones] = useState(s.shipping.zones.map((z) => ({ ...z, countries: z.countries.join(","), cities: z.cities.join(","), flat: z.flatMinor / 100, perKg: z.perKgMinor / 100, freeOver: z.freeOverMinor === null ? "" : z.freeOverMinor / 100, windows: (z.windows || []).join(",") })));
  const [pickup, setPickup] = useState(s.shipping.pickup); const a = useAction();
  const up = (i, k, v) => setZones(zones.map((z, j) => (j === i ? { ...z, [k]: v } : z)));
  return <div className="space-y-3">
    <p className={`text-sm ${mu}`}>Delivery is fulfilled by your team (manual fulfilment). Add tracking references on orders; carrier integrations are not included.</p>
    {zones.map((z, i) => <div key={i} className={`${card} grid md:grid-cols-4 gap-2`}>
      <L t="Name"><input className={f} value={z.name} onChange={(e) => up(i, "name", e.target.value)} /></L>
      <L t="Countries (codes, e.g. PK,GB)"><input className={f} value={z.countries} onChange={(e) => up(i, "countries", e.target.value)} /></L>
      <L t="Cities (empty = whole country)"><input className={f} value={z.cities} onChange={(e) => up(i, "cities", e.target.value)} /></L>
      <L t="Rate"><select className={f} value={z.rateType} onChange={(e) => up(i, "rateType", e.target.value)}><option value="flat">Flat</option><option value="weight">Flat + per kg</option><option value="free">Free</option></select></L>
      <L t="Flat amount"><input className={f} value={z.flat} onChange={(e) => up(i, "flat", e.target.value)} /></L>
      {z.rateType === "weight" && <L t="Per kg"><input className={f} value={z.perKg} onChange={(e) => up(i, "perKg", e.target.value)} /></L>}
      <L t="Free over (order value)"><input className={f} value={z.freeOver} onChange={(e) => up(i, "freeOver", e.target.value)} /></L>
      <L t="Delivery time text"><input className={f} value={z.etaText || ""} onChange={(e) => up(i, "etaText", e.target.value)} /></L>
      <L t="Time slots (comma separated, optional)"><input className={f} value={z.windows} onChange={(e) => up(i, "windows", e.target.value)} /></L>
      <div className="flex items-end"><button className={gb} onClick={() => setZones(zones.filter((_, j) => j !== i))}>Remove</button></div>
    </div>)}
    <button className={gb} onClick={() => setZones([...zones, { name: "Delivery", countries: "PK", cities: "", rateType: "flat", flat: 0, perKg: 0, freeOver: "", etaText: "", windows: "" }])}>+ Delivery zone</button>
    <div className={card}><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pickup.enabled} onChange={(e) => setPickup({ ...pickup, enabled: e.target.checked })} />Customers can pick up from the store's location</label>
      <L t="Pickup instructions"><input className={f} value={pickup.instructions || ""} onChange={(e) => setPickup({ ...pickup, instructions: e.target.value })} /></L></div>
    <div className="flex gap-2 items-center"><button className={pb} onClick={() => a.run(() => api("store", { orgId, method: "PUT", body: { shipping: { zones: zones.map((z) => ({ ...z, countries: String(z.countries).split(",").map((c) => c.trim()).filter(Boolean), cities: String(z.cities).split(",").map((c) => c.trim()).filter(Boolean), windows: String(z.windows || "").split(",").map((c) => c.trim()).filter(Boolean) })), pickup: { ...pickup, warehouseIds: pickup.warehouseIds?.length ? pickup.warehouseIds : [s.warehouseId] } } } }).then(onDone), "Delivery options saved.")}>Save delivery options</button><Msg {...a} /></div>
  </div>;
}

function Payments({ orgId, s, onDone }) {
  const p = s.payments; const a = useAction();
  const [bt, setBt] = useState(p.bankTransfer); const [cod, setCod] = useState({ enabled: p.cod.enabled, maxOrder: p.cod.maxOrder ?? "" });
  const [st, setSt] = useState({ secretKey: "", webhookSecret: "" }); const [sp, setSp] = useState({ environment: p.safepay.environment || "production", apiKey: p.safepay.apiKey || "", secretKey: "", webhookSecret: "" });
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const save = (body, msg) => a.run(() => api("store/payments", { orgId, method: "PUT", body }).then(onDone), msg);
  return <div className="grid lg:grid-cols-2 gap-3">
    <div className={`${card} space-y-2`}><H>Bank transfer</H>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={bt.enabled} onChange={(e) => setBt({ ...bt, enabled: e.target.checked })} />Offer bank transfer (the order is held until you confirm the money arrived)</label>
      <L t="Instructions shown to the customer"><textarea className={f} rows={3} value={bt.instructions} onChange={(e) => setBt({ ...bt, instructions: e.target.value })} placeholder="Account name, bank, IBAN / account number" /></L>
      <button className={pb} onClick={() => save({ bankTransfer: bt }, "Saved.")}>Save</button></div>
    <div className={`${card} space-y-2`}><H>Cash on delivery</H>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cod.enabled} onChange={(e) => setCod({ ...cod, enabled: e.target.checked })} />Offer cash on delivery</label>
      <L t="Maximum order value (optional)"><input className={f} value={cod.maxOrder} onChange={(e) => setCod({ ...cod, maxOrder: e.target.value })} /></L>
      <button className={pb} onClick={() => save({ cod: { enabled: cod.enabled, maxOrder: cod.maxOrder === "" ? null : Number(cod.maxOrder) } }, "Saved.")}>Save</button></div>
    <div className={`${card} space-y-2`}><H>Card payments with your Stripe account (UK)</H>
      <p className={`text-xs ${mu}`}>No monthly fee from Inaya; Stripe charges you per payment. Customers pay on Stripe's secure page; the money goes straight to your Stripe account. {p.stripe.keySet ? `Key saved (${p.stripe.mode}, ${p.stripe.keyHint}).` : "No key saved."}</p>
      <L t="Secret or restricted key (sk_live_… for real payments)"><input className={f} type="password" autoComplete="off" value={st.secretKey} onChange={(e) => setSt({ ...st, secretKey: e.target.value })} /></L>
      <p className="text-xs break-all">Webhook URL to add in Stripe (events: checkout.session.completed, checkout.session.expired, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, charge.refunded, charge.dispute.created): <code>{origin}/api/shop/webhooks/stripe/{s.id}</code></p>
      <L t="Webhook signing secret (whsec_…)"><input className={f} type="password" autoComplete="off" value={st.webhookSecret} onChange={(e) => setSt({ ...st, webhookSecret: e.target.value })} /></L>
      <div className="flex gap-2"><button className={gb} onClick={() => save({ stripe: { ...(st.secretKey ? { secretKey: st.secretKey } : {}), ...(st.webhookSecret ? { webhookSecret: st.webhookSecret } : {}) } }, "Keys saved.").then(() => setSt({ secretKey: "", webhookSecret: "" }))}>Save keys</button>
        <button className={pb} onClick={() => save({ stripe: { enabled: !p.stripe.enabled } }, p.stripe.enabled ? "Stripe switched off." : "Stripe switched on.")}>{p.stripe.enabled ? "Switch off" : "Switch on"}</button></div></div>
    <div className={`${card} space-y-2`}><H>Card / wallet payments with your Safepay account (Pakistan)</H>
      <p className={`text-xs ${mu}`}>No monthly fee from Inaya; Safepay charges you per payment. {p.safepay.secretSet ? `Secret saved (${p.safepay.secretHint}).` : "No secret saved."}</p>
      <L t="Environment"><select className={f} value={sp.environment} onChange={(e) => setSp({ ...sp, environment: e.target.value })}><option value="production">Production (real payments)</option><option value="sandbox">Sandbox (testing)</option></select></L>
      <L t="API key (public key)"><input className={f} value={sp.apiKey} onChange={(e) => setSp({ ...sp, apiKey: e.target.value })} /></L>
      <L t="Secret key"><input className={f} type="password" autoComplete="off" value={sp.secretKey} onChange={(e) => setSp({ ...sp, secretKey: e.target.value })} /></L>
      <p className="text-xs break-all">Webhook endpoint to add in Safepay: <code>{origin}/api/shop/webhooks/safepay/{s.id}</code></p>
      <L t="Webhook shared secret"><input className={f} type="password" autoComplete="off" value={sp.webhookSecret} onChange={(e) => setSp({ ...sp, webhookSecret: e.target.value })} /></L>
      <div className="flex gap-2"><button className={gb} onClick={() => save({ safepay: { environment: sp.environment, apiKey: sp.apiKey, ...(sp.secretKey ? { secretKey: sp.secretKey } : {}), ...(sp.webhookSecret ? { webhookSecret: sp.webhookSecret } : {}) } }, "Saved.").then(() => setSp({ ...sp, secretKey: "", webhookSecret: "" }))}>Save keys</button>
        <button className={pb} onClick={() => save({ safepay: { enabled: !p.safepay.enabled } }, p.safepay.enabled ? "Safepay switched off." : "Safepay switched on.")}>{p.safepay.enabled ? "Switch off" : "Switch on"}</button></div></div>
    <div className="lg:col-span-2"><Msg {...a} /></div>
    <ProviderPayments orgId={orgId} />
  </div>;
}

function ProviderPayments({ orgId }) {
  const [d, setD] = useState(null); useEffect(() => { api("payments", { orgId }).then(setD).catch(() => {}); }, [orgId]);
  if (!d?.payments?.length) return null;
  return <div className={`${card} lg:col-span-2`}><H>Card payments (settlement)</H>
    <p className="text-sm">Paid {money(d.totals.paid)} · fees {money(d.totals.fees)} · net {money(d.totals.net)} · pending {d.totals.pending}{d.totals.mismatched ? ` · ${d.totals.mismatched} held for a mismatch (check in the provider)` : ""}</p>
    <div className="overflow-x-auto"><table className="w-full text-xs mt-2"><thead><tr className={`text-left ${mu}`}><th>Order</th><th>Provider</th><th>Reference</th><th>Amount</th><th>Fee</th><th>Net</th><th>State</th></tr></thead><tbody>{d.payments.map((x) => <tr key={x.id} className="border-t border-[var(--inaya-border)]"><td>{x.orderNumber}</td><td>{x.provider} {x.mode}</td><td className="font-mono">{x.reference}</td><td>{money(x.amount, x.currency)}</td><td>{money(x.fee)}</td><td>{money(x.net)}</td><td>{x.state}</td></tr>)}</tbody></table></div>
  </div>;
}

function Channels({ orgId }) {
  const [d, setD] = useState(null); const [form, setForm] = useState(null); const [pull, setPull] = useState(null); const a = useAction();
  const [back] = useState(() => { if (typeof window === "undefined") return null; const q = new URLSearchParams(window.location.search); return q.get("shopify") === "connected" ? { ok: `Shopify connected.${q.get("shopify_missing") ? ` Shopify didn't grant: ${q.get("shopify_missing")}.` : ""} Next: Import & match products.` } : q.get("shopify_error") ? { err: q.get("shopify_error") } : null; });
  const load = useCallback(() => api("channels", { orgId }).then(setD).catch(() => {}), [orgId]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <p className={`text-sm ${mu}`}>Loading…</p>;
  const act = (id, what, body = {}, msg) => a.run(() => api(`channels/${id}/${what}`, { orgId, method: "POST", body }).then((r) => { load(); return r; }), msg);
  return <div className="space-y-3">
    {back && <Msg ok={back.ok} err={back.err} />}
    <p className={`text-sm ${mu}`}>Sync products, prices, stock and orders with the Shopify or WooCommerce store you already run. Included in Inaya Commerce: {d.limits.plan === "enterprise" ? `${d.limits.total} connected stores` : `1 Shopify + 1 WooCommerce store`}{d.limits.extraStores ? ` + ${d.limits.extraStores} extra` : ""}. Orders synced this month: {d.usage.syncedOrdersThisMonth}{d.limits.monthlyOrders ? ` of ${d.limits.monthlyOrders}` : " (unlimited)"}.</p>
    {d.channels.map((ch) => <div key={ch.id} className={`${card} space-y-2`}>
      <div className="flex flex-wrap gap-2 items-baseline"><b>{ch.platform === "SHOPIFY" ? "Shopify" : "WooCommerce"}: {ch.name}</b><span className={`text-xs ${mu}`}>{ch.address} · {ch.status} · {ch.currency || ""}</span></div>
      <p className={`text-xs ${mu}`}>Orders last synced {ch.lastOrderSyncAt ? new Date(ch.lastOrderSyncAt).toLocaleString() : "never"} · stock pushed {ch.lastStockPushAt ? new Date(ch.lastStockPushAt).toLocaleString() : "never"} · webhooks {ch.webhooksRegisteredAt ? "on" : "not registered"}{ch.lastError ? ` · last error: ${ch.lastError.message}` : ""}</p>
      <div className="flex flex-wrap gap-2">
        <button className={gb} onClick={() => act(ch.id, "webhooks", {}, "Webhooks registered; new orders arrive instantly.")}>Register webhooks</button>
        <button className={gb} onClick={async () => { const r = await act(ch.id, "pull-products"); if (r) setPull({ id: ch.id, ...r }); }}>Import & match products</button>
        <button className={gb} onClick={() => act(ch.id, "sync-stock", { force: true }, (r) => `${r.pushed} stock levels sent.${r.skipped ? ` ${r.skipped} skipped: run Import & match products first.` : ""}`)}>Send stock now</button>
        <button className={gb} onClick={() => act(ch.id, "sync-orders", {}, (r) => `${r.imported} new orders imported (${r.seen} checked).`)}>Get orders now</button>
        <PushProducts orgId={orgId} ch={ch} onDone={load} />
        <select className={f + " max-w-[180px]"} aria-label="Price master" value={ch.masters.price} onChange={(e) => a.run(() => api(`channels/${ch.id}`, { orgId, method: "PUT", body: { masters: { ...ch.masters, price: e.target.value } } }).then(load), "Saved.")}><option value="inaya">Prices: Inaya decides</option><option value="channel">Prices: {ch.platform === "SHOPIFY" ? "Shopify" : "WooCommerce"} decides</option></select>
        <button className={gb} onClick={() => a.run(() => api(`channels/${ch.id}`, { orgId, method: "PUT", body: { status: ch.status === "ACTIVE" ? "PAUSED" : "ACTIVE" } }).then(load))}>{ch.status === "ACTIVE" ? "Pause" : "Resume"}</button>
        <button className={gb} onClick={() => window.confirm("Disconnect this store? Its saved keys are destroyed; past orders stay.") && a.run(() => api(`channels/${ch.id}`, { orgId, method: "DELETE" }).then(load), "Disconnected.")}>Disconnect</button>
      </div>
      {ch.platform === "SHOPIFY" && ch.locations.length > 1 && <L t="Shopify location that shows Inaya's stock"><select className={f + " max-w-xs"} value={ch.locationId || ""} onChange={(e) => a.run(() => api(`channels/${ch.id}`, { orgId, method: "PUT", body: { locationId: e.target.value } }).then(load))}>{ch.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></L>}
      {pull?.id === ch.id && <div className="text-sm"><p>{pull.matched} matched by SKU · {pull.conflicts} price conflicts · {pull.unmatched.length} not in Inaya</p>
        {pull.unmatched.length > 0 && <button className={pb} onClick={() => act(ch.id, "import-products", { items: pull.unmatched }, (r) => `${r.results.filter((x) => x.ok).length} products created in Inaya with their current store stock as opening stock (${r.results.reduce((n, x) => n + (x.openingStock || 0), 0)} units).${r.results.some((x) => x.ok && x.stockTracked === false) ? " Some items don't track stock in the store; set their stock in Inaya before sending stock." : ""}${r.results.some((x) => !x.ok) ? ` Skipped ${r.results.filter((x) => !x.ok).length}: ${[...new Set(r.results.filter((x) => !x.ok).map((x) => x.error))].join(" ")}` : ""}`).then(() => setPull(null))}>Create the {pull.unmatched.length} missing products in Inaya</button>}</div>}
    </div>)}
    <Conflicts orgId={orgId} />
    {!form ? <div className="flex gap-2"><button className={pb} onClick={() => setForm({ platform: "SHOPIFY" })}>Connect Shopify</button><button className={pb} onClick={() => setForm({ platform: "WOOCOMMERCE" })}>Connect WooCommerce</button></div>
      : <div className={`${card} space-y-2 max-w-xl`}><H>Connect {form.platform === "SHOPIFY" ? "Shopify" : "WooCommerce"}</H>
        {form.platform === "SHOPIFY" && d.shopifyApp?.enabled && !form.manual ? <>
          <p className={`text-xs ${mu}`}>Type your store address and click Install. Shopify asks you to approve Inaya, then brings you back here, connected. No keys to copy.</p>
          <L t="Store address"><input className={f} placeholder="yourshop.myshopify.com" value={form.shopDomain || ""} onChange={(e) => setForm({ ...form, shopDomain: e.target.value })} /></L>
          <div className="flex gap-2 flex-wrap"><button className={pb} onClick={() => a.run(() => api("channels/shopify/install", { orgId, method: "POST", body: { shopDomain: form.shopDomain } }).then((r) => { window.location.href = r.url; return r; }))}>Install Inaya on Shopify</button><button className={gb} onClick={() => setForm(null)}>Cancel</button></div>
          <button className={`text-xs underline ${mu}`} onClick={() => setForm({ ...form, manual: true })}>I already have a custom app token</button>
        </> : form.platform === "SHOPIFY" ? <>
          <p className={`text-xs ${mu}`}>In Shopify admin: Settings → Apps → Develop apps → Create an app. Give it Admin API access to products, inventory, orders, fulfillments and locations (read and write), install it, then copy the Admin API access token and the API secret key.</p>
          <L t="Store address"><input className={f} placeholder="yourshop.myshopify.com" value={form.shopDomain || ""} onChange={(e) => setForm({ ...form, shopDomain: e.target.value })} /></L>
          <L t="Admin API access token (shpat_…)"><input className={f} type="password" autoComplete="off" value={form.accessToken || ""} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} /></L>
          <L t="API secret key"><input className={f} type="password" autoComplete="off" value={form.apiSecret || ""} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} /></L>
        </> : <>
          <p className={`text-xs ${mu}`}>In WordPress: WooCommerce → Settings → Advanced → REST API → Add key, with Read/Write permission. The site must use https.</p>
          <L t="Shop address"><input className={f} placeholder="https://shop.example.com" value={form.siteUrl || ""} onChange={(e) => setForm({ ...form, siteUrl: e.target.value })} /></L>
          <L t="Consumer key (ck_…)"><input className={f} type="password" autoComplete="off" value={form.consumerKey || ""} onChange={(e) => setForm({ ...form, consumerKey: e.target.value })} /></L>
          <L t="Consumer secret (cs_…)"><input className={f} type="password" autoComplete="off" value={form.consumerSecret || ""} onChange={(e) => setForm({ ...form, consumerSecret: e.target.value })} /></L>
        </>}
        {!(form.platform === "SHOPIFY" && d.shopifyApp?.enabled && !form.manual) && <><L t="Import orders placed from (optional)"><input type="date" className={f} value={form.importOrdersFrom || ""} onChange={(e) => setForm({ ...form, importOrdersFrom: e.target.value })} /></L>
        <div className="flex gap-2"><button className={pb} onClick={() => a.run(() => api("channels", { orgId, method: "POST", body: form }).then((r) => { setForm(null); load(); return r; }), (r) => r.warning || "Connected. Next: register webhooks and import & match products.")}>Connect</button><button className={gb} onClick={() => setForm(null)}>Cancel</button></div></>}
      </div>}
    <Msg {...a} />
  </div>;
}

function PushProducts({ orgId, ch, onDone }) {
  const [open, setOpen] = useState(false); const [prods, setProds] = useState([]); const [sel, setSel] = useState([]); const a = useAction();
  useEffect(() => { if (open) fetch(`/api/orgs/inventory/products?orgId=${orgId}`, { credentials: "include" }).then((x) => x.json()).then((p) => setProds((p.products || []).filter((x) => x.sku && !["GIFT_CARD", "SERVICE"].includes(x.productType)))).catch(() => {}); }, [open, orgId]);
  if (!open) return <button className={gb} onClick={() => setOpen(true)}>Publish products to {ch.platform === "SHOPIFY" ? "Shopify" : "WooCommerce"}</button>;
  return <div className={`${card} w-full space-y-2`}><div className="max-h-48 overflow-y-auto grid sm:grid-cols-2 gap-1">{prods.map((p) => <label key={p.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} />{p.name} <span className={mu}>({p.sku})</span></label>)}</div>
    <div className="flex gap-2"><button className={pb} disabled={!sel.length} onClick={() => a.run(() => api(`channels/${ch.id}/push-products`, { orgId, method: "POST", body: { productIds: sel } }).then((r) => { onDone(); return r; }), (r) => `${r.results.filter((x) => x.ok).length} published${r.results.some((x) => !x.ok) ? `; ${r.results.filter((x) => !x.ok).map((x) => x.error).join("; ")}` : ""}.`)}>Publish {sel.length}</button><button className={gb} onClick={() => setOpen(false)}>Close</button></div><Msg {...a} /></div>;
}

function Conflicts({ orgId }) {
  const [rows, setRows] = useState([]); const a = useAction();
  const load = useCallback(() => api("conflicts", { orgId }).then((r) => setRows(r.conflicts)).catch(() => {}), [orgId]);
  useEffect(() => { load(); }, [load]);
  if (!rows.length) return null;
  return <div className={card}><H>Changed on both sides</H><p className={`text-xs ${mu}`}>These values were edited in the connected store while Inaya decides them. Choose which to keep.</p>
    {rows.map((r) => <div key={r.id} className="flex flex-wrap gap-2 items-center text-sm py-1 border-t border-[var(--inaya-border)]"><span className="flex-1">{r.name} ({r.sku}) · {r.field}: Inaya {money(r.inayaValue)} vs store {money(r.channelValue)}</span>
      <button className={gb} onClick={() => a.run(() => api(`conflicts/${r.id}/resolve`, { orgId, method: "POST", body: { keep: "inaya" } }).then(load))}>Keep Inaya's</button><button className={gb} onClick={() => a.run(() => api(`conflicts/${r.id}/resolve`, { orgId, method: "POST", body: { keep: "channel" } }).then(load))}>Keep store's</button></div>)}<Msg {...a} /></div>;
}

function SyncLog({ orgId }) {
  const [d, setD] = useState(null); const [failed, setFailed] = useState(true); const a = useAction();
  const load = useCallback(() => api(`sync-log${failed ? "?failed=1" : ""}`, { orgId }).then(setD).catch(() => {}), [orgId, failed]);
  useEffect(() => { load(); }, [load]);
  return <div className="space-y-2">
    <div className="flex gap-3 items-center"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)} />Only problems</label>{d && <span className={`text-sm ${mu}`}>{d.openFailures} open problem{d.openFailures === 1 ? "" : "s"}. Failed jobs retry automatically (up to 8 times, waiting longer each time).</span>}</div>
    <Msg {...a} />
    {d?.entries?.map((e) => <div key={e.id} className={`${card} text-sm flex flex-wrap gap-2 items-center`}>
      <span className={e.ok ? "text-emerald-600" : e.resolvedAt ? mu : "text-red-500"}>{e.ok ? "OK" : e.resolvedAt ? "Resolved" : "Failed"}</span><b>{e.type.replace(/_/g, " ").toLowerCase()}</b>{e.ref && <span className={`font-mono text-xs ${mu}`}>{e.ref}</span>}
      <span className="flex-1">{e.error || e.summary || ""}</span><span className={`text-xs ${mu}`}>{new Date(e.createdAt).toLocaleString()}{e.attempts > 1 ? ` · ${e.attempts} attempts` : ""}</span>
      {!e.ok && !e.resolvedAt && <><button className={gb} onClick={() => a.run(() => api(`sync-log/${e.id}/retry`, { orgId, method: "POST", body: {} }).then((r) => { load(); return r; }), (r) => (r.fixed ? "Fixed." : "Still failing; see the message."))}>Retry now</button><button className={gb} onClick={() => a.run(() => api(`sync-log/${e.id}/dismiss`, { orgId, method: "POST", body: {} }).then(load))}>Dismiss</button></>}
    </div>)}
  </div>;
}

function Analytics({ orgId }) {
  const [d, setD] = useState(null); const [days, setDays] = useState(30);
  useEffect(() => { api(`analytics?days=${days}`, { orgId }).then(setD).catch(() => {}); }, [orgId, days]);
  if (!d) return <p className={`text-sm ${mu}`}>Loading…</p>; const t = d.totals;
  const tiles = [["Store visits", t.views || 0], ["Product views", t.productViews || 0], ["Checkouts started", t.checkoutsStarted || 0], ["Orders", t.orderCount || 0], ["Revenue", money(t.revenue, t.currency)], ["Conversion", `${t.conversionPercent || 0}%`], ["Unpaid & expired", t.abandoned || 0], ["Cancelled", t.cancelled || 0]];
  return <div className="space-y-3">
    <select className={f + " max-w-[160px]"} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map((n) => <option key={n} value={n}>Last {n} days</option>)}</select>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{tiles.map(([k, v]) => <div key={k} className={card}><p className={`text-xs ${mu}`}>{k}</p><p className="text-xl font-bold">{v}</p></div>)}</div>
    {d.days.length > 0 && <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className={`text-left ${mu}`}><th>Day</th><th>Visits</th><th>Product views</th><th>Checkouts</th><th>Orders</th></tr></thead><tbody>{d.days.map((r) => <tr key={r.day} className="border-t border-[var(--inaya-border)]"><td>{r.day}</td><td>{r.views}</td><td>{r.productViews}</td><td>{r.checkoutsStarted}</td><td>{r.orders}</td></tr>)}</tbody></table></div>}
  </div>;
}
