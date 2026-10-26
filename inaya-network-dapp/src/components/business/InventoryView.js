"use client";

// src/components/business/InventoryView.js
//
// Inventory tab (Phase 4) — Products (with real cross-warehouse stock
// totals and a low-stock indicator) and a manual stock movement recorder
// (stock-in/stock-out/adjustment), backed by /api/orgs/inventory/*.
// Automatic RECEIPT movements from a received purchase order (Phase 3)
// show up in the same per-product movement history here — this view
// doesn't duplicate that recording path, only the manual one.
// Batches: products can track batch / lot numbers with expiry dates
// (lib/inventory-lots.js); the Batches tab lists what expires soon and
// traces a batch through every movement.

import { useState, useEffect, useCallback, useRef } from "react";
import EmptyState from "../EmptyState";
import { useErpSection, useErpTabsHidden, useErpCreate } from "./erp/ErpNavContext";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function InventoryView({ orgId }) {
  const [tab, setTab] = useErpSection("products", ["products", "batches", "movements", "warehouses"]);
  const tabsHidden = useErpTabsHidden();
  const [departments, setDepartments] = useState([]);
  const [departmentsError, setDepartmentsError] = useState("");

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => { setDepartments(d.departments); setDepartmentsError(""); }).catch((err) => setDepartmentsError(`Couldn't load departments: ${err.message}`));
  }, [orgId]);

  return (
    <div className="space-y-5">
      {!tabsHidden && (
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
          {[["products", "Products"], ["batches", "Batches"], ["movements", "Movements"], ["warehouses", "Warehouses"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
          ))}
        </div>
      )}
      {departmentsError && <p className="text-red-400 text-xs">{departmentsError}</p>}
      {tab === "products" && <ProductsTab orgId={orgId} departments={departments} />}
      {tab === "batches" && <BatchesTab orgId={orgId} />}
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
  useErpCreate("products", () => setShowCreate(true));
  const [showTransfer, setShowTransfer] = useState(false);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [showScan, setShowScan] = useState(false);
  const [newBarcode, setNewBarcode] = useState(null);

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

  const filtered = (products || []).filter((p) => !search.trim() || p.name.toLowerCase().includes(search.trim().toLowerCase()) || p.sku.toLowerCase().includes(search.trim().toLowerCase()) || (p.barcode || "").includes(search.trim()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Search products" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products, SKU or barcode…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-full sm:w-56" />
        <button onClick={() => setShowScan(true)} className="text-[11px] font-bold uppercase px-2.5 py-2 rounded-lg border bg-black/45 text-[var(--inaya-text-primary)] border-white/15">▥ Scan</button>
        <button onClick={() => setLowStockOnly((v) => !v)} className={`text-[11px] font-bold uppercase px-2.5 py-2 rounded-lg border ${lowStockOnly ? "bg-amber-400/10 text-amber-400 border-amber-400/30" : "bg-black/45 text-[var(--inaya-text-muted)] border-white/15"}`}>Low stock only</button>
        <button onClick={() => setShowTransfer(true)} className="ml-auto text-[11px] font-bold uppercase px-2.5 py-2 rounded-lg border bg-black/45 text-[var(--inaya-text-primary)] border-white/15">⇄ Transfer stock</button>
        <button onClick={() => setShowCreate(true)} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New product</button>
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
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">SKU {p.sku}{p.barcode ? ` · ${p.barcode}` : ""}{p.trackLots ? " · batches" : ""}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{p.totalStock}{p.unit && p.unit !== "each" ? ` ${p.unit}` : ""}</span>
                  {p.lowStock && <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border bg-amber-400/10 text-amber-400 border-amber-400/30">Low stock</span>}
                  {p.openReorderRequestId && <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30">Reorder drafted</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateProductModal orgId={orgId} departments={departments} initialBarcode={newBarcode} onClose={() => { setShowCreate(false); setNewBarcode(null); }} onCreated={() => { setShowCreate(false); setNewBarcode(null); load(); }} />}
      {showScan && <ScanModal products={products || []} onClose={() => setShowScan(false)} onFound={(p) => { setShowScan(false); setSelected(p); }} onCreate={(code) => { setShowScan(false); setNewBarcode(code); setShowCreate(true); }} />}
      {showTransfer && <TransferStockModal orgId={orgId} products={products || []} onClose={() => setShowTransfer(false)} onTransferred={() => { setShowTransfer(false); load(); }} />}
      {selected && <ProductDetailModal orgId={orgId} product={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function TransferStockModal({ orgId, products, onClose, onTransferred }) {
  const [productId, setProductId] = useState("");
  const [warehouses, setWarehouses] = useState([]);
  const [sourceWarehouseId, setSourceWarehouseId] = useState("");
  const [destWarehouseId, setDestWarehouseId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const product = products.find((p) => p.id === productId);

  useEffect(() => {
    setSourceWarehouseId(""); setDestWarehouseId(""); setWarehouses([]);
    if (!product) return;
    api(`/api/orgs/inventory/warehouses?orgId=${orgId}&departmentId=${product.departmentId}`).then((d) => setWarehouses(d.warehouses)).catch((err) => setError(`Couldn't load warehouses: ${err.message}`));
  }, [orgId, product]);

  const warehouseName = (id) => warehouses.find((w) => w.id === id)?.name || "";
  const canReview = productId && sourceWarehouseId && destWarehouseId && sourceWarehouseId !== destWarehouseId && Number(quantity) > 0;

  async function handleConfirm() {
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/inventory/transfers", { method: "POST", body: JSON.stringify({ orgId, productId, sourceWarehouseId, destWarehouseId, quantity: Number(quantity), note: note.trim() || undefined, lotNumber: lotNumber.trim() || undefined }) });
      onTransferred();
    } catch (err) {
      setError(err.message);
      setReviewing(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Transfer stock" onClose={onClose}>
      {!reviewing ? (
        <div className="space-y-3">
          <select aria-label="Product" value={productId} onChange={(e) => setProductId(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="">Product…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
          </select>
          <select aria-label="Source warehouse" value={sourceWarehouseId} onChange={(e) => setSourceWarehouseId(e.target.value)} disabled={!product} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
            <option value="">Source warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select aria-label="Destination warehouse" value={destWarehouseId} onChange={(e) => setDestWarehouseId(e.target.value)} disabled={!product} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
            <option value="">Destination warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {sourceWarehouseId && destWarehouseId && sourceWarehouseId === destWarehouseId && <p className="text-red-400 text-xs">Source and destination must be different.</p>}
          <input aria-label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} type="number" min="1" placeholder="Quantity" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          {product?.trackLots && <input aria-label="Batch / lot number (optional)" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} placeholder="Batch (blank = earliest expiry first)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />}
          <input aria-label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button disabled={!canReview} onClick={() => setReviewing(true)} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">Review transfer</button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Confirm this transfer</p>
          <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-1 text-xs text-[var(--inaya-text-primary)]">
            <p><strong>{quantity}</strong> × {product?.name} ({product?.sku})</p>
            <p>{warehouseName(sourceWarehouseId)} → {warehouseName(destWarehouseId)}</p>
            {product?.trackLots && <p className="text-[var(--inaya-text-muted)]">Batch: {lotNumber.trim() || "earliest expiry first"}</p>}
            {note && <p className="text-[var(--inaya-text-muted)]">Note: {note}</p>}
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex gap-1.5">
            <button onClick={handleConfirm} disabled={submitting} className="flex-1 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Transferring…" : "Confirm transfer"}</button>
            <button onClick={() => setReviewing(false)} disabled={submitting} className="py-2.5 px-4 rounded-xl text-xs font-bold uppercase bg-white/5 border border-white/10 text-[var(--inaya-text-primary)]">Back</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateProductModal({ orgId, departments, initialBarcode = null, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [barcode, setBarcode] = useState(initialBarcode || "");
  const [unit, setUnit] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("");
  const [perPurchaseUnit, setPerPurchaseUnit] = useState("");
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [reorderThreshold, setReorderThreshold] = useState("");
  const [trackLots, setTrackLots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !sku.trim() || !name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/inventory/products", { method: "POST", body: JSON.stringify({ orgId, departmentId, sku: sku.trim(), name: name.trim(), reorderThreshold: reorderThreshold ? Number(reorderThreshold) : undefined, barcode: barcode.trim() || undefined, unit: unit.trim() || undefined, trackLots, ...(purchaseUnit.trim() ? { purchaseUnit: purchaseUnit.trim(), unitsPerPurchaseUnit: Number(perPurchaseUnit) } : {}) }) });
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
        <select aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input aria-label="SKU" value={sku} onChange={(e) => setSku(e.target.value)} required placeholder="SKU" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Product name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Product name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Reorder threshold (optional)" value={reorderThreshold} onChange={(e) => setReorderThreshold(e.target.value)} type="number" min="0" placeholder="Reorder threshold (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <UnitFields barcode={barcode} setBarcode={setBarcode} unit={unit} setUnit={setUnit} purchaseUnit={purchaseUnit} setPurchaseUnit={setPurchaseUnit} perPurchaseUnit={perPurchaseUnit} setPerPurchaseUnit={setPerPurchaseUnit} />
        <label className="flex items-start gap-2 text-xs text-[var(--inaya-text-primary)]">
          <input type="checkbox" checked={trackLots} onChange={(e) => setTrackLots(e.target.checked)} className="mt-0.5" />
          <span>Track batches / lots with expiry dates<span className="block text-[11px] text-[var(--inaya-text-muted)]">Stock in needs a batch number; stock out uses the earliest-expiring batch first.</span></span>
        </label>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !sku.trim() || !name.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create product"}</button>
      </form>
    </Modal>
  );
}

// Batch 3 — barcode + units of measure (lib/inventory-units.js).
const unitInput = "w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]";

function UnitFields({ barcode, setBarcode, unit, setUnit, purchaseUnit, setPurchaseUnit, perPurchaseUnit, setPerPurchaseUnit }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <input aria-label="Barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Barcode (optional)" className={unitInput} />
      <input aria-label="Stock unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Counted in (each, kg, m…)" className={unitInput} />
      <input aria-label="Purchase unit" value={purchaseUnit} onChange={(e) => setPurchaseUnit(e.target.value)} placeholder="Bought in (box, case…) optional" className={unitInput} />
      <input aria-label="Units per purchase unit" value={perPurchaseUnit} onChange={(e) => setPerPurchaseUnit(e.target.value)} type="number" min="2" disabled={!purchaseUnit.trim()} placeholder="Units in each one" className={`${unitInput} disabled:opacity-40`} />
    </div>
  );
}

function UnitsEditor({ orgId, product, onChanged }) {
  const [open, setOpen] = useState(false);
  const [barcode, setBarcode] = useState(product.barcode || "");
  const [unit, setUnit] = useState(product.unit && product.unit !== "each" ? product.unit : "");
  const [purchaseUnit, setPurchaseUnit] = useState(product.purchaseUnit || "");
  const [perPurchaseUnit, setPerPurchaseUnit] = useState(product.unitsPerPurchaseUnit ? String(product.unitsPerPurchaseUnit) : "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  if (!open) return <button onClick={() => setOpen(true)} className="text-[11px] font-bold uppercase text-[#00f2fe]">Edit barcode & units</button>;
  async function save() {
    setSaving(true); setMsg("");
    try {
      await api(`/api/orgs/inventory/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ orgId, barcode: barcode.trim() || null, unit: unit.trim() || null, purchaseUnit: purchaseUnit.trim() || null, unitsPerPurchaseUnit: purchaseUnit.trim() ? Number(perPurchaseUnit) : null }) });
      setMsg("Saved. New purchase-order lines use these units; existing ones keep theirs."); onChanged();
    } catch (err) { setMsg(err.message); } finally { setSaving(false); }
  }
  return (
    <div className="space-y-2 border border-white/10 rounded-lg p-3">
      <UnitFields barcode={barcode} setBarcode={setBarcode} unit={unit} setUnit={setUnit} purchaseUnit={purchaseUnit} setPurchaseUnit={setPurchaseUnit} perPurchaseUnit={perPurchaseUnit} setPerPurchaseUnit={setPerPurchaseUnit} />
      <button disabled={saving} onClick={save} className="text-[11px] font-bold uppercase px-3 py-2 rounded-md bg-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{saving ? "…" : "Save"}</button>
      {msg && <p className="text-xs text-[var(--inaya-text-muted)]">{msg}</p>}
    </div>
  );
}

/** Scan with the camera where the browser supports BarcodeDetector; a USB or
 *  Bluetooth scanner types into the field like a keyboard and presses Enter. */
function ScanModal({ products, onClose, onFound, onCreate }) {
  const [code, setCode] = useState("");
  const [notFound, setNotFound] = useState("");
  const [camera, setCamera] = useState("off"); // off | on | unsupported | error
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  const lookup = useCallback((raw) => {
    const c = String(raw || "").trim();
    if (!c) return;
    const match = products.find((p) => p.barcode === c || p.sku === c);
    if (match) onFound(match); else setNotFound(c);
  }, [products, onFound]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  async function startCamera() {
    if (typeof window === "undefined" || !("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) { setCamera("unsupported"); return; }
    try {
      const detector = new window.BarcodeDetector();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setCamera("on");
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          const found = await detector.detect(video);
          if (found[0]?.rawValue) { stream.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCamera("off"); setCode(found[0].rawValue); lookup(found[0].rawValue); return; }
        } catch { /* keep scanning */ }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch { setCamera("error"); }
  }

  return (
    <Modal title="Scan a barcode" onClose={onClose}>
      <div className="space-y-3">
        <form onSubmit={(e) => { e.preventDefault(); setNotFound(""); lookup(code); }} className="flex gap-2">
          <input aria-label="Barcode or SKU" autoFocus value={code} onChange={(e) => { setCode(e.target.value); setNotFound(""); }} placeholder="Scan or type a barcode / SKU" className={unitInput} />
          <button className="text-[11px] font-bold uppercase px-3 rounded-lg bg-white/10 text-[var(--inaya-text-primary)]">Find</button>
        </form>
        <video ref={videoRef} className={camera === "on" ? "w-full rounded-lg bg-black" : "hidden"} muted playsInline />
        {camera !== "on" && <button onClick={startCamera} className="text-[11px] font-bold uppercase px-3 py-2 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)]">Use camera</button>}
        {camera === "unsupported" && <p className="text-xs text-[var(--inaya-text-muted)]">This browser can't read barcodes from the camera (Chrome, Edge and Android can). A handheld scanner or typing the code works everywhere.</p>}
        {camera === "error" && <p className="text-xs text-amber-400">The camera couldn't be opened. Check the browser's camera permission.</p>}
        {notFound && (
          <div className="text-xs space-y-2">
            <p className="text-[var(--inaya-text-muted)]">No product has the barcode or SKU "{notFound}".</p>
            <button onClick={() => onCreate(notFound)} className="text-[11px] font-bold uppercase text-[#00f2fe]">Create a product with this barcode</button>
          </div>
        )}
      </div>
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
  const [lotNumber, setLotNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [trackLots, setTrackLots] = useState(!!product.trackLots);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const incoming = type === "RECEIPT" || (type === "ADJUSTMENT" && Number(quantity) > 0);

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
      await api("/api/orgs/inventory/movements", { method: "POST", body: JSON.stringify({ orgId, productId: product.id, warehouseId, type, quantity: Number(quantity), note: note.trim() || undefined, lotNumber: lotNumber.trim() || undefined, expiryDate: incoming && expiryDate ? expiryDate : undefined }) });
      setQuantity("");
      setNote("");
      setLotNumber("");
      setExpiryDate("");
      await load();
      window.dispatchEvent(new CustomEvent("inaya:guided-movement-recorded"));
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
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">SKU {product.sku} · Reorder at {product.reorderThreshold}{product.barcode ? ` · Barcode ${product.barcode}` : ""} · Counted in {product.unit || "each"}{product.purchaseUnit ? ` · Bought by the ${product.purchaseUnit} of ${product.unitsPerPurchaseUnit}` : ""}</p>
        <UnitsEditor orgId={orgId} product={product} onChanged={onChanged} />
        <BatchTrackingToggle orgId={orgId} productId={product.id} trackLots={trackLots} onChanged={(v) => { setTrackLots(v); load(); onChanged(); }} />

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

        {stock && trackLots && (
          <div className="space-y-1">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Batches in stock (earliest expiry first)</p>
            {stock.lots.length === 0 ? <p className="text-[#8a96ab] text-xs italic">No batches in stock.</p> : stock.lots.map((l) => (
              <div key={`${l.warehouseId}-${l.lotNumber}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[var(--inaya-text-primary)] font-mono truncate">{l.lotNumber}<span className="text-[var(--inaya-text-muted)] font-sans"> · {l.warehouseName}</span></span>
                <span className="flex items-center gap-2 shrink-0">
                  <ExpiryBadge expiryDate={l.expiryDate} days={l.daysToExpiry} />
                  <span className="text-[var(--inaya-text-primary)] font-mono tabular-nums">{l.quantity}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        <ReorderSection orgId={orgId} productId={product.id} refreshKey={stock} onChanged={onChanged} />

        <form onSubmit={handleSubmit} className="space-y-2 border-t border-white/5 pt-3">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Record a movement</p>
          <select aria-label="Warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="">Warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
              <option value="RECEIPT">Stock in</option>
              <option value="ISSUE">Stock out</option>
              <option value="ADJUSTMENT">Adjustment (+/-)</option>
            </select>
            <input aria-label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} type="number" placeholder="Quantity" className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
          </div>
          {trackLots && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input aria-label="Batch / lot number" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} placeholder={incoming ? "Batch / lot number" : "Batch (blank = earliest expiry first)"} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
              {incoming && (
                <label className="text-[11px] text-[var(--inaya-text-muted)] flex items-center gap-2">
                  Expiry
                  <input aria-label="Expiry date" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
                </label>
              )}
            </div>
          )}
          <input aria-label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button disabled={submitting || !warehouseId || !quantity || (trackLots && incoming && !lotNumber.trim())} className="w-full py-2 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Recording…" : "Record movement"}</button>
        </form>

        {stock && stock.movements.length > 0 && (
          <div className="space-y-1.5 border-t border-white/5 pt-3">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Recent movements</p>
            {stock.movements.slice(0, 10).map((m, i) => (
              <div key={i} className="text-xs border-b border-white/5 pb-1.5 last:border-0">
                <span className={m.delta > 0 ? "text-emerald-400" : "text-red-400"}>{m.delta > 0 ? "+" : ""}{m.delta}</span>
                <span className="text-[var(--inaya-text-primary)]"> {m.type.toLowerCase()} · {m.warehouseName}</span>
                {m.lots && <div className="text-[11px] font-mono text-[var(--inaya-text-muted)]">{lotsLabel(m.lots)}</div>}
                <div className="text-[11px] font-mono text-[#8a96ab]">{m.actorEmail} · {new Date(m.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// Low stock -> a DRAFT purchase request (never submitted on anyone's
// behalf). refreshKey changes whenever stock reloads, so this re-reads the
// product's live low-stock / in-flight state after a movement is recorded.
function ReorderSection({ orgId, productId, refreshKey, onChanged }) {
  const [info, setInfo] = useState(null);
  const [reorderQuantity, setReorderQuantity] = useState("");
  const [autoReorder, setAutoReorder] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/inventory/products/${productId}?orgId=${orgId}`)
      .then((p) => { setInfo(p); setReorderQuantity(p.reorderQuantity ?? ""); setAutoReorder(!!p.autoReorder); })
      .catch((err) => setError(err.message));
  }, [orgId, productId, refreshKey]);

  if (!info) return null;
  const hasThreshold = info.reorderThreshold > 0;
  const settingsChanged = String(reorderQuantity) !== String(info.reorderQuantity ?? "") || autoReorder !== !!info.autoReorder;

  async function saveSettings() {
    setBusy("save"); setError(""); setMessage("");
    try {
      const qty = String(reorderQuantity).trim() === "" ? null : Number(reorderQuantity);
      const updated = await api(`/api/orgs/inventory/products/${productId}`, { method: "PATCH", body: JSON.stringify({ orgId, reorderQuantity: qty, autoReorder }) });
      setInfo((i) => ({ ...i, ...updated }));
      setMessage("Reorder settings saved.");
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  async function draftReorder() {
    setBusy("draft"); setError(""); setMessage("");
    try {
      const result = await api(`/api/orgs/inventory/products/${productId}/reorder`, { method: "POST", body: JSON.stringify({ orgId }) });
      setInfo((i) => ({ ...i, openReorderRequestId: result.request.id }));
      setMessage(result.created
        ? `Draft purchase request created for ${result.request.reorderQuantity} units. Submit it from Procurement when ready.`
        : "A reorder request for this product is already in progress — see Procurement.");
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  return (
    <div className="space-y-2 border-t border-white/5 pt-3">
      <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Reordering</p>
      {!hasThreshold ? (
        <p className="text-[#8a96ab] text-xs italic">Set a reorder threshold on this product to enable reordering.</p>
      ) : (
        <>
          {info.lowStock && (
            info.openReorderRequestId ? (
              <p className="text-xs text-[#00f2fe]">A reorder request is already in progress for this product.</p>
            ) : (
              <button type="button" onClick={draftReorder} disabled={!!busy} className="w-full py-2 rounded-xl text-xs font-bold uppercase tracking-wide bg-amber-400/10 text-amber-400 border border-amber-400/30 disabled:opacity-40">
                {busy === "draft" ? "Drafting…" : "Draft reorder request"}
              </button>
            )
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
            <label className="text-[11px] text-[var(--inaya-text-muted)]" htmlFor={`reorder-qty-${productId}`}>
              Reorder quantity
              <input id={`reorder-qty-${productId}`} value={reorderQuantity} onChange={(e) => setReorderQuantity(e.target.value)} type="number" min="1" placeholder={`Auto: top up to ${info.reorderThreshold * 2}`} className="mt-1 w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--inaya-text-primary)] pb-2" htmlFor={`auto-reorder-${productId}`}>
              <input id={`auto-reorder-${productId}`} type="checkbox" checked={autoReorder} onChange={(e) => setAutoReorder(e.target.checked)} />
              Draft automatically each day when low
            </label>
          </div>
          {settingsChanged && <button type="button" onClick={saveSettings} disabled={!!busy} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{busy === "save" ? "Saving…" : "Save reorder settings"}</button>}
        </>
      )}
      {message && <p className="text-emerald-400 text-xs">{message}</p>}
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}

// ============================================================
// BATCHES (lot tracking with expiry dates)
// ============================================================
const lotsLabel = (lots) => `Batch ${lots.map((l) => `${l.lotNumber} ×${l.quantity}`).join(", ")}`;

function ExpiryBadge({ expiryDate, days }) {
  if (!expiryDate) return <span className="text-[11px] text-[#8a96ab]">no expiry</span>;
  const tone = days < 0 ? "bg-red-400/10 text-red-400 border-red-400/30" : days <= 30 ? "bg-amber-400/10 text-amber-400 border-amber-400/30" : "bg-white/5 text-[var(--inaya-text-muted)] border-white/10";
  const label = days < 0 ? `expired ${expiryDate}` : days === 0 ? "expires today" : `exp ${expiryDate}`;
  return <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${tone}`}>{label}</span>;
}

function BatchTrackingToggle({ orgId, productId, trackLots, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function toggle() {
    if (!trackLots && !window.confirm("Turn on batch tracking? Stock already held becomes batch OPENING-STOCK, and stock coming in will need a batch number.")) return;
    setBusy(true); setError("");
    try {
      await api(`/api/orgs/inventory/products/${productId}`, { method: "PATCH", body: JSON.stringify({ orgId, trackLots: !trackLots }) });
      onChanged(!trackLots);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-[var(--inaya-text-primary)]">Batch / lot tracking: <strong>{trackLots ? "on" : "off"}</strong></span>
      <button type="button" onClick={toggle} disabled={busy} className="text-[11px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">{busy ? "…" : trackLots ? "Turn off" : "Turn on"}</button>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}

function BatchesTab({ orgId }) {
  const [days, setDays] = useState(30);
  const [expiring, setExpiring] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [trace, setTrace] = useState(null);
  const [tracing, setTracing] = useState(false);

  useEffect(() => {
    setExpiring(null);
    api(`/api/orgs/inventory/lots?orgId=${orgId}&expiringWithinDays=${days}`).then((d) => setExpiring(d.lots)).catch((err) => setError(err.message));
  }, [orgId, days]);

  async function runTrace(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setTracing(true); setError("");
    try { setTrace(await api(`/api/orgs/inventory/lots?orgId=${orgId}&lotNumber=${encodeURIComponent(query.trim())}`)); } catch (err) { setError(err.message); } finally { setTracing(false); }
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[var(--inaya-text-primary)] text-sm font-bold mr-auto">Expiring soon</p>
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-lg border ${days === d ? "bg-[#00f2fe]/15 text-[#00f2fe] border-[#00f2fe]/30" : "bg-black/45 text-[var(--inaya-text-muted)] border-white/15"}`}>{d} days</button>
          ))}
        </div>
        {!expiring ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : expiring.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No batches in stock expire within {days} days. Turn on batch tracking on a product to record batch numbers and expiry dates.</p>
        ) : (
          <div className="space-y-2">
            {expiring.map((l) => (
              <div key={`${l.productId}-${l.warehouseId}-${l.lotNumber}`} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{l.productName}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">Batch {l.lotNumber} · {l.warehouseName}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <ExpiryBadge expiryDate={l.expiryDate} days={l.daysToExpiry} />
                  <span className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{l.quantity}{l.unit && l.unit !== "each" ? ` ${l.unit}` : ""}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-3">
        <p className="text-[var(--inaya-text-primary)] text-sm font-bold">Trace a batch</p>
        <form onSubmit={runTrace} className="flex gap-2">
          <input aria-label="Batch / lot number" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Batch / lot number" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button disabled={tracing || !query.trim()} className="text-[11px] font-bold uppercase px-3 rounded-lg bg-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{tracing ? "…" : "Trace"}</button>
        </form>
        {trace && (
          trace.movements.length === 0 && trace.lots.length === 0 ? <p className="text-[var(--inaya-text-muted)] text-xs">No batch &ldquo;{trace.lotNumber}&rdquo; found.</p> : (
            <div className="space-y-3">
              {trace.lots.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Where it is now</p>
                  {trace.lots.map((l) => (
                    <div key={`${l.productId}-${l.warehouseId}`} className="flex items-center justify-between text-xs">
                      <span className="text-[var(--inaya-text-primary)]">{l.productName} · {l.warehouseName}</span>
                      <span className="flex items-center gap-2"><ExpiryBadge expiryDate={l.expiryDate} days={l.daysToExpiry} /><span className="font-mono tabular-nums text-[var(--inaya-text-primary)]">{l.quantity}</span></span>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-1.5">
                <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">History</p>
                {trace.movements.map((m, i) => (
                  <div key={i} className="text-xs border-b border-white/5 pb-1.5 last:border-0">
                    <span className={m.quantity > 0 ? "text-emerald-400" : "text-red-400"}>{m.quantity > 0 ? "+" : ""}{m.quantity}</span>
                    <span className="text-[var(--inaya-text-primary)]"> {m.type.toLowerCase().replace("_", " ")} · {m.productName} · {m.warehouseName}</span>
                    {m.customerName ? <span className="text-[var(--inaya-text-primary)]"> → <strong>{m.customerName}</strong> ({m.orderNumber})</span> : m.note && <span className="text-[var(--inaya-text-muted)]"> · {m.note}</span>}
                    <div className="text-[11px] font-mono text-[#8a96ab]">{m.actorEmail} · {new Date(m.createdAt).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </div>
    </div>
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
              {m.lots && <div className="text-[11px] font-mono text-[var(--inaya-text-muted)] mt-0.5">{lotsLabel(m.lots)}</div>}
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
  useErpCreate("warehouses", () => setShowCreate(true));
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
        <input aria-label="Search warehouses" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search warehouses…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
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
        <select aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input aria-label="Warehouse name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Warehouse name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Location (optional)" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
