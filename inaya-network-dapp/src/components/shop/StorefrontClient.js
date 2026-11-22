"use client";
// components/shop/StorefrontClient.js -- the shopper-facing store UI (Commerce Phase 5). Server-rendered data comes in as props;
// the cart lives in this browser (localStorage) and is re-priced by the server on every change; checkout posts once with an
// idempotency key (a double click can't create two orders); the order page re-checks a card payment with the provider.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const money = (v, cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, minimumFractionDigits: 2 }).format(v); } catch { return `${cur} ${Number(v).toFixed(2)}`; } };
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const newKey = () => { try { return `chk_${crypto.randomUUID().replace(/-/g, "")}`; } catch { return `chk_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`; } };
const COUNTRIES = [["PK", "Pakistan"], ["GB", "United Kingdom"], ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"], ["US", "United States"], ["IN", "India"], ["BD", "Bangladesh"], ["MY", "Malaysia"], ["ID", "Indonesia"], ["TR", "Türkiye"]];

function useCart(storeId) {
  const k = `inaya-cart-${storeId}`; const [cart, setCart] = useState([]);
  useEffect(() => { setCart(ls.get(k, [])); }, [k]);
  const save = useCallback((next) => { setCart(next); ls.set(k, next); window.dispatchEvent(new Event("inaya-cart")); }, [k]);
  useEffect(() => { const f = () => setCart(ls.get(k, [])); window.addEventListener("inaya-cart", f); return () => window.removeEventListener("inaya-cart", f); }, [k]);
  return {
    cart, count: cart.reduce((n, l) => n + l.quantity, 0),
    add: (item, q = 1) => { const c = ls.get(k, []); const i = c.findIndex((x) => x.listingId === item.listingId); if (i >= 0) c[i].quantity = Math.min(999, c[i].quantity + q); else c.push({ ...item, quantity: q }); save(c); },
    setQty: (id, q) => save(ls.get(k, []).map((x) => (x.listingId === id ? { ...x, quantity: Math.max(1, Math.min(999, q)) } : x))),
    remove: (id) => save(ls.get(k, []).filter((x) => x.listingId !== id)),
    clear: () => save([]),
  };
}

export default function StorefrontClient({ store, view, data, linkBase, apiBase, preview, query }) {
  const b = store.content.branding; const cart = useCart(store.id);
  const theme = { "--shop": b.primaryColor, "--accent": b.accentColor };
  useEffect(() => { if (preview) return; if (view === "home" || view === "product") fetch(`${apiBase}/view`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: view === "product" ? "product" : "store" }) }).catch(() => {}); }, [view, apiBase, preview]);
  const L = (p) => `${linkBase}${p}` || "/";
  const dark = store.content.theme === "bold";
  return (
    <div style={theme} className="min-h-screen flex flex-col bg-white text-slate-900">
      {preview && <div className="bg-amber-400 text-black text-center text-sm py-1.5 font-semibold">Preview of the draft store. Customers don't see these changes until you publish. Checkout is off.</div>}
      <header className={dark ? "bg-slate-900 text-white" : "bg-white border-b border-slate-200"}>
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <a href={L("") || "/"} className="flex items-center gap-2 font-extrabold text-lg min-w-0">
            {b.logoUrl ? <img src={b.logoUrl} alt="" className="h-9 w-auto max-w-[120px] object-contain" /> : <span className="w-9 h-9 rounded-lg grid place-items-center text-white" style={{ background: "var(--shop)" }}>{b.name.slice(0, 1)}</span>}
            <span className="truncate">{b.name}</span>
          </a>
          <nav className="hidden sm:flex gap-4 text-sm">{store.content.nav.map((n) => <a key={n.href + n.label} href={L(n.href)} className="hover:underline">{n.label}</a>)}</nav>
          <form action={L("/products")} className="ml-auto flex-1 min-w-[160px] max-w-xs"><input name="q" defaultValue={query.q} aria-label="Search products" placeholder="Search products" className="w-full rounded-full border border-slate-300 px-3 py-1.5 text-sm text-slate-900" /></form>
          <a href={L("/cart")} className="relative rounded-full px-3 py-1.5 text-sm font-semibold text-white" style={{ background: "var(--shop)" }} aria-label={`Cart, ${cart.count} items`}>Cart{cart.count ? ` (${cart.count})` : ""}</a>
        </div>
      </header>
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6">
        {view === "home" && <Home store={store} data={data} L={L} />}
        {view === "products" && <Products store={store} data={data} L={L} query={query} />}
        {view === "product" && <Product store={store} p={data} L={L} cart={cart} />}
        {view === "page" && <article className="max-w-3xl"><h1 className="text-2xl font-bold mb-4">{data.title}</h1><div className="whitespace-pre-wrap leading-relaxed text-slate-700">{data.text}</div></article>}
        {view === "cart" && <Cart store={store} cart={cart} apiBase={apiBase} L={L} />}
        {view === "checkout" && <Checkout store={store} cart={cart} apiBase={apiBase} L={L} preview={preview} />}
        {view === "order" && <Order store={store} apiBase={apiBase} orderNumber={data.orderNumber} token={query.t} paidFlag={query.paid} cancelledFlag={query.cancelled} cart={cart} />}
      </main>
      <footer className="border-t border-slate-200 text-sm text-slate-600">
        <div className="max-w-6xl mx-auto px-4 py-6 flex flex-wrap gap-x-5 gap-y-2">
          {Object.entries({ contact: "Contact", shipping: "Delivery", returns: "Returns", privacy: "Privacy", terms: "Terms" }).filter(([k]) => String(store.content.pages?.[k] || "").trim()).map(([k, t]) => <a key={k} href={L(`/pages/${k}`)} className="hover:underline">{t}</a>)}
          <span className="ml-auto text-slate-400">Powered by Inaya Commerce</span>
        </div>
      </footer>
    </div>
  );
}

function Card({ x, L, cur }) {
  return (
    <a href={L(`/p/${x.slug}`)} className="group block rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-shadow bg-white">
      <div className="aspect-square bg-slate-100 overflow-hidden">{x.image ? <img src={x.image} alt={x.title} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform" /> : <div className="w-full h-full grid place-items-center text-slate-400 text-sm">No image</div>}</div>
      <div className="p-3">
        <p className="font-semibold text-sm line-clamp-2">{x.title}</p>
        <p className="mt-1 text-sm"><span className="font-bold">{x.variants > 1 ? "From " : ""}{money(x.price, cur)}</span>{x.compareAtPrice ? <span className="ml-2 line-through text-slate-400">{money(x.compareAtPrice, cur)}</span> : null}</p>
        <p className={`text-xs mt-1 ${x.available.inStock ? (x.available.low ? "text-amber-600" : "text-emerald-700") : "text-red-600"}`}>{x.available.label}</p>
      </div>
    </a>
  );
}
const Grid = ({ items, L, cur }) => (items.length ? <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">{items.map((x) => <Card key={x.id} x={x} L={L} cur={cur} />)}</div> : <p className="text-slate-500">No products yet.</p>);

function Home({ store, data, L }) {
  const h = store.content.home || {};
  return (
    <div className="space-y-10">
      <section className="rounded-2xl overflow-hidden relative text-white" style={{ background: "var(--shop)" }}>
        {h.heroImageUrl && <img src={h.heroImageUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" />}
        <div className="relative px-6 py-14 sm:px-10 max-w-2xl"><h1 className="text-3xl sm:text-4xl font-extrabold">{h.heroTitle || store.content.branding.name}</h1>{(h.heroText || store.content.branding.tagline) && <p className="mt-3 text-lg opacity-95">{h.heroText || store.content.branding.tagline}</p>}<a href={L("/products")} className="inline-block mt-6 rounded-full bg-white text-slate-900 font-semibold px-5 py-2">Shop now</a></div>
      </section>
      {(h.sections || []).map((s, i) => s.type === "categories" ? (data.all.categories.length > 0 && <section key={i}><h2 className="text-xl font-bold mb-3">{s.title || "Shop by category"}</h2><div className="flex flex-wrap gap-2">{data.all.categories.map((cat) => <a key={cat} href={L(`/products?category=${encodeURIComponent(cat)}`)} className="rounded-full border border-slate-300 px-4 py-1.5 text-sm hover:border-slate-500">{cat}</a>)}</div></section>)
        : s.type === "text" ? <section key={i} className="max-w-3xl"><h2 className="text-xl font-bold mb-2">{s.title}</h2><p className="whitespace-pre-wrap text-slate-700">{s.text}</p></section>
        : <section key={i}><div className="flex items-end justify-between mb-3"><h2 className="text-xl font-bold">{s.title || "Featured"}</h2><a href={L("/products")} className="text-sm hover:underline">See all</a></div><Grid items={(s.type === "new" ? data.all.items : data.featured.items.some((x) => x.featured) ? data.featured.items.filter((x) => x.featured) : data.featured.items).slice(0, 8)} L={L} cur={store.currency} /></section>)}
    </div>
  );
}

function Products({ store, data, L, query }) {
  const qs = (o) => { const p = new URLSearchParams(); const v = { q: query.q, category: query.category, sort: query.sort, ...o }; for (const [k, x] of Object.entries(v)) if (x) p.set(k, x); const s = p.toString(); return L(`/products${s ? `?${s}` : ""}`); };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <h1 className="text-2xl font-bold mr-auto">{query.q ? `Results for "${query.q}"` : query.category || "All products"}</h1>
        <select aria-label="Sort" defaultValue={query.sort} onChange={(e) => { window.location.href = qs({ sort: e.target.value, page: "" }); }} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
          <option value="featured">Featured</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option><option value="name">Name</option>
        </select>
      </div>
      {data.categories.length > 0 && <div className="flex flex-wrap gap-2 mb-5"><a href={qs({ category: "", page: "" })} className={`rounded-full px-3 py-1 text-sm border ${!query.category ? "text-white border-transparent" : "border-slate-300"}`} style={!query.category ? { background: "var(--shop)" } : {}}>All</a>{data.categories.map((cat) => <a key={cat} href={qs({ category: cat, page: "" })} className={`rounded-full px-3 py-1 text-sm border ${query.category === cat ? "text-white border-transparent" : "border-slate-300"}`} style={query.category === cat ? { background: "var(--shop)" } : {}}>{cat}</a>)}</div>}
      <Grid items={data.items} L={L} cur={store.currency} />
      {data.pages > 1 && <div className="flex gap-2 justify-center mt-6">{Array.from({ length: data.pages }, (_, i) => i + 1).map((n) => <a key={n} href={qs({ page: String(n) })} className={`w-9 h-9 grid place-items-center rounded-lg border ${n === data.page ? "text-white border-transparent" : "border-slate-300"}`} style={n === data.page ? { background: "var(--shop)" } : {}}>{n}</a>)}</div>}
    </div>
  );
}

function Product({ store, p, L, cart }) {
  const [img, setImg] = useState(0); const [qty, setQty] = useState(1); const [added, setAdded] = useState(false);
  const canBuy = p.available.inStock;
  return (
    <div className="grid md:grid-cols-2 gap-8">
      <div>
        <div className="aspect-square rounded-xl overflow-hidden bg-slate-100">{p.images[img] ? <img src={p.images[img]} alt={p.title} className="w-full h-full object-cover" /> : <div className="w-full h-full grid place-items-center text-slate-400">No image</div>}</div>
        {p.images.length > 1 && <div className="flex gap-2 mt-2 overflow-x-auto">{p.images.map((u, i) => <button key={u} onClick={() => setImg(i)} aria-label={`Image ${i + 1}`} className={`w-16 h-16 rounded-lg overflow-hidden border-2 shrink-0 ${i === img ? "border-slate-800" : "border-transparent"}`}><img src={u} alt="" className="w-full h-full object-cover" /></button>)}</div>}
      </div>
      <div>
        <a href={L("/products")} className="text-sm text-slate-500 hover:underline">← All products</a>
        <h1 className="text-2xl sm:text-3xl font-extrabold mt-2">{p.title}</h1>
        <p className="mt-3 text-2xl font-bold">{money(p.price, p.currency)} <span className="text-sm font-normal text-slate-500">{p.priceNote}</span>{p.compareAtPrice ? <span className="ml-2 text-lg line-through text-slate-400">{money(p.compareAtPrice, p.currency)}</span> : null}</p>
        <p className={`mt-1 text-sm ${p.available.inStock ? (p.available.low ? "text-amber-600" : "text-emerald-700") : "text-red-600"}`}>{p.available.label}</p>
        {p.variants.length > 1 && <div className="mt-4"><p className="text-sm font-semibold mb-1">{p.variantGroupName || "Options"}</p><div className="flex flex-wrap gap-2">{p.variants.map((v) => <a key={v.listingId} href={L(`/p/${v.slug}`)} className={`rounded-lg border px-3 py-1.5 text-sm ${v.slug === p.slug ? "border-slate-900 font-semibold" : "border-slate-300"} ${v.available.inStock ? "" : "opacity-50"}`}>{v.attributes ? Object.values(v.attributes).join(" / ") : v.title}</a>)}</div></div>}
        <div className="flex items-center gap-3 mt-6">
          <label className="text-sm">Qty <input type="number" min={1} max={999} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(999, Number(e.target.value) || 1)))} className="w-20 ml-1 rounded-lg border border-slate-300 px-2 py-1.5" /></label>
          <button disabled={!canBuy} onClick={() => { cart.add({ listingId: p.id, slug: p.slug, title: p.title, image: p.images[0] || null, price: p.price }, qty); setAdded(true); }} className="flex-1 rounded-full text-white font-semibold px-6 py-2.5 disabled:opacity-40" style={{ background: "var(--shop)" }}>{canBuy ? "Add to cart" : "Out of stock"}</button>
        </div>
        {added && <p className="mt-3 text-sm text-emerald-700">Added. <a href={L("/cart")} className="underline font-semibold">View cart</a></p>}
        {p.description && <div className="mt-6 whitespace-pre-wrap text-slate-700 leading-relaxed">{p.description}</div>}
        <dl className="mt-6 text-sm text-slate-600 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">{p.sku && <><dt>SKU</dt><dd>{p.sku}</dd></>}{p.weightKg ? <><dt>Weight</dt><dd>{p.weightKg} kg</dd></> : null}{p.dimensionsCm ? <><dt>Size</dt><dd>{p.dimensionsCm} cm</dd></> : null}{p.digital ? <><dt>Delivery</dt><dd>Digital</dd></> : null}</dl>
      </div>
    </div>
  );
}

function useQuote(apiBase, cart, extra) {
  const [quote, setQuote] = useState(null); const [err, setErr] = useState("");
  const body = useMemo(() => JSON.stringify({ lines: cart.cart.map((l) => ({ listingId: l.listingId, quantity: l.quantity })), ...extra }), [cart.cart, extra]);
  useEffect(() => {
    if (!cart.cart.length) { setQuote(null); return; } let live = true;
    fetch(`${apiBase}/cart`, { method: "POST", headers: { "Content-Type": "application/json" }, body }).then((r) => r.json()).then((j) => { if (!live) return; if (j.error) { setErr(j.error); setQuote(null); } else { setErr(""); setQuote(j); } }).catch(() => live && setErr("Couldn't price the cart. Check your connection."));
    return () => { live = false; };
  }, [apiBase, body, cart.cart.length]);
  return { quote, err };
}

function Summary({ quote, cur, shippingKnown = true }) {
  if (!quote) return null; const t = quote.totals;
  const Row = ({ k, v, bold }) => <div className={`flex justify-between ${bold ? "font-bold text-base" : ""}`}><span>{k}</span><span>{v}</span></div>;
  return (
    <div className="space-y-1 text-sm">
      <Row k="Subtotal" v={money(t.subtotal, cur)} />
      {t.discounts > 0 && <Row k="Discounts" v={`−${money(t.discounts, cur)}`} />}
      {(t.promotions || []).map((p) => <Row key={p.id} k={<span className="text-emerald-700">Offer: {p.name}{p.code ? ` (${p.code})` : ""}</span>} v="" />)}
      {(t.rejectedCoupons || []).map((r) => <p key={r.code} className="text-amber-700">Code {r.code}: {r.reason}</p>)}
      <Row k={quote.taxMode === "inclusive" ? "Includes tax" : "Tax"} v={money(t.tax, cur)} />
      <Row k="Delivery" v={shippingKnown ? (t.shipping ? money(t.shipping, cur) : "Free") : "At checkout"} />
      <div className="border-t border-slate-200 pt-2 mt-2"><Row k="Total" v={money(t.grandTotal, cur)} bold /></div>
    </div>
  );
}

function Cart({ store, cart, apiBase, L }) {
  const [coupon, setCoupon] = useState(""); const [coupons, setCoupons] = useState([]);
  const extra = useMemo(() => ({ coupons }), [coupons]); const { quote, err } = useQuote(apiBase, cart, extra);
  useEffect(() => { try { sessionStorage.setItem(`inaya-coupons-${store.id}`, JSON.stringify(coupons)); } catch { /* ignore */ } }, [coupons, store.id]);
  if (!cart.cart.length) return <div className="text-center py-16"><h1 className="text-2xl font-bold">Your cart is empty</h1><a href={L("/products")} className="inline-block mt-4 rounded-full text-white px-5 py-2 font-semibold" style={{ background: "var(--shop)" }}>Browse products</a></div>;
  return (
    <div className="grid lg:grid-cols-[1fr_320px] gap-8">
      <div>
        <h1 className="text-2xl font-bold mb-4">Your cart</h1>
        <ul className="divide-y divide-slate-200 border-y border-slate-200">
          {cart.cart.map((l) => (
            <li key={l.listingId} className="py-3 flex gap-3 items-center">
              <div className="w-16 h-16 rounded-lg bg-slate-100 overflow-hidden shrink-0">{l.image && <img src={l.image} alt="" className="w-full h-full object-cover" />}</div>
              <div className="flex-1 min-w-0"><a href={L(`/p/${l.slug}`)} className="font-semibold hover:underline line-clamp-2">{l.title}</a><p className="text-sm text-slate-500">{money(l.price, store.currency)} each</p></div>
              <input type="number" aria-label={`Quantity of ${l.title}`} min={1} max={999} value={l.quantity} onChange={(e) => cart.setQty(l.listingId, Number(e.target.value) || 1)} className="w-16 rounded-lg border border-slate-300 px-2 py-1" />
              <button onClick={() => cart.remove(l.listingId)} className="text-sm text-red-600 hover:underline">Remove</button>
            </li>))}
        </ul>
        {err && <p className="mt-3 text-red-600 text-sm">{err}</p>}
      </div>
      <aside className="rounded-xl border border-slate-200 p-4 h-fit space-y-3">
        <form onSubmit={(e) => { e.preventDefault(); const c = coupon.trim().toUpperCase(); if (c) setCoupons((x) => [...new Set([...x, c])]); setCoupon(""); }} className="flex gap-2"><input value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="Discount code" aria-label="Discount code" className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /><button className="rounded-lg border border-slate-300 px-3 text-sm">Apply</button></form>
        {coupons.length > 0 && <p className="text-xs text-slate-500">Codes: {coupons.join(", ")} <button onClick={() => setCoupons([])} className="underline">remove</button></p>}
        <Summary quote={quote} cur={store.currency} shippingKnown={false} />
        <a href={L("/checkout")} className={`block text-center rounded-full text-white font-semibold py-2.5 ${quote ? "" : "pointer-events-none opacity-40"}`} style={{ background: "var(--shop)" }}>Checkout</a>
      </aside>
    </div>
  );
}

function Checkout({ store, cart, apiBase, L, preview }) {
  const sh = store.shipping; const pay = store.payments;
  const methods = [pay.stripe && ["STRIPE", "Card (secure payment page)"], pay.safepay && ["SAFEPAY", "Card / wallet (Safepay)"], pay.bankTransfer && ["BANK_TRANSFER", "Bank transfer"], pay.cod && ["COD", `Cash on delivery${pay.codMax ? ` (orders up to ${money(pay.codMax, store.currency)})` : ""}`]].filter(Boolean);
  const [f, setF] = useState({ name: "", email: "", phone: "", line1: "", line2: "", city: "", region: "", postcode: "", country: sh.zones[0]?.countries?.[0] || "PK", fulfilment: sh.zones.length ? "DELIVERY" : "PICKUP", zoneId: sh.zones[0]?.id || "", window: "", pickupWarehouseId: sh.pickup?.warehouseIds?.[0] || "", payment: methods[0]?.[0] || "", notes: "", terms: false });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const coupons = useMemo(() => { try { return JSON.parse(sessionStorage.getItem(`inaya-coupons-${store.id}`) || "[]"); } catch { return []; } }, [store.id]);
  const extra = useMemo(() => ({ coupons, fulfilment: f.fulfilment, zoneId: f.zoneId, address: { city: f.city, country: f.country }, pickupWarehouseId: f.pickupWarehouseId }), [coupons, f.fulfilment, f.zoneId, f.city, f.country, f.pickupWarehouseId]);
  const { quote, err } = useQuote(apiBase, cart, extra);
  const keyRef = useRef(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState("");
  const zone = sh.zones.find((z) => z.id === f.zoneId);
  if (!cart.cart.length) return <div className="text-center py-16"><h1 className="text-2xl font-bold">Your cart is empty</h1><a href={L("/products")} className="underline">Browse products</a></div>;
  const field = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm";
  const submit = async (e) => {
    e.preventDefault(); if (busy || preview) return; setBusy(true); setMsg("");
    if (!keyRef.current) keyRef.current = newKey();
    try {
      const r = await fetch(`${apiBase}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: keyRef.current, lines: cart.cart.map((l) => ({ listingId: l.listingId, quantity: l.quantity })), coupons, customer: { name: f.name, email: f.email, phone: f.phone }, address: { line1: f.line1, line2: f.line2, city: f.city, region: f.region, postcode: f.postcode, country: f.country }, fulfilment: f.fulfilment, zoneId: f.zoneId, deliveryWindow: f.window || undefined, pickupWarehouseId: f.pickupWarehouseId || undefined, paymentMethod: f.payment, notes: f.notes, acceptTerms: f.terms }) });
      const j = await r.json();
      if (!r.ok || j.error) { setMsg(j.error || "Something went wrong."); if (j.code !== "IN_PROGRESS") keyRef.current = null; setBusy(false); return; }
      cart.clear(); try { sessionStorage.removeItem(`inaya-coupons-${store.id}`); } catch { /* ignore */ }
      window.location.href = j.redirectUrl || L(`/order/${encodeURIComponent(j.orderNumber)}?t=${encodeURIComponent(j.token)}`);
    } catch { setMsg("Network problem. Your order may not have been placed; try again (you won't be charged twice)."); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="grid lg:grid-cols-[1fr_340px] gap-8">
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Checkout</h1>
        <fieldset className="space-y-2"><legend className="font-semibold mb-1">Contact</legend>
          <input required className={field} placeholder="Full name" aria-label="Full name" autoComplete="name" value={f.name} onChange={set("name")} />
          <div className="grid sm:grid-cols-2 gap-2"><input required type="email" className={field} placeholder="Email (for your receipt)" aria-label="Email" autoComplete="email" value={f.email} onChange={set("email")} /><input required={store.checkout.requirePhone} type="tel" className={field} placeholder="Phone" aria-label="Phone" autoComplete="tel" value={f.phone} onChange={set("phone")} /></div>
        </fieldset>
        {!quote?.allDigital && <fieldset className="space-y-2"><legend className="font-semibold mb-1">Delivery</legend>
          <div className="flex gap-4 text-sm">{sh.zones.length > 0 && <label className="flex items-center gap-2"><input type="radio" name="ful" checked={f.fulfilment === "DELIVERY"} onChange={() => setF((x) => ({ ...x, fulfilment: "DELIVERY" }))} />Deliver to me</label>}{sh.pickup && <label className="flex items-center gap-2"><input type="radio" name="ful" checked={f.fulfilment === "PICKUP"} onChange={() => setF((x) => ({ ...x, fulfilment: "PICKUP" }))} />Pick up</label>}</div>
          {f.fulfilment === "DELIVERY" ? <>
            <input required className={field} placeholder="Street address" aria-label="Street address" autoComplete="address-line1" value={f.line1} onChange={set("line1")} />
            <input className={field} placeholder="Apartment, area (optional)" aria-label="Address line 2" autoComplete="address-line2" value={f.line2} onChange={set("line2")} />
            <div className="grid sm:grid-cols-3 gap-2"><input required className={field} placeholder="City" aria-label="City" autoComplete="address-level2" value={f.city} onChange={set("city")} /><input className={field} placeholder="Region" aria-label="Region" value={f.region} onChange={set("region")} /><input className={field} placeholder="Postcode" aria-label="Postcode" autoComplete="postal-code" value={f.postcode} onChange={set("postcode")} /></div>
            <select className={field} aria-label="Country" value={f.country} onChange={set("country")}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
            <select className={field} aria-label="Delivery option" value={f.zoneId} onChange={set("zoneId")}>{sh.zones.map((z) => <option key={z.id} value={z.id}>{z.name}{z.etaText ? ` — ${z.etaText}` : ""}</option>)}</select>
            {zone?.windows?.length > 0 && <select className={field} aria-label="Delivery time" value={f.window} onChange={set("window")}><option value="">Any time</option>{zone.windows.map((w) => <option key={w}>{w}</option>)}</select>}
          </> : sh.pickup && <p className="text-sm text-slate-600">{sh.pickup.instructions || "We'll email you when your order is ready to collect."}</p>}
        </fieldset>}
        <fieldset className="space-y-2"><legend className="font-semibold mb-1">Payment</legend>
          {methods.map(([v, t]) => <label key={v} className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"><input type="radio" name="pay" checked={f.payment === v} onChange={() => setF((x) => ({ ...x, payment: v }))} />{t}</label>)}
          {f.payment === "BANK_TRANSFER" && <p className="text-xs text-slate-600">You'll see the bank details after placing the order. We hold your items while you pay.</p>}
          {["STRIPE", "SAFEPAY"].includes(f.payment) && <p className="text-xs text-slate-600">You'll pay on the provider's secure page. This shop never sees your card number.</p>}
        </fieldset>
        <textarea className={field} rows={2} placeholder="Note for the shop (optional)" aria-label="Order note" value={f.notes} onChange={set("notes")} />
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={f.terms} onChange={set("terms")} className="mt-1" required /><span>{store.checkout.termsText} <a href={L("/pages/terms")} target="_blank" className="underline">Terms</a> · <a href={L("/pages/privacy")} target="_blank" className="underline">Privacy</a></span></label>
      </div>
      <aside className="rounded-xl border border-slate-200 p-4 h-fit space-y-3 lg:sticky lg:top-4">
        <h2 className="font-semibold">Order summary</h2>
        <ul className="text-sm space-y-1">{(quote?.lines || []).map((l) => <li key={l.productId} className="flex justify-between gap-2"><span className="truncate">{l.quantity} × {l.name}</span><span>{money(l.total, store.currency)}</span></li>)}</ul>
        <Summary quote={quote} cur={store.currency} shippingKnown={f.fulfilment === "PICKUP" || !!quote?.zoneMatched} />
        {f.fulfilment === "DELIVERY" && quote && !quote.zoneMatched && f.city && <p className="text-xs text-amber-700">This delivery option doesn't cover {f.city}. Choose another option or pickup.</p>}
        {(err || msg) && <p className="text-sm text-red-600" role="alert">{msg || err}</p>}
        <button disabled={busy || !quote || preview || !methods.length} className="w-full rounded-full text-white font-semibold py-2.5 disabled:opacity-40" style={{ background: "var(--shop)" }}>{preview ? "Checkout is off in preview" : busy ? "Placing order…" : ["STRIPE", "SAFEPAY"].includes(f.payment) ? "Continue to payment" : "Place order"}</button>
      </aside>
    </form>
  );
}

function Order({ store, apiBase, orderNumber, token, paidFlag, cancelledFlag }) {
  const [o, setO] = useState(null); const [err, setErr] = useState(""); const tries = useRef(0);
  const load = useCallback(() => fetch(`${apiBase}/order/${encodeURIComponent(orderNumber)}?t=${encodeURIComponent(token)}`).then((r) => r.json()).then((j) => { if (j.error) setErr(j.error); else setO(j.order); }).catch(() => setErr("Couldn't load the order.")), [apiBase, orderNumber, token]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (o?.payment?.state === "AWAITING_PAYMENT" && paidFlag && tries.current < 10) { const t = setTimeout(() => { tries.current++; load(); }, 3000); return () => clearTimeout(t); } }, [o, paidFlag, load]);
  if (err) return <p className="text-red-600">{err}</p>; if (!o) return <p>Loading your order…</p>;
  const ps = o.payment?.state; const cur = o.currency;
  const headline = o.status === "CANCELLED" ? "This order was cancelled" : ps === "PAID" || ps === "PAID_ON_CHANNEL" ? "Thank you! Your payment was received." : ps === "AWAITING_PAYMENT" ? (cancelledFlag ? "Payment was cancelled" : paidFlag ? "Confirming your payment…" : "Waiting for payment") : "Thank you! We received your order.";
  return (
    <div className="max-w-2xl space-y-5">
      <div><h1 className="text-2xl font-bold">{headline}</h1><p className="text-slate-600">Order <b>{o.orderNumber}</b> · placed {new Date(o.placedAt).toLocaleString()}</p></div>
      {ps === "PENDING_BANK_TRANSFER" && o.status !== "CANCELLED" && <div className="rounded-xl border-2 p-4" style={{ borderColor: "var(--shop)" }}><p className="font-semibold">Please pay {money(o.total - o.paid, cur)} by bank transfer</p><p className="text-sm mt-1">Use <b>{o.orderNumber}</b> as the payment reference.</p><p className="whitespace-pre-wrap text-sm mt-2">{o.payment.instructions}</p>{o.payment.holdUntil && <p className="text-xs text-slate-500 mt-2">We hold your items until {new Date(o.payment.holdUntil).toLocaleString()}.</p>}</div>}
      {ps === "PAID_AFTER_CANCEL" && <p className="rounded-xl border-2 border-amber-500 p-3 text-sm">Your payment arrived after this order had expired. The shop has been alerted and will refund you or complete the order. You don't need to pay again.</p>}
      {ps === "COD_DUE" && <p className="rounded-xl bg-slate-100 p-3 text-sm">Please have {money(o.total, cur)} ready when your order arrives (cash on delivery).</p>}
      {ps === "AWAITING_PAYMENT" && cancelledFlag && <p className="text-sm">Your items are held for a short time. <button type="button" onClick={() => window.history.back()} className="underline">Go back to try again</button>, or contact the shop.</p>}
      <ul className="divide-y divide-slate-200 border-y border-slate-200 text-sm">{o.lines.map((l, i) => <li key={i} className="py-2 flex justify-between"><span>{l.quantity} × {l.description}</span><span>{money(l.total, cur)}</span></li>)}</ul>
      <div className="text-sm space-y-1">{o.shipping && <div className="flex justify-between"><span>{o.fulfilmentMethod === "PICKUP" ? "Pickup" : `Delivery${o.shipping.zone ? ` (${o.shipping.zone})` : ""}`}</span><span>{o.shipping.amount ? money(o.shipping.amount, cur) : "Free"}</span></div>}<div className="flex justify-between"><span>Tax</span><span>{money(o.tax, cur)}</span></div><div className="flex justify-between font-bold text-base"><span>Total</span><span>{money(o.total, cur)}</span></div>{o.paid > 0 && <div className="flex justify-between text-emerald-700"><span>Paid</span><span>{money(o.paid, cur)}</span></div>}</div>
      <p className="text-sm text-slate-600">Status: {o.stage ? o.stage.replace(/_/g, " ").toLowerCase() : o.status.toLowerCase()}{o.shipping?.trackingRef ? ` · tracking ${o.shipping.trackingRef}` : ""}</p>
      <p className="text-xs text-slate-500">Keep this page's link to check your order later. A confirmation was sent to your email.</p>
    </div>
  );
}
