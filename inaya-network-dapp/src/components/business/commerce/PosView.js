"use client";

// src/components/business/commerce/PosView.js -- Inaya Commerce: Point of Sale (Master SOW 6.3, 6.5, 6.10).
// Tabs: Register (sell), Sales (history, receipts, reprint), Approvals (supervisors/managers), Setup (managers).
// Every number shown in the cart comes from the server (POST price-preview); the register never computes prices itself.
// Barcode scanners work as keyboards: the search box keeps focus, and Enter on an exact barcode/SKU adds the item.
// Touch-friendly controls; keyboard: F2 search, F4 customer, F8 park, F9 pay, Esc closes dialogs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "min-h-[40px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] hover:border-[var(--inaya-accent)] disabled:opacity-40";
const primary = "min-h-[44px] px-4 rounded-lg text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] hover:brightness-110 disabled:opacity-40";
const field = "w-full min-h-[40px] rounded-lg border border-[var(--inaya-border)] bg-[var(--inaya-surface)] px-3 text-sm text-[var(--inaya-text-primary)]";
const money = (v, cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "PKR", minimumFractionDigits: Number.isInteger(v || 0) ? 0 : 2, maximumFractionDigits: 2 }).format(v || 0); } catch { return `${cur || ""} ${(v || 0).toFixed(2)}`; } };
const newKey = () => `pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;

async function api(path, { orgId, method = "GET", body } = {}) {
  const url = `/api/orgs/commerce/${path}${method === "GET" || method === "DELETE" ? `${path.includes("?") ? "&" : "?"}orgId=${orgId}` : ""}`;
  const r = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify({ orgId, ...body }) } : {}) });
  let d = {}; try { d = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { status: r.status, code: d.code, data: d });
  return d;
}

export default function PosView({ orgId }) {
  const [tab, setTab] = useState("register");
  const [settings, setSettings] = useState(null); const [role, setRole] = useState(null); const [blocked, setBlocked] = useState(null);
  useEffect(() => { api("settings", { orgId }).then((d) => { setSettings(d.settings); setRole(d.role); }).catch((e) => setBlocked(e)); }, [orgId]);
  if (blocked) return (
    <div className={`${card} p-6 max-w-xl`}>
      <h2 className="text-lg font-bold mb-2">Point of Sale</h2>
      <p className={muted}>{blocked.code === "COMMERCE_NOT_ENABLED" ? "Inaya Commerce is a paid add-on for the Business and Enterprise plans. Ask Inaya to enable it for your company." : blocked.code === "COMMERCE_ROLE" ? "You don't have a commerce role in this company. A manager can make you a cashier, supervisor or manager." : blocked.message}</p>
    </div>
  );
  if (!settings) return <p className={muted}>Loading…</p>;
  const tabs = [["register", "Register"], ["sales", "Sales"], ...(role !== "cashier" ? [["approvals", "Approvals"]] : []), ...(role === "manager" ? [["setup", "Setup"]] : [])];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? primary : btn} onClick={() => setTab(k)}>{l}</button>)}
        <span className={`ml-auto self-center text-xs ${muted}`}>Signed in as {role} · prices in {settings.currency} ({settings.taxMode === "inclusive" ? "tax included" : "tax added"})</span>
      </div>
      {tab === "register" && <Register orgId={orgId} settings={settings} />}
      {tab === "sales" && <Sales orgId={orgId} settings={settings} />}
      {tab === "approvals" && <Approvals orgId={orgId} settings={settings} />}
      {tab === "setup" && <Setup orgId={orgId} settings={settings} onSaved={setSettings} />}
    </div>
  );
}

// ================================================================= Register
function Register({ orgId, settings }) {
  const [products, setProducts] = useState(null); const [warehouses, setWarehouses] = useState([]); const [warehouseId, setWarehouseId] = useState("");
  const [q, setQ] = useState(""); const [category, setCategory] = useState(""); const [cart, setCart] = useState([]); const [orderDiscount, setOrderDiscount] = useState(null);
  const [customer, setCustomer] = useState(null); const [notes, setNotes] = useState(""); const [priced, setPriced] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState(null); const [parkedId, setParkedId] = useState(null); const searchRef = useRef(null);

  useEffect(() => {
    fetch(`/api/orgs/inventory/products?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => setProducts((d.products || []).filter((p) => p.status === "ACTIVE" && p.posVisible !== false))).catch(() => { setProducts([]); setErr("Could not load products."); });
    fetch(`/api/orgs/inventory/warehouses?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => { const w = d.warehouses || []; setWarehouses(w); try { const saved = localStorage.getItem(`pos:wh:${orgId}`); setWarehouseId(w.find((x) => x.id === saved)?.id || w[0]?.id || ""); } catch { setWarehouseId(w[0]?.id || ""); } }).catch(() => {});
  }, [orgId]);
  useEffect(() => { try { if (warehouseId) localStorage.setItem(`pos:wh:${orgId}`, warehouseId); } catch { /* ignore */ } }, [orgId, warehouseId]);

  const input = useMemo(() => ({ warehouseId, customerId: customer?.id || null, lines: cart.map((l) => ({ productId: l.productId, quantity: l.quantity, discount: l.discount || undefined, priceOverride: l.priceOverride ?? undefined, note: l.note || undefined })), orderDiscount: orderDiscount || undefined, notes }), [warehouseId, customer, cart, orderDiscount, notes]);
  // server-side pricing on every change (debounced)
  useEffect(() => {
    if (!cart.length || !warehouseId) { setPriced(null); return; }
    const t = setTimeout(() => api("price-preview", { orgId, method: "POST", body: input }).then((d) => { setPriced(d); setErr(""); }).catch((e) => setErr(e.message)), 250);
    return () => clearTimeout(t);
  }, [orgId, input, cart.length, warehouseId]);

  const categories = useMemo(() => [...new Set((products || []).map((p) => p.category).filter(Boolean))].sort(), [products]);
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase(); const byGroup = new Map();
    for (const p of products || []) {
      if (warehouseId && p.availableWarehouseIds?.length && !p.availableWarehouseIds.includes(warehouseId)) continue;
      if (category && p.category !== category) continue;
      if (s && !(p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s) || (p.barcode || "").toLowerCase() === s)) continue;
      const g = p.variantGroupId || p.id; byGroup.set(g, [...(byGroup.get(g) || []), p]);
    }
    return [...byGroup.values()].slice(0, 60);
  }, [products, q, category, warehouseId]);

  const add = useCallback((p) => {
    setCart((c) => { const i = c.findIndex((l) => l.productId === p.id && !l.priceOverride && !l.discount); if (i >= 0) { const n = [...c]; n[i] = { ...n[i], quantity: n[i].quantity + 1 }; return n; } return [...c, { productId: p.id, name: p.name, sku: p.sku, quantity: 1 }]; });
    setMsg(""); searchRef.current?.focus();
  }, []);
  const onScan = (e) => {
    if (e.key !== "Enter") return; const s = q.trim().toLowerCase(); if (!s) return;
    const hit = (products || []).find((p) => (p.barcode || "").toLowerCase() === s || p.sku.toLowerCase() === s);
    if (hit) { add(hit); setQ(""); } else if (visible.length === 1 && visible[0].length === 1) { add(visible[0][0]); setQ(""); } else setMsg(`No product with barcode or SKU "${q.trim()}".`);
  };
  const setLine = (i, patch) => setCart((c) => c.map((l, k) => (k === i ? { ...l, ...patch } : l)).filter((l) => l.quantity > 0));
  const clearSale = () => { setCart([]); setOrderDiscount(null); setCustomer(null); setNotes(""); setPriced(null); setParkedId(null); setErr(""); };
  useEffect(() => {
    const k = (e) => { if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); } if (e.key === "F4") { e.preventDefault(); setDialog({ type: "customer" }); } if (e.key === "F8" && cart.length) { e.preventDefault(); setDialog({ type: "park" }); } if (e.key === "F9" && priced) { e.preventDefault(); setDialog({ type: "pay" }); } if (e.key === "Escape") setDialog(null); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [cart.length, priced]);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className={`${card} p-3 space-y-3`}>
        <div className="flex flex-wrap gap-2">
          <input ref={searchRef} autoFocus aria-label="Search or scan" className={`${field} flex-1 min-w-[200px]`} placeholder="Search name or SKU, or scan a barcode (F2)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onScan} />
          <select aria-label="Location" className={`${field} !w-auto`} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </div>
        {categories.length > 0 && <div className="flex flex-wrap gap-2">{["", ...categories].map((c) => <button key={c || "all"} className={category === c ? primary : btn} onClick={() => setCategory(c)}>{c || "All"}</button>)}</div>}
        {msg && <p className="text-sm text-amber-600" role="status">{msg}</p>}
        {!products ? <p className={muted}>Loading products…</p> : !products.length ? <p className={muted}>No sellable products yet. Add products in Inventory.</p> : (
          <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
            {visible.map((group) => group.length > 1 ? (
              <button key={group[0].variantGroupId} className={`${card} p-3 text-left min-h-[84px] hover:border-[var(--inaya-accent)]`} onClick={() => setDialog({ type: "variant", group })}>
                <p className="font-semibold text-sm">{group[0].variantGroupName || group[0].name}</p><p className={`text-xs ${muted}`}>{group.length} options</p>
              </button>
            ) : (
              <button key={group[0].id} className={`${card} p-3 text-left min-h-[84px] hover:border-[var(--inaya-accent)]`} onClick={() => add(group[0])}>
                <p className="font-semibold text-sm">{group[0].name}</p><p className={`text-xs ${muted}`}>{group[0].sku}</p>
                <p className="text-sm font-bold mt-1">{group[0].unitPrice !== null ? money(group[0].unitPrice, settings.currency) : "No price"}</p>
                {group[0].productType === "STOCK" && <p className={`text-xs ${group[0].totalStock > 0 ? muted : "text-red-500"}`}>{group[0].totalStock} in stock</p>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`${card} p-3 flex flex-col gap-2`}>
        <div className="flex items-center gap-2">
          <button className={btn} onClick={() => setDialog({ type: "customer" })}>{customer ? `Customer: ${customer.name}` : "Guest sale · add customer (F4)"}</button>
          {customer && <button className={btn} aria-label="Remove customer" onClick={() => setCustomer(null)}>✕</button>}
          <button className={`${btn} ml-auto`} onClick={() => setDialog({ type: "parked" })}>Parked</button>
        </div>
        {!cart.length ? <p className={`${muted} py-8 text-center`}>Scan or tap a product to start a sale.</p> : (
          <ul className="divide-y divide-[var(--inaya-border)] max-h-[48vh] overflow-auto">
            {cart.map((l, i) => { const pl = priced?.lines?.[i]; return (
              <li key={i} className="py-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0"><p className="font-semibold text-sm truncate">{l.name}</p><p className={`text-xs ${muted}`}>{pl ? `${money(pl.unitPrice, settings.currency)} × ${l.quantity}${pl.priceSource === "override" ? " · price changed" : pl.priceSource === "customer" ? " · customer price" : pl.priceSource === "price_list" ? " · price list" : ""}` : l.sku}</p></div>
                  <button className={btn} aria-label="One less" onClick={() => setLine(i, { quantity: l.quantity - 1 })}>−</button>
                  <input aria-label="Quantity" className={`${field} !w-16 text-center`} inputMode="decimal" value={l.quantity} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) setLine(i, { quantity: v }); }} />
                  <button className={btn} aria-label="One more" onClick={() => setLine(i, { quantity: l.quantity + 1 })}>+</button>
                  <button className={btn} aria-label="Line options" onClick={() => setDialog({ type: "line", i })}>⋯</button>
                </div>
                {pl && <p className="text-right text-sm font-semibold">{pl.lineDiscount + pl.orderDiscountShare > 0 && <span className="text-emerald-600 mr-2">−{money(pl.lineDiscount + pl.orderDiscountShare, settings.currency)}</span>}{money(pl.total, settings.currency)}</p>}
                {l.note && <p className={`text-xs ${muted}`}>Note: {l.note}</p>}
              </li>); })}
          </ul>
        )}
        {err && <p className="text-sm text-red-500" role="alert">{err}</p>}
        {priced && (
          <div className="border-t border-[var(--inaya-border)] pt-2 text-sm space-y-1">
            <Row k="Subtotal" v={money(priced.totals.subtotal, settings.currency)} />
            {priced.totals.discounts > 0 && <Row k="Discounts" v={`−${money(priced.totals.discounts, settings.currency)}`} />}
            {priced.totals.taxBreakdown.map((t) => <Row key={`${t.category}${t.rate}`} k={`${t.name || "Tax"} ${t.rate}%${settings.taxMode === "inclusive" ? " (included)" : ""}`} v={money(t.tax, settings.currency)} />)}
            <Row k={<b>Total</b>} v={<b className="text-lg">{money(priced.totals.total, settings.currency)}</b>} />
            {priced.approvals.length > 0 && <p className="text-xs text-amber-600">Needs a {priced.approvals.some((a) => a.needed === "manager") ? "manager" : "supervisor"}'s approval before payment.</p>}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 mt-auto">
          <button className={btn} disabled={!cart.length} onClick={() => setDialog({ type: "orderDiscount" })}>Discount</button>
          <button className={btn} disabled={!cart.length} onClick={() => setDialog({ type: "park" })}>Park (F8)</button>
          <button className={btn} disabled={!cart.length} onClick={() => { if (window.confirm("Clear this sale?")) clearSale(); }}>Clear</button>
        </div>
        <textarea aria-label="Sale notes" className={`${field} min-h-[44px]`} placeholder="Sale note (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <button className={primary} disabled={!priced} onClick={() => setDialog({ type: "pay" })}>Pay {priced ? money(priced.totals.total, settings.currency) : ""} (F9)</button>
      </div>

      {dialog?.type === "variant" && <Modal title={dialog.group[0].variantGroupName || "Choose an option"} onClose={() => setDialog(null)}>
        <div className="grid grid-cols-2 gap-2">{dialog.group.map((p) => <button key={p.id} className={btn} onClick={() => { add(p); setDialog(null); }}>{Object.values(p.variantAttributes || {}).join(" / ") || p.name}<br /><span className={`text-xs ${muted}`}>{money(p.unitPrice, settings.currency)} · {p.totalStock} in stock</span></button>)}</div>
      </Modal>}
      {dialog?.type === "line" && <LineDialog line={cart[dialog.i]} settings={settings} onClose={() => setDialog(null)} onSave={(patch) => { setLine(dialog.i, patch); setDialog(null); }} onRemove={() => { setCart((c) => c.filter((_, k) => k !== dialog.i)); setDialog(null); }} />}
      {dialog?.type === "orderDiscount" && <DiscountDialog title="Discount on the whole sale" value={orderDiscount} onClose={() => setDialog(null)} onSave={(d) => { setOrderDiscount(d); setDialog(null); }} />}
      {dialog?.type === "customer" && <CustomerDialog orgId={orgId} onClose={() => setDialog(null)} onPick={(cst) => { setCustomer(cst); setDialog(null); }} />}
      {dialog?.type === "park" && <ParkDialog onClose={() => setDialog(null)} onPark={async (label) => { try { await api("parked", { orgId, method: "POST", body: { cart: input, label } }); clearSale(); setMsg("Sale parked."); } catch (e) { setErr(e.message); } setDialog(null); }} />}
      {dialog?.type === "parked" && <ParkedDialog orgId={orgId} onClose={() => setDialog(null)} onResume={(p) => { setCart(p.cart.lines.map((l) => ({ ...l, name: (products || []).find((x) => x.id === l.productId)?.name || "Item", sku: (products || []).find((x) => x.id === l.productId)?.sku || "" }))); setOrderDiscount(p.cart.orderDiscount || null); setNotes(p.cart.notes || ""); setParkedId(p.id); if (p.cart.warehouseId) setWarehouseId(p.cart.warehouseId); setDialog(null); }} />}
      {dialog?.type === "pay" && priced && <PayDialog orgId={orgId} settings={settings} input={{ ...input, parkedId: parkedId || undefined }} priced={priced} onClose={() => setDialog(null)} onDone={(sale) => { setDialog({ type: "receipt", saleId: sale.id }); clearSale(); }} />}
      {dialog?.type === "receipt" && <ReceiptDialog orgId={orgId} saleId={dialog.saleId} onClose={() => { setDialog(null); searchRef.current?.focus(); }} />}
    </div>
  );
}
const Row = ({ k, v }) => <div className="flex justify-between gap-2"><span>{k}</span><span>{v}</span></div>;

function Modal({ title, children, onClose, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-2" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={`${card} p-4 w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[90vh] overflow-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center mb-3"><h3 className="font-bold flex-1">{title}</h3><button className={btn} aria-label="Close" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  );
}
function DiscountDialog({ title, value, onSave, onClose }) {
  const [type, setType] = useState(value?.type || "percent"); const [v, setV] = useState(value?.value ?? "");
  return <Modal title={title} onClose={onClose}>
    <div className="flex gap-2 mb-2">{[["percent", "%"], ["amount", "Amount"]].map(([k, l]) => <button key={k} className={type === k ? primary : btn} onClick={() => setType(k)}>{l}</button>)}</div>
    <input className={field} inputMode="decimal" aria-label="Discount value" value={v} onChange={(e) => setV(e.target.value)} placeholder={type === "percent" ? "e.g. 10" : "e.g. 250"} />
    <p className={`text-xs ${muted} mt-1`}>Discounts above your limit need a supervisor's or manager's approval at payment.</p>
    <div className="flex gap-2 mt-3"><button className={primary} onClick={() => onSave(Number(v) > 0 ? { type, value: Number(v) } : null)}>Apply</button><button className={btn} onClick={() => onSave(null)}>Remove discount</button></div>
  </Modal>;
}
function LineDialog({ line, settings, onSave, onRemove, onClose }) {
  const [note, setNote] = useState(line.note || ""); const [price, setPrice] = useState(line.priceOverride ?? ""); const [disc, setDisc] = useState(line.discount || null); const [showDisc, setShowDisc] = useState(false);
  if (showDisc) return <DiscountDialog title={`Discount on ${line.name}`} value={disc} onClose={() => setShowDisc(false)} onSave={(d) => { setDisc(d); setShowDisc(false); }} />;
  return <Modal title={line.name} onClose={onClose}>
    <label className="text-sm">Note for this item<textarea className={field} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    {settings.allowPriceOverride !== "never" && <label className="text-sm block mt-2">Change price (needs a {settings.allowPriceOverride} if you aren't one)<input className={field} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Leave empty to use the normal price" /></label>}
    <button className={`${btn} mt-2`} onClick={() => setShowDisc(true)}>{disc ? `Discount: ${disc.type === "percent" ? `${disc.value}%` : disc.value}` : "Add a discount"}</button>
    <div className="flex gap-2 mt-3"><button className={primary} onClick={() => onSave({ note, priceOverride: price === "" ? undefined : Number(price), discount: disc || undefined })}>Save</button><button className={btn} onClick={onRemove}>Remove item</button></div>
  </Modal>;
}
function CustomerDialog({ orgId, onPick, onClose }) {
  const [q, setQ] = useState(""); const [list, setList] = useState([]);
  useEffect(() => { fetch(`/api/orgs/crm/contacts?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => setList(d.contacts || [])).catch(() => {}); }, [orgId]);
  const s = q.trim().toLowerCase(); const shown = list.filter((x) => !s || (x.name || "").toLowerCase().includes(s) || (x.email || "").toLowerCase().includes(s) || (x.phone || "").includes(s)).slice(0, 30);
  return <Modal title="Customer" onClose={onClose}>
    <input autoFocus className={field} placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} />
    <ul className="mt-2 divide-y divide-[var(--inaya-border)]">{shown.map((x) => <li key={x.id}><button className="w-full text-left py-2 text-sm" onClick={() => onPick({ id: x.id, name: x.name })}>{x.name}<span className={`ml-2 ${muted}`}>{x.email || x.phone || ""}</span></button></li>)}</ul>
    {!shown.length && <p className={muted}>No matching customers. Add them in Customers.</p>}
  </Modal>;
}
function ParkDialog({ onPark, onClose }) {
  const [label, setLabel] = useState("");
  return <Modal title="Park this sale" onClose={onClose}><input autoFocus className={field} placeholder="Label, e.g. customer name" value={label} onChange={(e) => setLabel(e.target.value)} /><button className={`${primary} mt-3`} onClick={() => onPark(label)}>Park</button></Modal>;
}
function ParkedDialog({ orgId, onResume, onClose }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => api("parked", { orgId }).then((d) => setList(d.parked)).catch(() => setList([])), [orgId]);
  useEffect(() => { load(); }, [load]);
  return <Modal title="Parked sales" onClose={onClose}>
    {!list ? <p className={muted}>Loading…</p> : !list.length ? <p className={muted}>Nothing parked.</p> : <ul className="divide-y divide-[var(--inaya-border)]">{list.map((p) => <li key={p.id} className="py-2 flex items-center gap-2"><span className="flex-1 text-sm">{p.label || "Unnamed"} · {p.lines} item(s)<br /><span className={`text-xs ${muted}`}>{p.parkedBy} · {new Date(p.createdAt).toLocaleString()}</span></span><button className={btn} onClick={() => onResume(p)}>Resume</button><button className={btn} onClick={async () => { await api(`parked/${p.id}`, { orgId, method: "DELETE" }); load(); }}>Discard</button></li>)}</ul>}
  </Modal>;
}
function PayDialog({ orgId, settings, input, priced, onDone, onClose }) {
  const total = priced.totals.total; const cashTotal = priced.totals.cashTotal ?? total; const [tenders, setTenders] = useState([{ method: "CASH", amount: String(cashTotal), reference: "" }]); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [approval, setApproval] = useState(null); const keyRef = useRef(newKey());
  const sum = tenders.reduce((s, t) => s + (Number(t.amount) || 0), 0); const cash = tenders.filter((t) => t.method === "CASH").reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const due = cash > 0 ? cashTotal : total; const change = Math.max(0, Math.round((sum - due) * 100) / 100);
  const needsApproval = priced.approvals.length > 0;
  const askApproval = async () => { setErr(""); try { const r = await api("approvals", { orgId, method: "POST", body: { cart: input } }); setApproval({ id: r.approvalId, status: "PENDING", needed: r.needed }); } catch (e) { setErr(e.message); } };
  useEffect(() => { if (approval?.status !== "PENDING") return; const t = setInterval(() => api(`approvals/${approval.id}`, { orgId }).then((d) => setApproval((a) => ({ ...a, status: d.status, by: d.decidedBy }))).catch(() => {}), 3000); return () => clearInterval(t); }, [orgId, approval?.id, approval?.status]);
  const complete = async () => {
    setBusy(true); setErr("");
    try { const r = await api("sales", { orgId, method: "POST", body: { ...input, idempotencyKey: keyRef.current, approvalId: approval?.status === "APPROVED" ? approval.id : undefined, tenders: tenders.filter((t) => Number(t.amount) > 0).map((t) => ({ method: t.method, amount: Number(t.amount), reference: t.reference || undefined })) } }); onDone(r.sale); }
    catch (e) { setErr(e.message); if (e.code !== "APPROVAL_REQUIRED" && e.code !== "APPROVAL_INVALID" && e.status >= 400 && e.status < 500 && e.code !== "UNDERPAID" && e.code !== "OVERPAID") keyRef.current = newKey(); }
    finally { setBusy(false); }
  };
  return <Modal title={`Payment · ${money(total, settings.currency)}`} onClose={onClose}>
    {needsApproval && approval?.status !== "APPROVED" && <div className="mb-3 text-sm">
      <p className="text-amber-600 mb-2">This sale has a discount or price change above your limit. A {priced.approvals.some((a) => a.needed === "manager") ? "manager" : "supervisor"} must approve it from their own device (Point of Sale → Approvals).</p>
      {!approval ? <button className={btn} onClick={askApproval}>Request approval</button> : <p className={muted}>{approval.status === "PENDING" ? "Waiting for approval…" : approval.status === "REJECTED" ? "The request was rejected." : approval.status === "EXPIRED" ? "The request expired; ask again." : approval.status}</p>}
    </div>}
    {approval?.status === "APPROVED" && <p className="text-emerald-600 text-sm mb-2">Approved by {approval.by}.</p>}
    {tenders.map((t, i) => <div key={i} className="grid grid-cols-[1fr_1fr] gap-2 mb-2">
      <select aria-label="Payment method" className={field} value={t.method} onChange={(e) => setTenders((x) => x.map((y, k) => (k === i ? { ...y, method: e.target.value } : y)))}>
        <option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="MANUAL_REFERENCE">Other (reference)</option>
      </select>
      <input aria-label="Amount" className={field} inputMode="decimal" value={t.amount} onChange={(e) => setTenders((x) => x.map((y, k) => (k === i ? { ...y, amount: e.target.value } : y)))} />
      {t.method !== "CASH" && <input aria-label="Reference" className={`${field} col-span-2`} placeholder="Reference (bank / NayaPay transaction id)" value={t.reference} onChange={(e) => setTenders((x) => x.map((y, k) => (k === i ? { ...y, reference: e.target.value } : y)))} />}
    </div>)}
    <div className="flex gap-2 mb-2"><button className={btn} onClick={() => setTenders((x) => [...x, { method: "BANK_TRANSFER", amount: String(Math.max(0, Math.round((total - sum) * 100) / 100)), reference: "" }])}>Split payment</button>
      {[500, 1000, 5000].map((v) => <button key={v} className={btn} onClick={() => setTenders((x) => x.map((y, k) => (k === 0 && y.method === "CASH" ? { ...y, amount: String(v) } : y)))}>{v}</button>)}</div>
    {cash > 0 && cashTotal !== total && <p className="text-sm">Cash total after rounding: <b>{money(cashTotal, settings.currency)}</b></p>}
    <p className="text-sm">Paid {money(sum, settings.currency)}{cash > 0 && change > 0 ? ` · change ${money(change, settings.currency)}` : ""}</p>
    <p className={`text-xs ${muted}`}>Payments are recorded manually; no card is charged.{settings.rounding.cashIncrement ? " Cash is rounded to the nearest " + money(settings.rounding.cashIncrement / 100, settings.currency) + "." : ""}</p>
    {err && <p className="text-sm text-red-500 mt-2" role="alert">{err}</p>}
    <button className={`${primary} w-full mt-3`} disabled={busy || (needsApproval && approval?.status !== "APPROVED")} onClick={complete}>{busy ? "Completing…" : "Complete sale"}</button>
  </Modal>;
}
function ReceiptDialog({ orgId, saleId, onClose }) {
  const [r, setR] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { api(`sales/${saleId}/receipt`, { orgId }).then((d) => setR(d.receipt)).catch((e) => setErr(e.message)); }, [orgId, saleId]);
  return <Modal title="Sale complete" onClose={onClose}>
    {err && <p className="text-red-500">{err}</p>}
    {r && <><Receipt r={r} /><div className="flex gap-2 mt-3 print:hidden"><button className={primary} onClick={() => printReceipt(r)}>Print receipt</button><button className={btn} onClick={onClose}>New sale</button></div></>}
  </Modal>;
}
export function Receipt({ r }) {
  return <div className="font-mono text-xs space-y-1" id="pos-receipt">
    <p className="text-center font-bold">{r.company}</p><p className="text-center">{r.location}</p>
    <p className="text-center">{r.saleNumber} · {new Date(r.completedAt).toLocaleString()}</p><hr />
    {r.lines.map((l, i) => <div key={i}><div className="flex justify-between"><span>{l.name}</span><span>{money(l.total, r.currency)}</span></div><div className="text-[10px]">{l.quantity} × {money(l.unitPrice, r.currency)}{l.discount ? ` · −${money(l.discount, r.currency)}` : ""}{l.taxRate ? ` · ${l.taxCategory || "tax"} ${l.taxRate}%` : ""}</div></div>)}<hr />
    <div className="flex justify-between"><span>Subtotal</span><span>{money(r.totals.subtotal, r.currency)}</span></div>
    {r.totals.discounts > 0 && <div className="flex justify-between"><span>Discounts</span><span>−{money(r.totals.discounts, r.currency)}</span></div>}
    {r.totals.taxBreakdown.map((t) => <div key={`${t.category}${t.rate}`} className="flex justify-between"><span>{t.name || "Tax"} {t.rate}% on {money(t.taxable, r.currency)}</span><span>{money(t.tax, r.currency)}</span></div>)}
    <div className="flex justify-between font-bold"><span>TOTAL</span><span>{money(r.totals.total, r.currency)}</span></div>
    {r.tenders.map((t, i) => <div key={i} className="flex justify-between"><span>{t.method === "CASH" ? "Cash" : t.method === "BANK_TRANSFER" ? "Bank transfer" : "Other"}{t.reference ? ` (${t.reference})` : ""} · recorded manually</span><span>{money(t.amount, r.currency)}</span></div>)}
    {r.cashRounding ? <div className="flex justify-between"><span>Cash rounding</span><span>{money(r.cashRounding, r.currency)}</span></div> : null}
    {r.change > 0 && <div className="flex justify-between"><span>Change</span><span>{money(r.change, r.currency)}</span></div>}
    <hr /><p>{r.returnPolicy}</p>{r.footer && <p>{r.footer}</p>}
  </div>;
}
export function printReceipt(r) {
  const el = document.getElementById("pos-receipt"); const w = window.open("", "_blank", "width=380,height=640"); if (!w || !el) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${r.saleNumber}</title><style>body{font:12px/1.4 ui-monospace,Consolas,monospace;margin:8px;width:72mm} .flex{display:flex} .justify-between{justify-content:space-between} .text-center{text-align:center} .font-bold{font-weight:700} hr{border:0;border-top:1px dashed #000} p{margin:2px 0}</style></head><body>${el.innerHTML}</body></html>`);
  w.document.close(); w.focus(); w.print();
}

// ================================================================= Sales history
function Sales({ orgId, settings }) {
  const [sales, setSales] = useState(null); const [q, setQ] = useState(""); const [open, setOpen] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { api("sales", { orgId }).then((d) => setSales(d.sales)).catch((e) => setErr(e.message)); }, [orgId]);
  const find = async () => { setErr(""); try { const d = await api(`sales/by-number/${encodeURIComponent(q.trim())}`, { orgId }); setOpen(d.sale.id); } catch (e) { setErr(e.message); } };
  return <div className={`${card} p-3 space-y-2`}>
    <div className="flex gap-2"><input className={field} placeholder="Find by receipt number, e.g. S-000123" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find()} /><button className={btn} onClick={find}>Find</button></div>
    {err && <p className="text-red-500 text-sm">{err}</p>}
    {!sales ? <p className={muted}>Loading…</p> : !sales.length ? <p className={muted}>No sales yet.</p> : <table className="w-full text-sm"><thead><tr className={`text-left ${muted}`}><th>Receipt</th><th>Time</th><th>Cashier</th><th className="text-right">Total</th><th /></tr></thead>
      <tbody>{sales.map((s) => <tr key={s.id} className="border-t border-[var(--inaya-border)]"><td>{s.saleNumber}</td><td>{new Date(s.completedAt).toLocaleString()}</td><td>{s.cashier}</td><td className="text-right">{money(s.totals.total, s.currency)}{s.refunded ? <span className="text-amber-600 text-xs"> (refunded {money(s.refunded, s.currency)})</span> : null}</td><td className="text-right"><button className={btn} onClick={() => setOpen(s.id)}>Receipt</button></td></tr>)}</tbody></table>}
    {open && <ReceiptDialog orgId={orgId} saleId={open} onClose={() => setOpen(null)} />}
  </div>;
}

// ================================================================= Approvals (supervisors / managers)
function Approvals({ orgId, settings }) {
  const [list, setList] = useState(null); const [err, setErr] = useState("");
  const load = useCallback(() => api("approvals", { orgId }).then((d) => setList(d.approvals)).catch((e) => setErr(e.message)), [orgId]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  const decide = async (id, approve) => { const reason = window.prompt(approve ? "Reason (optional)" : "Why is this rejected?") ?? ""; try { await api(`approvals/${id}/decide`, { orgId, method: "POST", body: { approve, reason } }); load(); } catch (e) { setErr(e.message); } };
  return <div className={`${card} p-3`}>
    <p className={`text-sm ${muted} mb-2`}>Discounts and price changes above a cashier's limit wait here. You cannot approve your own request.</p>
    {err && <p className="text-red-500 text-sm">{err}</p>}
    {!list ? <p className={muted}>Loading…</p> : !list.length ? <p className={muted}>Nothing waiting.</p> : list.map((a) => <div key={a.id} className="border-t border-[var(--inaya-border)] py-2">
      <p className="text-sm font-semibold">{a.requestedBy} · {money(a.total, a.currency)} · needs a {a.needed}</p>
      <ul className="text-xs list-disc ml-5">{a.items.map((x, i) => <li key={i}>{x.kind === "price_override" ? `Price changed ${x.from ?? "-"} → ${x.to}` : `${x.kind === "sale_discount" ? "Whole-sale" : "Line"} discount ${x.percent}%`}</li>)}</ul>
      <div className="flex gap-2 mt-1"><button className={primary} onClick={() => decide(a.id, true)}>Approve</button><button className={btn} onClick={() => decide(a.id, false)}>Reject</button></div>
    </div>)}
  </div>;
}

function SetPrice({ orgId, lists, run }) {
  const [products, setProducts] = useState([]); const [contacts, setContacts] = useState([]);
  const [f, setF] = useState({ target: "list", priceListId: "", customerId: "", productId: "", price: "" });
  useEffect(() => {
    fetch(`/api/orgs/inventory/products?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => setProducts(d.products || [])).catch(() => {});
    fetch(`/api/orgs/crm/contacts?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => setContacts(d.contacts || [])).catch(() => {});
  }, [orgId]);
  const body = () => ({ productId: f.productId, price: f.price === "" ? null : Number(f.price), ...(f.target === "list" ? { priceListId: f.priceListId } : { customerId: f.customerId }) });
  return <div className="border-t border-[var(--inaya-border)] pt-2 space-y-2">
    <p className="text-sm font-semibold">Set a special price</p>
    <div className="flex gap-2">{[["list", "For a price list"], ["customer", "For one customer"]].map(([k, l]) => <button key={k} className={f.target === k ? primary : btn} onClick={() => setF({ ...f, target: k })}>{l}</button>)}</div>
    {f.target === "list"
      ? <select aria-label="Price list" className={field} value={f.priceListId} onChange={(e) => setF({ ...f, priceListId: e.target.value })}><option value="">Choose a price list</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
      : <select aria-label="Customer" className={field} value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">Choose a customer</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    <select aria-label="Product" className={field} value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}><option value="">Choose a product</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku}) · normal {p.unitPrice ?? "-"}</option>)}</select>
    <input aria-label="Special price" className={field} inputMode="decimal" placeholder="Price (leave empty to remove the special price)" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
    <button className={btn} disabled={!f.productId || !(f.priceListId || f.customerId)} onClick={() => run(() => api("prices", { orgId, method: "PUT", body: body() }), f.price === "" ? "Special price removed." : "Special price saved.")}>Save price</button>
  </div>;
}

// ================================================================= Setup (managers)
function Setup({ orgId, settings, onSaved }) {
  const [s, setS] = useState(settings); const [taxes, setTaxes] = useState([]); const [lists, setLists] = useState([]); const [staff, setStaff] = useState([]); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const load = useCallback(() => { api("tax-categories", { orgId }).then((d) => setTaxes(d.categories)); api("price-lists", { orgId }).then((d) => setLists(d.priceLists)); api("staff", { orgId }).then((d) => setStaff(d.staff)).catch(() => {}); }, [orgId]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, ok) => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); load(); } catch (e) { setErr(e.message); } };
  const [tax, setTax] = useState({ code: "", name: "", rate: "", isDefault: false }); const [pl, setPl] = useState({ code: "", name: "" });
  return <div className="grid gap-3 lg:grid-cols-2">
    {(msg || err) && <p className={`lg:col-span-2 text-sm ${err ? "text-red-500" : "text-emerald-600"}`}>{err || msg}</p>}
    <div className={`${card} p-3 space-y-2`}><h3 className="font-bold">Register settings</h3>
      <label className="text-sm block">Currency<select className={field} value={s.currency} onChange={(e) => setS({ ...s, currency: e.target.value })}>{["PKR", "GBP", "USD", "AED", "EUR", "INR", "BDT"].map((c) => <option key={c}>{c}</option>)}</select></label>
      <label className="text-sm block">Shelf prices<select className={field} value={s.taxMode} onChange={(e) => setS({ ...s, taxMode: e.target.value })}><option value="exclusive">exclude tax (tax added at the till)</option><option value="inclusive">include tax</option></select></label>
      <label className="text-sm block">Cashier discount limit (%)<input className={field} inputMode="decimal" value={s.discountLimits.cashierPercent} onChange={(e) => setS({ ...s, discountLimits: { ...s.discountLimits, cashierPercent: Number(e.target.value) } })} /></label>
      <label className="text-sm block">Supervisor discount limit (%)<input className={field} inputMode="decimal" value={s.discountLimits.supervisorPercent} onChange={(e) => setS({ ...s, discountLimits: { ...s.discountLimits, supervisorPercent: Number(e.target.value) } })} /></label>
      <label className="text-sm block">Who may change a price<select className={field} value={s.allowPriceOverride} onChange={(e) => setS({ ...s, allowPriceOverride: e.target.value })}><option value="never">nobody</option><option value="supervisor">supervisors and managers</option><option value="manager">managers only</option></select></label>
      <label className="text-sm block">Cash rounding<select className={field} value={s.rounding.cashIncrement} onChange={(e) => setS({ ...s, rounding: { ...s.rounding, cashIncrement: Number(e.target.value) } })}><option value={0}>none</option><option value={100}>nearest 1</option><option value={500}>nearest 5</option><option value={1000}>nearest 10</option></select></label>
      <label className="text-sm block">Return policy (days)<input className={field} inputMode="numeric" value={s.returnPolicy.days} onChange={(e) => setS({ ...s, returnPolicy: { ...s.returnPolicy, days: Number(e.target.value) } })} /></label>
      <label className="text-sm block">Return policy text (printed on receipts)<textarea className={field} value={s.returnPolicy.text} onChange={(e) => setS({ ...s, returnPolicy: { ...s.returnPolicy, text: e.target.value } })} /></label>
      <label className="text-sm block">Receipt footer<textarea className={field} value={s.receiptFooter} onChange={(e) => setS({ ...s, receiptFooter: e.target.value })} /></label>
      <button className={primary} onClick={() => run(async () => { const d = await api("settings", { orgId, method: "PUT", body: s }); onSaved(d.settings); }, "Settings saved.")}>Save settings</button>
    </div>
    <div className="space-y-3">
      <div className={`${card} p-3 space-y-2`}><h3 className="font-bold">Tax categories</h3>
        <ul className="text-sm">{taxes.map((t) => <li key={t.id}>{t.code} · {t.name} · {t.rate}%{t.isDefault ? " (default)" : ""}{t.locationRates.length ? ` · ${t.locationRates.length} location rate(s)` : ""}</li>)}</ul>
        <div className="grid grid-cols-3 gap-2"><input className={field} placeholder="Code" value={tax.code} onChange={(e) => setTax({ ...tax, code: e.target.value })} /><input className={field} placeholder="Name" value={tax.name} onChange={(e) => setTax({ ...tax, name: e.target.value })} /><input className={field} placeholder="Rate %" inputMode="decimal" value={tax.rate} onChange={(e) => setTax({ ...tax, rate: e.target.value })} /></div>
        <label className="text-sm"><input type="checkbox" checked={tax.isDefault} onChange={(e) => setTax({ ...tax, isDefault: e.target.checked })} /> default category</label>
        <button className={btn} onClick={() => run(() => api("tax-categories", { orgId, method: "POST", body: { ...tax, rate: Number(tax.rate) } }), "Tax category saved.")}>Add tax category</button>
      </div>
      <div className={`${card} p-3 space-y-2`}><h3 className="font-bold">Price lists</h3>
        <ul className="text-sm">{lists.map((l) => <li key={l.id}>{l.code} · {l.name} · {l.currency}</li>)}</ul>
        <div className="grid grid-cols-2 gap-2"><input className={field} placeholder="Code" value={pl.code} onChange={(e) => setPl({ ...pl, code: e.target.value })} /><input className={field} placeholder="Name" value={pl.name} onChange={(e) => setPl({ ...pl, name: e.target.value })} /></div>
        <button className={btn} onClick={() => run(() => api("price-lists", { orgId, method: "POST", body: pl }), "Price list saved.")}>Add price list</button>
        <SetPrice orgId={orgId} lists={lists} run={run} />
      </div>
      <div className={`${card} p-3 space-y-2`}><h3 className="font-bold">Staff</h3>
        <ul className="text-sm divide-y divide-[var(--inaya-border)]">{staff.map((m) => <li key={m.email} className="py-1 flex items-center gap-2"><span className="flex-1">{m.email}</span>
          {m.orgRole === "owner" || m.orgRole === "admin" ? <span className={muted}>manager (owner/admin)</span> : <select aria-label={`Commerce role for ${m.email}`} className={`${field} !w-auto`} value={m.commerceRole || ""} onChange={(e) => run(() => api("staff", { orgId, method: "PUT", body: { email: m.email, commerceRole: e.target.value || null } }), "Role saved.")}><option value="">no access</option><option value="cashier">cashier</option><option value="supervisor">supervisor</option><option value="manager">manager</option></select>}
        </li>)}</ul>
      </div>
    </div>
  </div>;
}
