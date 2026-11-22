// src/lib/commerce/receipts.js -- Inaya Commerce, Batch 4 (Master SOW 6.10): receipts and documents.
//
// One receipt model (built only from the stored sale/refund, so it always matches the transaction) rendered three ways:
//   - on screen / print (PosView), - a downloadable PDF (pdfkit, 80 mm roll width), - an email with the PDF attached
//     (Resend, "where messaging is configured": without RESEND_API_KEY the API says so instead of pretending it sent).
// Branding comes from the company's billing profile (Document Automation settings): legal name, address, tax number and
// label, phone, website, brand colour and logo. Sale notes are printed only when the company turns that on (privacy).
// "Save to Documents" stores the PDF in the company's `pos-receipts` storage bucket (server-managed encryption, versioned,
// protected by the bucket's retention/lifecycle rules like every other Documents bucket) and records it on the sale, so
// a receipt can be attached to the transaction and found again in Inaya Documents.
import PDFDocument from "pdfkit";
import { fail, clean, nowIso, oid, sid, commerceAccess, getSettings, fromMinor, audit } from "./store.js";
import { receiptFor } from "./sale.js";
import { refundReceipt } from "./returns.js";
import { getOrgCollections } from "../orgs.js";

export const RECEIPT_BUCKET = "pos-receipts";
const TENDER = { CASH: "Cash", BANK_TRANSFER: "Bank transfer", MANUAL_REFERENCE: "Other", EXCHANGE_CREDIT: "Exchange credit", EXCHANGE: "Exchange" };
const fmt = (v, cur) => { try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur, minimumFractionDigits: 2 }).format(v || 0); } catch { return `${cur} ${(v || 0).toFixed(2)}`; } };

async function branding(orgId) {
  try {
    const { getDocumentSettings, addressLines } = await import("../documentAutomation/settings.js");
    const s = await getDocumentSettings(orgId); const b = s.billingProfile || {};
    return { legalName: b.legalName || null, address: b.address ? addressLines(b.address) : [], taxId: b.taxId || null, taxLabel: b.taxLabel || "Tax no.", phone: b.phone || null, website: b.website || null, email: b.email || null, brandColor: b.brandColor || "#0a5f6e", logo: b.logo?.dataBase64 ? Buffer.from(b.logo.dataBase64, "base64") : null };
  } catch { return { address: [], brandColor: "#0a5f6e", logo: null }; }
}

/** The full receipt (sale or refund) with branding and privacy rules applied. */
export async function receiptModel({ orgId, membership, saleId, refundNumber = null }) {
  const r = refundNumber ? await refundReceipt({ orgId, membership, saleId, refundNumber }) : await receiptFor({ orgId, membership, saleId });
  if (r.error) return r;
  const settings = await getSettings(orgId); const brand = await branding(orgId);
  const rec = { ...r.receipt, kind: refundNumber ? "refund" : "sale", brand: { ...brand, logo: !!brand.logo }, timezone: settings.timezone || "UTC" };
  if (!settings.receiptShowNotes) { delete rec.notes; if (rec.lines) rec.lines = rec.lines.map(({ note, ...l }) => l); }
  return { receipt: rec, logo: brand.logo };
}

/** Two passes: the first measures how long the roll is, the second draws on a page of exactly that height (a receipt
 *  is one continuous 80 mm strip, never split across pages). */
export async function renderReceiptPdf(rec, logo) {
  const W = 226; // 80 mm
  const measure = await paintReceipt(rec, logo, W, 20000);
  const buf = await paintReceipt(rec, logo, W, Math.max(200, Math.ceil(measure.height + 18)));
  return buf.pdf;
}
function paintReceipt(rec, logo, W, H) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [W, H], margins: { top: 14, left: 12, right: 12, bottom: 4 }, autoFirstPage: true, info: { Title: `${rec.kind === "refund" ? "Refund" : "Receipt"} ${rec.kind === "refund" ? rec.refundNumber : rec.saleNumber}`, Author: rec.company } });
    const chunks = []; let height = 0; doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve({ pdf: Buffer.concat(chunks), height })); doc.on("error", reject);
    const cur = rec.currency; const inner = W - 24; const color = /^#[0-9a-f]{6}$/i.test(rec.brand?.brandColor || "") ? rec.brand.brandColor : "#0a5f6e";
    const row = (l, r, opts = {}) => { const y = doc.y; doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size || 7.5).fillColor("#111").text(l, 12, y, { width: inner - 70 }); const y2 = doc.y; doc.text(r, 12, y, { width: inner, align: "right" }); doc.y = Math.max(y2, doc.y); };
    const rule = () => { doc.moveDown(0.3); doc.moveTo(12, doc.y).lineTo(W - 12, doc.y).dash(1.5, { space: 1.5 }).strokeColor("#888").stroke().undash(); doc.moveDown(0.3); };
    if (logo) { try { doc.image(logo, (W - 60) / 2, doc.y, { fit: [60, 40], align: "center" }); doc.moveDown(3.2); } catch { /* unreadable logo: skip */ } }
    doc.font("Helvetica-Bold").fontSize(10).fillColor(color).text(rec.brand?.legalName || rec.company, { align: "center" });
    doc.font("Helvetica").fontSize(7).fillColor("#333");
    for (const l of [...(rec.brand?.address || []), rec.location, rec.brand?.phone, rec.brand?.website, rec.brand?.taxId ? `${rec.brand.taxLabel || "Tax no."} ${rec.brand.taxId}` : null].filter(Boolean)) doc.text(l, { align: "center" });
    rule();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#111").text(rec.kind === "refund" ? `REFUND ${rec.refundNumber}` : `RECEIPT ${rec.saleNumber}`, { align: "center" });
    doc.font("Helvetica").fontSize(7).text(`${new Date(rec.kind === "refund" ? rec.createdAt : rec.completedAt).toLocaleString("en-GB", { timeZone: rec.timezone || "UTC" })} (${rec.timezone || "UTC"})`, { align: "center" });
    if (rec.kind === "refund") doc.text(`Original sale ${rec.saleNumber}`, { align: "center" });
    doc.text(`Transaction ID ${rec.kind === "refund" ? `${rec.saleId}/${rec.refundNumber}` : rec.id}`, { align: "center" });
    rule();
    for (const l of rec.lines) {
      row(rec.kind === "refund" ? `${l.name} x ${l.quantity}` : l.name, `${rec.kind === "refund" ? "-" : ""}${fmt(l.total, cur)}`);
      const sub = rec.kind === "refund" ? `${String(l.disposition || "").toLowerCase().replace("_", "-")}${l.taxRate ? ` · tax ${l.taxRate}% reversed ${fmt(l.tax, cur)}` : ""}` : `${l.quantity} x ${fmt(l.unitPrice, cur)}${l.discount ? ` · -${fmt(l.discount, cur)}` : ""}${l.taxRate ? ` · ${l.taxCategory || "tax"} ${l.taxRate}%` : ""}`;
      doc.font("Helvetica").fontSize(6.5).fillColor("#555").text(sub, 12, doc.y, { width: inner });
      if (l.note) doc.text(`Note: ${l.note}`, { width: inner });
    }
    rule();
    if (rec.kind === "refund") {
      row("Refund before tax", fmt(rec.net, cur)); row("Tax reversed", fmt(rec.tax, cur)); row("REFUND TOTAL", fmt(rec.total, cur), { bold: true, size: 9 });
    } else {
      row("Subtotal", fmt(rec.totals.subtotal, cur)); if (rec.totals.discounts > 0) row("Discounts", `-${fmt(rec.totals.discounts, cur)}`);
      for (const t of rec.totals.taxBreakdown || []) row(`${t.name || "Tax"} ${t.rate}% on ${fmt(t.taxable, cur)}`, fmt(t.tax, cur));
      row("TOTAL", fmt(rec.totals.total, cur), { bold: true, size: 9 });
    }
    for (const t of rec.tenders || []) row(`${TENDER[t.method] || t.method}${t.reference ? ` (${t.reference})` : ""} · recorded manually`, fmt(t.amount, cur));
    if (rec.cashRounding) row("Cash rounding", fmt(rec.cashRounding, cur)); if (rec.change > 0) row("Change", fmt(rec.change, cur));
    rule();
    doc.font("Helvetica").fontSize(6.5).fillColor("#333");
    if (rec.kind === "refund") { doc.text(`Reason: ${rec.reason}`, { width: inner }); doc.text(`Processed by ${rec.processedBy}${rec.approvedBy ? `, approved by ${rec.approvedBy}` : ""}`, { width: inner }); }
    else { if (rec.notes) doc.text(`Note: ${rec.notes}`, { width: inner }); if (rec.returnPolicy) doc.text(rec.returnPolicy, { width: inner }); if (rec.footer) doc.text(rec.footer, { width: inner }); }
    doc.moveDown(0.5).fontSize(6).fillColor("#888").text("Payments shown are recorded by the shop; no card was charged by Inaya.", { width: inner, align: "center" });
    height = doc.y;
    doc.end();
  });
}

export async function receiptPdf({ orgId, membership, saleId, refundNumber }) {
  const m = await receiptModel({ orgId, membership, saleId, refundNumber }); if (m.error) return m;
  const pdf = await renderReceiptPdf(m.receipt, m.logo);
  return { pdf, filename: `${m.receipt.kind === "refund" ? m.receipt.refundNumber : m.receipt.saleNumber}.pdf`, receipt: m.receipt };
}

export async function emailReceipt({ orgId, membership, actorEmail, saleId, refundNumber, to }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const email = clean(to, 200).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email address.");
  if (process.env.INAYA_USE_TEST_DB === "1") return fail("This is a test environment, so receipts are never emailed. Download or print it instead.", 409, "EMAIL_TEST_ENVIRONMENT");
  if (!process.env.RESEND_API_KEY) return fail("Email isn't configured for this workspace, so the receipt can't be emailed. Download or print it instead.", 409, "EMAIL_NOT_CONFIGURED");
  const r = await receiptPdf({ orgId, membership, saleId, refundNumber }); if (r.error) return r;
  const { sendEmail } = await import("../email.js");
  const rec = r.receipt; const title = rec.kind === "refund" ? `Refund ${rec.refundNumber}` : `Receipt ${rec.saleNumber}`; const who = rec.brand?.legalName || rec.company;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto"><h2 style="color:#10151f">${esc(who)}</h2><p>Thank you. Your ${rec.kind === "refund" ? "refund receipt" : "receipt"} <b>${esc(rec.kind === "refund" ? rec.refundNumber : rec.saleNumber)}</b> for <b>${esc(fmt(rec.total ?? rec.totals?.total, rec.currency))}</b> is attached as a PDF.</p><p style="color:#666;font-size:12px">${esc(rec.returnPolicy || "")}</p></div>`;
  const sent = await sendEmail({ to: email, subject: `${title} from ${who}`, html, text: `${title} from ${who}: ${fmt(rec.total ?? rec.totals?.total, rec.currency)}. The PDF is attached.`, attachments: [{ filename: r.filename, content: r.pdf.toString("base64"), contentType: "application/pdf" }] });
  if (!sent.sent) return fail("The email could not be sent. Try again or download the receipt.", 502, "EMAIL_FAILED");
  await audit({ orgId, actorEmail, recordType: "POS_SALE", recordId: saleId, action: "RECEIPT_EMAILED", newState: { receipt: rec.kind === "refund" ? rec.refundNumber : rec.saleNumber, toDomain: email.split("@")[1] } });
  const { salesOrders } = await getOrgCollections();
  await salesOrders.updateOne({ _id: oid(saleId), orgId: oid(orgId) }, { $push: { receiptEmails: { at: nowIso(), by: actorEmail, refundNumber: refundNumber || null } } });
  return { sent: true };
}

export async function saveReceiptToDocuments({ orgId, membership, actorEmail, saleId, refundNumber }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const r = await receiptPdf({ orgId, membership, saleId, refundNumber }); if (r.error) return r;
  const rec = r.receipt; const day = String(rec.kind === "refund" ? rec.createdAt : rec.completedAt).slice(0, 10);
  const key = `${day.slice(0, 4)}/${day.slice(5, 7)}/${r.filename}`;
  const { putS3Object } = await import("../s3-compat/store.js");
  const { ensureOwnerS3Passphrase } = await import("../s3-compat/credentials.js");
  const { workspaceProviderOrder } = await import("../pinningProviders/index.js");
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  const order = workspaceProviderOrder(); let stored = null, last = null;
  for (const providerName of order.length ? order : [undefined]) {
    try { stored = await putS3Object({ orgId: String(orgId), bucket: RECEIPT_BUCKET, key, bodyBuffer: r.pdf, contentType: "application/pdf", actorEmail: actorEmail || "pos", providerName }); break; }
    catch (e) { last = e; console.error(`pos receipts storage: provider "${providerName || "default"}" failed (${String(e.message).slice(0, 100)})`); }
  }
  if (!stored) return fail(`The receipt could not be stored (${String(last?.message || "storage error").slice(0, 120)}).`, 502, "STORAGE");
  const { salesOrders } = await getOrgCollections();
  const documentId = sid(stored.documentId || stored._id || stored.document?._id) || null;
  await salesOrders.updateOne({ _id: oid(saleId), orgId: oid(orgId) }, { $push: { attachments: { kind: rec.kind === "refund" ? "refund_receipt" : "receipt", refundNumber: refundNumber || null, bucket: RECEIPT_BUCKET, key, documentId, at: nowIso(), by: actorEmail } } });
  await audit({ orgId, actorEmail, recordType: "POS_SALE", recordId: saleId, action: "RECEIPT_SAVED_TO_DOCUMENTS", newState: { bucket: RECEIPT_BUCKET, key } });
  return { saved: true, bucket: RECEIPT_BUCKET, key, documentId };
}
