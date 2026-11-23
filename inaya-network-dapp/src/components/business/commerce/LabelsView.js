"use client";

// src/components/business/commerce/LabelsView.js -- Inaya Commerce: product barcode labels (post-SOW, beta).
// Pick products and how many labels each, choose the label size, then either print through the print dialog (any label
// printer with its driver, or A4 sticker sheets) or, in the Inaya desktop app, straight to a Zebra (ZPL) or TSC / Xprinter
// (TSPL) label printer. The barcode is the product's own barcode, or its SKU when it has none (Code 128).
import { useEffect, useMemo, useState } from "react";
import { LABEL_SIZES, labelSheetHtml, zplLabel, tsplLabel, barcodeProblem, code128Svg } from "../../../lib/commerce/barcode";
import { inDesktopApp, listPrinters, printRawText } from "../../../lib/commerce/desktopPrint";

const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "min-h-[40px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] hover:border-[var(--inaya-accent)] disabled:opacity-40";
const primary = "min-h-[44px] px-4 rounded-lg text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] hover:brightness-110 disabled:opacity-40";
const field = "w-full min-h-[40px] rounded-lg border border-[var(--inaya-border)] bg-[var(--inaya-surface)] px-3 text-sm text-[var(--inaya-text-primary)]";
const KEY = "inaya_pos_labels_v1";
const loadPrefs = () => { try { return { size: "50x25", showName: true, showPrice: true, direct: "", lang: "zpl", ...(JSON.parse(localStorage.getItem(KEY) || "{}")) }; } catch { return { size: "50x25", showName: true, showPrice: true, direct: "", lang: "zpl" }; } };
const priceText = (v, cur) => { if (v === null || v === undefined || v === "") return ""; try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "PKR", maximumFractionDigits: 2 }).format(v); } catch { return `${cur} ${v}`; } };

export default function LabelsView({ orgId, settings }) {
  const [products, setProducts] = useState(null); const [q, setQ] = useState(""); const [rows, setRows] = useState([]); const [prefs, setPrefs] = useState(loadPrefs);
  const [printers, setPrinters] = useState([]); const [msg, setMsg] = useState(""); const [err, setErr] = useState(""); const desktop = inDesktopApp();
  useEffect(() => { fetch(`/api/orgs/inventory/products?orgId=${orgId}`, { credentials: "include" }).then((r) => r.json()).then((d) => setProducts((d.products || []).filter((p) => p.status === "ACTIVE" && p.productType !== "GIFT_CARD"))).catch(() => setProducts([])); }, [orgId]);
  useEffect(() => { if (desktop) listPrinters().then(setPrinters).catch(() => {}); }, [desktop]);
  const setPref = (k, v) => { const n = { ...prefs, [k]: v }; setPrefs(n); try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* storage blocked */ } };
  const found = useMemo(() => { const s = q.trim().toLowerCase(); if (!s || !products) return []; return products.filter((p) => p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s) || (p.barcode || "").toLowerCase() === s).slice(0, 12); }, [q, products]);
  const add = (p, copies = 1) => { setRows((r) => (r.some((x) => x.p.id === p.id) ? r.map((x) => (x.p.id === p.id ? { ...x, copies: x.copies + copies } : x)) : [...r, { p, copies }])); setQ(""); };
  const items = rows.map(({ p, copies }) => ({ name: p.name, code: p.barcode || p.sku, price: priceText(p.unitPrice, settings.currency), copies, problem: barcodeProblem(p.barcode || p.sku) }));
  const bad = items.filter((x) => x.problem); const total = items.reduce((s, x) => s + (Number(x.copies) || 0), 0);
  const size = LABEL_SIZES[prefs.size] || LABEL_SIZES["50x25"];
  const printDialog = () => {
    setErr(""); const html = labelSheetHtml(items.filter((x) => !x.problem), prefs.size, { showName: prefs.showName, showPrice: prefs.showPrice });
    const w = window.open("", "_blank", "width=820,height=900"); if (!w) { setErr("The print window was blocked. Allow pop-ups for this site."); return; }
    w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  };
  const printDirect = async () => {
    setErr(""); setMsg("");
    try {
      const make = prefs.lang === "tspl" ? tsplLabel : zplLabel;
      const text = items.filter((x) => !x.problem).map((x) => make({ name: prefs.showName ? x.name : "", code: x.code, price: prefs.showPrice ? x.price : "" }, { w: size.w, h: size.h, copies: x.copies })).join("");
      await printRawText(prefs.direct, text); setMsg(`${total} label${total === 1 ? "" : "s"} sent to ${prefs.direct}.`);
    } catch (e) { setErr(e.message || String(e)); }
  };
  return <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
    <div className={`${card} p-3 space-y-2`}>
      <h3 className="font-bold">Barcode labels <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border border-amber-500 text-amber-600 ml-1">Beta</span></h3>
      <p className={`text-xs ${muted}`}>The barcode is the product's own barcode, or its SKU when it has none. Every scanner reads these labels (Code 128).</p>
      <input aria-label="Find products for labels" className={field} placeholder="Search a product by name or SKU, or scan it" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && found[0]) add(found[0]); }} />
      {found.length > 0 && <ul className="border border-[var(--inaya-border)] rounded-lg divide-y divide-[var(--inaya-border)]">{found.map((p) => <li key={p.id}><button className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--inaya-overlay-5)]" onClick={() => add(p)}>{p.name} <span className={muted}>· {p.barcode || p.sku}</span></button></li>)}</ul>}
      {!products ? <p className={muted}>Loading products…</p> : !rows.length ? <p className={`${muted} text-sm py-4`}>Add the products you need labels for.</p> :
        <table className="w-full text-sm"><thead><tr className={`text-left ${muted}`}><th>Product</th><th>Barcode</th><th className="w-24">Labels</th><th /></tr></thead>
          <tbody>{rows.map(({ p, copies }, i) => { const prob = items[i].problem; return <tr key={p.id} className="border-t border-[var(--inaya-border)]">
            <td className="py-1">{p.name}</td><td className={prob ? "text-red-500" : ""}>{prob || items[i].code}</td>
            <td><input aria-label={`Labels for ${p.name}`} className={field} inputMode="numeric" value={copies} onChange={(e) => setRows((r) => r.map((x, k) => (k === i ? { ...x, copies: Math.max(0, Math.min(500, Math.floor(Number(e.target.value) || 0))) } : x)))} /></td>
            <td className="text-right"><button className={btn} aria-label={`Remove ${p.name}`} onClick={() => setRows((r) => r.filter((_, k) => k !== i))}>✕</button></td></tr>; })}</tbody></table>}
      {rows.length > 0 && <button className={btn} onClick={() => { const n = Number(window.prompt("Set every product to how many labels?", "1")); if (n >= 0) setRows((r) => r.map((x) => ({ ...x, copies: Math.min(500, Math.floor(n)) }))); }}>Same number for all</button>}
    </div>
    <div className={`${card} p-3 space-y-2 text-sm`}>
      <label className="block">Label size<select aria-label="Label size" className={field} value={prefs.size} onChange={(e) => setPref("size", e.target.value)}>{Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}</select></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.showName} onChange={(e) => setPref("showName", e.target.checked)} />Product name</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.showPrice} onChange={(e) => setPref("showPrice", e.target.checked)} />Price</label>
      {items[0] && !items[0].problem && <div className="border border-[var(--inaya-border)] rounded-lg p-2 bg-white text-black" style={{ aspectRatio: `${size.w} / ${size.h}` }} aria-label="Label preview">
        {prefs.showName && <p className="text-[11px] font-bold text-center truncate">{items[0].name}</p>}
        <div className="h-[60%]" dangerouslySetInnerHTML={{ __html: code128Svg(items[0].code, { height: 50, fontSize: 11 }).replace("<svg ", '<svg style="width:100%;height:100%" ') }} />
        {prefs.showPrice && items[0].price && <p className="text-[11px] font-bold text-center">{items[0].price}</p>}
      </div>}
      {bad.length > 0 && <p className="text-xs text-red-500">{bad.length} product{bad.length === 1 ? "" : "s"} can't be printed (see the list).</p>}
      <button className={`${primary} w-full`} disabled={!total || bad.length === rows.length} onClick={printDialog}>Print {total || ""} label{total === 1 ? "" : "s"}</button>
      <p className={`text-xs ${muted}`}>Uses the print window: choose your label printer (with its driver) or a normal printer with sticker sheets. Set the printer's paper to the label size, margins none, scale 100%.</p>
      {desktop && <fieldset className="border border-[var(--inaya-border)] rounded-lg p-2 space-y-2"><legend className="px-1 font-semibold">Or print straight to a label printer</legend>
        <select aria-label="Label printer" className={field} value={prefs.direct} onChange={(e) => setPref("direct", e.target.value)}><option value="">Choose the label printer…</option>{printers.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <select aria-label="Label printer language" className={field} value={prefs.lang} onChange={(e) => setPref("lang", e.target.value)}><option value="zpl">Zebra (ZPL)</option><option value="tspl">TSC, Xprinter, Gprinter and similar (TSPL)</option></select>
        <button className={`${btn} w-full`} disabled={!total || !prefs.direct || bad.length === rows.length} onClick={printDirect}>Send {total || ""} label{total === 1 ? "" : "s"} to the printer</button>
      </fieldset>}
      {(msg || err) && <p className={`text-xs ${err ? "text-red-500" : "text-emerald-600"}`}>{err || msg}</p>}
    </div>
  </div>;
}
