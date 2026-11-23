"use client";
// src/lib/commerce/desktopPrint.js -- the web till's side of desktop printing ("Route 3", post-SOW, beta).
// Settings are PER TILL COMPUTER (localStorage): which printer this till prints to and how its cash drawer opens.
//   printer.kind  "none" | "installed" (a printer installed on the computer: USB/Windows/CUPS)
//                 | "network" (a LAN receipt printer, IP + port 9100) | "laser" (normal print dialog, A4/A5 or roll)
//   drawer.kind   "none" | "printer" (pulse through the receipt printer's RJ11 port)
//                 | "serial" (USB cash drawer or USB-to-RJ11 trigger box on a COM port; the shop buys and connects it)
// Only the Inaya desktop app can print silently or open a drawer; in a browser the till falls back to the print dialog.
import { receiptBytes, drawerKickBytes, toBase64 } from "./escpos.js";

const KEY = "inaya_pos_print_v1";
export const DEFAULT_PRINT = { printer: { kind: "none", name: "", host: "", port: 9100, paper: 80 }, drawer: { kind: "none", port: "", baud: 9600 }, autoPrint: true, backup: "dialog" }; // backup: "dialog" (laser/inkjet via the print dialog) | "none"

export const inDesktopApp = () => typeof window !== "undefined" && !!window.__TAURI__?.core?.invoke;
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

export function loadPrintSettings() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); return v ? { ...DEFAULT_PRINT, ...v, printer: { ...DEFAULT_PRINT.printer, ...(v.printer || {}) }, drawer: { ...DEFAULT_PRINT.drawer, ...(v.drawer || {}) } } : { ...DEFAULT_PRINT }; } catch { return { ...DEFAULT_PRINT }; }
}
export function savePrintSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ } }

export async function listPrinters() { return inDesktopApp() ? invoke("pos_list_printers") : []; }
export async function listSerialPorts() { return inDesktopApp() ? invoke("pos_list_serial_ports") : []; }

async function sendToPrinter(s, bytes) {
  const data = toBase64(bytes);
  if (s.printer.kind === "installed") return invoke("pos_print_raw", { printer: s.printer.name, dataB64: data });
  if (s.printer.kind === "network") return invoke("pos_print_network", { host: s.printer.host, port: Number(s.printer.port) || 9100, dataB64: data });
  throw new Error("No receipt printer is set up on this till.");
}

/** True when this till can open its drawer by itself (desktop app + a drawer method). */
export function canOpenDrawer(s = loadPrintSettings()) {
  if (!inDesktopApp()) return false;
  if (s.drawer.kind === "serial") return !!s.drawer.port;
  if (s.drawer.kind === "printer") return s.printer.kind === "installed" || s.printer.kind === "network";
  return false;
}

/** Opens the drawer (no logging here: callers log every opening through the server first). */
export async function openDrawer(s = loadPrintSettings()) {
  if (!canOpenDrawer(s)) throw new Error("This till can't open a cash drawer by itself. Set it up in Point of Sale > Setup on the Inaya desktop app.");
  if (s.drawer.kind === "serial") return invoke("pos_serial_write", { port: s.drawer.port, baud: Number(s.drawer.baud) || 9600, dataB64: toBase64(drawerKickBytes()) });
  return sendToPrinter(s, drawerKickBytes());
}

/**
 * Prints a sale receipt. Thermal printer: silent, and (for cash) the drawer pulse goes in the same job when the drawer
 * hangs off the printer. Returns { printed, drawer: "opened" | "ask" | "none" } so the till can show the laser-printer
 * "Open cash drawer?" prompt.
 */
export async function printSaleReceipt(r, { cash = false, money } = {}, s = loadPrintSettings()) {
  if (!inDesktopApp() || s.printer.kind === "none" || s.printer.kind === "laser") return { printed: false, drawer: cash && canOpenDrawer(s) ? "ask" : "none" };
  const kickInJob = cash && s.drawer.kind === "printer";
  await sendToPrinter(s, receiptBytes(r, { paper: Number(s.printer.paper) === 58 ? 58 : 80, kickDrawer: kickInJob, money }));
  if (cash && s.drawer.kind === "serial" && s.drawer.port) { await openDrawer(s); return { printed: true, drawer: "opened" }; }
  return { printed: true, drawer: kickInJob ? "opened" : "none" };
}

/** One receipt on a specific installed printer, without changing the till's settings ("Print on..."). Thermal only (raw). */
export async function printOn(printerName, r, { money, paper = 80 } = {}) {
  if (!inDesktopApp()) throw new Error("Choosing a printer here needs the Inaya desktop app; use Print receipt instead.");
  return invoke("pos_print_raw", { printer: printerName, dataB64: toBase64(receiptBytes(r, { paper, money })) });
}

/** A short test page (used by Setup's "Print a test receipt"). */
export async function printTest(s = loadPrintSettings()) {
  const r = { company: "Inaya test receipt", location: "Printer check", saleNumber: "TEST", completedAt: new Date().toISOString(), currency: "", lines: [{ name: "If you can read this, printing works", quantity: 1, unitPrice: 0, total: 0 }], totals: { subtotal: 0, taxBreakdown: [], total: 0 }, tenders: [], returnPolicy: "", footer: s.printer.paper === 58 ? "58 mm paper" : "80 mm paper" };
  return sendToPrinter(s, receiptBytes(r, { paper: Number(s.printer.paper) === 58 ? 58 : 80 }));
}
