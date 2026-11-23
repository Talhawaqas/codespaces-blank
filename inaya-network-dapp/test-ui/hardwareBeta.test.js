// test-ui/hardwareBeta.test.js -- network cash drawer controllers (the desktop app sends the standard drawer pulse to the
// controller's IP:port) and full-page A4 / A5 receipts for laser / inkjet printers.
import { loadPrintSettings, savePrintSettings, canOpenDrawer, openDrawer, printSaleReceipt, DEFAULT_PRINT } from "../src/lib/commerce/desktopPrint";
import { fullPageReceiptHtml, fullPageFromMarkup } from "../src/lib/commerce/receiptLayout";

const calls = []; beforeEach(() => { calls.length = 0; window.__TAURI__ = { core: { invoke: async (cmd, args) => { calls.push([cmd, args]); return null; } } }; localStorage.clear(); });
afterAll(() => { delete window.__TAURI__; });
const b64 = (u8) => Buffer.from(u8).toString("base64");

test("defaults are unchanged for existing tills (strip receipts, no drawer)", () => {
  expect(DEFAULT_PRINT.pageLayout).toBe("strip"); expect(loadPrintSettings().drawer.kind).toBe("none");
});
test("network drawer: needs an address, sends exactly the drawer pulse to that controller", async () => {
  const s = { ...DEFAULT_PRINT, drawer: { ...DEFAULT_PRINT.drawer, kind: "network", host: "" } }; expect(canOpenDrawer(s)).toBe(false);
  s.drawer.host = "192.168.1.60"; s.drawer.netPort = 9100; expect(canOpenDrawer(s)).toBe(true);
  await openDrawer(s);
  expect(calls).toEqual([["pos_print_network", { host: "192.168.1.60", port: 9100, dataB64: b64([0x1b, 0x70, 0x00, 0x19, 0xfa]) }]]);
});
test("network drawer opens after a cash sale's receipt prints on the receipt printer", async () => {
  const s = { ...DEFAULT_PRINT, printer: { ...DEFAULT_PRINT.printer, kind: "network", host: "192.168.1.50", port: 9100, paper: 80 }, drawer: { ...DEFAULT_PRINT.drawer, kind: "network", host: "192.168.1.60", netPort: 9100 } };
  const r = { company: "Shop", location: "Main", saleNumber: "S-1", completedAt: "2026-11-23T10:00:00Z", currency: "PKR", lines: [{ name: "Mug", quantity: 1, unitPrice: 100, total: 100 }], totals: { subtotal: 100, taxBreakdown: [], total: 100 }, tenders: [{ method: "CASH", amount: 100 }] };
  const res = await printSaleReceipt(r, { cash: true }, s);
  expect(res).toEqual({ printed: true, drawer: "opened" });
  expect(calls.map((c) => [c[0], c[1].host])).toEqual([["pos_print_network", "192.168.1.50"], ["pos_print_network", "192.168.1.60"]]);
  calls.length = 0; await printSaleReceipt(r, { cash: false }, s); expect(calls.length).toBe(1);
});
test("settings round-trip per till", () => { savePrintSettings({ ...DEFAULT_PRINT, pageLayout: "A5", drawer: { kind: "network", host: "10.0.0.9", netPort: 9101 } }); const s = loadPrintSettings(); expect(s.pageLayout).toBe("A5"); expect(s.drawer.netPort).toBe(9101); });

const sale = { company: "Lahore <Home> Goods", location: "Gulberg", saleNumber: "S-000123", completedAt: "2026-11-23T10:00:00Z", currency: "PKR", taxMode: "exclusive", cashier: "cash@shop.pk",
  lines: [{ name: "Ceramic mug", quantity: 2, unitPrice: 1200, total: 2832, taxRate: 18 }, { name: "Cushion", quantity: 1, unitPrice: 2400, discount: 240, total: 2548.8, taxRate: 18, note: "gift wrap" }],
  totals: { subtotal: 4800, discounts: 240, total: 5380.8, taxBreakdown: [{ name: "GST", rate: 18, taxable: 4560, tax: 820.8 }] }, tenders: [{ method: "CASH", amount: 6000 }], change: 619.2, returnPolicy: "Returns within 14 days.", footer: "Thank you!" };
test.each(["A4", "A5"])("full-page %s receipt: right page size, every line and total, text escaped", (size) => {
  const h = fullPageReceiptHtml(sale, size);
  expect(h).toContain(`@page { size: ${size};`); expect(h).toContain("Lahore &lt;Home&gt; Goods"); expect(h).not.toContain("<Home>");
  for (const t of ["Ceramic mug", "Cushion", "gift wrap", "S-000123", "GST 18%", "Returns within 14 days.", "Thank you!", "Served by cash@shop.pk"]) expect(h).toContain(t);
  for (const v of ["5,380.80", "820.80", "6,000.00", "619.20", "240.00"]) expect(h).toContain(v);
  document.body.innerHTML = h.replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, ""); expect(document.querySelectorAll("tbody tr").length).toBeGreaterThanOrEqual(2 + 4);
});
test("refund receipts (screen markup) also go on a full page", () => { const h = fullPageFromMarkup("<p>REFUND R-1</p>", "R-1", "A5"); expect(h).toContain("@page { size: A5;"); expect(h).toContain("REFUND R-1"); });
