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
const ACTIONS = {
  DRAFT: [["confirm", "Confirm order"], ["cancel", "Cancel"]],
  CONFIRMED: [["fulfil", "Dispatch stock"], ["invoice", "Create invoice"], ["cancel", "Cancel"]],
  FULFILLED: [["invoice", "Create invoice"]],
};
const STATUS_LABEL = { FULFILLED: "DISPATCHED" };

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
        {["", "DRAFT", "CONFIRMED", "FULFILLED", "INVOICED", "CANCELLED"].map((s) => (
          <button key={s || "all"} onClick={() => setStatus(s)} className={`text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-lg border ${status === s ? "bg-[#00f2fe]/15 text-[#00f2fe] border-[#00f2fe]/30" : "bg-black/45 text-[var(--inaya-text-muted)] border-white/15"}`}>{s ? (STATUS_LABEL[s] || s).toLowerCase() : "all"}</button>
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
                  <span className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{money(o.currency, o.subtotal)}</span>
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
      await api("/api/orgs/sales/orders", { method: "POST", body: JSON.stringify({ orgId, departmentId, contactId, warehouseId, currency, deliveryDate: deliveryDate || undefined, notes: notes.trim() || undefined, lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })) }) });
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
        <button disabled={submitting || !ready} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create draft order"}</button>
      </form>
    </Modal>
  );
}

function OrderDetailModal({ orgId, order, onClose, onChanged }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function act(action) {
    if (action === "cancel" && !window.confirm(`Cancel order ${order.orderNumber}?`)) return;
    setBusy(action); setError(""); setMessage("");
    try {
      const updated = await api(`/api/orgs/sales/orders/${order.id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      onChanged({ ...updated, customerName: order.customerName, warehouseName: order.warehouseName });
      setMessage(action === "fulfil" ? "Stock dispatched." : action === "invoice" ? "Draft invoice created. Find it in Accounting > Invoices." : action === "confirm" ? "Order confirmed: stock is available." : "Order cancelled.");
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  const actions = (ACTIONS[order.status] || []).filter(([a]) => !(a === "invoice" && order.invoiceId) && !(a === "cancel" && order.invoiceId));
  return (
    <Modal title={`${order.orderNumber} · ${order.customerName || "Customer"}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs">
          <StatusBadge status={STATUS_LABEL[order.status] || order.status} />
          <span className="text-[var(--inaya-text-muted)]">from {order.warehouseName}{order.deliveryDate ? ` · deliver by ${order.deliveryDate}` : ""}{order.invoiceId ? " · invoice raised" : ""}</span>
        </div>
        <div className="space-y-1.5">
          {order.lines.map((l, i) => (
            <div key={i} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--inaya-text-primary)]">{l.description} × {l.quantity}{l.unit && l.unit !== "each" ? ` ${l.unit}` : ""}</span>
                <span className="text-[var(--inaya-text-primary)] font-mono tabular-nums">{money(order.currency, l.quantity * l.unitPrice)}</span>
              </div>
              {l.dispatchedLots && <p className="text-[11px] font-mono text-[var(--inaya-text-muted)]">Batch {l.dispatchedLots.map((b) => `${b.lotNumber}${b.expiryDate ? ` (exp ${b.expiryDate})` : ""} ×${b.quantity}`).join(", ")}</p>}
            </div>
          ))}
          <p className="text-right text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums border-t border-white/5 pt-1.5">Total: {money(order.currency, order.subtotal)}</p>
        </div>
        {order.notes && <p className="text-xs text-[var(--inaya-text-muted)]">{order.notes}</p>}
        {message && <p className="text-emerald-400 text-xs">{message}</p>}
        {error && <p className="text-red-400 text-xs">{error}</p>}
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {actions.map(([a, label]) => (
              <button key={a} onClick={() => act(a)} disabled={!!busy} className={`py-2 px-3 rounded-xl text-[11px] font-bold uppercase disabled:opacity-40 ${a === "cancel" ? "bg-white/5 border border-white/10 text-[var(--inaya-text-muted)]" : "bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black"}`}>{busy === a ? "…" : label}</button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
