// test-ui/barcode.test.js -- barcode labels: every Code 128 symbol we draw is DECODED by an independent reader (ZXing)
// and must give back exactly the text it was made from; label sheets and the ZPL / TSPL label-printer output are checked.
import { RGBLuminanceSource, BinaryBitmap, HybridBinarizer, Code128Reader, DecodeHintType } from "@zxing/library";
import { code128Modules, code128Values, code128Svg, barcodeProblem, labelSheetHtml, zplLabel, tsplLabel, LABEL_SIZES } from "../src/lib/commerce/barcode";

function decode(text, px = 2) {
  const mods = code128Modules(text); const width = mods.reduce((s, m) => s + m.w, 0) * px; const height = 20;
  const lum = new Uint8ClampedArray(width * height); let x = 0;
  for (const m of mods) { for (let k = 0; k < m.w * px; k++, x++) for (let y = 0; y < height; y++) lum[y * width + x] = m.bar ? 0 : 255; }
  const bmp = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, width, height)));
  return new Code128Reader().decodeRow(10, bmp.getBlackRow(10, null), new Map([[DecodeHintType.TRY_HARDER, true]])).getText();
}

const SAMPLES = ["8901234567890", "5012345678900", "036000291452", "SKU-0001", "A", "12", "123", "1234", "12345", "0000000000", "ABC123456789XYZ", "TS-2026/11 shirt (L)", "9780306406157", "ab12cd3456ef78", "!\"#$%&'()*+,-./:;<=>?@[\]^_`{|}~", "999999999999999999999999"];

test.each(SAMPLES)("Code 128 for %p decodes back to exactly the same text", (s) => { expect(decode(s)).toBe(s); });
test("decodes at the smallest printable scale (1 pixel per module)", () => { for (const s of SAMPLES.slice(0, 6)) expect(decode(s, 1)).toBe(s); });
test("digits use the compact set: an EAN-13 number is much shorter than in set B", () => {
  expect(code128Values("8901234567890").length).toBeLessThan(code128Values("8901234567890".replace(/\d/g, "x")).length);
});
test("refuses what can't be a barcode", () => {
  expect(barcodeProblem("")).toMatch(/No barcode/); expect(barcodeProblem("é")).toMatch(/standard/); expect(barcodeProblem("x".repeat(49))).toMatch(/48/);
  expect(() => code128Values("naïve")).toThrow();
});
test("SVG is self-contained, escapes text and shows the human-readable line", () => {
  const svg = code128Svg("A<B", { height: 40 }); expect(svg).toMatch(/^<svg/); expect(svg).toContain("A&lt;B"); expect(svg).not.toContain("A<B<");
});
test("label sheets: one label per copy, the right page size, names escaped", () => {
  const html = labelSheetHtml([{ name: "Shirt <L>", code: "SKU-1", price: "PKR 1,000", copies: 3 }, { name: "Cap", code: "SKU-2", copies: 2 }], "50x25");
  expect((html.match(/<svg/g) || []).length).toBe(5); expect(html).toContain("@page { size: 50mm 25mm"); expect(html).toContain("Shirt &lt;L&gt;");
  const a4 = labelSheetHtml([{ name: "X", code: "1", copies: 24 }], "a4-3x8"); expect(a4).toContain("@page { size: A4"); expect(a4).toContain("repeat(3, 70mm)");
  expect(Object.keys(LABEL_SIZES).length).toBeGreaterThanOrEqual(6);
});
test("ZPL (Zebra): one format, Code 128 field, copies, no command characters from product names", () => {
  const z = zplLabel({ name: "Shirt ^XZ~JA", code: "8901234567890", price: "PKR 1,000" }, { w: 50, h: 25, copies: 4 });
  expect(z.startsWith("^XA")).toBe(true); expect(z.trim().endsWith("^XZ")).toBe(true); expect((z.match(/\^XA/g) || []).length).toBe(1);
  expect(z).toContain("^BCN,"); expect(z).toContain("^FD8901234567890^FS"); expect(z).toContain("^PQ4"); expect(z).toContain("^PW400");
  expect(z).not.toMatch(/Shirt \^XZ/); expect(() => zplLabel({ code: "A^B" })).toThrow();
});
test("TSPL (TSC / Xprinter): size, Code 128, copies, quotes can't break out", () => {
  const t = tsplLabel({ name: 'Cap "new"', code: "SKU-2", price: "PKR 500" }, { w: 40, h: 30, copies: 2 });
  expect(t).toContain("SIZE 40 mm,30 mm"); expect(t).toContain('BARCODE 16,36,"128",'); expect(t).toContain('"SKU-2"'); expect(t).toContain("PRINT 2,1"); expect(t).toContain("Cap 'new'");
  expect(() => tsplLabel({ code: 'A"B' })).toThrow();
});
