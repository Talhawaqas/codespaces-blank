// Sends two real Inaya receipts (80 mm with the drawer pulse, 58 mm without) to a receipt-printer emulator on 127.0.0.1:<port>,
// exactly as the desktop app's network printing does (raw bytes over TCP). Usage: node test/_escpos_emulator_send.mjs <port>
import net from "node:net";
import { receiptBytes } from "../src/lib/commerce/escpos.js";
const port = Number(process.argv[2] || 9100);
const r = {
  company: "Lahore Home Goods", location: "Lahore - Gulberg", saleNumber: "S-000123", completedAt: "2026-11-23T10:00:00Z", currency: "PKR",
  lines: [{ name: "Ceramic mug", quantity: 2, unitPrice: 1200, total: 2400 }, { name: "Cotton cushion (winter promotion)", quantity: 1, unitPrice: 2400, total: 2160, discount: 240 }],
  totals: { subtotal: 4800, discounts: 240, taxBreakdown: [{ name: "Sales tax", rate: 18, tax: 695.59 }], total: 4560 },
  tenders: [{ method: "CASH", amount: 5000 }], change: 440, returnPolicy: "Returns within 14 days with this receipt.", footer: "Thank you for shopping with us!",
};
const money = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const send = (bytes) => new Promise((res, rej) => { const s = net.connect(port, "127.0.0.1", () => s.end(Buffer.from(bytes))); s.on("close", res); s.on("error", rej); });
await send(receiptBytes(r, { paper: 80, kickDrawer: true, money }));
await send(receiptBytes(r, { paper: 58, kickDrawer: false, money }));
console.log("sent 2 jobs");
