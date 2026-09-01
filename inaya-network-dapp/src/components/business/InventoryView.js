"use client";

// src/components/business/InventoryView.js
//
// Inventory tab (Phase 4) — Products (with real cross-warehouse stock
// totals and a low-stock indicator) and a manual stock movement recorder
// (stock-in/stock-out/adjustment), backed by /api/orgs/inventory/*.
// Automatic RECEIPT movements from a received purchase order (Phase 3)
// show up in the same per-product movement history here — this view
// doesn't duplicate that recording path, only the manual one.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function InventoryView({ orgId }) {
  const [tab, setTab] = useState("products");
  const [departments, setDepartments] = useState([]);
  const [departmentsError, setDepartmentsError] = useState("");

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => { setDepartments(d.departments); setDepartmentsError(""); }).catch((err) => setDepartmentsError(`Couldn't load departments: ${err.message}`));
  }, [orgId]);

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
        {[["products", "Products"], ["movements", "Movements"], ["warehouses", "Warehouses"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </div>
      {departmentsError && <p className="text-red-400 text-xs">{departmentsError}</p>}
      {tab === "products" && <ProductsTab orgId={orgId} departments={departments} />}
      {tab === "movements" && <MovementsTab orgId={orgId} />}
      {tab === "warehouses" && <WarehousesTab orgId={orgId} departments={departments} />}
    </div>
  );
}

// ============================================================
// PRODUCTS
// ============================================================
function ProductsTab({ orgId, departments }) {
  const [products, setProducts] = useState(null);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ orgId });
      if (lowStockOnly) params.set("lowStockOnly", "true");
      setProducts((await api(`/api/orgs/inventory/products?${params.toString()}`)).products);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, lowStockOnly]);

  useEffect(() => { load(); }, [load]);

  const filtered = (products || []).filter((p) => !search.trim() || p.name.toLowerCase().includes(search.trim().toLowerCase()) || p.sku.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products or SKU…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setLowStockOnly((v) => !v)} className={`text-[11px] font-bold uppercase px-2.5 py-2 rounded-lg border ${lowStockOnly ? "bg-amber-400/10 text-amber-400 border-amber-400/30" : "bg-black/45 text-[var(--inaya-text-muted)] border-white/15"}`}>Low stock only</button>
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New product</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!products ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : products.length === 0 ? (
          <EmptyState compact icon="📦" description="No products match these filters." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No products match "{search}".</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((p) => (
              <button key={p.id} onClick={() => setSelected(p)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{p.name}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">SKU {p.sku}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{p.totalStock}</span>
                  {p.lowStock && <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border bg-amber-400/10 text-amber-400 border-amber-400/30">Low stock</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateProductModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <ProductDetailModal orgId={orgId} product={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function CreateProductModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [reorderThreshold, setReorderThreshold] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !sku.trim() || !name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/inventory/products", { method: "POST", body: JSON.stringify({ orgId, departmentId, sku: sku.trim(), name: name.trim(), reorderThreshold: reorderThreshold ? Number(reorderThreshold) : undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New product" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input value={sku} onChange={(e) => setSku(e.target.value)} required placeholder="SKU" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Product name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={reorderThreshold} onChange={(e) => setReorderThreshold(e.target.value)} type="number" min="0" placeholder="Reorder threshold (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !sku.trim() || !name.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create product"}</button>
      </form>
    </Modal>
  );
}

function ProductDetailModal({ orgId, product, onClose, onChanged }) {
  const [stock, setStock] = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [type, setType] = useState("RECEIPT");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setStock(await api(`/api/orgs/inventory/products/${product.id}/stock?orgId=${orgId}`));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, product.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api(`/api/orgs/inventory/warehouses?orgId=${orgId}&departmentId=${product.departmentId}`).then((d) => setWarehouses(d.warehouses)).catch((err) => { setWarehouses([]); setError(`Couldn't load warehouses: ${err.message}`); });
  }, [orgId, product.departmentId]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!warehouseId || !quantity) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/inventory/movements", { method: "POST", body: JSON.stringify({ orgId, productId: product.id, warehouseId, type, quantity: Number(quantity), note: note.trim() || undefined }) });
      setQuantity("");
      setNote("");
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={product.name} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">SKU {product.sku} · Reorder at {product.reorderThreshold}</p>

        {stock && (
          <div className="space-y-1">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Stock by warehouse</p>
            {stock.levels.length === 0 ? <p className="text-[#8a96ab] text-xs italic">No stock recorded yet.</p> : stock.levels.map((l) => (
              <div key={l.warehouseId} className="flex items-center justify-between text-xs">
                <span className="text-[var(--inaya-text-primary)]">{l.warehouseName}</span>
                <span className="text-[var(--inaya-text-primary)] font-mono tabular-nums">{l.quantity}</span>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-2 border-t border-white/5 pt-3">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Record a movement</p>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="">Warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
              <option value="RECEIPT">Stock in</option>
              <option value="ISSUE">Stock out</option>
              <option value="ADJUSTMENT">Adjustment (+/-)</option>
            </select>
            <input value={quantity} onChange={(e) => setQuantity(e.target.value)} type="number" placeholder="Quantity" className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button disabled={submitting || !warehouseId || !quantity} className="w-full py-2 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Recording…" : "Record movement"}</button>
        </form>

        {stock && stock.movements.length > 0 && (
          <div className="space-y-1.5 border-t border-white/5 pt-3">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Recent movements</p>
            {stock.movements.slice(0, 10).map((m, i) => (
              <div key={i} className="text-xs border-b border-white/5 pb-1.5 last:border-0">
                <span className={m.delta > 0 ? "text-emerald-400" : "text-red-400"}>{m.delta > 0 ? "+" : ""}{m.delta}</span>
                <span className="text-[var(--inaya-text-primary)]"> {m.type.toLowerCase()} · {m.warehouseName}</span>
                <div className="text-[11px] font-mono text-[#8a96ab]">{m.actorEmail} · {new Date(m.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ============================================================
// MOVEMENTS (org-wide feed)
// ============================================================
const MOVEMENTS_FEED_CAP = 100;

function MovementsTab({ orgId }) {
  const [movements, setMovements] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/inventory/movements?orgId=${orgId}`).then((d) => setMovements(d.movements)).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  const capped = (movements || []).slice(0, MOVEMENTS_FEED_CAP);
  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
      {!movements ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : movements.length === 0 ? (
        <EmptyState compact icon="📜" description="No stock movements recorded yet." />
      ) : (
        <div className="space-y-2.5">
          {movements.length > MOVEMENTS_FEED_CAP && <p className="text-[11px] font-mono text-[#8a96ab]">Showing latest {MOVEMENTS_FEED_CAP} of {movements.length}.</p>}
          {capped.map((m, i) => (
            <div key={i} className="text-xs border-b border-white/5 pb-2.5 last:border-0 last:pb-0">
              <span className="text-[var(--inaya-text-primary)] font-bold">{m.productName}</span>
              <span className={m.delta > 0 ? "text-emerald-400" : "text-red-400"}> {m.delta > 0 ? "+" : ""}{m.delta}</span>
              <span className="text-[var(--inaya-text-muted)]"> · {m.type.toLowerCase()} · {m.warehouseName}</span>
              <div className="text-[12px] font-mono text-[#8a96ab] mt-0.5">{m.actorEmail} · {new Date(m.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// WAREHOUSES
// ============================================================
function WarehousesTab({ orgId, departments }) {
  const [warehouses, setWarehouses] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setWarehouses((await api(`/api/orgs/inventory/warehouses?orgId=${orgId}`)).warehouses);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const filtered = (warehouses || []).filter((w) => !search.trim() || w.name.toLowerCase().includes(search.trim().toLowerCase()) || (w.location || "").toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search warehouses…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New warehouse</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!warehouses ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : warehouses.length === 0 ? (
          <EmptyState compact icon="🏬" description="No warehouses yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No warehouses match "{search}".</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((w) => (
              <div key={w.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <span className="text-[var(--inaya-text-primary)] text-sm">{w.name}</span>
                {w.location && <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{w.location}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateWarehouseModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateWarehouseModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/inventory/warehouses", { method: "POST", body: JSON.stringify({ orgId, departmentId, name: name.trim(), location: location.trim() || undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New warehouse" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Warehouse name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !name.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create warehouse"}</button>
      </form>
    </Modal>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
