// src/lib/commerce/escpos.js -- builds ESC/POS bytes for thermal receipt printers (post-SOW "Route 3" desktop printing,
// owner-approved 22 Nov 2026). Pure and dependency-free so it is unit-tested directly. Text is sent as plain ASCII/Latin-1
// (characters a receipt printer can't print are replaced, so a name never corrupts the job).
//   58 mm paper = 32 characters a line, 80 mm = 48 (Font A).
// The drawer pulse ESC p m t1 t2 (1B 70 00 19 FA) is the industry-standard "kick" on the printer's RJ11 drawer port.

export const WIDTHS = { 58: 32, 80: 48 };
export const CMD = {
  init: [0x1b, 0x40],
  alignLeft: [0x1b, 0x61, 0x00], alignCenter: [0x1b, 0x61, 0x01],
  boldOn: [0x1b, 0x45, 0x01], boldOff: [0x1b, 0x45, 0x00],
  doubleOn: [0x1d, 0x21, 0x11], doubleOff: [0x1d, 0x21, 0x00],
  feed: (n) => [0x1b, 0x64, Math.max(0, Math.min(10, n | 0))],
  cut: [0x1d, 0x56, 0x42, 0x03], // partial cut after a 3-dot feed
  drawerKick: [0x1b, 0x70, 0x00, 0x19, 0xfa], // pin 2, 50 ms on, 500 ms off
};

const safe = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e\n]/g, "?");
const bytes = (s) => [...safe(s)].map((c) => c.charCodeAt(0));
const fit = (s, n) => (s.length > n ? s.slice(0, n) : s);
/** "left ........ right" on one line of `w` characters (left side is trimmed, never the amount). */
export function twoCol(left, right, w) {
  const r = safe(right); const l = fit(safe(left), Math.max(1, w - r.length - 1));
  return l + " ".repeat(Math.max(1, w - l.length - r.length)) + r;
}
/** Word-wraps text to `w` characters. */
export function wrap(text, w) {
  const out = []; for (const para of safe(text).split("\n")) { let line = ""; for (const word of para.split(/\s+/).filter(Boolean)) { if (!line) line = fit(word, w); else if (line.length + 1 + word.length <= w) line += " " + word; else { out.push(line); line = fit(word, w); } } out.push(line); }
  return out;
}

/**
 * A sale receipt as ESC/POS bytes. `r` is the receipt object the POS API returns (company, location, saleNumber,
 * completedAt, lines[], totals{subtotal, discounts, taxBreakdown[], total}, tenders[], change, returnPolicy, footer, currency).
 * Options: paper 58 | 80, kickDrawer (append the drawer pulse), money(amount) formatter.
 */
export function receiptBytes(r, { paper = 80, kickDrawer = false, money = (n) => Number(n || 0).toFixed(2) } = {}) {
  const w = WIDTHS[paper] || 48; const out = [...CMD.init];
  const line = (s = "") => out.push(...bytes(fit(safe(s), w)), 0x0a); // never wider than the paper
  const rule = () => line("-".repeat(w));
  out.push(...CMD.alignCenter, ...CMD.boldOn, ...CMD.doubleOn); line(fit(safe(r.company), Math.floor(w / 2))); out.push(...CMD.doubleOff, ...CMD.boldOff);
  if (r.location) line(r.location);
  line(r.saleNumber || ""); if (r.completedAt) line(new Date(r.completedAt).toLocaleString());
  out.push(...CMD.alignLeft); rule();
  for (const l of r.lines || []) {
    for (const [i, part] of wrap(l.name, w - 12).entries()) line(i === 0 ? twoCol(part, money(l.total), w) : part);
    line(`  ${l.quantity} x ${money(l.unitPrice)}${l.discount ? `  -${money(l.discount)}` : ""}`);
  }
  rule();
  const t = r.totals || {};
  line(twoCol("Subtotal", money(t.subtotal), w));
  if (t.discounts > 0) line(twoCol("Discounts", `-${money(t.discounts)}`, w));
  for (const x of t.taxBreakdown || []) line(twoCol(`${x.name || "Tax"} ${x.rate}%`, money(x.tax), w));
  out.push(...CMD.boldOn); line(twoCol("TOTAL", `${r.currency || ""} ${money(t.total)}`.trim(), w)); out.push(...CMD.boldOff);
  for (const p of r.tenders || []) line(twoCol(p.method === "CASH" ? "Cash" : p.method === "BANK_TRANSFER" ? "Bank transfer" : p.method === "CARD" ? "Card" : "Other", money(p.amount), w));
  if (r.change > 0) line(twoCol("Change", money(r.change), w));
  rule();
  for (const s of wrap(r.returnPolicy || "", w)) line(s);
  if (r.footer) { out.push(...CMD.alignCenter); for (const s of wrap(r.footer, w)) line(s); out.push(...CMD.alignLeft); }
  out.push(...CMD.feed(3), ...CMD.cut);
  if (kickDrawer) out.push(...CMD.drawerKick);
  return Uint8Array.from(out);
}

/** Just the drawer pulse (for "No sale" or the laser-printer prompt). */
export const drawerKickBytes = () => Uint8Array.from(CMD.drawerKick);

/** Base64 for the desktop bridge (Tauri commands take strings). */
export function toBase64(u8) {
  let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return typeof btoa === "function" ? btoa(s) : Buffer.from(u8).toString("base64");
}
