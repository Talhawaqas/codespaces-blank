// src/lib/bookkeeper/exportFormats.js
//
// Excel (.xlsx) and PDF versions of the Bookkeeper reports, alongside the existing CSV. Same input as toCsv(): { meta, columns, rows }.
// No new dependency: the .xlsx is written here (a ZIP of a few XML parts, using node:zlib) and the PDF uses pdfkit, which the document
// renderer already ships. Both keep the CSV's formula-injection protection: a text cell that starts with = + - @ (or a tab/CR) is
// stored as plain text with a leading apostrophe, and in the workbook it is always a string cell (never a formula).
// PDF limits: the built-in Helvetica covers Latin text only; characters outside it are replaced with "?" rather than printed as boxes.

import { deflateRawSync } from "node:zlib";
import PDFDocument from "pdfkit";

// ------------------------------------------------------------------------------------------------ xlsx
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Minimal ZIP writer (deflate). `files` = [{ name, data: Buffer|string }]. */
export function zip(files) {
  const locals = []; const central = []; let offset = 0;
  const dosTime = 0; const dosDate = (1 << 5) | 1; // 1980-01-01: reproducible output
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"); const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = deflateRawSync(data); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

const xmlEscape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
export function columnName(i) { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
const guardText = (v) => { const s = String(v); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };

function cell(ref, v, style = 0) {
  if (v === null || v === undefined || v === "") return "";
  // Real numbers stay numbers (so Excel can sum them); everything else is an inline string, never a formula.
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEscape(guardText(v))}</t></is></c>`;
}

/** Workbook with two sheets: "Report" (header row + data, frozen header) and "About" (the report's metadata). */
export function toXlsx({ meta, columns, rows }) {
  const sheetRows = [`<row r="1">${columns.map((c, i) => cell(`${columnName(i)}1`, c, 1)).join("")}</row>`];
  rows.forEach((r, ri) => sheetRows.push(`<row r="${ri + 2}">${columns.map((c, ci) => cell(`${columnName(ci)}${ri + 2}`, r[c])).join("")}</row>`));
  const widths = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(48, Math.max(10, String(c).length + 2, ...rows.slice(0, 200).map((r) => String(r[c] ?? "").length + 2)))}" customWidth="1"/>`).join("");
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${sheetRows.join("")}</sheetData></worksheet>`;
  const metaRows = Object.entries(meta || {}).map(([k, v], i) => `<row r="${i + 1}">${cell(`A${i + 1}`, k, 1)}${cell(`B${i + 1}`, typeof v === "object" ? JSON.stringify(v) : v)}</row>`);
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="22" customWidth="1"/><col min="2" max="2" width="70" customWidth="1"/></cols><sheetData>${metaRows.join("")}</sheetData></worksheet>`;
  return zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/><sheet name="About" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", data: sheet1 },
    { name: "xl/worksheets/sheet2.xml", data: sheet2 },
  ]);
}

// ------------------------------------------------------------------------------------------------ pdf
const latin = (v) => String(v ?? "").replace(/[^ -~ -ÿ]/g, "?");

/** A landscape A4 table report: title, metadata block, then the rows with a repeated header on every page. Resolves to a Buffer. */
export function toPdf({ meta, columns, rows }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, info: { Title: latin(meta?.report || "Bookkeeper report"), Producer: "Inaya AI Bookkeeper" } });
    const chunks = []; doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const left = doc.page.margins.left; const width = doc.page.width - left - doc.page.margins.right; const bottom = doc.page.height - doc.page.margins.bottom;
    doc.font("Helvetica-Bold").fontSize(15).text(latin(`Bookkeeper report: ${String(meta?.report || "").replace(/_/g, " ")}`), left, doc.y);
    doc.font("Helvetica").fontSize(8).fillColor("#444444");
    for (const [k, v] of Object.entries(meta || {})) if (k !== "report") doc.text(latin(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`), { width });
    doc.moveDown(0.6).fillColor("#000000");
    const colW = width / Math.max(1, columns.length); const rowH = 14;
    const header = () => { const y = doc.y; doc.font("Helvetica-Bold").fontSize(7.5); columns.forEach((c, i) => doc.text(latin(c), left + i * colW, y, { width: colW - 4, height: rowH, ellipsis: true, lineBreak: false })); doc.y = y + rowH; doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).strokeColor("#999999").lineWidth(0.5).stroke(); };
    header(); doc.font("Helvetica").fontSize(7.5);
    for (const r of rows) {
      if (doc.y + rowH > bottom) { doc.addPage(); header(); doc.font("Helvetica").fontSize(7.5); }
      const y = doc.y; columns.forEach((c, i) => doc.text(latin(r[c]), left + i * colW, y, { width: colW - 4, height: rowH, ellipsis: true, lineBreak: false })); doc.y = y + rowH;
    }
    if (!rows.length) doc.text("No rows for this report and period.", left, doc.y);
    doc.end();
  });
}
