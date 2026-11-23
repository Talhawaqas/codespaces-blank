// src/lib/commerce/barcode.js -- Inaya Commerce: product barcode labels (post-SOW, beta).
//
// Code 128 (read by every 1D/2D scanner; it carries the product's barcode or SKU exactly as text) drawn as SVG for any
// printer through the print dialog (label printers with their driver, or A4 sticker sheets), plus the two common label
// printer languages for direct printing from the Inaya desktop app: ZPL (Zebra) and TSPL (TSC, Xprinter and similar).
// Pure; no dependencies. Every symbol is checked in test-ui/barcode.test.js by decoding it with the ZXing reader.

// Code 128 bar/space widths for values 0-105, then STOP (106).
const P = "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112".split(" ");
const START_B = 104, START_C = 105, TO_B = 100, TO_C = 99, STOP = 106;
const QUIET = 10;

export function barcodeProblem(text) {
  const s = String(text ?? "");
  if (!s) return "No barcode or SKU to print.";
  if (s.length > 48) return "Barcodes are limited to 48 characters.";
  if (!/^[\x20-\x7e]+$/.test(s)) return "Only standard letters, digits and symbols can go in a barcode.";
  return null;
}

/** Code 128 symbol values (start, data, checksum, stop). Uses Code C for long digit runs (shorter labels), Code B else. */
export function code128Values(text) {
  const s = String(text); const p = barcodeProblem(s); if (p) throw new Error(p);
  const vals = []; let i = 0; let set = null;
  const digitRun = (k) => { let n = 0; while (k + n < s.length && /\d/.test(s[k + n])) n++; return n; };
  while (i < s.length) {
    const run = digitRun(i);
    const useC = run >= 4 && (i === 0 || i + run === s.length ? run >= 4 : run >= 6);
    if (useC) {
      const pairs = Math.floor(run / 2) * 2; // an odd digit left over goes in Code B
      if (set !== "C") { vals.push(set === null ? START_C : TO_C); set = "C"; }
      for (let k = 0; k < pairs; k += 2) vals.push(Number(s.substr(i + k, 2)));
      i += pairs; continue;
    }
    if (set !== "B") { vals.push(set === null ? START_B : TO_B); set = "B"; }
    vals.push(s.charCodeAt(i) - 32); i++;
  }
  let sum = vals[0]; for (let k = 1; k < vals.length; k++) sum += vals[k] * k;
  vals.push(sum % 103, STOP);
  return vals;
}

/** Module pattern: array of { bar: boolean, w: modules }, with the quiet zones. */
export function code128Modules(text) {
  const out = [{ bar: false, w: QUIET }];
  for (const v of code128Values(text)) P[v].split("").forEach((d, k) => out.push({ bar: k % 2 === 0, w: Number(d) }));
  out.push({ bar: false, w: QUIET });
  return out;
}
export const moduleCount = (text) => code128Modules(text).reduce((s, m) => s + m.w, 0);

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The barcode as SVG (scales to any label size; crisp at any printer resolution). */
export function code128Svg(text, { height = 60, showText = true, fontSize = 12 } = {}) {
  const mods = code128Modules(text); const width = mods.reduce((s, m) => s + m.w, 0);
  let x = 0; const rects = [];
  for (const m of mods) { if (m.bar) rects.push(`<rect x="${x}" y="0" width="${m.w}" height="${height}"/>`); x += m.w; }
  const h = height + (showText ? fontSize + 4 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Barcode ${esc(text)}"><rect width="${width}" height="${h}" fill="#fff"/><g fill="#000">${rects.join("")}</g>${showText ? `<text x="${width / 2}" y="${height + fontSize + 1}" font-family="Arial, sans-serif" font-size="${fontSize}" text-anchor="middle">${esc(text)}</text>` : ""}</svg>`;
}

// ---------------------------------------------------------------- label sheets (print dialog)
export const LABEL_SIZES = {
  "50x25": { name: "50 × 25 mm label", w: 50, h: 25 },
  "40x30": { name: "40 × 30 mm label", w: 40, h: 30 },
  "38x25": { name: "38 × 25 mm label", w: 38, h: 25 },
  "58x40": { name: "58 × 40 mm label", w: 58, h: 40 },
  "a4-3x8": { name: "A4 sticker sheet, 3 × 8 (70 × 37 mm)", w: 70, h: 37, sheet: { cols: 3, rows: 8, page: "A4" } },
  "a4-4x10": { name: "A4 sticker sheet, 4 × 10 (52.5 × 29.7 mm)", w: 52.5, h: 29.7, sheet: { cols: 4, rows: 10, page: "A4" } },
};

/** items: [{ name, code, price? (text) , copies }]. Returns a complete HTML document for the print window. */
export function labelSheetHtml(items, sizeKey = "50x25", { showName = true, showPrice = true } = {}) {
  const size = LABEL_SIZES[sizeKey] || LABEL_SIZES["50x25"];
  const labels = [];
  for (const it of items) { const n = Math.max(0, Math.min(500, Math.floor(Number(it.copies) || 0))); for (let k = 0; k < n; k++) labels.push(it); }
  const one = (it) => `<div class="lab">${showName ? `<div class="nm">${esc(it.name)}</div>` : ""}<div class="bc">${code128Svg(it.code, { height: 50, fontSize: 11 })}</div>${showPrice && it.price ? `<div class="pr">${esc(it.price)}</div>` : ""}</div>`;
  const sheet = size.sheet;
  const page = sheet ? `@page { size: A4; margin: 0; } body { margin: 0; } .sheet { display: grid; grid-template-columns: repeat(${sheet.cols}, ${size.w}mm); grid-auto-rows: ${size.h}mm; justify-content: center; align-content: start; padding-top: ${Math.max(0, (297 - sheet.rows * size.h) / 2).toFixed(2)}mm; }`
    : `@page { size: ${size.w}mm ${size.h}mm; margin: 0; } body { margin: 0; } .lab { page-break-after: always; break-after: page; }`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title><style>
${page}
* { box-sizing: border-box; } body { font-family: Arial, sans-serif; color: #000; }
.lab { width: ${size.w}mm; height: ${size.h}mm; padding: 1.5mm 2.5mm; display: flex; flex-direction: column; justify-content: center; overflow: hidden; break-inside: avoid; }
.nm { font-size: ${size.h < 28 ? 7 : 8.5}pt; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
.bc { flex: 1; min-height: 0; display: flex; } .bc svg { width: 100%; height: 100%; }
.pr { font-size: ${size.h < 28 ? 8 : 10}pt; font-weight: 700; text-align: center; }
</style></head><body>${sheet ? `<div class="sheet">${labels.map(one).join("")}</div>` : labels.map(one).join("")}</body></html>`;
}

// ---------------------------------------------------------------- direct printing (desktop app, raw)
const DOTS_PER_MM = 8; // 203 dpi, the usual label-printer resolution
const zplText = (s) => String(s ?? "").replace(/[\^~\\]/g, " ").replace(/[^\x20-\x7e]/g, "?").slice(0, 60);
/** ZPL II (Zebra). One format, printed `copies` times. */
export function zplLabel({ name, code, price }, { w = 50, h = 25, copies = 1 } = {}) {
  const p = barcodeProblem(code); if (p) throw new Error(p);
  if (/[\^~]/.test(code)) throw new Error("This barcode has a character Zebra printers treat as a command (^ or ~).");
  const W = Math.round(w * DOTS_PER_MM), H = Math.round(h * DOTS_PER_MM); const barH = Math.max(40, H - 90);
  return `^XA^CI28^PW${W}^LL${H}^LH0,0` + (name ? `^FO16,10^A0N,22,22^FB${W - 32},1,0,C^FD${zplText(name)}^FS` : "") +
    `^FO24,38^BY2^BCN,${barH},Y,N,N^FD${code}^FS` + (price ? `^FO16,${H - 26}^A0N,22,22^FB${W - 32},1,0,C^FD${zplText(price)}^FS` : "") +
    `^PQ${Math.max(1, Math.min(500, Math.floor(copies)))}^XZ\n`;
}
const tsplText = (s) => String(s ?? "").replace(/"/g, "'").replace(/[^\x20-\x7e]/g, "?").slice(0, 40);
/** TSPL (TSC, Xprinter, Gprinter and similar). */
export function tsplLabel({ name, code, price }, { w = 50, h = 25, copies = 1 } = {}) {
  const p = barcodeProblem(code); if (p) throw new Error(p);
  if (/"/.test(code)) throw new Error("This barcode has a quote mark, which these label printers can't print in a barcode.");
  const H = Math.round(h * DOTS_PER_MM); const barH = Math.max(40, H - 100);
  return [`SIZE ${w} mm,${h} mm`, "GAP 2 mm,0 mm", "DIRECTION 1", "CLS",
    ...(name ? [`TEXT 16,8,"2",0,1,1,"${tsplText(name)}"`] : []),
    `BARCODE 16,36,"128",${barH},1,0,2,2,"${code}"`,
    ...(price ? [`TEXT 16,${H - 28},"2",0,1,1,"${tsplText(price)}"`] : []),
    `PRINT ${Math.max(1, Math.min(500, Math.floor(copies)))},1`, ""].join("\r\n");
}
