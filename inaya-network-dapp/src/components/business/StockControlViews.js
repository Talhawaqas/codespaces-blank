"use client";

// src/components/business/StockControlViews.js -- Inaya Commerce Phase 3 (Advanced Inventory Intelligence) screens, used
// as tabs of the Inventory view and inside the product and purchase-order details:
//   AvailabilityTab  on hand / reserved / available / in transit / incoming / backordered / available-to-promise
//   TransfersTab     request -> approve -> dispatch -> receive (partial, short, damaged) -> cancel / reverse
//   CountsTab        full / cycle / blind counts, scanning, CSV import/export, variance review and approval
//   ReplenishTab     explained reorder suggestions, overrides, purchase requests, forecast accuracy, valuation
//   SuppliersCatalogTab  supplier SKUs, prices, lead times, MOQ, returns to suppliers, invoice proposals
//   ProductStockSettings / PoControls  small sections embedded in existing detail screens
// Every action is checked again on the server (src/lib/stock-control/*); these screens only offer what makes sense.

import { useState, useEffect, useCallback, useRef } from "react";

const f = "w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]";
const pbtn = "py-2 px-3 rounded-xl text-[11px] font-bold uppercase bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40";
const gbtn = "py-2 px-3 rounded-xl text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40";
const box = "bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4";
const muted = "text-[var(--inaya-text-muted)]";
const n = (v) => (v === null || v === undefined ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
async function api(path, { orgId, method = "GET", body } = {}) {
  const url = `/api/orgs/stock/${path}${method === "GET" ? `${path.includes("?") ? "&" : "?"}orgId=${orgId}` : ""}`;
  const r = await fetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify({ orgId, ...body }) } : {}) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { code: d.code, data: d }); return d;
}
const get = (url) => fetch(url, { credentials: "include" }).then((r) => r.json());
function useLists(orgId) {
  const [products, setProducts] = useState([]); const [warehouses, setWarehouses] = useState([]); const [suppliers, setSuppliers] = useState([]);
  useEffect(() => {
    get(`/api/orgs/inventory/products?orgId=${orgId}`).then((d) => setProducts(d.products || [])).catch(() => {});
    get(`/api/orgs/inventory/warehouses?orgId=${orgId}`).then((d) => setWarehouses(d.warehouses || [])).catch(() => {});
    get(`/api/orgs/procurement/suppliers?orgId=${orgId}`).then((d) => setSuppliers(d.suppliers || [])).catch(() => {});
  }, [orgId]);
  return { products, warehouses, suppliers };
}
function Modal({ title, onClose, children }) {
  return <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-2" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
    <div className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-4 w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center mb-3"><h3 className="font-bold text-sm text-[var(--inaya-text-primary)] flex-1">{title}</h3><button className={gbtn} aria-label="Close" onClick={onClose}>✕</button></div>{children}</div></div>;
}
const Msg = ({ ok, err }) => <>{ok && <p className="text-emerald-400 text-xs">{ok}</p>}{err && <p className="text-red-400 text-xs" role="alert">{err}</p>}</>;
const STATUS_TONE = { OUT: "text-red-400", BELOW_SAFETY: "text-red-400", REORDER: "text-amber-400", OVER_MAX: "text-amber-400", QUARANTINE: "text-[#a78bfa]", OK: "text-emerald-400" };

// ================================================================ Availability
export function AvailabilityTab({ orgId }) {
  const { warehouses } = useLists(orgId); const [wh, setWh] = useState(""); const [d, setD] = useState(null); const [q, setQ] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { setD(null); api(`availability${wh ? `?warehouseId=${wh}` : ""}`, { orgId }).then(setD).catch((e) => setErr(e.message)); }, [orgId, wh]);
  const rows = (d?.rows || []).filter((r) => !q || `${r.name} ${r.sku}`.toLowerCase().includes(q.toLowerCase()));
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2"><select aria-label="Location" className={`${f} !w-auto`} value={wh} onChange={(e) => setWh(e.target.value)}><option value="">All locations</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <input aria-label="Search products" className={`${f} !w-60`} placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} /></div>
    <p className={`text-[11px] ${muted}`}>Available = on hand − reserved (what the till, orders and transfers can take). Available to promise = available + in transit + incoming − backordered. Kits show how many complete kits the components allow.</p>
    <Msg err={err} />
    <div className={`${box} overflow-x-auto`}>{!d ? <p className={`${muted} text-sm`}>Loading…</p> : !rows.length ? <p className={`${muted} text-sm`}>No stock yet.</p> :
      <table className="w-full text-xs"><thead><tr className={`text-left ${muted}`}><th className="py-1">Product</th><th>Location</th><th className="text-right">On hand</th><th className="text-right">Reserved</th><th className="text-right">Available</th><th className="text-right">In transit</th><th className="text-right">Incoming</th><th className="text-right">Backordered</th><th className="text-right">ATP</th><th>Status</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={`${r.productId}${r.warehouseId}`} className="border-t border-white/5 text-[var(--inaya-text-primary)]"><td className="py-1.5">{r.name} <span className={muted}>{r.sku}{r.bin ? ` · bin ${r.bin}` : ""}</span></td><td>{r.warehouse}</td>
          <td className="text-right font-mono">{n(r.onHand)}</td><td className="text-right font-mono">{n(r.reserved)}</td><td className="text-right font-mono font-bold">{n(r.available)}</td><td className="text-right font-mono">{n(r.inTransit)}</td><td className="text-right font-mono">{n(r.incoming)}{r.nextExpected ? <span className={muted}> ({r.nextExpected})</span> : null}</td><td className="text-right font-mono">{n(r.backordered)}</td><td className="text-right font-mono">{n(r.atp)}</td>
          <td className={STATUS_TONE[r.status] || muted}>{r.kit ? "kit" : (r.status || "").toLowerCase().replaceAll("_", " ")}</td></tr>)}</tbody></table>}</div>
  </div>;
}

// ================================================================ Transfers
const TR_TONE = { REQUESTED: "text-amber-400", APPROVED: "text-[#00f2fe]", DISPATCHED: "text-[#00f2fe]", PARTIALLY_RECEIVED: "text-amber-400", RECEIVED: "text-emerald-400", RECEIVED_WITH_DISCREPANCY: "text-amber-400", CANCELLED: muted, REVERSED: muted };
export function TransfersTab({ orgId }) {
  const lists = useLists(orgId); const [rows, setRows] = useState(null); const [open, setOpen] = useState(null); const [create, setCreate] = useState(false); const [err, setErr] = useState("");
  const load = useCallback(() => api("transfers", { orgId }).then((d) => setRows(d.transfers)).catch((e) => setErr(e.message)), [orgId]);
  useEffect(() => { load(); }, [load]);
  return <div className="space-y-3">
    <div className="flex"><button className={`${pbtn} ml-auto`} onClick={() => setCreate(true)}>+ Request transfer</button></div><Msg err={err} />
    <div className={`${box} space-y-2`}>{!rows ? <p className={`${muted} text-sm`}>Loading…</p> : !rows.length ? <p className={`${muted} text-sm`}>No transfers yet. A transfer is requested, approved (stock is held at the source), dispatched (in transit) and received.</p> :
      rows.map((t) => <button key={t.id} onClick={() => setOpen(t)} className="w-full text-left bg-black/20 border border-white/5 rounded-lg p-3 hover:bg-white/5 flex items-center gap-2"><span className="flex-1 text-sm text-[var(--inaya-text-primary)]">{t.number} · {t.from} → {t.to}<span className={`block text-[11px] ${muted}`}>{t.lines.length} product(s) · requested by {t.requestedBy}</span></span><span className={`text-[11px] font-bold uppercase ${TR_TONE[t.status] || ""}`}>{t.status.toLowerCase().replaceAll("_", " ")}</span></button>)}</div>
    {create && <CreateTransfer orgId={orgId} {...lists} onClose={() => setCreate(false)} onDone={() => { setCreate(false); load(); }} />}
    {open && <TransferDetail orgId={orgId} t={open} onClose={() => setOpen(null)} onChanged={(t) => { setOpen(t); load(); }} />}
  </div>;
}
function CreateTransfer({ orgId, products, warehouses, onClose, onDone }) {
  const [x, setX] = useState({ fromWarehouseId: "", toWarehouseId: "", note: "", lines: [{ productId: "", quantity: "" }] }); const [err, setErr] = useState("");
  const stocked = products.filter((p) => !["SERVICE", "NON_STOCK", "KIT"].includes(p.productType));
  return <Modal title="Request a transfer" onClose={onClose}><div className="space-y-2">
    <div className="grid grid-cols-2 gap-2"><select aria-label="From" className={f} value={x.fromWarehouseId} onChange={(e) => setX({ ...x, fromWarehouseId: e.target.value })}><option value="">From…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <select aria-label="To" className={f} value={x.toWarehouseId} onChange={(e) => setX({ ...x, toWarehouseId: e.target.value })}><option value="">To…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
    {x.lines.map((l, i) => <div key={i} className="grid grid-cols-[1fr_90px] gap-2"><select aria-label="Product" className={f} value={l.productId} onChange={(e) => setX({ ...x, lines: x.lines.map((y, k) => (k === i ? { ...y, productId: e.target.value } : y)) })}><option value="">Product…</option>{stocked.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}</select>
      <input aria-label="Quantity" type="number" min="0" className={f} value={l.quantity} onChange={(e) => setX({ ...x, lines: x.lines.map((y, k) => (k === i ? { ...y, quantity: e.target.value } : y)) })} placeholder="Qty" /></div>)}
    <button className={gbtn} onClick={() => setX({ ...x, lines: [...x.lines, { productId: "", quantity: "" }] })}>+ Add product</button>
    <input aria-label="Note" className={f} placeholder="Note (optional)" value={x.note} onChange={(e) => setX({ ...x, note: e.target.value })} /><Msg err={err} />
    <button className={`${pbtn} w-full`} onClick={async () => { try { await api("transfers", { orgId, method: "POST", body: { ...x, lines: x.lines.filter((l) => l.productId && Number(l.quantity) > 0).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) } }); onDone(); } catch (e) { setErr(e.message); } }}>Request</button>
  </div></Modal>;
}
function TransferDetail({ orgId, t, onClose, onChanged }) {
  const [err, setErr] = useState(""); const [ok, setOk] = useState(""); const [rx, setRx] = useState(() => t.lines.map((l) => ({ received: String(l.open || ""), short: "", damaged: "", reason: "" }))); const [busy, setBusy] = useState(false);
  useEffect(() => { setRx(t.lines.map((l) => ({ received: String(l.open || ""), short: "", damaged: "", reason: "" }))); }, [t]);
  const act = async (action, body = {}) => { setBusy(true); setErr(""); setOk(""); try { const d = await api(`transfers/${t.id}/${action}`, { orgId, method: "POST", body }); onChanged(d.transfer); setOk("Saved."); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return <Modal title={`${t.number} · ${t.from} → ${t.to}`} onClose={onClose}><div className="space-y-3 text-xs text-[var(--inaya-text-primary)]">
    <p className={muted}>Status: <b className={TR_TONE[t.status]}>{t.status.toLowerCase().replaceAll("_", " ")}</b> · requested by {t.requestedBy}{t.approvedBy ? ` · approved by ${t.approvedBy}` : ""}{t.note ? ` · ${t.note}` : ""}</p>
    <table className="w-full"><thead><tr className={`text-left ${muted}`}><th>Product</th><th className="text-right">Asked</th><th className="text-right">Sent</th><th className="text-right">Received</th><th className="text-right">Short</th><th className="text-right">Damaged</th>{["DISPATCHED", "PARTIALLY_RECEIVED"].includes(t.status) && <th>Arrived now</th>}</tr></thead>
      <tbody>{t.lines.map((l, i) => <tr key={i} className="border-t border-white/5"><td className="py-1">{l.name}</td><td className="text-right">{n(l.quantity)}</td><td className="text-right">{n(l.dispatchedQty)}</td><td className="text-right">{n(l.receivedQty)}</td><td className="text-right">{n(l.shortQty)}</td><td className="text-right">{n(l.damagedQty)}</td>
        {["DISPATCHED", "PARTIALLY_RECEIVED"].includes(t.status) && <td>{l.open > 0 ? <div className="grid grid-cols-3 gap-1 min-w-[180px]">
          <input aria-label={`Received ${l.name}`} className={f} type="number" min="0" value={rx[i]?.received || ""} onChange={(e) => setRx(rx.map((y, k) => (k === i ? { ...y, received: e.target.value } : y)))} placeholder="ok" />
          <input aria-label={`Short ${l.name}`} className={f} type="number" min="0" value={rx[i]?.short || ""} onChange={(e) => setRx(rx.map((y, k) => (k === i ? { ...y, short: e.target.value } : y)))} placeholder="short" />
          <input aria-label={`Damaged ${l.name}`} className={f} type="number" min="0" value={rx[i]?.damaged || ""} onChange={(e) => setRx(rx.map((y, k) => (k === i ? { ...y, damaged: e.target.value } : y)))} placeholder="damaged" />
          {(Number(rx[i]?.short) > 0 || Number(rx[i]?.damaged) > 0) && <input aria-label={`Reason ${l.name}`} className={`${f} col-span-3`} value={rx[i]?.reason || ""} onChange={(e) => setRx(rx.map((y, k) => (k === i ? { ...y, reason: e.target.value } : y)))} placeholder="What happened?" />}</div> : <span className={muted}>done</span>}</td>}</tr>)}</tbody></table>
    {t.lines.some((l) => l.discrepancies.length) && <div className={muted}>{t.lines.flatMap((l) => l.discrepancies.map((d, k) => <p key={`${l.productId}${k}`}>{l.name}: {d.short ? `${d.short} short` : ""}{d.short && d.damaged ? ", " : ""}{d.damaged ? `${d.damaged} damaged` : ""} · {d.reason} · {d.by}</p>))}</div>}
    <Msg ok={ok} err={err} />
    <div className="flex flex-wrap gap-2">
      {t.status === "REQUESTED" && <button className={pbtn} disabled={busy} onClick={() => act("approve")}>Approve (hold stock)</button>}
      {t.status === "APPROVED" && <button className={pbtn} disabled={busy} onClick={() => act("dispatch")}>Dispatch everything</button>}
      {["DISPATCHED", "PARTIALLY_RECEIVED"].includes(t.status) && <button className={pbtn} disabled={busy} onClick={() => act("receive", { lines: rx.map((r, i) => ({ lineIndex: i, received: Number(r.received) || 0, short: Number(r.short) || 0, damaged: Number(r.damaged) || 0, reason: r.reason })).filter((r) => r.received + r.short + r.damaged > 0) })}>Record what arrived</button>}
      {["REQUESTED", "APPROVED"].includes(t.status) && <button className={gbtn} disabled={busy} onClick={() => { const reason = window.prompt("Why cancel?") ?? ""; act("cancel", { reason }); }}>Cancel</button>}
      {t.status === "DISPATCHED" && <button className={gbtn} disabled={busy} onClick={() => { const reason = window.prompt("Why reverse (stock goes back to the source)?"); if (reason) act("reverse", { reason }); }}>Reverse</button>}
    </div>
    {t.history?.length > 0 && <details className={muted}><summary className="cursor-pointer">History</summary>{t.history.map((h, i) => <p key={i}>{new Date(h.at).toLocaleString()} · {h.to.toLowerCase().replaceAll("_", " ")} · {h.by}</p>)}</details>}
  </div></Modal>;
}

// ================================================================ Stock counts
export function CountsTab({ orgId }) {
  const { warehouses, products } = useLists(orgId); const [rows, setRows] = useState(null); const [open, setOpen] = useState(null); const [create, setCreate] = useState(false); const [err, setErr] = useState("");
  const load = useCallback(() => api("counts", { orgId }).then((d) => setRows(d.counts)).catch((e) => setErr(e.message)), [orgId]);
  useEffect(() => { load(); }, [load]);
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  return <div className="space-y-3">
    <div className="flex"><button className={`${pbtn} ml-auto`} onClick={() => setCreate(true)}>+ Start a count</button></div><Msg err={err} />
    <div className={`${box} space-y-2`}>{!rows ? <p className={`${muted} text-sm`}>Loading…</p> : !rows.length ? <p className={`${muted} text-sm`}>No counts yet. Counts are saved as you go, so an interrupted count carries on where it stopped.</p> :
      rows.map((x) => <button key={x.id} onClick={() => setOpen(x.id)} className="w-full text-left bg-black/20 border border-white/5 rounded-lg p-3 hover:bg-white/5 flex items-center gap-2"><span className="flex-1 text-sm text-[var(--inaya-text-primary)]">{x.number} · {x.warehouse} · {x.scope.toLowerCase()}{x.blind ? " · blind" : ""}<span className={`block text-[11px] ${muted}`}>{x.progress.counted}/{x.progress.total} counted · {x.startedBy}</span></span><span className="text-[11px] font-bold uppercase text-[#00f2fe]">{x.status.toLowerCase().replaceAll("_", " ")}</span></button>)}</div>
    {create && <CreateCount orgId={orgId} warehouses={warehouses} categories={categories} onClose={() => setCreate(false)} onDone={(c) => { setCreate(false); load(); setOpen(c.id); }} />}
    {open && <CountDetail orgId={orgId} countId={open} onClose={() => { setOpen(null); load(); }} />}
  </div>;
}
function CreateCount({ orgId, warehouses, categories, onClose, onDone }) {
  const [x, setX] = useState({ warehouseId: "", scope: "FULL", category: "", blind: false }); const [err, setErr] = useState("");
  return <Modal title="Start a stock count" onClose={onClose}><div className="space-y-2">
    <select aria-label="Location" className={f} value={x.warehouseId} onChange={(e) => setX({ ...x, warehouseId: e.target.value })}><option value="">Location…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
    <div className="flex gap-2">{[["FULL", "Full stocktake"], ["CYCLE", "Cycle count (one category)"]].map(([k, l]) => <button key={k} className={x.scope === k ? pbtn : gbtn} onClick={() => setX({ ...x, scope: k })}>{l}</button>)}</div>
    {x.scope === "CYCLE" && <select aria-label="Category" className={f} value={x.category} onChange={(e) => setX({ ...x, category: e.target.value })}><option value="">Category…</option>{categories.map((c) => <option key={c}>{c}</option>)}</select>}
    <label className={`text-xs ${muted} flex items-center gap-2`}><input type="checkbox" checked={x.blind} onChange={(e) => setX({ ...x, blind: e.target.checked })} /> Blind count (counters don't see the expected quantity)</label><Msg err={err} />
    <button className={`${pbtn} w-full`} onClick={async () => { try { const d = await api("counts", { orgId, method: "POST", body: x }); onDone(d.count); } catch (e) { setErr(e.message); } }}>Start</button>
  </div></Modal>;
}
function CountDetail({ orgId, countId, onClose }) {
  const [x, setX] = useState(null); const [code, setCode] = useState(""); const [qty, setQty] = useState("1"); const [err, setErr] = useState(""); const [ok, setOk] = useState(""); const inRef = useRef(null);
  const load = useCallback(() => api(`counts/${countId}`, { orgId }).then((d) => setX(d.count)).catch((e) => setErr(e.message)), [orgId, countId]);
  useEffect(() => { load(); }, [load]);
  const scan = async () => { if (!code.trim()) return; setErr(""); setOk(""); try { const d = await api(`counts/${countId}/scan`, { orgId, method: "POST", body: { scanId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, barcode: code.trim(), quantity: Number(qty) || 1 } }); setOk(d.duplicate ? "Already counted (repeat scan ignored)." : `${d.line.name}: ${d.line.counted}`); setCode(""); setQty("1"); load(); } catch (e) { setErr(e.message); } inRef.current?.focus(); };
  const act = async (a, body = {}) => { setErr(""); setOk(""); try { const d = await api(`counts/${countId}/${a}`, { orgId, method: "POST", body }); setX(d.count); setOk("Saved."); } catch (e) { if (e.code === "UNCOUNTED" && window.confirm(`${e.message}\n\nSubmit and treat the uncounted products as zero?`)) act(a, { uncountedAsZero: true }); else setErr(e.message); } };
  if (!x) return <Modal title="Stock count" onClose={onClose}><Msg err={err} /><p className={muted}>Loading…</p></Modal>;
  const counting = x.status === "IN_PROGRESS";
  return <Modal title={`${x.number} · ${x.warehouse}`} onClose={onClose}><div className="space-y-3 text-xs text-[var(--inaya-text-primary)]">
    <p className={muted}>{x.scope.toLowerCase()} count{x.blind ? " · blind" : ""} · {x.status.toLowerCase().replaceAll("_", " ")} · {x.progress.counted}/{x.progress.total} counted</p>
    {counting && <div className="grid grid-cols-[1fr_70px_auto] gap-2"><input ref={inRef} autoFocus aria-label="Scan barcode or SKU" className={f} placeholder="Scan a barcode or type a SKU, then Enter" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && scan()} />
      <input aria-label="Quantity per scan" className={f} type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} /><button className={pbtn} onClick={scan}>Add</button></div>}
    <Msg ok={ok} err={err} />
    <div className="max-h-[45vh] overflow-auto"><table className="w-full"><thead><tr className={`text-left ${muted}`}><th>Product</th>{!x.blind || !counting ? <th className="text-right">Expected</th> : null}<th className="text-right">Counted</th>{!counting && <><th className="text-right">Variance</th><th className="text-right">Value</th></>}</tr></thead>
      <tbody>{x.lines.map((l) => <tr key={l.productId} className="border-t border-white/5"><td className="py-1">{l.name} <span className={muted}>{l.sku}</span></td>{l.expected !== undefined && <td className="text-right font-mono">{n(l.expected)}</td>}
        <td className="text-right">{counting ? <input key={`${l.productId}:${l.counted}`} aria-label={`Counted ${l.name}`} className={`${f} !w-20 text-right`} type="number" min="0" defaultValue={l.counted ?? ""} onBlur={async (e) => { if (e.target.value === "" || Number(e.target.value) === l.counted) return; try { await api(`counts/${countId}/set`, { orgId, method: "POST", body: { productId: l.productId, counted: Number(e.target.value) } }); load(); } catch (er) { setErr(er.message); } }} /> : n(l.counted)}</td>
        {!counting && <><td className={`text-right font-mono ${l.variance < 0 ? "text-red-400" : l.variance > 0 ? "text-amber-400" : ""}`}>{n(l.variance)}</td><td className="text-right font-mono">{n(l.varianceValue)}</td></>}</tr>)}</tbody></table></div>
    {!counting && <p className={muted}>Net variance value: <b>{n(x.lines.reduce((s, l) => s + (l.varianceValue || 0), 0))}</b> (at average cost). Expected allows for sales and receipts made while the count ran.</p>}
    <div className="flex flex-wrap gap-2">
      <a className={gbtn} href={`/api/orgs/stock/counts/${countId}/export?orgId=${orgId}`} download>Export sheet (CSV)</a>
      {counting && <label className={`${gbtn} cursor-pointer`}>Import sheet<input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { const d = await api(`counts/${countId}/import`, { orgId, method: "POST", body: { csv: await file.text() } }); setOk(`${d.applied} line(s) imported${d.problems.length ? `; ${d.problems.length} problem(s): ${d.problems.slice(0, 3).join("; ")}` : ""}.`); load(); } catch (er) { setErr(er.message); } e.target.value = ""; }} /></label>}
      {counting && <button className={pbtn} onClick={() => act("submit")}>Submit for review</button>}
      {x.status === "SUBMITTED" && <><button className={pbtn} onClick={() => { const reason = window.prompt("Reason for the adjustment (shown in the stock history)", "Stock count"); if (reason) act("approve", { reason }); }}>Approve adjustments</button><button className={gbtn} onClick={() => act("reject", { reason: window.prompt("What needs recounting?") ?? "" })}>Send back for recount</button></>}
      {["IN_PROGRESS", "SUBMITTED"].includes(x.status) && <button className={gbtn} onClick={() => window.confirm("Cancel this count? Nothing is adjusted.") && act("cancel")}>Cancel count</button>}
    </div>
  </div></Modal>;
}

// ================================================================ Replenishment
const FLAG_TONE = { STOCKOUT_RISK: "text-red-400", DEAD_STOCK: "text-amber-400", OVERSTOCK: "text-amber-400", SLOW_MOVING: "text-amber-400", ABOVE_MAX: "text-amber-400", MARGIN_EROSION: "text-red-400", LEAD_TIME_VARIANCE: "text-amber-400", BACKORDERS: "text-amber-400", TOO_NEW: "text-[var(--inaya-text-muted)]" };
export function ReplenishTab({ orgId }) {
  const { warehouses } = useLists(orgId); const [wh, setWh] = useState(""); const [win, setWin] = useState(90); const [d, setD] = useState(null); const [acc, setAcc] = useState(null); const [val, setVal] = useState(null); const [only, setOnly] = useState(true); const [err, setErr] = useState(""); const [ok, setOk] = useState("");
  const load = useCallback(() => { setD(null); api(`replenishment?windowDays=${win}${wh ? `&warehouseId=${wh}` : ""}`, { orgId }).then(setD).catch((e) => setErr(e.message)); api("replenishment/accuracy", { orgId }).then(setAcc).catch(() => {}); api("valuation", { orgId }).then(setVal).catch(() => {}); }, [orgId, win, wh]);
  useEffect(() => { load(); }, [load]);
  const rows = (d?.rows || []).filter((r) => !only || r.suggestedQty > 0 || r.flags.length);
  const request = async (r, qty) => { setErr(""); setOk(""); try { const x = await api("replenishment/request", { orgId, method: "POST", body: { productId: r.productId, warehouseId: r.warehouseId, quantity: qty, supplierId: r.supplier?.id, unitPrice: r.supplier?.price, explanation: r.explanation } }); setOk(x.created ? `Draft purchase request created for ${r.name}. Review it in Purchasing.` : `${r.name} already has an open purchase request.`); } catch (e) { setErr(e.message); } };
  const override = async (r) => { const v = window.prompt(`Order how many ${r.name}? (suggested ${r.suggestedQty})`, String(r.suggestedQty)); if (v === null) return; const reason = window.prompt("Reason for changing the suggestion"); if (!reason) return; try { await api("replenishment/override", { orgId, method: "POST", body: { productId: r.productId, warehouseId: r.warehouseId, quantity: Number(v), suggested: r.suggestedQty, reason } }); load(); } catch (e) { setErr(e.message); } };
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2 items-center"><select aria-label="Location" className={`${f} !w-auto`} value={wh} onChange={(e) => setWh(e.target.value)}><option value="">All locations</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <select aria-label="Data window" className={`${f} !w-auto`} value={win} onChange={(e) => setWin(Number(e.target.value))}>{[30, 60, 90, 180, 365].map((x) => <option key={x} value={x}>Last {x} days</option>)}</select>
      <label className={`text-xs ${muted} flex items-center gap-1`}><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Only items needing attention</label></div>
    <p className={`text-[11px] ${muted}`}>Suggestions are estimates from your sales history, not certainties. Each row explains its data, lead time and safety stock. Change a suggestion and give a reason; it is kept next to the original.</p>
    <Msg ok={ok} err={err} />
    <div className={`${box} space-y-2`}>{!d ? <p className={`${muted} text-sm`}>Working it out…</p> : !rows.length ? <p className={`${muted} text-sm`}>Nothing needs reordering right now.</p> : rows.map((r) => <div key={`${r.productId}${r.warehouseId}`} className="bg-black/20 border border-white/5 rounded-lg p-3 text-xs text-[var(--inaya-text-primary)] space-y-1">
      <div className="flex flex-wrap items-center gap-2"><b className="text-sm">{r.name}</b><span className={muted}>{r.sku} · {r.warehouse}</span><span className="ml-auto text-[11px] font-bold uppercase">{r.confidence.toLowerCase()} confidence</span></div>
      <p className={muted}>Available {n(r.available)} · ATP {n(r.atp)} · {n(r.dailyDemand)}/day · {r.daysOfCover === null ? "no recent sales" : `${n(r.daysOfCover)} days of cover`} · lead time {n(r.leadTimeDays)} days · reorder point {n(r.reorderPoint)}</p>
      {r.flags.map((fl, i) => <p key={i} className={FLAG_TONE[fl.kind] || ""}>• {fl.text}</p>)}
      <details><summary className={`cursor-pointer ${muted}`}>Why?</summary><p className={muted}>{r.explanation} Data: {r.dataWindow.historyDays} days of history in a {r.dataWindow.days}-day window; seasonality {String(r.dataWindow.seasonality)}.</p></details>
      {r.transferSuggestion && <p className="text-[#00f2fe]">↔ {r.transferSuggestion.text}</p>}
      {(r.suggestedQty > 0 || r.override) && <div className="flex flex-wrap gap-2 items-center pt-1">
        <span>{r.override ? <>Order <b>{n(r.override.quantity)}</b> <span className={muted}>(changed from {n(r.suggestedQty)}: {r.override.reason})</span></> : <>Suggest ordering <b>{n(r.suggestedQty)}</b>{r.supplier ? ` from ${r.supplier.name}` : ""}</>}</span>
        <button className={pbtn} onClick={() => request(r, r.override?.quantity ?? r.suggestedQty)}>Create purchase request</button><button className={gbtn} onClick={() => override(r)}>Change quantity</button></div>}
    </div>)}</div>
    <div className="grid md:grid-cols-2 gap-3">
      <div className={box}><h4 className="text-sm font-bold text-[var(--inaya-text-primary)] mb-1">Forecast accuracy</h4><p className={`text-xs ${muted}`}>{acc ? (acc.mape === null ? acc.note : `Average error ${acc.mape}% over ${acc.evaluated} past 30-day forecasts.`) : "…"}</p></div>
      <div className={box}><h4 className="text-sm font-bold text-[var(--inaya-text-primary)] mb-1">Stock value by branch</h4>{val ? <><table className="w-full text-xs text-[var(--inaya-text-primary)]"><tbody>{val.branches.map((b) => <tr key={b.warehouseId}><td>{b.warehouse}{b.estimate ? <span className="text-amber-400"> (estimate)</span> : null}</td><td className="text-right font-mono">{n(b.value)}</td></tr>)}<tr className="border-t border-white/10 font-bold"><td>Total</td><td className="text-right font-mono">{n(val.total)}</td></tr></tbody></table><p className={`text-[11px] ${muted} mt-1`}>{val.note}</p></> : <p className={`text-xs ${muted}`}>…</p>}</div>
    </div>
  </div>;
}

// ================================================================ Supplier catalogue, returns and invoice proposals
export function SuppliersCatalogTab({ orgId }) {
  const { suppliers, products, warehouses } = useLists(orgId); const [sup, setSup] = useState(""); const [items, setItems] = useState([]); const [rets, setRets] = useState(null); const [err, setErr] = useState(""); const [ok, setOk] = useState("");
  const [form, setForm] = useState({ productId: "", supplierSku: "", price: "", currency: "", leadTimeDays: "", moq: "", orderMultiple: "", preferred: false });
  const [ret, setRet] = useState(null); const [docId, setDocId] = useState(""); const [prop, setProp] = useState(null);
  const load = useCallback(() => { if (sup) api(`supplier-items?supplierId=${sup}`, { orgId }).then((d) => setItems(d.items)).catch((e) => setErr(e.message)); api(`supplier-returns${sup ? `?supplierId=${sup}` : ""}`, { orgId }).then(setRets).catch(() => {}); }, [orgId, sup]);
  useEffect(() => { load(); }, [load]);
  const pname = (id) => products.find((p) => p.id === id)?.name || id;
  return <div className="space-y-3">
    <select aria-label="Supplier" className={`${f} !w-72`} value={sup} onChange={(e) => setSup(e.target.value)}><option value="">Choose a supplier…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
    <Msg ok={ok} err={err} />
    {sup && <div className={`${box} space-y-2`}><h4 className="text-sm font-bold text-[var(--inaya-text-primary)]">Catalogue</h4>
      <table className="w-full text-xs text-[var(--inaya-text-primary)]"><thead><tr className={`text-left ${muted}`}><th>Product</th><th>Their SKU</th><th className="text-right">Price</th><th className="text-right">Lead time</th><th className="text-right">Measured</th><th className="text-right">MOQ</th><th className="text-right">Multiple</th><th /></tr></thead>
        <tbody>{items.map((x) => <tr key={x.id} className="border-t border-white/5"><td className="py-1">{pname(x.productId)}{x.preferred ? <span className="text-emerald-400"> ★ preferred</span> : null}</td><td>{x.supplierSku || "–"}</td><td className="text-right">{n(x.price)} {x.currency || ""}{x.priceHistory.length > 1 ? <span className={muted}> ({x.priceHistory.length} prices)</span> : null}</td><td className="text-right">{n(x.leadTimeDays)}d</td><td className="text-right">{x.avgLeadTimeDays === null ? "–" : `${n(x.avgLeadTimeDays)}d`}</td><td className="text-right">{n(x.moq)}</td><td className="text-right">{n(x.orderMultiple)}</td>
          <td className="text-right"><button className={gbtn} onClick={() => setForm({ productId: x.productId, supplierSku: x.supplierSku || "", price: x.price ?? "", currency: x.currency || "", leadTimeDays: x.leadTimeDays ?? "", moq: x.moq ?? "", orderMultiple: x.orderMultiple ?? "", preferred: x.preferred })}>Edit</button></td></tr>)}</tbody></table>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2"><select aria-label="Catalogue product" className={f} value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}><option value="">Product…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {[["supplierSku", "Their SKU"], ["price", "Price"], ["currency", "Currency"], ["leadTimeDays", "Lead time (days)"], ["moq", "Minimum order"], ["orderMultiple", "Order multiple"]].map(([k, l]) => <input key={k} aria-label={l} className={f} placeholder={l} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />)}
        <label className={`text-xs ${muted} flex items-center gap-1`}><input type="checkbox" checked={form.preferred} onChange={(e) => setForm({ ...form, preferred: e.target.checked })} /> preferred supplier</label></div>
      <button className={pbtn} disabled={!form.productId} onClick={async () => { setErr(""); try { await api("supplier-items", { orgId, method: "PUT", body: { ...form, supplierId: sup } }); setOk("Catalogue saved."); load(); } catch (e) { setErr(e.message); } }}>Save catalogue line</button>
    </div>}
    <div className={`${box} space-y-2`}><div className="flex items-center"><h4 className="text-sm font-bold text-[var(--inaya-text-primary)] flex-1">Returns to suppliers</h4>{sup && <button className={gbtn} onClick={() => setRet({ warehouseId: "", reason: "", lines: [{ productId: "", quantity: "" }] })}>+ New return</button>}</div>
      {rets && <p className={`text-[11px] ${muted}`}>Awaiting credit: {n(rets.outstandingValue)} · credited: {n(rets.creditedValue)}</p>}
      {(rets?.returns || []).map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-[var(--inaya-text-primary)] border-t border-white/5 pt-1"><span className="flex-1">{r.number} · {r.supplierName} · {r.lines.length} item(s) · {n(r.value)} · {r.reason}</span><span className="text-[11px] font-bold uppercase text-[#00f2fe]">{r.status.toLowerCase()}</span>
        {r.status === "DRAFT" && <button className={pbtn} onClick={async () => { try { await api(`supplier-returns/${r.id}/send`, { orgId, method: "POST", body: {} }); load(); } catch (e) { setErr(e.message); } }}>Send (stock leaves)</button>}
        {r.status === "SENT" && <button className={gbtn} onClick={async () => { const amount = window.prompt("Credit received (amount)"); if (amount === null) return; const settlement = (window.prompt("Settlement: CREDIT_NOTE, REFUND or REPLACEMENT", "CREDIT_NOTE") || "").toUpperCase(); const reference = window.prompt("Reference (credit note number)") || ""; try { await api(`supplier-returns/${r.id}/credit`, { orgId, method: "POST", body: { amount: Number(amount), settlement, reference } }); load(); } catch (e) { setErr(e.message); } }}>Record credit</button>}</div>)}
    </div>
    <div className={`${box} space-y-2`}><h4 className="text-sm font-bold text-[var(--inaya-text-primary)]">Supplier invoice → purchase order proposal</h4>
      <p className={`text-[11px] ${muted}`}>Paste the id of a supplier invoice read by the AI Bookkeeper. Inaya proposes which of your products each line is. Nothing is created until you approve the lines, and then only as a draft purchase order.</p>
      <div className="flex gap-2"><input aria-label="Bookkeeper document id" className={f} placeholder="Document id" value={docId} onChange={(e) => setDocId(e.target.value)} /><button className={gbtn} disabled={!docId} onClick={async () => { setErr(""); try { setProp(await api(`supplier-documents/${docId.trim()}/proposal`, { orgId, method: "POST", body: { supplierId: sup || undefined } })); } catch (e) { setErr(e.message); } }}>Propose</button></div>
      {prop && <ProposalReview orgId={orgId} prop={prop} warehouses={warehouses} supplierId={sup || prop.supplier?.id} onDone={(m) => { setOk(m); setProp(null); }} setErr={setErr} />}
    </div>
    {ret && <Modal title="Return to supplier" onClose={() => setRet(null)}><div className="space-y-2">
      <select aria-label="From location" className={f} value={ret.warehouseId} onChange={(e) => setRet({ ...ret, warehouseId: e.target.value })}><option value="">From location…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      {ret.lines.map((l, i) => <div key={i} className="grid grid-cols-[1fr_90px] gap-2"><select aria-label="Return product" className={f} value={l.productId} onChange={(e) => setRet({ ...ret, lines: ret.lines.map((y, k) => (k === i ? { ...y, productId: e.target.value } : y)) })}><option value="">Product…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input aria-label="Return quantity" className={f} type="number" min="0" value={l.quantity} onChange={(e) => setRet({ ...ret, lines: ret.lines.map((y, k) => (k === i ? { ...y, quantity: e.target.value } : y)) })} /></div>)}
      <input aria-label="Return reason" className={f} placeholder="Reason (e.g. faulty batch)" value={ret.reason} onChange={(e) => setRet({ ...ret, reason: e.target.value })} />
      <button className={`${pbtn} w-full`} onClick={async () => { try { await api("supplier-returns", { orgId, method: "POST", body: { ...ret, supplierId: sup, lines: ret.lines.filter((l) => l.productId && Number(l.quantity) > 0).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) } }); setRet(null); load(); } catch (e) { setErr(e.message); } }}>Create draft return</button>
    </div></Modal>}
  </div>;
}
function ProposalReview({ orgId, prop, warehouses, supplierId, onDone, setErr }) {
  const [pick, setPick] = useState(() => prop.lines.map((l) => ({ use: !!l.match, quantity: l.quantity ?? "", unitPrice: l.unitPrice ?? "" }))); const [wh, setWh] = useState("");
  return <div className="space-y-2 text-xs text-[var(--inaya-text-primary)]">
    <p className={muted}>Invoice {prop.invoiceNumber || "(no number)"} · {prop.supplier?.name || "supplier not identified"} · {prop.unmatched} unmatched line(s)</p>
    {prop.lines.map((l, i) => <div key={i} className="grid grid-cols-[auto_1fr_70px_80px] gap-2 items-center border-t border-white/5 pt-1"><input type="checkbox" aria-label={`Use line ${i + 1}`} disabled={!l.match} checked={pick[i].use} onChange={(e) => setPick(pick.map((p, k) => (k === i ? { ...p, use: e.target.checked } : p)))} />
      <span>{l.description}<span className={`block ${l.match ? "text-emerald-400" : "text-amber-400"}`}>{l.match ? `→ ${l.match.name} (${l.match.how}, ${Math.round(l.match.confidence * 100)}%)` : "no match: add it to the catalogue first"}</span></span>
      <input aria-label={`Quantity line ${i + 1}`} className={f} value={pick[i].quantity} onChange={(e) => setPick(pick.map((p, k) => (k === i ? { ...p, quantity: e.target.value } : p)))} /><input aria-label={`Price line ${i + 1}`} className={f} value={pick[i].unitPrice} onChange={(e) => setPick(pick.map((p, k) => (k === i ? { ...p, unitPrice: e.target.value } : p)))} /></div>)}
    <select aria-label="Receiving location" className={f} value={wh} onChange={(e) => setWh(e.target.value)}><option value="">Receiving location…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
    <button className={pbtn} disabled={!wh || !supplierId || !pick.some((p) => p.use)} onClick={async () => { try { const d = await api(`supplier-documents/${prop.documentId}/draft-po`, { orgId, method: "POST", body: { supplierId, warehouseId: wh, currency: prop.currency || "USD", lines: prop.lines.map((l, i) => ({ ...pick[i], productId: l.match?.productId })).filter((x) => x.use).map((x) => ({ productId: x.productId, quantity: Number(x.quantity), unitPrice: Number(x.unitPrice) })) } }); onDone(`Draft purchase order created from the invoice (it still needs approval). Id ${d.poId}.`); } catch (e) { setErr(e.message); } }}>Create draft purchase order</button>
  </div>;
}

// ================================================================ embedded sections
export function ProductStockSettings({ orgId, product, onChanged }) {
  const { warehouses, products, suppliers } = useLists(orgId);
  const [x, setX] = useState(() => ({ minStock: product.minStock ?? "", maxStock: product.maxStock ?? "", safetyStock: product.safetyStock ?? "", leadTimeDays: product.leadTimeDays ?? "", preferredSupplierId: product.preferredSupplierId || "", trackSerials: !!product.trackSerials, locationRules: product.locationRules || [], kitComponents: product.kitComponents || [] }));
  const [err, setErr] = useState(""); const [ok, setOk] = useState(""); const kit = product.productType === "KIT";
  const num = (v) => (v === "" || v === null ? null : Number(v));
  const save = async () => { setErr(""); setOk(""); try {
    const r = await fetch(`/api/orgs/inventory/products/${product.id}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, minStock: num(x.minStock), maxStock: num(x.maxStock), safetyStock: num(x.safetyStock), leadTimeDays: num(x.leadTimeDays), preferredSupplierId: x.preferredSupplierId || null, ...(kit ? { kitComponents: x.kitComponents.filter((c) => c.productId && Number(c.quantity) > 0).map((c) => ({ productId: c.productId, quantity: Number(c.quantity) })) } : { trackSerials: x.trackSerials }), locationRules: x.locationRules.map((r) => ({ warehouseId: r.warehouseId, ...(r.reorderThreshold !== "" && r.reorderThreshold != null ? { reorderThreshold: Number(r.reorderThreshold) } : {}), ...(r.minStock !== "" && r.minStock != null ? { minStock: Number(r.minStock) } : {}), ...(r.maxStock !== "" && r.maxStock != null ? { maxStock: Number(r.maxStock) } : {}), bin: r.bin || null })) }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not save."); setOk("Stock settings saved."); onChanged?.(); } catch (e) { setErr(e.message); } };
  const rule = (w) => x.locationRules.find((r) => r.warehouseId === w) || {};
  const setRule = (w, k, v) => setX({ ...x, locationRules: [...x.locationRules.filter((r) => r.warehouseId !== w), { ...rule(w), warehouseId: w, [k]: v }] });
  return <details className="border-t border-white/5 pt-3"><summary className="cursor-pointer text-xs font-bold uppercase text-[var(--inaya-text-muted)]">Stock control settings</summary><div className="space-y-2 mt-2 text-xs">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{[["minStock", "Min stock"], ["maxStock", "Max stock"], ["safetyStock", "Safety stock"], ["leadTimeDays", "Lead time (days)"]].map(([k, l]) => <label key={k} className={muted}>{l}<input aria-label={l} className={f} type="number" min="0" value={x[k]} onChange={(e) => setX({ ...x, [k]: e.target.value })} /></label>)}</div>
    <label className={`${muted} block`}>Preferred supplier<select aria-label="Preferred supplier" className={f} value={x.preferredSupplierId} onChange={(e) => setX({ ...x, preferredSupplierId: e.target.value })}><option value="">none</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    {!kit && <label className={`${muted} flex items-center gap-2`}><input type="checkbox" checked={x.trackSerials} onChange={(e) => setX({ ...x, trackSerials: e.target.checked })} /> Track serial numbers (one unique serial per unit; turns on batch tracking)</label>}
    {kit && <div className="space-y-1"><p className={muted}>Kit contents (selling one kit takes these from stock)</p>{x.kitComponents.map((c, i) => <div key={i} className="grid grid-cols-[1fr_80px] gap-2"><select aria-label="Kit component" className={f} value={c.productId} onChange={(e) => setX({ ...x, kitComponents: x.kitComponents.map((y, k) => (k === i ? { ...y, productId: e.target.value } : y)) })}><option value="">Product…</option>{products.filter((p) => p.id !== product.id && p.productType !== "KIT").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input aria-label="Component quantity" className={f} type="number" min="0" value={c.quantity} onChange={(e) => setX({ ...x, kitComponents: x.kitComponents.map((y, k) => (k === i ? { ...y, quantity: e.target.value } : y)) })} /></div>)}<button className={gbtn} onClick={() => setX({ ...x, kitComponents: [...x.kitComponents, { productId: "", quantity: 1 }] })}>+ Component</button></div>}
    {warehouses.length > 0 && <div><p className={muted}>Per location (overrides the product's own settings there)</p><table className="w-full"><thead><tr className={`text-left ${muted}`}><th>Location</th><th>Reorder at</th><th>Min</th><th>Max</th><th>Bin / shelf</th></tr></thead><tbody>{warehouses.map((w) => <tr key={w.id}><td className="text-[var(--inaya-text-primary)]">{w.name}</td>{["reorderThreshold", "minStock", "maxStock", "bin"].map((k) => <td key={k}><input aria-label={`${k} at ${w.name}`} className={f} value={rule(w.id)[k] ?? ""} onChange={(e) => setRule(w.id, k, e.target.value)} /></td>)}</tr>)}</tbody></table></div>}
    <Msg ok={ok} err={err} /><button className={pbtn} onClick={save}>Save stock settings</button>
  </div></details>;
}
export function PoControls({ orgId, po, onChanged }) {
  const [charges, setCharges] = useState(po.landedCharges || []); const [err, setErr] = useState(""); const [ok, setOk] = useState("");
  const locked = (po.items || []).some((i) => (i.receivedQuantity || 0) > 0) || ["CANCELLED", "REJECTED", "RECEIVED"].includes(po.status);
  const call = async (path, body, msg) => { setErr(""); setOk(""); try { await api(`purchase-orders/${po.id}/${path}`, { orgId, method: "POST", body }); setOk(msg); onChanged?.(); } catch (e) { setErr(e.message); } };
  return <div className="space-y-2 border-t border-white/5 pt-3 text-xs">
    {po.approvals?.length > 0 && <p className={muted}>Approvals: {po.approvals.map((a) => `level ${a.level} by ${a.by}`).join(" · ")}</p>}
    <p className="font-bold uppercase text-[11px] text-[var(--inaya-text-muted)]">Landed costs (freight, insurance, duty, handling)</p>
    {charges.map((c, i) => <div key={i} className="grid grid-cols-[110px_90px_110px_1fr_auto] gap-1.5"><select aria-label="Charge type" disabled={locked} className={f} value={c.type} onChange={(e) => setCharges(charges.map((y, k) => (k === i ? { ...y, type: e.target.value } : y)))}>{["FREIGHT", "INSURANCE", "DUTY", "HANDLING", "OTHER"].map((t) => <option key={t}>{t}</option>)}</select>
      <input aria-label="Charge amount" disabled={locked} className={f} type="number" min="0" value={c.amount} onChange={(e) => setCharges(charges.map((y, k) => (k === i ? { ...y, amount: e.target.value } : y)))} />
      <select aria-label="Allocate by" disabled={locked} className={f} value={c.allocation || "VALUE"} onChange={(e) => setCharges(charges.map((y, k) => (k === i ? { ...y, allocation: e.target.value } : y)))}><option value="VALUE">by value</option><option value="QUANTITY">by quantity</option></select>
      <input aria-label="Charge note" disabled={locked} className={f} value={c.note || ""} onChange={(e) => setCharges(charges.map((y, k) => (k === i ? { ...y, note: e.target.value } : y)))} placeholder="note" />
      {!locked && <button className={gbtn} onClick={() => setCharges(charges.filter((_, k) => k !== i))}>✕</button>}</div>)}
    {locked ? <p className={muted}>{(po.landedCharges || []).length ? "Locked: goods have been received, so costs already booked are never rewritten." : "No landed charges."}</p> : <div className="flex gap-2"><button className={gbtn} onClick={() => setCharges([...charges, { type: "FREIGHT", amount: "", allocation: "VALUE" }])}>+ Charge</button><button className={pbtn} onClick={() => call("landed-charges", { charges: charges.map((c) => ({ ...c, amount: Number(c.amount) })) }, "Landed costs saved: they are added to each unit's cost when received.")}>Save landed costs</button></div>}
    {["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(po.status) && <button className={gbtn} onClick={() => { const date = window.prompt("New expected delivery date (YYYY-MM-DD), or leave empty", po.expectedDeliveryDate || ""); if (date === null) return; const reason = window.prompt("Reason for the amendment (kept on the order)"); if (!reason) return; call("amend", { expectedDeliveryDate: date || null, reason }, "Amendment recorded."); }}>Amend delivery date</button>}
    {po.amendments?.length > 0 && <details className={muted}><summary className="cursor-pointer">Amendments ({po.amendments.length})</summary>{po.amendments.map((a) => <p key={a.no}>#{a.no} {new Date(a.at).toLocaleString()} · {a.by} · {a.reason} · {a.changes.map((c) => `${c.field}${c.line !== undefined ? ` (line ${c.line + 1})` : ""}: ${c.from ?? "–"} → ${c.to ?? "–"}`).join("; ")}</p>)}</details>}
    {po.receipts?.length > 0 && <details className={muted}><summary className="cursor-pointer">Receipts ({po.receipts.length})</summary>{po.receipts.map((r) => <p key={r.no}>#{r.no} {new Date(r.at).toLocaleString()} · {r.by} · {r.lines.map((l) => `line ${l.itemIndex + 1}: ${l.received}${l.damaged ? ` (+${l.damaged} damaged${l.toQuarantine ? ", quarantined" : ""})` : ""}`).join("; ")}{r.discrepancies.length ? ` · ${r.discrepancies.map((d) => `${d.type.toLowerCase()}: ${d.note}`).join("; ")}` : ""}</p>)}</details>}
    <Msg ok={ok} err={err} />
  </div>;
}
