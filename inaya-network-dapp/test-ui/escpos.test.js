import { receiptBytes, drawerKickBytes, twoCol, wrap, CMD, WIDTHS, toBase64 } from "../src/lib/commerce/escpos";

const r = {
  company: "Lahore Home Goods", location: "Lahore - Gulberg", saleNumber: "S-000123", completedAt: "2026-11-23T10:00:00Z", currency: "PKR",
  lines: [{ name: "Ceramic mug with a very long descriptive name that must wrap", quantity: 2, unitPrice: 1200, total: 2400 }, { name: "Green tea 100g", quantity: 1, unitPrice: 450, total: 450, discount: 45 }],
  totals: { subtotal: 2850, discounts: 45, taxBreakdown: [{ name: "Sales tax", rate: 18, tax: 427.88 }], total: 2805 },
  tenders: [{ method: "CASH", amount: 3000 }], change: 195, returnPolicy: "Returns within 14 days with this receipt.", footer: "Thank you!",
};
const has = (u8, seq) => { for (let i = 0; i + seq.length <= u8.length; i++) if (seq.every((b, j) => u8[i + j] === b)) return true; return false; };
// printable text only: skip ESC/GS command sequences (ESC @ / a n / E n / d n / p m t1 t2, GS ! n / V m n)
const text = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) { const b = u8[i];
  if (b === 0x1b) { const c = u8[i + 1]; i += c === 0x40 ? 1 : c === 0x70 ? 4 : 2; continue; }
  if (b === 0x1d) { const c = u8[i + 1]; i += c === 0x56 ? 3 : 2; continue; }
  if (b === 0x0a || (b >= 0x20 && b < 0x7f)) s += String.fromCharCode(b); } return s; };

test("receipt starts with init, ends with feed + cut, and only kicks the drawer when asked", () => {
  const a = receiptBytes(r, { paper: 80 });
  expect([...a.slice(0, 2)]).toEqual(CMD.init);
  expect(has(a, CMD.cut)).toBe(true);
  expect(has(a, CMD.drawerKick)).toBe(false);
  const b = receiptBytes(r, { paper: 80, kickDrawer: true });
  expect([...b.slice(-5)]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
});

test("every printed line fits the paper width (58 mm = 32, 80 mm = 48)", () => {
  for (const paper of [58, 80]) {
    const lines = text(receiptBytes(r, { paper })).split("\n");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(WIDTHS[paper]);
    expect(lines.some((l) => /TOTAL/.test(l) && /2805/.test(l))).toBe(true);
  }
});

test("amounts are never cut off; names wrap; unsupported characters can't corrupt the job", () => {
  expect(twoCol("A very long product name indeed", "12,345.00", 20)).toMatch(/12,345\.00$/);
  expect(twoCol("x", "1.00", 20)).toHaveLength(20);
  expect(wrap("one two three four five", 9)).toEqual(["one two", "three", "four five"]);
  const u = receiptBytes({ ...r, company: "Café Urdu اردو" }, { paper: 58 });
  expect([...u].every((b) => b < 0x80 || [0xfa].includes(b))).toBe(true);
});

test("drawer pulse alone, and base64 for the desktop bridge", () => {
  expect([...drawerKickBytes()]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  expect(toBase64(drawerKickBytes())).toBe("G3AAGfo=");
});
