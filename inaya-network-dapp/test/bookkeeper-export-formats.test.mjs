// test/bookkeeper-export-formats.test.mjs -- the Excel and PDF versions of Bookkeeper reports (pure; no database).
// The .xlsx is read back with an independent ZIP reader written here (central directory + CRC check), so a broken archive fails.
// Run: node --test --test-force-exit test/bookkeeper-export-formats.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { crc32, columnName, toXlsx, toPdf } from "../src/lib/bookkeeper/exportFormats.js";

function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "has an end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory entry signature");
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, "local header signature");
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = inflateRawSync(buf.subarray(start, start + csize));
    assert.equal(data.length, usize, `${name}: size`); assert.equal(crc32(data), crc, `${name}: crc32`);
    out[name] = data.toString("utf8"); p += 46 + nlen + elen + clen;
  }
  return out;
}

const report = {
  meta: { report: "supplier_spend", organization: "Acme & <Sons>", period: "2026-01-01 to 2026-03-31", sourceScope: { departments: 2 } },
  columns: ["supplier", "currency", "transactions", "total"],
  rows: [{ supplier: "Globex", currency: "USD", transactions: 3, total: 1250.5 }, { supplier: "=HYPERLINK(\"http://evil\")", currency: "USD", transactions: 1, total: 10 }, { supplier: "Ünïcode & <b>", currency: "EUR", transactions: 2, total: "n/a" }],
};

test("crc32 matches the standard check value; column letters run A..Z, AA..", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702].map(columnName), ["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
});

test("xlsx: a valid package with the expected parts, header, typed cells and an About sheet", () => {
  const files = readZip(toXlsx(report));
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
  const s1 = files["xl/worksheets/sheet1.xml"];
  assert.match(s1, /<row r="1"><c r="A1" t="inlineStr" s="1"><is><t[^>]*>supplier<\/t><\/is><\/c>/, "bold header row");
  assert.match(s1, /<c r="D2"><v>1250.5<\/v><\/c>/, "numbers stay numbers so Excel can sum them");
  assert.match(s1, /<c r="D4" t="inlineStr"><is><t[^>]*>n\/a<\/t>/, "a non-number is text");
  assert.match(s1, /state="frozen"/, "header row is frozen");
  assert.match(files["xl/worksheets/sheet2.xml"], /Acme &amp; &lt;Sons&gt;/, "metadata is XML-escaped");
  for (const [name, xml] of Object.entries(files)) assert.match(xml, /^<\?xml[^>]*\?>/, `${name} is XML`);
});

test("xlsx: formula injection is neutralised and special characters are escaped", () => {
  const s1 = readZip(toXlsx(report))["xl/worksheets/sheet1.xml"];
  assert.doesNotMatch(s1, /<f>/, "no formula element is ever written");
  assert.match(s1, /<t[^>]*>'=HYPERLINK\(&quot;http:\/\/evil&quot;\)<\/t>/, "a leading = is stored as text with an apostrophe");
  assert.match(s1, /Ünïcode &amp; &lt;b&gt;/);
});

test("xlsx: an empty report still produces a valid workbook", () => {
  const files = readZip(toXlsx({ meta: { report: "x" }, columns: ["a", "b"], rows: [] }));
  assert.match(files["xl/worksheets/sheet1.xml"], /<sheetData><row r="1">/);
});

test("pdf: a real PDF, paginates long reports, never throws on non-Latin text", async () => {
  const many = { ...report, rows: Array.from({ length: 160 }, (_, i) => ({ supplier: `Supplier ${i} ${i === 7 ? "日本語" : ""}`, currency: "USD", transactions: i, total: i * 3.5 })) };
  const pdf = await toPdf(many);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(pdf.subarray(-32).toString("latin1"), /%%EOF/);
  const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 3, `160 rows span several pages (got ${pages})`);
  const empty = await toPdf({ meta: { report: "x" }, columns: ["a"], rows: [] });
  assert.equal(empty.subarray(0, 5).toString(), "%PDF-");
});
