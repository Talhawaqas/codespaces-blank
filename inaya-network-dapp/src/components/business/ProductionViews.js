"use client";

// src/components/business/ProductionViews.js
//
// Inventory -> Bills of materials and Production (src/lib/production.js):
// define what a product is made from, plan production orders, see what the
// open orders need against stock (with one click to draft purchase requests
// for the shortfall), and start / complete / cancel an order. Completing books
// the finished goods into a batch and records the component batches used.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import Modal from "./ui/Modal";
import StatusBadge from "./ui/StatusBadge";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const field = "w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]";
const primary = "py-2 px-3 rounded-xl text-[11px] font-bold uppercase bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40";
const quiet = "py-2 px-3 rounded-xl text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-[var(--inaya-text-muted)] disabled:opacity-40";

function useProducts(orgId) {
  const [products, setProducts] = useState([]);
  useEffect(() => { api(`/api/orgs/inventory/products?orgId=${orgId}`).then((d) => setProducts(d.products || [])).catch(() => setProducts([])); }, [orgId]);
  return products;
}

// ============================================================
// BILLS OF MATERIALS
// ============================================================
export function BomsTab({ orgId, openCreateSignal = 0 }) {
  const [boms, setBoms] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | bom
  const products = useProducts(orgId);

  const load = useCallback(async () => {
    try { setBoms((await api(`/api/orgs/inventory/boms?orgId=${orgId}`)).boms); } catch (err) { setError(err.message); }
  }, [orgId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (openCreateSignal) setEditing("new"); }, [openCreateSignal]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-[var(--inaya-text-muted)] text-xs mr-auto">What each product is made from. Production orders use these to work out the components needed.</p>
        <button onClick={() => setEditing("new")} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New bill of materials</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!boms ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : boms.length === 0 ? (
          <EmptyState compact icon="🧩" description="No bills of materials yet." ctaLabel="Create one" onCta={() => setEditing("new")} />
        ) : (
          <div className="space-y-2">
            {boms.map((b) => (
              <button key={b.id} onClick={() => setEditing(b)} className="w-full text-left bg-black/20 border border-white/5 rounded-lg p-3 hover:bg-white/5">
                <span className="text-[var(--inaya-text-primary)] text-sm">{b.productName}</span>
                <span className="text-[var(--inaya-text-muted)] text-[12px] font-mono"> · makes {b.outputQuantity}</span>
                <p className="text-[var(--inaya-text-muted)] text-[12px] mt-0.5">{b.components.map((c) => `${c.quantity} × ${c.productName}`).join(" · ")}</p>
              </button>
            ))}
          </div>
        )}
      </div>
      {editing && <BomModal orgId={orgId} products={products} bom={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function BomModal({ orgId, products, bom, onClose, onSaved }) {
  const [productId, setProductId] = useState(bom?.productId || "");
  const [outputQuantity, setOutputQuantity] = useState(bom ? String(bom.outputQuantity) : "1");
  const [components, setComponents] = useState(bom ? bom.components.map((c) => ({ productId: c.productId, quantity: String(c.quantity) })) : [{ productId: "", quantity: "" }]);
  const [notes, setNotes] = useState(bom?.notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (i, k, v) => setComponents((cs) => cs.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const ready = productId && Number(outputQuantity) > 0 && components.every((c) => c.productId && Number(c.quantity) > 0);
  const unit = (id) => { const p = products.find((x) => x.id === id); return p?.unit && p.unit !== "each" ? p.unit : ""; };

  async function save(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError("");
    try {
      await api("/api/orgs/inventory/boms", { method: "POST", body: JSON.stringify({ orgId, productId, outputQuantity: Number(outputQuantity), components: components.map((c) => ({ productId: c.productId, quantity: Number(c.quantity) })), notes: notes.trim() || undefined }) });
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <Modal title={bom ? `Bill of materials · ${bom.productName}` : "New bill of materials"} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <select aria-label="Finished product" value={productId} onChange={(e) => setProductId(e.target.value)} disabled={!!bom} className={`${field} disabled:opacity-60`}>
          <option value="">Finished product…</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
        </select>
        <label className="text-[11px] text-[var(--inaya-text-muted)] flex items-center gap-2">One run makes
          <input aria-label="Batch size" type="number" min="0" step="any" value={outputQuantity} onChange={(e) => setOutputQuantity(e.target.value)} className={`${field} w-24`} />
          {unit(productId) || "units"}
        </label>
        <div className="space-y-2 border-t border-white/5 pt-3">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Made from (per run)</p>
          {components.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_90px_auto] gap-1.5 items-center">
              <select aria-label="Component" value={c.productId} onChange={(e) => set(i, "productId", e.target.value)} className={field}>
                <option value="">Component…</option>
                {products.filter((p) => p.id !== productId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input aria-label="Quantity" type="number" min="0" step="any" value={c.quantity} onChange={(e) => set(i, "quantity", e.target.value)} placeholder={unit(c.productId) || "Qty"} className={field} />
              <button type="button" onClick={() => setComponents((cs) => cs.filter((_, j) => j !== i))} disabled={components.length === 1} className="text-[var(--inaya-text-muted)] hover:text-red-400 disabled:opacity-30 text-lg leading-none">×</button>
            </div>
          ))}
          <button type="button" onClick={() => setComponents((cs) => [...cs, { productId: "", quantity: "" }])} className="text-[11px] font-bold uppercase text-[#00f2fe]">+ Add component</button>
        </div>
        <input aria-label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional), e.g. method or recipe reference" className={field} />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={busy || !ready} className={`w-full ${primary} py-2.5`}>{busy ? "Saving…" : "Save bill of materials"}</button>
      </form>
    </Modal>
  );
}

// ============================================================
// PRODUCTION
// ============================================================
const STATUS_LABEL = { IN_PROGRESS: "IN PROGRESS" };

export function ProductionTab({ orgId, openCreateSignal = 0 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try { setData(await api(`/api/orgs/inventory/production?orgId=${orgId}`)); } catch (err) { setError(err.message); }
  }, [orgId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (openCreateSignal) setShowCreate(true); }, [openCreateSignal]);

  async function draftShortages() {
    setDrafting(true); setMessage(""); setError("");
    try {
      const r = await api("/api/orgs/inventory/production", { method: "POST", body: JSON.stringify({ orgId, action: "draftShortages" }) });
      setMessage(`${r.drafted.length ? `Drafted purchase requests for ${r.drafted.join(", ")}.` : "No new purchase requests needed."}${r.skipped.length ? ` Already requested: ${r.skipped.join(", ")}.` : ""} Review them in Purchasing.`);
    } catch (err) { setError(err.message); } finally { setDrafting(false); }
  }

  const short = (data?.plan || []).filter((r) => r.short > 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-[var(--inaya-text-muted)] text-xs mr-auto">Plan what to make, check the components, then complete it to book the finished goods into stock.</p>
        <button onClick={() => setShowCreate(true)} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New production order</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[var(--inaya-text-primary)] text-sm font-bold mr-auto">Materials for open orders</p>
          {short.length > 0 && <button onClick={draftShortages} disabled={drafting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-lg border bg-amber-400/10 text-amber-400 border-amber-400/30 disabled:opacity-40">{drafting ? "Drafting…" : "Draft purchase requests for shortages"}</button>}
        </div>
        {message && <p className="text-emerald-400 text-xs">{message}</p>}
        {!data ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : data.plan.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No planned or in-progress orders.</p>
        ) : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[11px] uppercase text-[var(--inaya-text-muted)]"><th className="pb-1.5">Component</th><th className="pb-1.5 text-right">Needed</th><th className="pb-1.5 text-right">In stock</th><th className="pb-1.5 text-right">Short</th></tr></thead>
            <tbody>
              {data.plan.map((r) => (
                <tr key={`${r.warehouseId}-${r.productId}`} className="border-t border-white/5">
                  <td className="py-1.5 text-[var(--inaya-text-primary)]">{r.productName}<span className="text-[var(--inaya-text-muted)] font-mono"> · {r.orders.join(", ")}</span></td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-[var(--inaya-text-primary)]">{r.needed}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-[var(--inaya-text-primary)]">{r.inStock}</td>
                  <td className={`py-1.5 text-right font-mono tabular-nums ${r.short > 0 ? "text-amber-400 font-bold" : "text-[var(--inaya-text-muted)]"}`}>{r.short > 0 ? r.short : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!data ? null : data.orders.length === 0 ? (
          <EmptyState compact icon="🏭" description="No production orders yet. Add a bill of materials first, then plan an order." ctaLabel="Plan one" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {data.orders.map((o) => (
              <button key={o.id} onClick={() => setSelected(o)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{o.quantity} × {o.productName}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{o.orderNumber} · {o.warehouseName}{o.dueDate ? ` · due ${o.dueDate}` : ""}{o.lotNumber ? ` · batch ${o.lotNumber}` : ""}</p>
                </div>
                <StatusBadge status={STATUS_LABEL[o.status] || o.status} />
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateProductionModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <ProductionDetailModal orgId={orgId} order={selected} onClose={() => setSelected(null)} onChanged={(o) => { setSelected(o); load(); }} />}
    </div>
  );
}

function CreateProductionModal({ orgId, onClose, onCreated }) {
  const [boms, setBoms] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api(`/api/orgs/inventory/boms?orgId=${orgId}`).then((d) => setBoms(d.boms)).catch((err) => setError(err.message)); }, [orgId]);
  const bom = boms.find((b) => b.productId === productId);
  useEffect(() => {
    setWarehouseId(""); setWarehouses([]);
    if (!bom) return;
    api(`/api/orgs/inventory/warehouses?orgId=${orgId}&departmentId=${bom.departmentId}`).then((d) => setWarehouses(d.warehouses)).catch((err) => setError(err.message));
  }, [orgId, bom]);
  const factor = bom && Number(quantity) > 0 ? Number(quantity) / bom.outputQuantity : 0;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/orgs/inventory/production", { method: "POST", body: JSON.stringify({ orgId, productId, quantity: Number(quantity), warehouseId, dueDate: dueDate || undefined }) });
      onCreated();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <Modal title="New production order" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <select aria-label="Product to make" value={productId} onChange={(e) => setProductId(e.target.value)} className={field}>
          <option value="">Product to make…</option>
          {boms.map((b) => <option key={b.id} value={b.productId}>{b.productName}</option>)}
        </select>
        {boms.length === 0 && <p className="text-[var(--inaya-text-muted)] text-xs">Only products with a bill of materials can be produced.</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input aria-label="Quantity to make" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Quantity to make" className={field} />
          <select aria-label="Warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} disabled={!bom} className={`${field} disabled:opacity-40`}>
            <option value="">Warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <label className="text-[11px] text-[var(--inaya-text-muted)] flex items-center gap-2">Due (optional)
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={`${field} flex-1`} />
        </label>
        {bom && factor > 0 && (
          <div className="text-xs border-t border-white/5 pt-2 space-y-0.5">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Components needed</p>
            {bom.components.map((c) => <p key={c.productId} className="text-[var(--inaya-text-primary)]">{Math.round(c.quantity * factor * 1e6) / 1e6} × {c.productName}</p>)}
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={busy || !productId || !(Number(quantity) > 0) || !warehouseId} className={`w-full ${primary} py-2.5`}>{busy ? "Planning…" : "Plan production order"}</button>
      </form>
    </Modal>
  );
}

function ProductionDetailModal({ orgId, order, onClose, onChanged }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  async function act(action) {
    if (action === "cancel" && !window.confirm(`Cancel ${order.orderNumber}?`)) return;
    setBusy(action); setError(""); setMessage("");
    try {
      const updated = await api(`/api/orgs/inventory/production/${order.id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action, lotNumber: lotNumber.trim() || undefined, expiryDate: expiryDate || undefined }) });
      onChanged(updated);
      setMessage(action === "start" ? "Started: the components are in stock." : action === "complete" ? "Completed: components used and finished goods booked into stock." : "Order cancelled.");
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  return (
    <Modal title={`${order.orderNumber} · ${order.quantity} × ${order.productName}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs">
          <StatusBadge status={STATUS_LABEL[order.status] || order.status} />
          <span className="text-[var(--inaya-text-muted)]">{order.warehouseName}{order.dueDate ? ` · due ${order.dueDate}` : ""}</span>
        </div>
        <div className="space-y-1 text-xs">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">{order.consumed ? "Components used" : "Components needed"}</p>
          {(order.consumed || order.requirements).map((c) => (
            <div key={c.productId}>
              <p className="text-[var(--inaya-text-primary)]">{c.quantity} × {c.productName}</p>
              {c.lots && <p className="text-[11px] font-mono text-[var(--inaya-text-muted)]">Batch {c.lots.map((l) => `${l.lotNumber} ×${l.quantity}`).join(", ")}</p>}
            </div>
          ))}
        </div>
        {order.status === "COMPLETED" && order.lotNumber && <p className="text-xs text-[var(--inaya-text-primary)]">Finished batch: <strong className="font-mono">{order.lotNumber}</strong>{order.expiryDate ? ` · expires ${order.expiryDate}` : ""}</p>}
        {order.status === "IN_PROGRESS" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 border-t border-white/5 pt-3">
            <input aria-label="Finished batch number" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} placeholder={`Finished batch (default ${order.orderNumber})`} className={field} />
            <label className="text-[11px] text-[var(--inaya-text-muted)] flex items-center gap-2">Expiry
              <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className={`${field} flex-1`} />
            </label>
          </div>
        )}
        {message && <p className="text-emerald-400 text-xs">{message}</p>}
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <div className="flex flex-wrap gap-1.5">
          {order.status === "PLANNED" && <button onClick={() => act("start")} disabled={!!busy} className={primary}>{busy === "start" ? "…" : "Start production"}</button>}
          {order.status === "IN_PROGRESS" && <button onClick={() => act("complete")} disabled={!!busy} className={primary}>{busy === "complete" ? "…" : "Complete and book stock"}</button>}
          {["PLANNED", "IN_PROGRESS"].includes(order.status) && <button onClick={() => act("cancel")} disabled={!!busy} className={quiet}>Cancel</button>}
        </div>
      </div>
    </Modal>
  );
}
