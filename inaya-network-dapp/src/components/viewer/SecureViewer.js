"use client";

// src/components/viewer/SecureViewer.js
//
// The Inaya secure viewer (Competitive Expansion SOW workstream E DRM-001..003 and preview I PREVIEW-001/002). It renders an already
// DECRYPTED file entirely in this browser: nothing readable is sent anywhere and no plaintext copy exists on a server.
//
// Modes: "normal" (preview with download if allowed), "view_only" (no download control, no printing, no save), "restricted" (view_only plus no
// copying, no selection, content hidden while the window is not in focus). Optional watermark (viewer, organization, time) tiled over the
// content and restored if removed. The access session expiry wipes the document from memory.
//
// WHAT THIS DOES NOT DO (and says so on screen): a web page cannot stop a photograph of the screen, an operating-system screenshot or screen
// recording, or someone who holds the decryption passkey from saving what they decrypted. Browser-level controls, watermarking, session
// expiry, suppression of printing and download, and capture-attempt signals (best effort, not proof) are what is actually enforced.
//
// Renders: PDF, images, text, Markdown, CSV, JSON/code, Word (.docx), Excel (.xlsx) and DICOM (uncompressed pixel data). Heavy readers load on demand.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../business/notes/NotesView";

export const VIEWER_HONESTY = "This viewer limits what the browser lets you do: no download, print or copy where the owner restricted them, a watermark, and a time limit. It cannot stop someone photographing the screen, using an operating-system screenshot or recording tool, or keeping a file they were allowed to decrypt.";

const ext = (n) => (String(n).includes(".") ? String(n).split(".").pop().toLowerCase() : "");
export function kindOf(name, mime, bytes) {
  const e = ext(name); const m = String(mime || "");
  if (e === "pdf" || m === "application/pdf") return "pdf";
  if (/^(png|jpe?g|gif|webp|bmp|avif)$/.test(e) || /^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(m)) return "image";
  if (e === "docx") return "docx"; if (e === "xlsx") return "xlsx"; if (e === "csv" || m === "text/csv") return "csv"; if (e === "md" || e === "markdown") return "markdown";
  if (e === "dcm" || e === "dicom" || (bytes && bytes.length > 132 && String.fromCharCode(...bytes.slice(128, 132)) === "DICM")) return "dicom";
  if (/^(txt|log|json|xml|yml|yaml|js|ts|py|java|c|cpp|h|go|rs|sql|sh|html|css|ini|conf|toml)$/.test(e) || m.startsWith("text/") || m === "application/json") return "text";
  return "unknown";
}

// ---------------------------------------------------------------------------------------------------- tiny readers
function parseCsv(text, maxRows = 1000) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(cur); cur = ""; } else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); } return rows;
}
const Table = ({ rows }) => (
  <div className="overflow-auto max-h-[70vh]"><table className="text-[12px] border-collapse"><tbody>{rows.slice(0, 1000).map((r, i) => <tr key={i} className={i === 0 ? "font-bold bg-slate-100" : ""}>{r.slice(0, 60).map((c, j) => <td key={j} className="border border-slate-300 px-2 py-0.5 whitespace-nowrap max-w-[260px] overflow-hidden text-ellipsis">{String(c ?? "")}</td>)}</tr>)}</tbody></table></div>
);
const EXPLICIT_LE = "1.2.840.10008.1.2.1", IMPLICIT_LE = "1.2.840.10008.1.2";

function PdfView({ bytes, onError }) {
  const host = useRef(null); const [pages, setPages] = useState(0); const [limit, setLimit] = useState(12);
  useEffect(() => {
    let dead = false; let doc;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false }).promise; if (dead) return; setPages(doc.numPages);
        host.current.innerHTML = "";
        for (let n = 1; n <= Math.min(doc.numPages, limit) && !dead; n++) {
          const page = await doc.getPage(n); const vp = page.getViewport({ scale: 1.3 }); const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; c.className = "max-w-full mx-auto mb-2 shadow"; host.current.appendChild(c);
          await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        }
      } catch (e) { if (!dead) onError(e.message?.includes("password") ? "This PDF is password protected." : "This PDF could not be displayed."); }
    })();
    return () => { dead = true; try { doc?.destroy(); } catch { /* ignore */ } };
  }, [bytes, limit, onError]);
  return (<div><div ref={host} />{pages > limit && <button className="block mx-auto mt-2 text-[12px] underline" onClick={() => setLimit((l) => l + 12)}>Show more pages ({limit} of {pages})</button>}</div>);
}
function DocxView({ bytes, onError }) {
  const [html, setHtml] = useState("");
  useEffect(() => { let dead = false; (async () => { try { const mammoth = await import("mammoth"); const r = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer }); const { sanitizeHtml } = await import("../business/notes/NotesView"); if (!dead) setHtml(sanitizeHtml(r.value)); } catch { if (!dead) onError("This Word document could not be displayed."); } })(); return () => { dead = true; }; }, [bytes, onError]);
  return <div className="prose max-w-none text-[14px] [&_ul]:list-disc [&_ul]:ml-5 [&_ol]:list-decimal [&_ol]:ml-5" dangerouslySetInnerHTML={{ __html: html }} />;
}
function XlsxView({ bytes, onError }) {
  const [sheets, setSheets] = useState([]); const [active, setActive] = useState(0);
  useEffect(() => { let dead = false; (async () => { try { const m = await import("read-excel-file/universal"); const r = await m.default(new Blob([bytes])); if (!dead) { setSheets(Array.isArray(r) ? r.map((x) => ({ name: x.sheet, rows: (x.data || []).slice(0, 1000) })) : []); setActive(0); } } catch { if (!dead) onError("This spreadsheet could not be displayed."); } })(); return () => { dead = true; }; }, [bytes, onError]);
  return (<div>{sheets.length > 1 && <div className="flex gap-1 mb-2 flex-wrap">{sheets.map((x, i) => <button key={x.name + i} className={`text-[11px] px-2 py-1 border rounded ${i === active ? "bg-slate-200 font-bold" : ""}`} onClick={() => setActive(i)}>{x.name}</button>)}</div>}<Table rows={sheets[active]?.rows || []} /></div>);
}
function DicomView({ bytes, onError }) {
  const cv = useRef(null); const [info, setInfo] = useState(null); const [wc, setWc] = useState(0); const [ww, setWw] = useState(1); const [show, setShow] = useState(false); const model = useRef(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const dp = (await import("dicom-parser")).default ?? (await import("dicom-parser")); const ds = dp.parseDicom(bytes);
        const ts = ds.string("x00020010") || IMPLICIT_LE; if (ts !== EXPLICIT_LE && ts !== IMPLICIT_LE) { onError(`This DICOM uses compressed pixel data (${ts}) that this viewer cannot display.`); return; }
        const rows = ds.uint16("x00280010"), cols = ds.uint16("x00280011"), bits = ds.uint16("x00280100"), signed = ds.uint16("x00280103") === 1, spp = ds.uint16("x00280002") || 1;
        const slope = parseFloat(ds.string("x00281053") || "1"), inter = parseFloat(ds.string("x00281052") || "0"); const photo = ds.string("x00280004") || "MONOCHROME2";
        if (!rows || !cols || spp !== 1 || (bits !== 8 && bits !== 16)) { onError("This DICOM image layout is not supported by the viewer."); return; }
        const el = ds.elements.x7fe00010; if (!el) { onError("This DICOM file has no image data."); return; }
        const raw = bits === 8 ? new Uint8Array(ds.byteArray.buffer, ds.byteArray.byteOffset + el.dataOffset, rows * cols) : (signed ? new Int16Array(ds.byteArray.buffer.slice(ds.byteArray.byteOffset + el.dataOffset, ds.byteArray.byteOffset + el.dataOffset + rows * cols * 2)) : new Uint16Array(ds.byteArray.buffer.slice(ds.byteArray.byteOffset + el.dataOffset, ds.byteArray.byteOffset + el.dataOffset + rows * cols * 2)));
        const vals = new Float32Array(raw.length); let mn = Infinity, mx = -Infinity; for (let i = 0; i < raw.length; i++) { const v = raw[i] * slope + inter; vals[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
        const c0 = parseFloat(String(ds.string("x00281050") || "").split("\\")[0]), w0 = parseFloat(String(ds.string("x00281051") || "").split("\\")[0]);
        model.current = { vals, rows, cols, photo }; if (dead) return;
        setInfo({ modality: ds.string("x00080060") || "?", rows, cols, bits, study: ds.string("x00081030") || "", patient: ds.string("x00100010") || "", min: mn, max: mx }); setWc(Number.isFinite(c0) ? c0 : (mn + mx) / 2); setWw(Number.isFinite(w0) && w0 > 0 ? w0 : Math.max(1, mx - mn));
      } catch { if (!dead) onError("This DICOM file could not be read."); }
    })();
    return () => { dead = true; };
  }, [bytes, onError]);
  useEffect(() => {
    const m = model.current; const c = cv.current; if (!m || !c || !info) return; c.width = m.cols; c.height = m.rows; const ctx = c.getContext("2d"); const img = ctx.createImageData(m.cols, m.rows);
    const lo = wc - ww / 2; for (let i = 0; i < m.vals.length; i++) { let g = Math.round(((m.vals[i] - lo) / ww) * 255); g = g < 0 ? 0 : g > 255 ? 255 : g; if (m.photo === "MONOCHROME1") g = 255 - g; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g; img.data[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  }, [info, wc, ww]);
  if (!info) return <p className="text-[13px] p-4">Reading the image…</p>;
  return (
    <div>
      <canvas ref={cv} className="max-w-full mx-auto bg-black" style={{ maxHeight: "65vh" }} />
      <div className="grid sm:grid-cols-2 gap-2 mt-2 text-[12px]">
        <label>Window level <input type="range" min={info.min} max={info.max} value={wc} onChange={(e) => setWc(Number(e.target.value))} className="w-full" aria-label="Window level" /></label>
        <label>Window width <input type="range" min={1} max={Math.max(2, info.max - info.min)} value={ww} onChange={(e) => setWw(Number(e.target.value))} className="w-full" aria-label="Window width" /></label>
      </div>
      <p className="text-[12px] mt-1">{info.modality} · {info.cols}×{info.rows} · {info.bits}-bit{info.study ? ` · ${info.study}` : ""}</p>
      {info.patient && <p className="text-[12px]">{show ? `Patient: ${info.patient}` : <button className="underline" onClick={() => setShow(true)}>Show patient name</button>}</p>}
      <p className="text-[11px] text-slate-500 mt-1">Viewing aid only. This is not a diagnostic or clinically validated viewer.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- the viewer shell
const wmUrl = (lines) => {
  const t = lines.filter(Boolean).map((l, i) => `<text x="12" y="${28 + i * 18}" font-family="sans-serif" font-size="13" font-weight="700" fill="rgba(15,23,42,0.22)" transform="rotate(-24 120 60)">${String(l).replace(/[<>&"]/g, " ")}</text>`).join("");
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='300' height='170'>${t}</svg>`)}")`;
};

/**
 * Props: file {bytes, name, mime}, mode, watermark {lines[]} | null, expiresAt (ISO) | null, canDownload, onSignal(type), onExpire(), onDownload()
 */
export default function SecureViewer({ file, mode = "normal", watermark = null, expiresAt = null, canDownload = false, onSignal = () => {}, onExpire = () => {}, onDownload }) {
  const root = useRef(null); const overlay = useRef(null); const [err, setErr] = useState(""); const [hidden, setHidden] = useState(false); const [left, setLeft] = useState(null); const [expired, setExpired] = useState(false);
  const restricted = mode === "restricted"; const locked = mode === "view_only" || restricted; const kind = useMemo(() => kindOf(file.name, file.mime, file.bytes), [file]);
  const signal = useCallback((t) => { try { onSignal(t); } catch { /* signals never break the viewer */ } }, [onSignal]);

  // session expiry: wipe the document from view and memory
  useEffect(() => {
    if (!expiresAt) return; const tick = () => { const ms = new Date(expiresAt).getTime() - Date.now(); setLeft(Math.max(0, Math.floor(ms / 1000))); if (ms <= 0) { setExpired(true); onExpire(); } };
    tick(); const t = setInterval(tick, 1000); return () => clearInterval(t);
  }, [expiresAt, onExpire]);

  // restrictions: printing, saving, copying, context menu, focus loss
  useEffect(() => {
    if (!locked) return;
    const onKey = (e) => {
      const k = String(e.key || "").toLowerCase(); const mod = e.ctrlKey || e.metaKey;
      if (mod && k === "p") { e.preventDefault(); signal("PRINT_ATTEMPT"); }
      if (mod && k === "s" && !canDownload) { e.preventDefault(); signal("DOWNLOAD_CLICKED"); }
      if (restricted && mod && (k === "c" || k === "x" || k === "a")) { e.preventDefault(); signal("COPY_BLOCKED"); }
    };
    const onKeyUp = (e) => { if (e.key === "PrintScreen") { signal("SCREENSHOT_KEY"); try { navigator.clipboard?.writeText(""); } catch { /* best effort */ } } };
    const onPrint = () => signal("PRINT_ATTEMPT"); let last = 0;
    const onBlur = () => { const n = Date.now(); if (n - last > 5000) { last = n; signal("WINDOW_BLURRED"); } if (restricted) setHidden(true); };
    const onFocus = () => setHidden(false); const onVis = () => { if (document.visibilityState === "hidden" && restricted) setHidden(true); };
    window.addEventListener("keydown", onKey); window.addEventListener("keyup", onKeyUp); window.addEventListener("beforeprint", onPrint); window.addEventListener("blur", onBlur); window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); window.removeEventListener("beforeprint", onPrint); window.removeEventListener("blur", onBlur); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVis); };
  }, [locked, restricted, canDownload, signal]);
  const block = (t) => (e) => { e.preventDefault(); signal(t); };

  // watermark: keep it in place; if something removes or restyles it, put it back
  useEffect(() => {
    if (!watermark || !root.current) return; const lines = watermark.lines;
    let mo = null;
    const make = () => { const d = document.createElement("div"); d.setAttribute("aria-hidden", "true"); d.setAttribute("data-watermark", "1"); d.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:50;background-image:${wmUrl(lines)};background-repeat:repeat;`; return d; };
    const ensure = () => { const cur = overlay.current; if (!cur || !root.current.contains(cur) || cur.style.display === "none" || cur.style.opacity === "0" || cur.style.visibility === "hidden") { try { cur?.remove(); } catch { /* ignore */ } overlay.current = make(); root.current.appendChild(overlay.current); mo?.observe(overlay.current, { attributes: true }); } };
    mo = new MutationObserver(ensure); ensure(); mo.observe(root.current, { childList: true, subtree: false }); if (overlay.current) mo.observe(overlay.current, { attributes: true });     return () => { mo?.disconnect(); try { overlay.current?.remove(); } catch { /* ignore */ } overlay.current = null; };
  }, [watermark]);

  if (expired) return <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-6 text-center text-sm" role="alert">Your access to this document has ended. Open the link again to continue.</div>;
  const body = err ? <p className="p-6 text-sm text-red-700" role="alert">{err}</p>
    : kind === "pdf" ? <PdfView bytes={file.bytes} onError={setErr} />
    : kind === "image" ? <ImageView file={file} locked={locked} />
    : kind === "docx" ? <DocxView bytes={file.bytes} onError={setErr} />
    : kind === "xlsx" ? <XlsxView bytes={file.bytes} onError={setErr} />
    : kind === "dicom" ? <DicomView bytes={file.bytes} onError={setErr} />
    : kind === "csv" ? <Table rows={parseCsv(new TextDecoder().decode(file.bytes))} />
    : kind === "markdown" ? <Markdown text={new TextDecoder().decode(file.bytes)} />
    : kind === "text" ? <pre className="text-[12px] whitespace-pre-wrap break-words max-h-[70vh] overflow-auto">{new TextDecoder().decode(file.bytes).slice(0, 400_000)}</pre>
    : <p className="p-6 text-sm text-slate-700">This file type cannot be previewed here.{canDownload ? " You can download it." : ""}</p>;
  return (
    <div>
      <style>{`@media print { .sv-root { display: none !important; } .sv-print-note { display: block !important; } }`}</style>
      <p className="sv-print-note hidden text-center p-6">Printing is not available for this document.</p>
      <div className="flex flex-wrap items-center gap-2 text-[11px] mb-1">
        <span className="font-bold uppercase">{{ normal: "Preview", view_only: "View only", restricted: "Restricted view" }[mode] || "Preview"}</span>
        {left !== null && <span aria-live="off">Access ends in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>}
        {canDownload && onDownload && <button className="underline ml-auto" onClick={() => { signal("DOWNLOAD_CLICKED"); onDownload(); }}>Download</button>}
      </div>
      <div ref={root} className="sv-root relative bg-white text-slate-900 rounded-xl overflow-hidden p-3" style={{ minHeight: 280, userSelect: restricted ? "none" : undefined, filter: hidden ? "blur(18px)" : undefined }}
        onContextMenu={locked ? block("COPY_BLOCKED") : undefined} onCopy={restricted ? block("COPY_BLOCKED") : undefined} onCut={restricted ? block("COPY_BLOCKED") : undefined} onDragStart={(e) => locked && e.preventDefault()}>
        {body}
      </div>
      {hidden && <p className="text-[12px] text-center mt-1" role="status">The document is hidden while this window is not in focus.</p>}
      <p className="text-[11px] mt-2 opacity-80">{VIEWER_HONESTY}</p>
    </div>
  );
}
function ImageView({ file, locked }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([file.bytes], { type: file.mime || "image/png" })), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="max-w-full mx-auto" draggable={!locked} />;
}
