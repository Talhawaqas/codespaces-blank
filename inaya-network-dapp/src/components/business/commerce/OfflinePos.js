"use client";

// src/components/business/commerce/OfflinePos.js -- Inaya Commerce, offline selling (post-SOW #4).
// useOfflineTill: knows when the till is offline, keeps the till's offline pack fresh while online (encrypted on the
// device), and sends the offline queue as soon as the connection is back. OfflineRegister: the cash-only register used
// while offline. OfflineReview: the supervisor/manager list of offline sales the server would not record, or wants checked.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { priceOfflineCart, settleOfflineCash } from "../../../lib/commerce/offlinePricing";
import { offlineSupported, keepOfflinePageReady, savePack, loadPack, packProblem, queueOfflineSale, queueCount, syncQueue } from "../../../lib/commerce/offlineStore";
import { inDesktopApp, loadPrintSettings, printSaleReceipt, openDrawer, canOpenDrawer } from "../../../lib/commerce/desktopPrint";
import { fullPageReceiptHtml } from "../../../lib/commerce/receiptLayout";
import { CameraScanner, cameraAvailable } from "./CameraScanner";

const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "min-h-[40px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] hover:border-[var(--inaya-accent)] disabled:opacity-40";
const primary = "min-h-[44px] px-4 rounded-lg text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] hover:brightness-110 disabled:opacity-40";
const field = "w-full min-h-[40px] rounded-lg border border-[var(--inaya-border)] bg-[var(--inaya-surface)] px-3 text-sm text-[var(--inaya-text-primary)]";
const money = (v, cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "PKR", minimumFractionDigits: Number.isInteger(v || 0) ? 0 : 2, maximumFractionDigits: 2 }).format(v || 0); } catch { return `${cur || ""} ${(v || 0).toFixed(2)}`; } };
const m = (minor) => (minor || 0) / 100;
const PACK_REFRESH_MS = 30 * 60 * 1000; const SYNC_MS = 20000; const PROBE_MS = 10000;

async function post(path, orgId, body) {
  let r; try { r = await fetch(`/api/orgs/commerce/${path}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, ...body }) }); }
  catch { throw Object.assign(new Error("No connection."), { code: "NETWORK" }); }
  let d = {}; try { d = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { status: r.status, code: d.code });
  return d;
}

/** Offline state for one till. `shiftId` = the register's open shift (a new shift gets a new pack). */
export function useOfflineTill({ orgId, registerId, shiftId, enabled }) {
  const supported = offlineSupported();
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  const [pack, setPack] = useState(null); const [queued, setQueued] = useState(0); const [sync, setSync] = useState(null); const [packErr, setPackErr] = useState("");
  const busy = useRef(false);
  const goOffline = useCallback(() => setOnline(false), []);
  // the browser's own online/offline events, plus a probe while we think we're offline (Wi-Fi can be "up" with no internet)
  useEffect(() => { const on = () => setOnline(true); const off = () => setOnline(false); window.addEventListener("online", on); window.addEventListener("offline", off); return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); }; }, []);
  // the computer can be online while Inaya is not reachable (no internet behind the Wi-Fi, an outage): check Inaya itself
  useEffect(() => {
    let done = false; const ctrl = typeof AbortController === "function" ? new AbortController() : null; const t = setTimeout(() => ctrl?.abort(), 6000);
    fetch(`/api/orgs/commerce/settings?orgId=${orgId}`, { credentials: "include", cache: "no-store", signal: ctrl?.signal }).then((r) => { if (!done && !r.ok && r.status >= 500) setOnline(false); }).catch(() => { if (!done) setOnline(false); }).finally(() => clearTimeout(t));
    return () => { done = true; clearTimeout(t); };
  }, [orgId]);
  useEffect(() => {
    if (online) return undefined;
    const t = setInterval(async () => { try { const r = await fetch(`/api/orgs/commerce/settings?orgId=${orgId}`, { credentials: "include", cache: "no-store" }); if (r.status < 500) setOnline(true); } catch { /* still offline */ } }, PROBE_MS);
    return () => clearInterval(t);
  }, [online, orgId]);
  // the pack on this device
  const reloadLocal = useCallback(async () => { if (!supported) return; try { setPack(await loadPack(orgId, registerId)); setQueued(await queueCount(orgId)); } catch { /* storage blocked */ } }, [supported, orgId, registerId]);
  useEffect(() => { reloadLocal(); }, [reloadLocal]);
  useEffect(() => { if (enabled && online && supported) keepOfflinePageReady(); }, [enabled, online, supported]);
  // download a fresh pack while online: when there is none, it is from another shift, or it is 30 minutes old
  const refreshPack = useCallback(async (force = false) => {
    if (!supported || !enabled || !registerId || !shiftId) return;
    const local = await loadPack(orgId, registerId).catch(() => null);
    if (!force && local && local.shiftId === shiftId && Date.now() - Date.parse(local.savedAt || local.issuedAt) < PACK_REFRESH_MS && !packProblem(local)) return;
    try { const d = await post("offline/pack", orgId, { registerId }); await savePack(orgId, d.pack); setPackErr(""); await reloadLocal(); keepOfflinePageReady(); }
    catch (e) { if (e.code === "NETWORK") setOnline(false); else setPackErr(e.message); }
  }, [supported, enabled, orgId, registerId, shiftId, reloadLocal]);
  useEffect(() => { if (!online) return undefined; refreshPack(); const t = setInterval(() => refreshPack(), PACK_REFRESH_MS); return () => clearInterval(t); }, [online, refreshPack]);
  // send the queue whenever we're online
  const syncNow = useCallback(async () => {
    if (!supported || busy.current) return; busy.current = true;
    try { // keep going while the server makes progress (a long outage can leave hundreds of sales)
      let total = { sent: 0, recorded: 0, rejected: 0, rejections: [] }; let r;
      for (let round = 0; round < 40; round++) { r = await syncQueue(orgId, (body) => post("offline/sync", orgId, body)); total = { sent: total.sent + r.sent, recorded: total.recorded + r.recorded, rejected: total.rejected + r.rejected, rejections: [...total.rejections, ...(r.rejections || [])] }; setQueued(r.left); if (!r.sent || !r.left) break; }
      if (total.sent) setSync({ at: new Date(), ...total, left: r.left }); await reloadLocal(); }
    catch (e) { if (e.code === "NETWORK") setOnline(false); else setSync({ at: new Date(), error: e.message }); }
    finally { busy.current = false; }
  }, [supported, orgId, reloadLocal]);
  useEffect(() => { if (!online) return undefined; syncNow(); const t = setInterval(syncNow, SYNC_MS); return () => clearInterval(t); }, [online, syncNow]);
  return { supported, online, goOffline, pack, problem: packProblem(pack), packErr, queued, sync, syncNow, reloadLocal, refreshPack };
}

/** The bar shown above the register: offline state, queue, last sync. */
export function OfflineBar({ till, settings }) {
  const enabled = settings.offlineSelling?.enabled;
  if (!enabled && !till.queued) return null;
  if (!till.online) return <div role="status" className="lg:col-span-2 p-2 rounded-xl border border-amber-500 bg-amber-500/10 text-sm flex flex-wrap items-center gap-2">
    <b>Offline.</b><span>{till.problem ? till.problem : "Selling cash only at shelf prices. Sales are saved on this computer and sync when the connection is back."}</span>
    {till.queued > 0 && <span className="ml-auto font-semibold">{till.queued} sale{till.queued === 1 ? "" : "s"} waiting to sync</span>}
  </div>;
  if (till.queued > 0) return <div role="status" className="lg:col-span-2 p-2 rounded-xl border border-[var(--inaya-border)] text-sm flex items-center gap-2"><span>Syncing {till.queued} offline sale{till.queued === 1 ? "" : "s"}…</span><button className={`${btn} ml-auto`} onClick={till.syncNow}>Sync now</button></div>;
  if (till.sync?.rejected) return <div role="alert" className="lg:col-span-2 p-2 rounded-xl border border-red-500 text-sm">{till.sync.rejected} offline sale{till.sync.rejected === 1 ? " was" : "s were"} not recorded and {till.sync.rejected === 1 ? "has" : "have"} gone to the manager (Offline review).</div>;
  if (till.sync?.error) return <div role="alert" className="lg:col-span-2 p-2 rounded-xl border border-red-500 text-sm">Offline sales could not sync: {till.sync.error}</div>;
  if (till.packErr && settings.offlineSelling?.enabled) return <div className={`lg:col-span-2 text-xs ${muted}`}>Offline selling not ready on this till: {till.packErr}</div>;
  return null;
}

/** Cash-only register used while offline. `initial` = cart lines carried over from the online register; `pendingKey` = the
 *  idempotency key of an online payment whose answer was lost (re-used, so the sale can never be recorded twice). */
export function OfflineRegister({ orgId, registerId, pack, initial = [], pendingKey = null, onQueued, onBusy }) {
  const cur = pack.currency;
  const [q, setQ] = useState(""); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [cart, setCart] = useState(() => initial.filter((l) => pack.products.some((p) => p.id === l.productId)).map((l) => ({ productId: l.productId, quantity: l.quantity })));
  const [cash, setCash] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(null); const keyRef = useRef(pendingKey); const searchRef = useRef(null);
  const dropped = initial.length - cart.length;
  // while a sale is in progress (or its receipt is on screen) the till stays offline even if the connection comes back
  useEffect(() => { onBusy?.(cart.length > 0 || !!done); }, [cart.length, done]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onBusy?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (initial.some((l) => l.discount || l.priceOverride !== undefined)) setMsg("Discounts and price changes aren't available offline: the sale is at shelf prices."); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(pack.products.map((p) => [p.id, p])), [pack]);
  const priced = useMemo(() => (cart.length ? priceOfflineCart(pack, cart) : null), [pack, cart]);
  const visible = useMemo(() => { const s = q.trim().toLowerCase(); return pack.products.filter((p) => !s || p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s) || (p.barcode || "").toLowerCase() === s).slice(0, 60); }, [pack, q]);
  const add = (p) => { setCart((c) => { const i = c.findIndex((l) => l.productId === p.id); if (i >= 0) { const n = [...c]; n[i] = { ...n[i], quantity: n[i].quantity + 1 }; return n; } return [...c, { productId: p.id, quantity: 1 }]; }); setMsg(""); searchRef.current?.focus(); };
  const findCode = (code) => { const s = String(code).trim().toLowerCase(); return s ? pack.products.find((p) => (p.barcode || "").toLowerCase() === s || p.sku.toLowerCase() === s) : null; };
  const onScan = (e) => { if (e.key !== "Enter") return; const hit = findCode(q); if (!q.trim()) return; if (hit) { add(hit); setQ(""); } else setMsg(`No product with barcode or SKU "${q.trim()}" in the offline price list.`); };
  const [camera, setCamera] = useState(false);
  const setQty = (i, v) => setCart((c) => c.map((l, k) => (k === i ? { ...l, quantity: v } : l)).filter((l) => l.quantity > 0));
  const cashMinor = Math.round(Number(cash) * 100);
  const pay = priced && !priced.error ? settleOfflineCash(priced.totals, cashMinor) : null;
  const complete = async () => {
    if (!priced || priced.error || !pay || pay.error) return; setBusy(true); setErr("");
    const ps = loadPrintSettings(); const drawer = inDesktopApp() && canOpenDrawer(ps);
    try {
      const sale = await queueOfflineSale(orgId, registerId, { offlineId: keyRef.current || undefined, lines: cart, cashMinor, totalMinor: priced.totals.totalMinor, drawerOpened: drawer });
      keyRef.current = null;
      const r = receiptOf(pack, sale, priced, pay); setDone({ r, hw: "" }); setCart([]); setCash(""); onQueued?.();
      if (inDesktopApp() && ps.printer.kind !== "none" && ps.printer.kind !== "laser" && ps.autoPrint) {
        try { const res = await printSaleReceipt(r, { cash: drawer, money: (v) => money(v, cur) }, ps); setDone({ r, hw: `Receipt printed${res.drawer === "opened" ? " and drawer opened" : ""}.` }); }
        catch (e) { setDone({ r, hw: `Printer: ${e.message || e}. Use Print receipt.` }); if (drawer && (ps.drawer.kind === "serial" || ps.drawer.kind === "network")) await openDrawer(ps).catch(() => {}); }
      } else if (drawer) { await openDrawer(ps).then(() => setDone({ r, hw: "Drawer opened." })).catch((e) => setDone({ r, hw: `Drawer: ${e.message || e}` })); }
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  };
  if (done) return <div className={`${card} p-4 lg:col-span-2 max-w-md`}>
    <h3 className="font-bold mb-1">Sale saved on this till</h3>
    <p className={`text-xs ${muted} mb-2`}>It is recorded in the books, stock and shift when the till reconnects. Change: <b>{money(m(done.r.changeMinor), cur)}</b></p>
    {done.hw && <p className="text-sm mb-2">{done.hw}</p>}
    <OfflineReceipt r={done.r} />
    <div className="flex gap-2 mt-3"><button className={primary} onClick={() => printOfflineReceipt(done.r)}>Print receipt</button><button className={btn} autoFocus onClick={() => { setDone(null); searchRef.current?.focus(); }}>New sale</button></div>
  </div>;
  return <>
    <div className={`${card} p-3 space-y-3`}>
      <div className="flex gap-2"><input ref={searchRef} autoFocus aria-label="Search or scan" className={field} placeholder="Search name or SKU, or scan a barcode" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onScan} />{cameraAvailable() && <button className={btn} aria-label="Scan with camera" onClick={() => setCamera(true)}>Camera</button>}</div>
      {camera && <CameraScanner onCode={(code) => { const hit = findCode(code); if (hit) add(hit); else setMsg(`No product with barcode or SKU "${String(code).trim()}" in the offline price list.`); }} onClose={() => { setCamera(false); searchRef.current?.focus(); }} />}
      {msg && <p className="text-sm text-amber-600" role="status">{msg}</p>}
      {dropped > 0 && <p className="text-sm text-amber-600">{dropped} item{dropped === 1 ? " isn't" : "s aren't"} in the offline price list and {dropped === 1 ? "was" : "were"} left out.</p>}
      <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">{visible.map((p) => <button key={p.id} className={`${card} p-3 text-left min-h-[84px] hover:border-[var(--inaya-accent)]`} onClick={() => add(p)}><p className="font-semibold text-sm">{p.name}</p><p className={`text-xs ${muted}`}>{p.sku}</p><p className="text-sm font-bold mt-1">{money(m(p.priceMinor), cur)}</p></button>)}</div>
    </div>
    <div className={`${card} p-3 flex flex-col gap-2`}>
      <p className={`text-xs ${muted}`}>Offline: guest sale, cash only, shelf prices. Receipt numbers {pack.receiptPrefix}-…</p>
      {!cart.length ? <p className={`${muted} py-8 text-center`}>Scan or tap a product to start a sale.</p> : <ul className="divide-y divide-[var(--inaya-border)] max-h-[44vh] overflow-auto">
        {cart.map((l, i) => { const p = byId.get(l.productId); const pl = priced?.lines?.[i]; return <li key={l.productId} className="py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0"><p className="font-semibold text-sm truncate">{p?.name}</p><p className={`text-xs ${muted}`}>{money(m(p?.priceMinor), cur)} × {l.quantity}</p></div>
          <button className={btn} aria-label="One less" onClick={() => setQty(i, l.quantity - 1)}>−</button><span className="w-8 text-center">{l.quantity}</span><button className={btn} aria-label="One more" onClick={() => setQty(i, l.quantity + 1)}>+</button>
          <span className="w-24 text-right text-sm font-semibold">{pl ? money(m(pl.grossMinor), cur) : ""}</span></li>; })}
      </ul>}
      {priced?.error && <p className="text-sm text-red-500">{priced.error}</p>}
      {priced && !priced.error && <div className="border-t border-[var(--inaya-border)] pt-2 text-sm space-y-1">
        {priced.totals.taxBreakdown.filter((t) => t.taxMinor).map((t) => <div key={`${t.category}${t.rate}`} className="flex justify-between"><span>{t.name} {t.rate}%{pack.taxMode === "inclusive" ? " (included)" : ""}</span><span>{money(m(t.taxMinor), cur)}</span></div>)}
        <div className="flex justify-between font-bold text-lg"><span>Total</span><span>{money(m(priced.totals.totalMinor), cur)}</span></div>
        {priced.totals.cashDueMinor !== priced.totals.totalMinor && <div className="flex justify-between"><span>Cash to pay (rounded)</span><span>{money(m(priced.totals.cashDueMinor), cur)}</span></div>}
        <label className="block">Cash received<input aria-label="Cash received" className={field} inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder={String(m(priced.totals.cashDueMinor))} /></label>
        {pay && !pay.error && <p>Change: <b>{money(m(pay.changeMinor), cur)}</b></p>}
        {pay?.error && cash !== "" && <p className="text-amber-600">{pay.error}</p>}
      </div>}
      {err && <p className="text-sm text-red-500" role="alert">{err}</p>}
      <button className={primary} disabled={busy || !pay || !!pay.error} onClick={complete}>Complete cash sale</button>
      {cart.length > 0 && <button className={btn} onClick={() => { if (window.confirm("Clear this sale?")) { setCart([]); setCash(""); keyRef.current = null; } }}>Clear</button>}
    </div>
  </>;
}

/** Receipt data in the same shape as the server's receipt (Receipt / ESC-POS printing). */
export function receiptOf(pack, sale, priced, pay) {
  return { company: pack.company, location: pack.location, saleNumber: sale.receiptNumber, completedAt: sale.createdAt, currency: pack.currency,
    lines: priced.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: m(l.unitPriceMinor), discount: 0, total: m(l.grossMinor), taxRate: l.taxRate, taxCategory: l.taxCategory })),
    totals: { subtotal: m(priced.totals.subtotalMinor), discounts: 0, total: m(priced.totals.totalMinor), tax: m(priced.totals.taxMinor), taxBreakdown: priced.totals.taxBreakdown.map((t) => ({ category: t.category, name: t.name, rate: t.rate, taxable: m(t.taxableMinor), tax: m(t.taxMinor) })) },
    tenders: [{ method: "CASH", amount: m(pay.cashMinor) }], cashRounding: m(pay.roundingMinor), change: m(pay.changeMinor), changeMinor: pay.changeMinor,
    returnPolicy: pack.returnPolicy, footer: [pack.footer, "Offline sale: recorded when the till reconnects."].filter(Boolean).join("\n") };
}
function OfflineReceipt({ r }) {
  return <div className="font-mono text-xs space-y-1" id="pos-offline-receipt">
    <p className="text-center font-bold">{r.company}</p><p className="text-center">{r.location}</p>
    <p className="text-center">{r.saleNumber} · {new Date(r.completedAt).toLocaleString()}</p><hr />
    {r.lines.map((l, i) => <div key={i}><div className="flex justify-between"><span>{l.name}</span><span>{money(l.total, r.currency)}</span></div><div className="text-[10px]">{l.quantity} × {money(l.unitPrice, r.currency)}{l.taxRate ? ` · ${l.taxCategory || "tax"} ${l.taxRate}%` : ""}</div></div>)}<hr />
    {r.totals.taxBreakdown.filter((t) => t.tax).map((t) => <div key={`${t.category}${t.rate}`} className="flex justify-between"><span>{t.name} {t.rate}% on {money(t.taxable, r.currency)}</span><span>{money(t.tax, r.currency)}</span></div>)}
    <div className="flex justify-between font-bold"><span>TOTAL</span><span>{money(r.totals.total, r.currency)}</span></div>
    <div className="flex justify-between"><span>Cash</span><span>{money(r.tenders[0].amount, r.currency)}</span></div>
    {r.cashRounding ? <div className="flex justify-between"><span>Cash rounding</span><span>{money(r.cashRounding, r.currency)}</span></div> : null}
    {r.change > 0 && <div className="flex justify-between"><span>Change</span><span>{money(r.change, r.currency)}</span></div>}
    <hr /><p>{r.returnPolicy}</p><p className="whitespace-pre-line">{r.footer}</p>
  </div>;
}
function printOfflineReceipt(r) {
  const layout = loadPrintSettings().pageLayout || "strip";
  if (r && (layout === "A4" || layout === "A5")) { const w0 = window.open("", "_blank", "width=820,height=1000"); if (!w0) return; w0.document.write(fullPageReceiptHtml(r, layout)); w0.document.close(); w0.focus(); setTimeout(() => w0.print(), 150); return; }
  const el = document.getElementById("pos-offline-receipt"); const w = window.open("", "_blank", "width=380,height=640"); if (!w || !el) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title><style>body{font:12px/1.4 ui-monospace,Consolas,monospace;margin:8px;width:72mm} .flex{display:flex} .justify-between{justify-content:space-between} .text-center{text-align:center} .font-bold{font-weight:700} .whitespace-pre-line{white-space:pre-line} hr{border:0;border-top:1px dashed #000} p{margin:2px 0}</style></head><body>${el.innerHTML}</body></html>`);
  w.document.close(); w.focus(); w.print();
}

/** Supervisors see offline sales the server did not record (REJECTED) or wants checked (REVIEW); managers decide. */
export function OfflineReview({ orgId, settings, role }) {
  const [status, setStatus] = useState("OPEN"); const [list, setList] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const load = useCallback(() => fetch(`/api/orgs/commerce/offline/issues?orgId=${orgId}&status=${status}`, { credentials: "include" }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setList(d.issues); }).catch((e) => setErr(e.message)), [orgId, status]);
  useEffect(() => { load(); }, [load]);
  const act = async (x, action) => {
    const reason = window.prompt(action === "record" ? "Record this sale at the till's offline prices. Reason:" : action === "dismiss" ? "Don't record this sale. Reason (e.g. checked: never happened):" : "Checked. Note:"); if (!reason) return;
    setErr(""); setMsg(""); try { const d = await post(`offline/issues/${x.id}/resolve`, orgId, { action, reason }); setMsg(d.issue.saleNumber ? `Recorded as ${d.issue.saleNumber}.` : "Done."); load(); } catch (e) { setErr(e.message); }
  };
  const cur = settings.currency;
  return <div className={`${card} p-3 space-y-2`}>
    <div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">Offline sales to review</h3>
      <select aria-label="Status" className={`${field} !w-auto ml-auto`} value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN">Open</option><option value="RESOLVED">Resolved</option><option value="ALL">All</option></select></div>
    <p className={`text-xs ${muted}`}>"Not recorded": the server refused the sale (shown why). "Check": the sale was recorded but needs a look. Only a manager can decide.</p>
    {(err || msg) && <p className={`text-sm ${err ? "text-red-500" : "text-emerald-600"}`}>{err || msg}</p>}
    {!list ? <p className={muted}>Loading…</p> : !list.length ? <p className={muted}>Nothing here.</p> : <ul className="divide-y divide-[var(--inaya-border)]">{list.map((x) => <li key={x.id} className="py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2"><b>{x.receiptNumber || "(no number)"}</b><span className={x.type === "REJECTED" ? "text-red-500" : "text-amber-600"}>{x.type === "REJECTED" ? "Not recorded" : "Check"}</span>
        <span className={muted}>{x.register} · {x.cashier} · {x.at ? new Date(x.at).toLocaleString() : ""} · {money(x.total, cur)} (cash {money(x.cash, cur)})</span>{x.saleNumber && <span>→ {x.saleNumber}</span>}
        {x.status === "OPEN" && role === "manager" && <span className="ml-auto flex gap-2">{x.type === "REJECTED" ? <><button className={btn} onClick={() => act(x, "record")}>Record sale</button><button className={btn} onClick={() => act(x, "dismiss")}>Don't record</button></> : <button className={btn} onClick={() => act(x, "acknowledge")}>Checked</button>}</span>}</div>
      <ul className="list-disc ml-5 text-xs">{x.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      {x.resolution && <p className={`text-xs ${muted}`}>{x.resolution.action} by {x.resolution.by}: {x.resolution.reason}</p>}
    </li>)}</ul>}
  </div>;
}
