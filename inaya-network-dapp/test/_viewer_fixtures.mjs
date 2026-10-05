// test/_viewer_fixtures.mjs -- builds small REAL files (PDF, PNG, DOCX, XLSX, DICOM, CSV, Markdown) for exercising the secure viewer in a browser.
// No dependencies beyond jszip (already installed for the Word reader). Nothing here is test-only logic: these are valid files of each format.
import { deflateSync } from "node:zlib";
import JSZip from "jszip";

export const csv = () => Buffer.from("item,qty,price\nWidget,10,2.50\nGadget,4,19.99\n\"Acme, Inc.\",1,100\n");
export const markdown = () => Buffer.from("# Board summary\n\n- Revenue **up 12%**\n- Churn `down`\n\nSee [policy](https://example.com).\n");

export function pdf(text = "Hello from the Inaya secure viewer") {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>"); add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  const stream = `BT /F1 20 Tf 30 110 Td (${text}) Tj ET`;
  add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(out, "latin1");
}

const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function png(w = 96, h = 64) {
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const i = y * (w * 4 + 1) + 1 + x * 4; raw[i] = Math.floor((x / w) * 255); raw[i + 1] = Math.floor((y / h) * 255); raw[i + 2] = 160; raw[i + 3] = 255; } }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export async function docx() {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Term sheet</w:t></w:r></w:p><w:p><w:r><w:t>The investor commits 5,000,000 USD subject to diligence.</w:t></w:r></w:p></w:body></w:document>`);
  return Buffer.from(await z.generateAsync({ type: "uint8array" }));
}
export async function xlsx() {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  z.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Cap table" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  z.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  const row = (r, vals) => `<row r="${r}">${vals.map((v, i) => `<c r="${"ABC"[i]}${r}" ${typeof v === "number" ? `><v>${v}</v>` : `t="inlineStr"><is><t>${v}</t></is>`}</c>`).join("")}</row>`;
  z.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${row(1, ["Holder", "Shares", "Percent"])}${row(2, ["Founders", 7000000, 70])}${row(3, ["Seed fund", 3000000, 30])}</sheetData></worksheet>`);
  return Buffer.from(await z.generateAsync({ type: "uint8array" }));
}

/** A valid 16-bit monochrome DICOM file with uncompressed pixel data (Explicit VR Little Endian). */
export function dicom(rows = 64, cols = 64) {
  const el = (group, element, vr, data) => {
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data); const pad = d.length % 2 ? Buffer.concat([d, Buffer.from([vr === "UI" ? 0 : 0x20])]) : d;
    const long = ["OB", "OW", "OF", "SQ", "UT", "UN"].includes(vr); const head = Buffer.alloc(long ? 12 : 8); head.writeUInt16LE(group, 0); head.writeUInt16LE(element, 2); head.write(vr, 4, "ascii");
    if (long) head.writeUInt32LE(pad.length, 8); else head.writeUInt16LE(pad.length, 6); return Buffer.concat([head, pad]);
  };
  const us = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const meta = Buffer.concat([el(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1")]);
  const metaLen = el(0x0002, 0x0000, "UL", (() => { const b = Buffer.alloc(4); b.writeUInt32LE(meta.length); return b; })());
  const px = Buffer.alloc(rows * cols * 2); for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) px.writeUInt16LE(Math.round(((x + y) / (rows + cols)) * 3000) + (Math.hypot(x - 32, y - 32) < 14 ? 800 : 0), (y * cols + x) * 2);
  const body = Buffer.concat([el(0x0008, 0x0060, "CS", "CT"), el(0x0010, 0x0010, "PN", "TEST^PATIENT"), el(0x0028, 0x0002, "US", us(1)), el(0x0028, 0x0004, "CS", "MONOCHROME2"), el(0x0028, 0x0010, "US", us(rows)), el(0x0028, 0x0011, "US", us(cols)), el(0x0028, 0x0100, "US", us(16)), el(0x0028, 0x0101, "US", us(16)), el(0x0028, 0x0102, "US", us(15)), el(0x0028, 0x0103, "US", us(0)), el(0x7fe0, 0x0010, "OW", px)]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), metaLen, meta, body]);
}
