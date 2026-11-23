"use client";

// src/components/business/SalesOrdersTab.js
//
// Sales (wholesale) orders inside the Sales/CRM module, backed by
// /api/orgs/sales/orders (src/lib/sales-orders.js): create an order for a
// customer from the dispatching warehouse's products, then confirm (checks
// stock), dispatch (stock leaves, batches earliest-expiry-first) and raise
// the invoice.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import Modal from "./ui/Modal";
import StatusBadge from "./ui/StatusBadge";
import { SUPPORTED_CURRENCIES } from "../../lib/currency.js";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const field = "w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]";
const money = (cur, n) => `${cur} ${Number(n || 0).toFixed(2)}`;
// Order lifecycle (Inaya Commerce Master SOW 6.9) -- the server (src/lib/sales-orders.js) enforces every step; this
// only offers the steps that make sense for the order's status and stage.
function actionsFor(o) {
  const inv = !o.invoiceId; const stage = o.stage || "RESERVED"; const pickup = o.fulfilmentMethod === "PICKUP";
  switch (o.status) {
    case "QUOTE": return [["accept", "Customer accepted"], ["cancel", "Cancel quote"]];
    case "DRAFT": return [["confirm", "Confirm and reserve stock"], ["confirm-backorder", "Confirm with backorder"], ["cancel", "Cancel"]];
    case "BACKORDERED": return [["reserve", "Reserve stock that arrived"], ...(inv ? [["invoice", "Create invoice"]] : []), ["cancel", "Cancel"]];
    case "CONFIRMED": return [
      ...(stage === "RESERVED" ? [["pick", "Start picking"]] : []), ...(stage === "PICKING" ? [["pack", "Packed"]] : []),
      ...(stage === "PACKED" && pickup ? [["ready", "Ready for pickup"]] : []),
      ["fulfil", pickup ? "Customer collected" : "Dispatch"], ...(inv ? [["invoice", "Create invoice"]] : []), ...(inv ? [["cancel", "Cancel"]] : [])];
    case "FULFILLED": case "INVOICED": return [...(o.stage === "DISPATCHED" ? [["deliver", "Mark delivered"]] : []), ...(inv ? [["invoice", "Create invoice"]] : [])];
    default: return [];
  }
}
const STATUS_LABEL = { FULFILLED: "DISPATCHED", BACKORDERED: "BACKORDER" };
const STAGE_LABEL = { RESERVED: "stock reserved", PICKING: "picking", PACKED: "packed", READY_FOR_PICKUP: "ready for pickup", DISPATCHED: "dispatched", COLLECTED: "collected", DELIVERED: "delivered" };
const PAY_LABEL = { UNPAID: "unpaid", PART_PAID: "part-paid", PAID: "paid" };

export default function SalesOrdersTab({ orgId, departments, openCreateSignal = 0 }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("");
  useEffect(() => { if (openCreateSignal) setShowCreate(true); }, [openCreateSignal]);

  const load = useCallback(async () => {
    try {
      setOrders((await api(`/api/orgs/sales/orders?orgId=${orgId}${status ? `&status=${status}` : ""}`)).orders);
    } catch (err) { setError(err.message); }
  }, [orgId, status]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {["", "QUOTE", "DRAFT", "CONFIRMED", "BACKORDERED", "FULFILLED", "INVOICED", "RETURNED", "CANCELLED"].map((s) => (
          <button key={s || "all"} onClick={() => setStatus(s)} className={`text-[12px] font-semibold px-3 py-1.5 rounded-full border ${status === s ? "bg-[#00f2fe]/15 text-[#00f2fe] border-[#00f2fe]/30" : "bg-black/45 text-[var(--inaya-text-muted)] border-white/15"}`}>{s ? ((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())(String(STATUS_LABEL[s] || s)) : "All"}</button>
        ))}
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New order</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!orders ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : orders.length === 0 ? (
          <EmptyState compact icon="🧾" description="No sales orders yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {orders.map((o) => (
              <button key={o.id} onClick={() => setSelected(o)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{o.customerName || "Customer"}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{o.orderNumber} · {o.lines.length} line{o.lines.length === 1 ? "" : "s"} · from {o.warehouseName}{o.deliveryDate ? ` · deliver ${o.deliveryDate}` : ""}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{money(o.currency, o.total)}</span>
                  {o.status !== "QUOTE" && o.status !== "CANCELLED" && <span className={`text-[11px] font-bold uppercase ${o.paymentStatus === "PAID" ? "text-emerald-400" : o.paymentStatus === "PART_PAID" ? "text-amber-400" : "text-[var(--inaya-text-muted)]"}`}>{PAY_LABEL[o.paymentStatus]}</span>}
                  {o.stage && <span className="text-[11px] text-[var(--inaya-text-muted)]">{STAGE_LABEL[o.stage]}</span>}
                  <StatusBadge status={STATUS_LABEL[o.status] || o.status} />
                  {o.invoiceId && o.status !== "INVOICED" && <span className="text-[11px] font-bold uppercase text-[#00f2fe]">invoiced</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateOrderModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <OrderDetailModal orgId={orgId} order={selected} onClose={() => setSelected(null)} onChanged={(o) => { setSelected(o); load(); }} />}
    </div>
  );
}

function CreateOrderModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [contacts, setContacts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [products, setProducts] = useState([]);
  const [contactId, setContactId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [asQuote, setAsQuote] = useState(false); const [validUntil, setValidUntil] = useState(""); const [method, setMethod] = useState("DELIVERY");
  const [lines, setLines] = useState([{ productId: "", quantity: "", unitPrice: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setContactId(""); setWarehouseId(""); setContacts([]); setWarehouses([]); setProducts([]);
    if (!departmentId) return;
    Promise.all([
      api(`/api/orgs/crm/contacts?orgId=${orgId}&departmentId=${departmentId}`),
      api(`/api/orgs/inventory/warehouses?orgId=${orgId}&departmentId=${departmentId}`),
      api(`/api/orgs/inventory/products?orgId=${orgId}`),
    ]).then(([c, w, p]) => {
      setContacts((c.contacts || []).filter((x) => x.type !== "LEAD"));
      setWarehouses(w.warehouses || []);
      setProducts((p.products || []).filter((x) => x.departmentId === departmentId && x.status !== "DISCONTINUED"));
    }).catch((err) => setError(err.message));
  }, [orgId, departmentId]);

  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const next = { ...l, [k]: v };
    if (k === "productId") { const p = products.find((x) => x.id === v); if (p && p.unitPrice != null && l.unitPrice === "") next.unitPrice = String(p.unitPrice); }
    return next;
  }));
  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);
  const ready = departmentId && contactId && warehouseId && lines.every((l) => l.productId && Number(l.quantity) > 0 && l.unitPrice !== "" && Number(l.unitPrice) >= 0);

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true); setError("");
    try {
      await api("/api/orgs/sales/orders", { method: "POST", body: JSON.stringify({ orgId, departmentId, contactId, warehouseId, currency, deliveryDate: deliveryDate || undefined, quote: asQuote, validUntil: asQuote && validUntil ? validUntil : undefined, fulfilmentMethod: method, notes: notes.trim() || undefined, lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })) }) });
      onCreated();
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  }

  return (
    <Modal title="New sales order" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <select aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={field}>
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select aria-label="Customer" value={contactId} onChange={(e) => setContactId(e.target.value)} disabled={!departmentId} className={`${field} disabled:opacity-40`}>
          <option value="">Customer…</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.company || c.name}{c.company && c.name ? ` (${c.name})` : ""}</option>)}
        </select>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <select aria-label="Ship from warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} disabled={!departmentId} className={`${field} disabled:opacity-40`}>
            <option value="">Ship from warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={field}>
            {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <select aria-label="Fulfilment" value={method} onChange={(e) => setMethod(e.target.value)} className={field}><option value="DELIVERY">We deliver</option><option value="PICKUP">Customer picks up</option></select>
          <label className="text-[11px] text-[var(--inaya-text-muted)] flex items-center gap-2"><input type="checkbox" checked={asQuote} onChange={(e) => setAsQuote(e.target.checked)} /> Send as a quote first</label>
        </div>
        {asQuote && <label className="text-[11px] text-[var(--inaya-text-muted)] flex items-center gap-2">Quote valid until<input type="date" aria-label="Quote valid until" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className={`${field} flex-1`} /></label>}
        <label className="text-[11px] text-[var(--inaya-text-muted)] flex items-center gap-2">Deliver by (optional)
          <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} className={`${field} flex-1`} />
        </label>

        <div className="space-y-2 border-t border-white/5 pt-3">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Products</p>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_70px_90px_auto] gap-1.5 items-center">
              <select aria-label="Product" value={l.productId} onChange={(e) => setLine(i, "productId", e.target.value)} disabled={!departmentId} className={`${field} disabled:opacity-40`}>
                <option value="">Product…</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.totalStock} in stock)</option>)}
              </select>
              <input aria-label="Quantity" type="number" min="0" step="any" value={l.quantity} onChange={(e) => setLine(i, "quantity", e.target.value)} placeholder="Qty" className={field} />
              <input aria-label="Unit price" type="number" min="0" step="any" value={l.unitPrice} onChange={(e) => setLine(i, "unitPrice", e.target.value)} placeholder="Price" className={field} />
              <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1} className="text-[var(--inaya-text-muted)] hover:text-red-400 disabled:opacity-30 text-lg leading-none">×</button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setLines((ls) => [...ls, { productId: "", quantity: "", unitPrice: "" }])} className="text-[11px] font-bold uppercase text-[#00f2fe]">+ Add line</button>
            <p className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">Total: {money(currency, total)}</p>
          </div>
        </div>
        <input aria-label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className={field} />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !ready} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : asQuote ? "Create quote" : "Create draft order"}</button>
      </form>
    </Modal>
  );
}

function OrderDetailModal({ orgId, order, onClose, onChanged }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [panel, setPanel] = useState(null);
  const [pay, setPay] = useState({ method: "CASH", amount: "", reference: "", reason: "" });
  const [ret, setRet] = useState(() => order.lines.map(() => ({ quantity: "", disposition: "RESTOCK" })));
  const [retReason, setRetReason] = useState("");

  async function act(action, extra = {}) {
    if (action === "cancel" && !window.confirm(`Cancel ${order.orderNumber}?`)) return;
    const real = action === "confirm-backorder" ? "confirm" : action;
    setBusy(action); setError(""); setMessage("");
    try {
      const updated = await api(`/api/orgs/sales/orders/${order.id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action: real, ...(action === "confirm-backorder" ? { allowBackorder: true } : {}), ...extra }) });
      onChanged({ ...updated, customerName: order.customerName, warehouseName: order.warehouseName });
      setPanel(null);
      setMessage({ accept: "Quote accepted: it is now a draft order.", confirm: "Order confirmed and stock reserved.", "confirm-backorder": updated.status === "BACKORDERED" ? "Confirmed: available stock reserved, the rest is on backorder." : "Order confirmed and stock reserved.", reserve: updated.status === "CONFIRMED" ? "All stock reserved." : "More stock reserved; some is still on backorder.", pick: "Picking started.", pack: "Packed.", ready: "Ready for pickup.", fulfil: order.fulfilmentMethod === "PICKUP" ? "Collected: stock has left." : "Dispatched: stock has left.", deliver: "Delivered.", invoice: "Draft invoice created. Find it in Accounting > Invoices.", cancel: "Cancelled; reserved stock released.", payment: "Payment recorded.", refund: "Deposit refunded.", return: "Return recorded." }[action] || "Done.");
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  const actions = actionsFor(order);
  const takesMoney = !["QUOTE", "CANCELLED", "RETURNED"].includes(order.status);
  return (
    <Modal title={`${order.orderNumber} · ${order.customerName || "Customer"}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge status={STATUS_LABEL[order.status] || order.status} />
          {order.stage && <span className="text-[11px] font-bold uppercase text-[#00f2fe]">{STAGE_LABEL[order.stage]}</span>}
          <span className="text-[var(--inaya-text-muted)]">{order.fulfilmentMethod === "PICKUP" ? "pickup" : "delivery"} from {order.warehouseName}{order.deliveryDate ? ` · by ${order.deliveryDate}` : ""}{order.validUntil ? ` · quote valid until ${order.validUntil}` : ""}{order.invoiceId ? " · invoice raised" : ""}</span>
        </div>
        <div className="space-y-1.5">
          {order.lines.map((l, i) => (
            <div key={i} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--inaya-text-primary)]">{l.description} × {l.quantity}{l.unit && l.unit !== "each" ? ` ${l.unit}` : ""}</span>
                <span className="text-[var(--inaya-text-primary)] font-mono tabular-nums">{money(order.currency, l.quantity * l.unitPrice)}</span>
              </div>
              {(order.status === "CONFIRMED" || order.status === "BACKORDERED") && l.reservedQty > 0 && <p className="text-[11px] text-[var(--inaya-text-muted)]">{l.reservedQty} reserved{l.backorderQty > 0 ? ` · ${l.backorderQty} on backorder` : ""}</p>}
              {l.backorderQty > 0 && !l.reservedQty && <p className="text-[11px] text-amber-400">{l.backorderQty} on backorder</p>}
              {l.returnedQty > 0 && <p className="text-[11px] text-amber-400">{l.returnedQty} returned</p>}
              {l.dispatchedLots && <p className="text-[11px] font-mono text-[var(--inaya-text-muted)]">Batch {l.dispatchedLots.map((b) => `${b.lotNumber}${b.expiryDate ? ` (exp ${b.expiryDate})` : ""} ×${b.quantity}`).join(", ")}</p>}
            </div>
          ))}
          <div className="text-right text-xs font-mono tabular-nums border-t border-white/5 pt-1.5 space-y-0.5 text-[var(--inaya-text-primary)]">
            <p>Subtotal {money(order.currency, order.subtotal)}{order.tax ? ` · tax ${money(order.currency, order.tax)}` : ""}</p>
            <p className="text-sm">Total {money(order.currency, order.total)}</p>
            {takesMoney && <p className={order.paymentStatus === "PAID" ? "text-emerald-400" : "text-[var(--inaya-text-muted)]"}>Paid {money(order.currency, order.paid)} · balance {money(order.currency, order.balance)} ({PAY_LABEL[order.paymentStatus]})</p>}
          </div>
        </div>
        {order.payments.length > 0 && <div className="text-[11px] text-[var(--inaya-text-muted)] space-y-0.5">{order.payments.map((p) => <p key={p.no}>{p.no} · {p.kind.toLowerCase()} · {p.method.replace("_", " ").toLowerCase()}{p.reference ? ` (${p.reference})` : ""} · {money(order.currency, p.amount)} · {p.by}{p.reason ? ` · ${p.reason}` : ""}</p>)}</div>}
        {order.returns.length > 0 && <div className="text-[11px] text-[var(--inaya-text-muted)] space-y-0.5">{order.returns.map((r) => <p key={r.no}>{r.no} · {r.lines.map((l) => `${l.description} ×${l.quantity} (${l.disposition.toLowerCase().replace("_", "-")})`).join(", ")} · {r.reason}</p>)}</div>}
        {order.notes && <p className="text-xs text-[var(--inaya-text-muted)]">{order.notes}</p>}
        {message && <p className="text-emerald-400 text-xs">{message}</p>}
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <div className="flex flex-wrap gap-1.5">
          {actions.map(([a, label]) => (
            <button key={a} onClick={() => act(a)} disabled={!!busy} className={`py-2 px-3 rounded-xl text-[11px] font-bold uppercase disabled:opacity-40 ${a === "cancel" ? "bg-white/5 border border-white/10 text-[var(--inaya-text-muted)]" : "bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black"}`}>{busy === a ? "…" : label}</button>
          ))}
          {takesMoney && order.balance > 0 && <button onClick={() => setPanel(panel === "pay" ? null : "pay")} className="py-2 px-3 rounded-xl text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-[var(--inaya-text-primary)]">{order.paid > 0 ? "Record payment" : "Take deposit / payment"}</button>}
          {order.paid > 0 && <button onClick={() => setPanel(panel === "refund" ? null : "refund")} className="py-2 px-3 rounded-xl text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-[var(--inaya-text-muted)]">Refund deposit</button>}
          {["FULFILLED", "INVOICED"].includes(order.status) && <button onClick={() => setPanel(panel === "return" ? null : "return")} className="py-2 px-3 rounded-xl text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-[var(--inaya-text-muted)]">Record a return</button>}
        </div>
        {(panel === "pay" || panel === "refund") && <div className="space-y-2 border-t border-white/5 pt-3">
          <div className="grid grid-cols-2 gap-2">
            <select aria-label="Payment method" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} className={field}><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="MANUAL_REFERENCE">Other (reference)</option></select>
            <input aria-label="Payment amount" type="number" min="0" step="any" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} placeholder={panel === "pay" ? `Up to ${order.balance}` : `Up to ${order.paid}`} className={field} />
          </div>
          {pay.method !== "CASH" && <input aria-label="Payment reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder="Reference (bank / NayaPay transaction id)" className={field} />}
          {panel === "refund" && <input aria-label="Refund reason" value={pay.reason} onChange={(e) => setPay({ ...pay, reason: e.target.value })} placeholder="Reason for the refund" className={field} />}
          <p className="text-[11px] text-[var(--inaya-text-muted)]">Recorded manually; Inaya does not charge cards. Money taken before the invoice is paid is held as a customer deposit in the books.</p>
          <button disabled={!!busy || !(Number(pay.amount) > 0)} onClick={() => act(panel === "pay" ? "payment" : "refund", { method: pay.method, amount: Number(pay.amount), reference: pay.reference || undefined, reason: pay.reason || undefined })} className="w-full py-2 rounded-xl text-[11px] font-bold uppercase bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{panel === "pay" ? "Record payment" : "Refund"}</button>
        </div>}
        {panel === "return" && <div className="space-y-2 border-t border-white/5 pt-3">
          {order.lines.map((l, i) => { const left = l.quantity - (l.returnedQty || 0); return left > 0 && <div key={i} className="grid grid-cols-[1fr_70px_140px] gap-1.5 items-center text-xs">
            <span className="text-[var(--inaya-text-primary)]">{l.description} ({left} can come back)</span>
            <input aria-label={`Return quantity for ${l.description}`} type="number" min="0" max={left} step="any" value={ret[i].quantity} onChange={(e) => setRet((r) => r.map((x, k) => (k === i ? { ...x, quantity: e.target.value } : x)))} className={field} />
            <select aria-label={`Condition of ${l.description}`} value={ret[i].disposition} onChange={(e) => setRet((r) => r.map((x, k) => (k === i ? { ...x, disposition: e.target.value } : x)))} className={field}><option value="RESTOCK">Back to stock</option><option value="DAMAGED">Damaged (write off)</option><option value="NON_RESTOCKABLE">Not restockable</option></select>
          </div>; })}
          <input aria-label="Return reason" value={retReason} onChange={(e) => setRetReason(e.target.value)} placeholder="Reason for the return" className={field} />
          <p className="text-[11px] text-[var(--inaya-text-muted)]">Money back: refund the deposit here while the invoice is unpaid; after that, cancel or credit the invoice in Accounting.</p>
          <button disabled={!!busy || retReason.trim().length < 3 || !ret.some((x) => Number(x.quantity) > 0)} onClick={() => act("return", { reason: retReason, lines: ret.map((x, i) => ({ lineIndex: i, quantity: Number(x.quantity), disposition: x.disposition })).filter((x) => x.quantity > 0) })} className="w-full py-2 rounded-xl text-[11px] font-bold uppercase bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">Record return</button>
        </div>}
        {order.history?.length > 0 && <details className="text-[11px] text-[var(--inaya-text-muted)]"><summary className="cursor-pointer">History</summary>{order.history.map((h, i) => <p key={i}>{new Date(h.at).toLocaleString()} · {String(h.to).toLowerCase().replaceAll("_", " ")} · {h.by}</p>)}</details>}
      </div>
    </Modal>
  );
}
