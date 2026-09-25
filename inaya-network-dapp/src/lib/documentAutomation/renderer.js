// src/lib/documentAutomation/renderer.js
//
// Document Automation SOW §5/§21/§22/§24 -- the generic template renderer.
// Interprets a validated template spec (templateSchema.js) against a view
// model and draws it with pdfkit. It never evaluates template content as
// code: every block is one of a closed set, every value is text drawn by
// pdfkit (markup is printed, not interpreted), and no external resource is
// ever fetched (the only image is the org logo bytes the caller passes in).
//
// Production concerns handled here rather than left to callers:
//   - A4 / Letter, portrait/landscape, configurable margins
//   - multi-page tables with the header repeated on every page
//   - footer with "Page x of y", document id, fingerprint, verification URL
//   - Unicode text via embedded Noto Sans (Latin/Greek/Cyrillic) and Noto
//     Sans Arabic (Arabic + Urdu), shaped by fontkit, with a small bidi
//     layer that orders mixed-direction runs and mirrors the page for RTL
//   - reproducibility (§24): fixed PDF metadata dates, no random ids -- the
//     same snapshot + template + renderer version yields the same bytes on
//     the same runtime; the runtime (Node/ICU) is recorded in the manifest
//     because Intl output can differ across ICU versions.

import PDFDocument from "pdfkit";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPath, evalCondition, INTERP_RE } from "./templateSchema.js";
import { label as i18nLabel, formatMoney, formatNumber, formatPercent, formatDate, isRtlLocale, icuInfo } from "./i18n.js";

export const RENDERER_NAME = "inaya-document-renderer";
export const RENDERER_VERSION = "1.0.0";
export const MAX_PAGES = 200;
export const MAX_RENDER_MS = 20000;

const FONT_FILES = {
  Sans: "NotoSans-Regular.ttf", "Sans-Bold": "NotoSans-Bold.ttf",
  Arabic: "NotoSansArabic-Regular.ttf", "Arabic-Bold": "NotoSansArabic-Bold.ttf",
};

let fontCache = null;
function loadFonts() {
  if (fontCache) return fontCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "fonts"),
    path.join(process.cwd(), "src", "lib", "documentAutomation", "fonts"),
    path.join(process.cwd(), "inaya-network-dapp", "src", "lib", "documentAutomation", "fonts"),
  ];
  const dir = candidates.find((d) => existsSync(path.join(d, FONT_FILES.Sans)));
  const loaded = {};
  if (dir) {
    for (const [name, file] of Object.entries(FONT_FILES)) {
      try { const buf = readFileSync(path.join(dir, file)); loaded[name] = { buf, sha256: createHash("sha256").update(buf).digest("hex").slice(0, 16), file }; } catch { /* missing font falls back below */ }
    }
  }
  fontCache = loaded;
  return fontCache;
}

let pdfkitVersion = null;
function getPdfkitVersion() {
  if (pdfkitVersion) return pdfkitVersion;
  try {
    const p = path.join(process.cwd(), "node_modules", "pdfkit", "package.json");
    pdfkitVersion = JSON.parse(readFileSync(p, "utf8")).version;
  } catch { pdfkitVersion = "unknown"; }
  return pdfkitVersion;
}

export function getRendererInfo() {
  const fonts = loadFonts();
  return {
    name: RENDERER_NAME, version: RENDERER_VERSION, library: "pdfkit", libraryVersion: getPdfkitVersion(),
    fonts: Object.entries(fonts).map(([name, f]) => ({ name, file: f.file, sha256: f.sha256 })),
    runtime: icuInfo(),
    reproducibility: "Same source snapshot + template version + renderer version on the same Node/ICU runtime yields byte-identical output. Number/date text comes from Intl, which can differ across ICU versions; the runtime is therefore recorded here.",
  };
}

// ---------------------------------------------------------------------
// Bidi-aware, word-atomic text layout
// ---------------------------------------------------------------------
// fontkit reverses glyphs per script run, which mis-places spaces between
// Arabic words (found by rendering a real Arabic invoice and reading it).
// So text is laid out word by word: an Arabic word is drawn as one atomic
// shaped unit (fontkit orders its glyphs correctly), spaces are explicit
// gaps, and this layer orders words/runs for the paragraph direction.
const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LETTER_RE = /[\p{L}\p{N}]/u;
const INVISIBLE_MARKS_RE = /[‎‏؜‪-‮⁦-⁩]/g;

function normalizeText(text) {
  return String(text ?? "").replace(INVISIBLE_MARKS_RE, "").replace(/[  ]/g, " ");
}

function tokenClass(tok) {
  if (tok === " ") return "N";
  if (ARABIC_RE.test(tok)) return "R";
  if (LETTER_RE.test(tok)) return "L";
  return "N";
}

/** Returns tokens in VISUAL left-to-right order: [{text, cls}] where cls is
 *  "R" (right-to-left word), "L" (left-to-right word) or "S" (a space). */
function visualTokens(text, paragraphRtl) {
  const raw = normalizeText(text).split(/( )/).filter((t) => t !== "");
  const items = raw.map((t) => ({ text: t, cls: tokenClass(t), space: t === " " }));
  const strong = (idx, dir) => { for (let i = idx + dir; i >= 0 && i < items.length; i += dir) if (items[i].cls !== "N") return items[i].cls; return null; };
  const resolved = items.map((it, i) => {
    if (it.cls !== "N") return it.cls;
    const a = strong(i, -1); const b = strong(i, 1);
    return a && a === b ? a : paragraphRtl ? "R" : "L";
  });
  items.forEach((it, i) => { it.cls = resolved[i]; });
  const runs = [];
  for (const it of items) {
    const last = runs[runs.length - 1];
    if (last && last.cls === it.cls) last.items.push(it); else runs.push({ cls: it.cls, items: [it] });
  }
  for (const r of runs) if (r.cls === "R") r.items.reverse();
  if (paragraphRtl) runs.reverse();
  return runs.flatMap((r) => r.items.map((it) => ({ text: it.text, cls: it.space ? "S" : r.cls })));
}

class Painter {
  constructor(doc, { fonts, useUnicode, rtl, scale }) {
    this.doc = doc; this.fonts = fonts; this.useUnicode = useUnicode; this.rtl = rtl; this.scale = scale;
    this.coverage = new Map();
    this.widthCache = new Map();
  }
  fontName(kind, bold) {
    if (!this.useUnicode) return bold ? "Helvetica-Bold" : "Helvetica";
    if (kind === "R" && this.fonts.Arabic) return bold ? "Arabic-Bold" : "Arabic";
    return bold ? "Sans-Bold" : "Sans";
  }
  covers(fontName, ch) {
    const key = `${fontName}:${ch}`;
    if (this.coverage.has(key)) return this.coverage.get(key);
    let ok = true;
    try { this.doc.font(fontName); ok = !!this.doc._font?.font?.hasGlyphForCodePoint?.(ch.codePointAt(0)); } catch { ok = true; }
    this.coverage.set(key, ok);
    return ok;
  }
  rawWidth(text, fontName, size) {
    const key = `${fontName}|${size}|${text}`;
    const hit = this.widthCache.get(key);
    if (hit !== undefined) return hit;
    this.doc.font(fontName).fontSize(size);
    const w = this.doc.widthOfString(text, { lineBreak: false });
    if (this.widthCache.size > 20000) this.widthCache.clear();
    this.widthCache.set(key, w);
    return w;
  }
  /** Drawable segments of ONE word, in visual left-to-right order. An
   *  Arabic word is split by glyph coverage so characters the Arabic font
   *  lacks (e.g. "+", parentheses) fall back to the Latin font instead of
   *  printing a missing-glyph box. */
  segments(token, bold) {
    if (token.cls === "S") return [{ text: " ", font: this.fontName("L", bold), gap: true }];
    if (token.cls !== "R" || !this.fonts.Arabic || !this.useUnicode) {
      return [{ text: token.text, font: this.fontName("L", bold) }];
    }
    const arabic = this.fontName("R", bold);
    const latin = this.fontName("L", bold);
    const segs = [];
    for (const ch of token.text) {
      const font = this.covers(arabic, ch) ? arabic : latin;
      const last = segs[segs.length - 1];
      if (last && last.font === font) last.text += ch; else segs.push({ text: ch, font });
    }
    return segs.reverse(); // an RTL word: the logical first segment sits at the right
  }
  tokenWidth(token, size, bold) {
    return this.segments(token, bold).reduce((w, s) => w + this.rawWidth(s.text, s.font, size), 0);
  }
  wordWidth(word, size, bold) {
    return visualTokens(word, this.rtl).reduce((w, t) => w + this.tokenWidth(t, size, bold), 0);
  }
  /** Greedy word wrap into lines of at most `width` points. */
  wrap(text, width, size, bold) {
    const lines = [];
    const spaceW = this.rawWidth(" ", this.fontName("L", bold), size);
    for (const para of normalizeText(text).split("\n")) {
      const words = para.split(" ");
      let line = "";
      let lineW = 0;
      for (const word of words) {
        const w = this.wordWidth(word, size, bold);
        if (line && lineW + spaceW + w > width) { lines.push(line); line = word; lineW = w; }
        else { lineW = line ? lineW + spaceW + w : w; line = line ? `${line} ${word}` : word; }
        // A single unbroken token wider than the column is hard-split so it
        // can never overflow into the next column or off the page.
        while (lineW > width && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && this.wordWidth(line.slice(0, cut), size, bold) > width) cut--;
          lines.push(line.slice(0, cut)); line = line.slice(cut); lineW = this.wordWidth(line, size, bold);
        }
      }
      lines.push(line);
    }
    return lines;
  }
  lineHeight(size) { return size * (this.rtl ? 1.5 : 1.3); }
  measure(text, width, size, bold) {
    return this.wrap(text, width, size, bold).length * this.lineHeight(size);
  }
  /** Draws one already-wrapped line at y. align: start|end|center */
  drawLine(text, x, y, width, { size, bold, color, align = "start" }) {
    const tokens = visualTokens(text, this.rtl);
    const parts = tokens.flatMap((t) => this.segments(t, bold).map((s) => ({ ...s, w: this.rawWidth(s.text, s.font, size) })));
    const total = parts.reduce((a, s) => a + s.w, 0);
    const physical = align === "center" ? "center" : (align === "start") === !this.rtl ? "left" : "right";
    let cx = physical === "left" ? x : physical === "right" ? x + width - total : x + (width - total) / 2;
    for (const s of parts) {
      if (!s.gap) this.doc.font(s.font).fontSize(size).fillColor(color).text(s.text, cx, y, { lineBreak: false });
      cx += s.w;
    }
  }
  /** Wraps and draws text; returns the height consumed. */
  paragraph(text, x, y, width, opts) {
    const lines = this.wrap(text, width, opts.size, opts.bold);
    const lh = this.lineHeight(opts.size);
    lines.forEach((line, i) => this.drawLine(line, x, y + i * lh, width, opts));
    return lines.length * lh;
  }
}

// ---------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------
function asLines(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((s) => s.trim() !== "");
  if (value === undefined || value === null || value === "") return [];
  return String(value).split("\n").filter((s) => s.trim() !== "");
}

function formatValue(value, fmt, view, locale) {
  if (value === undefined || value === null) return "";
  switch (fmt) {
    case "date": return formatDate(value, locale);
    case "datetime": return formatDate(value, locale, true);
    case "number": return typeof value === "number" ? formatNumber(value, locale) : String(value);
    case "integer": return typeof value === "number" ? formatNumber(value, locale, { maximumFractionDigits: 0 }) : String(value);
    case "currency": return typeof value === "number" ? formatMoney(value, view.doc?.currency || "USD", locale, view.__currencyDisplay || "symbol") : String(value);
    case "percent": return typeof value === "number" ? formatPercent(value, locale) : String(value);
    default: return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/** Interpolates {{path|format}} references. Substituted values are inserted
 *  verbatim and never re-scanned, so a source field containing "{{...}}"
 *  cannot inject template syntax. */
function interpolate(text, view, locale, defaultFormat) {
  if (typeof text !== "string") return "";
  return text.replace(INTERP_RE, (_, p, fmt) => formatValue(getPath(view, p), fmt || defaultFormat, view, locale));
}

/** A line that is exactly one reference to an array expands to one line per
 *  element (e.g. address lines); everything else is a single string. */
function expandLine(text, view, locale) {
  const m = /^\s*\{\{\s*([A-Za-z0-9_.]+)\s*\}\}\s*$/.exec(text);
  if (m) {
    const v = getPath(view, m[1]);
    if (Array.isArray(v)) return asLines(v);
  }
  const out = interpolate(text, view, locale);
  return out.trim() === "" ? [] : [out];
}

function cellValue(row, col, view, locale) {
  const v = row[col.key];
  if (v === undefined || v === null) return "";
  const fmt = col.format || (typeof v === "number" ? "number" : "text");
  if (fmt === "currency" && row.__currency) return formatMoney(v, row.__currency, locale, view.__currencyDisplay || "symbol");
  return formatValue(v, fmt, view, locale);
}

// ---------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------
/**
 * @param {Object} p
 * @param {Object} p.spec      validated template spec
 * @param {Object} p.view      view model (namespaces doc/org/party/calc/approval/flags/verify + row sources)
 * @param {string} p.locale
 * @param {Object} [p.assets]  { logo: Buffer }
 * @param {Object} [p.overrides] { pageSize, margins, orientation, accentColor }
 * @returns {Promise<{buffer: Buffer, pages: number, renderer: Object}>}
 */
export function renderDocumentPdf({ spec, view: inputView, locale = "en-US", assets = {}, overrides = {} }) {
  return new Promise((resolve, reject) => {
    const view = { ...inputView, __currencyDisplay: spec.currency?.display };
    const started = Date.now();
    const fonts = loadFonts();
    const useUnicode = !!fonts.Sans;
    const rtl = isRtlLocale(locale);
    const pageSize = overrides.pageSize || spec.page?.size || "A4";
    const orientation = overrides.orientation || spec.page?.orientation || "portrait";
    const m = { top: 50, right: 50, bottom: 50, left: 50, ...(spec.page?.margins || {}), ...(overrides.margins || {}) };
    const accent = overrides.accentColor || spec.style?.accentColor || "#2e3a5c";
    const scale = spec.style?.fontScale || 1;
    const ink = "#1a1a2e";
    const muted = "#666680";
    const line = "#d8d8e0";

    let doc;
    try {
      doc = new PDFDocument({
        size: pageSize, layout: orientation, margins: m, bufferPages: true, autoFirstPage: true,
        // Fixed metadata: no wall-clock time in the file, so identical inputs give identical bytes.
        info: {
          Title: String(view.doc?.number || "Document"), Author: String(view.org?.name || "Inaya"),
          Creator: `${RENDERER_NAME}/${RENDERER_VERSION}`, Producer: `${RENDERER_NAME}/${RENDERER_VERSION}`,
          CreationDate: new Date(view.doc?.generatedAtFixed || 0), ModDate: new Date(view.doc?.generatedAtFixed || 0),
        },
      });
    } catch (err) { reject(err); return; }

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("error", reject);
    let pageCount = 0;
    doc.on("end", () => resolve({ buffer: Buffer.concat(chunks), pages: pageCount, renderer: { ...getRendererInfo(), unicodeFonts: useUnicode } }));

    try {
      if (useUnicode) for (const [name, f] of Object.entries(fonts)) doc.registerFont(name, f.buf);
      const p = new Painter(doc, { fonts, useUnicode, rtl, scale });
      const L = (key) => i18nLabel(locale, key) || key;
      const x0 = m.left;
      const W = doc.page.width - m.left - m.right;
      const footerReserve = 40;
      const bottomLimit = () => doc.page.height - m.bottom - footerReserve;
      let y = m.top;
      const size = (n) => n * scale;
      const startSide = (xLeft, width, w) => (rtl ? xLeft + width - w : xLeft); // position a box of width w at the reading-start side
      const checkTime = () => { if (Date.now() - started > MAX_RENDER_MS) throw new Error("Rendering exceeded the time limit."); };

      const newPage = () => {
        if (doc.bufferedPageRange().count >= MAX_PAGES) throw new Error(`Document exceeds the ${MAX_PAGES}-page limit.`);
        doc.addPage(); y = m.top; checkTime();
      };
      const ensure = (h, onBreak) => {
        if (y + h > bottomLimit()) { newPage(); if (onBreak) onBreak(); }
      };

      const drawWatermark = () => {
        if (!view.flags?.isPreview && !view.flags?.isDraft) return;
        const text = view.flags.isPreview ? "PREVIEW" : "DRAFT";
        doc.save();
        doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.opacity(0.08).font(useUnicode ? "Sans-Bold" : "Helvetica-Bold").fontSize(110).fillColor("#000000");
        const w = doc.widthOfString(text);
        doc.text(text, (doc.page.width - w) / 2, doc.page.height / 2 - 55, { lineBreak: false });
        doc.restore();
      };
      drawWatermark();
      const origAddPage = doc.addPage.bind(doc);
      doc.addPage = (...a) => { const r = origAddPage(...a); drawWatermark(); return r; };

      const blocks = spec.blocks || [];
      for (const block of blocks) {
        checkTime();
        if (!evalCondition(block.when, view)) continue;
        switch (block.type) {
          case "header": {
            const half = (W - 20) / 2;
            const leftX = rtl ? x0 + half + 20 : x0; // org cluster at the reading-start side
            const rightX = rtl ? x0 : x0 + half + 20;
            let ly = y;
            const logo = assets.logo && (block.showLogo !== false) && (spec.style?.showLogo !== false);
            if (logo) {
              try {
                doc.image(assets.logo, rtl ? leftX + half - 120 : leftX, ly, { fit: [120, 48] });
                ly += 54;
              } catch { /* an unreadable logo never blocks a document */ }
            }
            ly += p.paragraph(view.org?.name || "", leftX, ly, half, { size: size(18), bold: true, color: accent, align: "start" });
            if (block.showOrgAddress !== false) for (const l of asLines(view.org?.addressLines)) ly += p.paragraph(l, leftX, ly, half, { size: size(9), color: muted, align: "start" });
            if (view.org?.email) ly += p.paragraph(view.org.email, leftX, ly, half, { size: size(9), color: muted, align: "start" });
            if (view.org?.phone) ly += p.paragraph(view.org.phone, leftX, ly, half, { size: size(9), color: muted, align: "start" });
            if (block.showTaxId !== false && view.org?.taxId) ly += p.paragraph(`${view.org.taxLabel || L("taxId")}: ${view.org.taxId}`, leftX, ly, half, { size: size(9), color: muted, align: "start" });

            let ry = y;
            ry += p.paragraph(L(block.titleLabel), rightX, ry, half, { size: size(20), bold: true, color: ink, align: "end" });
            ry += 4;
            for (const f of block.fields || []) {
              if (!evalCondition(f.when, view)) continue;
              const value = interpolate(f.value, view, locale, f.format);
              if (!value) continue;
              const text = `${L(f.labelKey)}: ${value}`;
              ry += p.paragraph(text, rightX, ry, half, { size: size(9.5), color: muted, align: "end" });
            }
            y = Math.max(ly, ry) + 16;
            break;
          }
          case "parties": {
            const cols = block.columns.filter((c) => evalCondition(c.when, view));
            if (cols.length === 0) break;
            const gap = 16;
            const cw = (W - gap * (cols.length - 1)) / cols.length;
            const rendered = cols.map((c) => ({ title: L(c.titleLabel), lines: c.lines.flatMap((l) => expandLine(l, view, locale)) }));
            const heights = rendered.map((r, i) => 16 + r.lines.reduce((h, l, k) => h + p.measure(l, cw, size(k === 0 ? 11 : 9), k === 0), 0));
            const need = Math.max(...heights) + 12;
            ensure(need);
            rendered.forEach((r, i) => {
              const cx = x0 + (rtl ? (cols.length - 1 - i) : i) * (cw + gap);
              let cy = y;
              cy += p.paragraph(r.title.toUpperCase(), cx, cy, cw, { size: size(8), bold: true, color: muted, align: "start" }) + 3;
              r.lines.forEach((l, k) => { cy += p.paragraph(l, cx, cy, cw, { size: size(k === 0 ? 11 : 9), bold: k === 0, color: k === 0 ? ink : muted, align: "start" }); });
            });
            y += need;
            break;
          }
          case "meta": {
            const fields = block.fields.filter((f) => evalCondition(f.when, view)).map((f) => ({ label: L(f.labelKey), value: interpolate(f.value, view, locale, f.format) })).filter((f) => f.value);
            if (fields.length === 0) break;
            if (block.titleLabel) { ensure(20); y += p.paragraph(L(block.titleLabel).toUpperCase(), x0, y, W, { size: size(8), bold: true, color: muted, align: "start" }) + 2; }
            const n = block.columns || 3;
            const gap = 14;
            const cw = (W - gap * (n - 1)) / n;
            for (let i = 0; i < fields.length; i += n) {
              const row = fields.slice(i, i + n);
              const h = Math.max(...row.map((f) => p.measure(f.label, cw, size(8), false) + p.measure(f.value, cw, size(10), true))) + 8;
              ensure(h);
              row.forEach((f, k) => {
                const cx = x0 + (rtl ? (n - 1 - k) : k) * (cw + gap);
                let cy = y;
                cy += p.paragraph(f.label, cx, cy, cw, { size: size(8), color: muted, align: "start" });
                p.paragraph(f.value, cx, cy, cw, { size: size(10), bold: true, color: ink, align: "start" });
              });
              y += h;
            }
            y += 6;
            break;
          }
          case "table": {
            const rows = Array.isArray(view[block.source]) ? view[block.source] : [];
            const cols = block.columns;
            const totalW = cols.reduce((s, c) => s + (c.width || 100 / cols.length), 0);
            const widths = cols.map((c) => ((c.width || 100 / cols.length) / totalW) * W);
            const order = rtl ? cols.map((_, i) => i).reverse() : cols.map((_, i) => i);
            const colX = [];
            let acc = x0;
            for (const idx of order) { colX[idx] = acc; acc += widths[idx]; }
            const pad = 4;
            const drawHeader = () => {
              const headH = Math.max(...cols.map((c, i) => p.measure(L(c.labelKey).toUpperCase(), widths[i] - pad * 2, size(8), true))) + 8;
              doc.save().rect(x0, y - 2, W, headH).fillColor("#f2f3f7").fill().restore();
              cols.forEach((c, i) => {
                const align = c.align === "end" ? "end" : c.align === "center" ? "center" : "start";
                p.paragraph(L(c.labelKey).toUpperCase(), colX[i] + pad, y + 2, widths[i] - pad * 2, { size: size(8), bold: true, color: muted, align });
              });
              y += headH;
              doc.moveTo(x0, y - 1).lineTo(x0 + W, y - 1).strokeColor(line).lineWidth(1).stroke();
              y += 3;
            };
            if (block.titleLabel && block.source !== "bulletRows") { ensure(30); y += p.paragraph(L(block.titleLabel).toUpperCase(), x0, y, W, { size: size(8), bold: true, color: muted, align: "start" }) + 2; }
            ensure(40);
            if (block.source === "bulletRows") { if (block.titleLabel) y += p.paragraph(L(block.titleLabel).toUpperCase(), x0, y, W, { size: size(8), bold: true, color: muted, align: "start" }) + 2; }
            else drawHeader();
            if (rows.length === 0) {
              y += p.paragraph(block.emptyText || L("none"), x0, y, W, { size: size(9), color: muted, align: "start" }) + 6;
              break;
            }
            for (const row of rows) {
              checkTime();
              const cells = cols.map((c, i) => ({ text: cellValue(row, c, view, locale), c, w: widths[i] - pad * 2 }));
              const rowH = Math.max(...cells.map((cell) => p.measure(cell.text, cell.w, size(9), false))) + 7;
              ensure(rowH + 4, block.repeatHeader !== false && block.source !== "bulletRows" ? drawHeader : undefined);
              cells.forEach((cell, i) => {
                const align = cell.c.align === "end" ? "end" : cell.c.align === "center" ? "center" : "start";
                p.paragraph(cell.text, colX[i] + pad, y + 1, cell.w, { size: size(9), color: ink, align });
              });
              y += rowH;
              doc.moveTo(x0, y - 2).lineTo(x0 + W, y - 2).strokeColor(line).lineWidth(0.5).stroke();
            }
            y += 6;
            break;
          }
          case "totals": {
            const rows = block.rows.filter((r) => evalCondition(r.when, view)).map((r) => {
              let v = getPath(view, r.path);
              if (typeof v !== "number") return null;
              if (r.negate) v = -v;
              return { label: L(r.labelKey), value: formatValue(v, r.format || "currency", view, locale), emphasize: !!r.emphasize };
            }).filter(Boolean);
            if (rows.length === 0) break;
            const bw = Math.min(280, W);
            const bx = rtl ? x0 : x0 + W - bw;
            const need = rows.length * 20 + 16;
            ensure(need);
            y += 6;
            rows.forEach((r) => {
              if (r.emphasize) { doc.moveTo(bx, y - 2).lineTo(bx + bw, y - 2).strokeColor(line).lineWidth(1).stroke(); y += 3; }
              const sz = size(r.emphasize ? 12 : 9.5);
              const labelX = rtl ? bx + bw * 0.5 : bx;
              const valueX = rtl ? bx : bx + bw * 0.5;
              p.paragraph(r.label, labelX, y, bw * 0.5, { size: sz, bold: r.emphasize, color: r.emphasize ? ink : muted, align: "start" });
              p.paragraph(r.value, valueX, y, bw * 0.5, { size: sz, bold: r.emphasize, color: r.emphasize ? accent : ink, align: "end" });
              y += r.emphasize ? 22 : 17;
            });
            y += 8;
            break;
          }
          case "text": {
            const body = interpolate(block.text, view, locale);
            if (!body.trim()) break;
            const sz = size(block.size || 9);
            if (block.titleLabel) { ensure(24); y += p.paragraph(L(block.titleLabel).toUpperCase(), x0, y, W, { size: size(8), bold: true, color: muted, align: "start" }) + 2; }
            const h = p.measure(body, W, sz, false);
            // Long text is allowed to flow across pages a line at a time.
            const lines = p.wrap(body, W, sz, false);
            const lh = p.lineHeight(sz);
            for (const ln of lines) { ensure(lh); p.drawLine(ln, x0, y, W, { size: sz, color: block.muted ? muted : ink, align: "start" }); y += lh; }
            y += 8;
            void h;
            break;
          }
          case "approval": {
            const approved = view.approval?.status === "APPROVED";
            const title = approved ? L("approved") : L("pendingApproval");
            const detail = approved
              ? `${L("approvedBy")}: ${view.approval.approvedBy || ""}   ${L("approvedAt")}: ${formatDate(view.approval.approvedAt, locale, true)}   ${L("version")}: ${view.approval.version ?? ""}`
              : `${L("approvalStatus")}: ${title}`;
            const h = p.measure(detail, W - 20, size(9), false) + 30;
            ensure(h);
            doc.save().roundedRect(x0, y, W, h - 8, 4).lineWidth(1).strokeColor(approved ? "#1f6b46" : "#9a5b00").stroke().restore();
            p.paragraph(title, x0 + 10, y + 6, W - 20, { size: size(10), bold: true, color: approved ? "#1f6b46" : "#9a5b00", align: "start" });
            p.paragraph(detail, x0 + 10, y + 22, W - 20, { size: size(9), color: ink, align: "start" });
            y += h + 2;
            break;
          }
          case "signature": {
            const n = block.lines.length;
            const gap = 24;
            const cw = (W - gap * (n - 1)) / n;
            ensure(64);
            y += 24;
            block.lines.forEach((l, i) => {
              const cx = x0 + (rtl ? (n - 1 - i) : i) * (cw + gap);
              doc.moveTo(cx, y).lineTo(cx + cw, y).strokeColor(ink).lineWidth(0.7).stroke();
              const name = l.path ? getPath(view, l.path) : "";
              let cy = y + 4;
              if (name) cy += p.paragraph(String(name), cx, cy, cw, { size: size(9), bold: true, color: ink, align: "start" });
              p.paragraph(L(l.labelKey), cx, cy, cw, { size: size(8), color: muted, align: "start" });
            });
            y += 40;
            break;
          }
          case "spacer": y += block.height; break;
          case "divider": ensure(10); doc.moveTo(x0, y).lineTo(x0 + W, y).strokeColor(line).lineWidth(1).stroke(); y += 10; break;
          default: break;
        }
      }

      // -- Footer on every page ------------------------------------------
      // Writing near the bottom margin makes pdfkit auto-append a page per
      // write (a real bug found and fixed in this engine's first version:
      // a 3-page invoice came out as 6). Zeroing the bottom margin for the
      // footer write, and never letting pdfkit wrap, prevents that.
      const range = doc.bufferedPageRange();
      pageCount = range.count;
      const footer = spec.footer || {};
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const fy = doc.page.height - m.bottom - 26;
        doc.moveTo(x0, fy - 4).lineTo(x0 + W, fy - 4).strokeColor(line).lineWidth(0.5).stroke();
        const parts = [];
        if (footer.text) { const t = interpolate(footer.text, view, locale); if (t.trim()) parts.push(t.replace(/\n/g, " ")); }
        if (footer.showDocumentId && view.verify?.documentId) parts.push(`${L("documentId")}: ${view.verify.documentId}`);
        if (parts.length) p.drawLine(parts.join("   |   "), x0, fy, W, { size: size(7), color: muted, align: "start" });
        const parts2 = [];
        if (footer.showHash && view.verify?.hash) parts2.push(`${L("documentHash")}: ${String(view.verify.hash).slice(0, 32)}...`);
        if (footer.showVerify && view.verify?.url) parts2.push(`${L("verifyAt")}: ${view.verify.url}`);
        if (parts2.length) p.drawLine(parts2.join("   |   "), x0, fy + 9, W - 90, { size: size(6.5), color: muted, align: "start" });
        if (footer.pageNumbers !== false) p.drawLine(`${L("page")} ${i - range.start + 1} ${L("of")} ${range.count}`, x0, fy + 9, W, { size: size(7.5), color: muted, align: "end" });
        doc.page.margins.bottom = savedBottom;
      }
      doc.end();
    } catch (err) {
      try { doc.end(); } catch { /* already failed */ }
      reject(err);
    }
  });
}
