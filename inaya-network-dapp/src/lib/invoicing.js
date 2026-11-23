// src/lib/invoicing.js
//
// Invoice portal for package requests (founder request, 16 Nov 2026). On /admin/billing the founder
// saves the payment channels once (bank account, NayaPay), then for each request presses
// "Email invoice": an invoice number is assigned, a PDF is generated with the amount and the payment
// details for the method the customer chose, and it is emailed to the customer (replies go to
// contact@). Settings and the invoice counter live in the existing _meta collection (no new
// collections: the database is near its collection limit); invoices are recorded on the request.

import PDFDocument from "pdfkit";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { PLANS } from "./orgPlans.js";
import { sendEmail } from "./email.js";
import { ACTIVATION_INBOX, PAYMENT_METHODS } from "./billingRequests.js";

const CHANNELS_ID = "billingPaymentChannels";
const COUNTER_ID = "invoiceCounter";
const DUE_DAYS = 7;

const FIELDS = {
  bank: ["bankName", "accountTitle", "accountNumber", "iban", "swift", "branch"],
  nayapay: ["accountName", "nayapayId", "iban"],
  issuer: ["name", "address", "email", "phone"],
};

async function meta() {
  const { db } = await getOrgCollections();
  return db.collection("_meta");
}

/** The saved payment details (empty strings when not set yet). */
export async function getPaymentChannels() {
  const doc = (await (await meta()).findOne({ _id: CHANNELS_ID })) || {};
  const out = {};
  for (const [group, keys] of Object.entries(FIELDS)) out[group] = Object.fromEntries(keys.map((k) => [k, doc[group]?.[k] || ""]));
  if (!out.issuer.name) out.issuer.name = "Inaya Network";
  if (!out.issuer.email) out.issuer.email = ACTIVATION_INBOX;
  out.note = doc.note || "";
  out.updatedAt = doc.updatedAt || null;
  return out;
}

export async function savePaymentChannels(input = {}) {
  const clean = (v, max = 120) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
  const set = { updatedAt: new Date().toISOString(), note: String(input.note ?? "").trim().slice(0, 500) };
  for (const [group, keys] of Object.entries(FIELDS)) set[group] = Object.fromEntries(keys.map((k) => [k, clean(input[group]?.[k], group === "issuer" && k === "address" ? 300 : 120)]));
  await (await meta()).updateOne({ _id: CHANNELS_ID }, { $set: set }, { upsert: true });
  return getPaymentChannels();
}

function channelReady(channels, method) {
  if (method === "nayapay") return !!(channels.nayapay.accountName && (channels.nayapay.nayapayId || channels.nayapay.iban));
  return !!(channels.bank.bankName && channels.bank.accountTitle && (channels.bank.accountNumber || channels.bank.iban));
}

async function nextInvoiceNumber() {
  const year = new Date().getUTCFullYear();
  const r = await (await meta()).findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { [`y${year}`]: 1 } }, { upsert: true, returnDocument: "after" });
  const n = (r?.value ?? r)?.[`y${year}`] || 1;
  return `INV-${year}-${String(n).padStart(4, "0")}`;
}

const money = (currency, n) => (currency === "PKR" ? `PKR ${Math.round(n).toLocaleString("en-US")}` : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const ascii = (s) => String(s ?? "").replace(/[^\x20-\x7E]/g, "?"); // built-in Helvetica is Latin only

/** Line items and total for a request paid for `months` months (or one year for yearly requests). */
export function invoiceLines(r, months = 1) {
  const plan = PLANS[r.planId];
  const currency = r.currency || "PKR";
  const per = currency === "USD" ? r.amountUsd : r.amountPkr;
  const periods = r.interval === "year" ? 1 : Math.max(1, Math.min(24, Number(months) || 1));
  const label = `${plan?.name || r.planId} package${r.extraUsers ? ` with ${r.extraUsers} extra users` : ""}${r.pilot ? " (pilot price, 30% off)" : ""}`;
  const lines = [{ description: `${label}, ${r.interval === "year" ? "1 year" : `${periods} month${periods > 1 ? "s" : ""}`}`, quantity: periods, unit: per, amount: per * periods }];
  if (r.setupFeePkr && currency === "PKR") lines.push({ description: "One-time setup", quantity: 1, unit: r.setupFeePkr, amount: r.setupFeePkr });
  return { currency, lines, total: lines.reduce((a, l) => a + l.amount, 0), periods };
}

/** Renders the invoice PDF and resolves to a Buffer. */
export function renderInvoicePdf({ number, issuedAt, dueAt, r, channels, months }) {
  const { currency, lines, total } = invoiceLines(r, months);
  const method = r.paymentMethod === "nayapay" ? "nayapay" : "bank_transfer";
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const teal = "#0B6E75", grey = "#5b6475";

    doc.fillColor(teal).font("Helvetica-Bold").fontSize(20).text(ascii(channels.issuer.name || "Inaya Network"), 50, 50);
    doc.fillColor(grey).font("Helvetica").fontSize(9);
    if (channels.issuer.address) doc.text(ascii(channels.issuer.address), { width: 250 });
    doc.text(ascii([channels.issuer.email, channels.issuer.phone].filter(Boolean).join("  |  ")));
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(22).text("INVOICE", 350, 50, { width: 195, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor(grey)
      .text(`Invoice no.  ${number}`, 350, 80, { width: 195, align: "right" })
      .text(`Date  ${issuedAt.slice(0, 10)}`, { width: 195, align: "right" })
      .text(`Due  ${dueAt.slice(0, 10)}`, { width: 195, align: "right" });

    doc.moveTo(50, 140).lineTo(545, 140).strokeColor("#e2e8f0").stroke();
    doc.fillColor(grey).fontSize(9).text("BILL TO", 50, 155);
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(11).text(ascii(r.orgName && r.orgName !== "(Company name not set)" ? r.orgName : r.contact?.name || r.requestedByEmail), 50, 168);
    doc.font("Helvetica").fontSize(9).fillColor(grey);
    if (r.contact?.name) doc.text(ascii(r.contact.name));
    doc.text(ascii(r.requestedByEmail || ""));
    if (r.contact?.phone) doc.text(ascii(r.contact.phone));

    let y = 240;
    doc.rect(50, y, 495, 22).fill("#f1f5f9");
    doc.fillColor(grey).font("Helvetica-Bold").fontSize(9)
      .text("DESCRIPTION", 58, y + 7).text("QTY", 330, y + 7, { width: 40, align: "right" })
      .text("UNIT", 380, y + 7, { width: 75, align: "right" }).text("AMOUNT", 460, y + 7, { width: 78, align: "right" });
    y += 30;
    doc.font("Helvetica").fontSize(10).fillColor("#0f172a");
    for (const l of lines) {
      doc.text(ascii(l.description), 58, y, { width: 265 }).text(String(l.quantity), 330, y, { width: 40, align: "right" })
        .text(money(currency, l.unit), 380, y, { width: 75, align: "right" }).text(money(currency, l.amount), 460, y, { width: 78, align: "right" });
      y += 24;
    }
    doc.moveTo(330, y).lineTo(545, y).strokeColor("#e2e8f0").stroke();
    doc.font("Helvetica-Bold").fontSize(12).text("Total due", 330, y + 10, { width: 120 }).text(money(currency, total), 440, y + 10, { width: 98, align: "right" });

    y += 60;
    doc.fillColor(teal).font("Helvetica-Bold").fontSize(11).text(`How to pay: ${PAYMENT_METHODS[method]}`, 50, y);
    doc.fillColor("#0f172a").font("Helvetica").fontSize(10);
    const rows = method === "nayapay"
      ? [["Account name", channels.nayapay.accountName], ["NayaPay ID / number", channels.nayapay.nayapayId], ["IBAN", channels.nayapay.iban]]
      : [["Bank", channels.bank.bankName], ["Account title", channels.bank.accountTitle], ["Account number", channels.bank.accountNumber], ["IBAN", channels.bank.iban], ["SWIFT / BIC", channels.bank.swift], ["Branch", channels.bank.branch]];
    y += 20;
    for (const [k, v] of rows.filter(([, v]) => v)) { doc.fillColor(grey).text(k, 50, y, { width: 140 }); doc.fillColor("#0f172a").text(ascii(v), 190, y, { width: 355 }); y += 16; }
    doc.fillColor(grey).text("Payment reference", 50, y, { width: 140 }); doc.fillColor("#0f172a").font("Helvetica-Bold").text(number, 190, y); y += 24;
    doc.font("Helvetica").fillColor(grey).fontSize(9).text(ascii(`Please include the invoice number as the payment reference and pay by ${dueAt.slice(0, 10)}. Your package is activated as soon as the payment arrives.${channels.note ? ` ${channels.note}` : ""}`), 50, y, { width: 495 });
    doc.fontSize(8).text(ascii(`Questions about this invoice: ${channels.issuer.email || ACTIVATION_INBOX}`), 50, 770, { width: 495, align: "center" });
    doc.end();
  });
}

async function loadRequest(requestId) {
  const { db } = await getOrgCollections();
  const r = await db.collection("billing_requests").findOne({ _id: toObjectId(requestId) });
  return { col: db.collection("billing_requests"), r };
}

/** A draft PDF (number "DRAFT") for checking before sending. */
export async function previewInvoice({ requestId, months }) {
  const { r } = await loadRequest(requestId);
  if (!r) return { error: "Request not found.", status: 404 };
  const channels = await getPaymentChannels();
  const now = new Date();
  const pdf = await renderInvoicePdf({ number: "DRAFT", issuedAt: now.toISOString(), dueAt: new Date(now.getTime() + DUE_DAYS * 86400000).toISOString(), r, channels, months });
  return { pdf };
}

/** Assigns a number, renders the PDF and emails it to the customer; records it on the request. */
export async function emailInvoice({ requestId, months }) {
  const { col, r } = await loadRequest(requestId);
  if (!r) return { error: "Request not found.", status: 404 };
  if (r.status !== "pending") return { error: `This request is ${r.status}; invoices are for pending requests.`, status: 409 };
  if (!r.requestedByEmail) return { error: "The request has no email address.", status: 400 };
  const method = r.paymentMethod === "nayapay" ? "nayapay" : "bank_transfer";
  const channels = await getPaymentChannels();
  if (!channelReady(channels, method)) return { error: `Add your ${PAYMENT_METHODS[method]} details under "Payment details" first.`, status: 400 };

  const number = await nextInvoiceNumber();
  const now = new Date();
  const issuedAt = now.toISOString();
  const dueAt = new Date(now.getTime() + DUE_DAYS * 86400000).toISOString();
  const { currency, total, periods } = invoiceLines(r, months);
  const pdf = await renderInvoicePdf({ number, issuedAt, dueAt, r, channels, months });
  const plan = PLANS[r.planId];

  const sent = await sendEmail({
    to: r.requestedByEmail,
    replyTo: channels.issuer.email || ACTIVATION_INBOX,
    subject: `Invoice ${number} for your Inaya ${plan?.name || ""} package`,
    text: [
      `Hello${r.contact?.name ? ` ${r.contact.name}` : ""},`,
      "",
      `Please find attached invoice ${number} for your Inaya Business OS ${plan?.name || r.planId} package: ${money(currency, total)}, due by ${dueAt.slice(0, 10)}.`,
      "",
      `Payment method: ${PAYMENT_METHODS[method]}. The payment details are on the invoice. Please use ${number} as the payment reference.`,
      "",
      "Your package is activated as soon as the payment arrives, and we will email you when it is active.",
      "",
      "Questions? Simply reply to this email.",
      "",
      `${channels.issuer.name || "Inaya Network"}`,
      `${channels.issuer.email || ACTIVATION_INBOX}`,
    ].join("\n"),
    attachments: [{ filename: `${number}.pdf`, content: pdf.toString("base64"), contentType: "application/pdf" }],
  });
  if (sent && sent.sent === false) return { error: "Email is not configured on the server, so the invoice was not sent.", status: 500 };

  const invoice = { number, issuedAt, dueAt, currency, total, months: periods, method, emailedTo: r.requestedByEmail };
  await col.updateOne({ _id: r._id }, { $push: { invoices: invoice }, $set: { lastInvoiceNumber: number, lastInvoicedAt: issuedAt } });
  return { invoice };
}
