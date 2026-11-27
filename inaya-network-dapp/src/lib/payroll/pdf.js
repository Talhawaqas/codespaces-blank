// src/lib/payroll/pdf.js -- the payslip PDF (download in the app, email and WhatsApp). With `password`, the PDF is
// encrypted (pdfkit, AES-128 with the PDF 1.6 standard security handler): it opens only with the employee's own
// payslip password, and printing is allowed while editing is not.
import PDFDocument from "pdfkit";
import { randomBytes } from "node:crypto";

const latin = (v) => String(v ?? "").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const fmt = (n, currency) => `${currency} ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const periodLabel = (p) => `${MONTHS[Number(String(p).slice(5, 7)) - 1] || ""} ${String(p).slice(0, 4)}`;

/** Resolves to a Buffer. slip = engine output + { employeeName, employeeRef, jobTitle, department, companyName, companyAddress, paidOn } */
export function payslipPdf(slip, { password = null } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { size: "A4", margin: 48, info: { Title: latin(`Payslip ${periodLabel(slip.period)}`), Producer: "Inaya Business OS Payroll" } };
    if (password) Object.assign(opts, { userPassword: String(password), ownerPassword: randomBytes(24).toString("base64url"), pdfVersion: "1.6", permissions: { printing: "highResolution", modifying: false, copying: false, annotating: false } });
    const doc = new PDFDocument(opts); const chunks = [];
    doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const W = doc.page.width - 96; const cur = slip.currency;
    doc.rect(0, 0, doc.page.width, 90).fill("#1f2433");
    doc.fillColor("#d4a537").font("Helvetica-Bold").fontSize(9).text("PAYSLIP", 48, 26, { characterSpacing: 2 });
    doc.fillColor("#ffffff").fontSize(18).text(latin(slip.companyName || "Company"), 48, 40);
    doc.fillColor("#cbd5e1").font("Helvetica").fontSize(10).text(latin(periodLabel(slip.period)), 48, 64);
    doc.fillColor("#111827").moveDown(3);
    let y = 110;
    const kv = (k, v, x) => { doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text(k, x, y); doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(latin(v || "-"), x, y + 12, { width: W / 2 - 10 }); };
    kv("Employee", slip.employeeName, 48); kv("Employee ID", slip.employeeRef, 48 + W / 2); y += 34;
    kv("Job title", slip.jobTitle, 48); kv("Department", slip.department, 48 + W / 2); y += 34;
    if (slip.paidOn) { kv("Paid on", slip.paidOn, 48); y += 34; }
    const table = (title, rows, total) => {
      y += 10; doc.font("Helvetica-Bold").fontSize(10).fillColor("#b8860b").text(title.toUpperCase(), 48, y, { characterSpacing: 1 }); y += 16;
      for (const r of rows) { doc.font("Helvetica").fontSize(10).fillColor("#111827").text(latin(r.label), 48, y, { width: W - 140 }); doc.text(fmt(r.amount, cur), 48 + W - 140, y, { width: 140, align: "right" }); y += 16; }
      if (total) { doc.moveTo(48, y + 2).lineTo(48 + W, y + 2).strokeColor("#e5e7eb").stroke(); y += 6; doc.font("Helvetica-Bold").text(total[0], 48, y); doc.text(fmt(total[1], cur), 48 + W - 140, y, { width: 140, align: "right" }); y += 18; }
    };
    const reductions = slip.deductions.filter((d) => d.shownAsReduction);
    table("Earnings", [...slip.earnings, ...reductions.map((d) => ({ label: d.label, amount: -d.amount }))], ["Gross pay", slip.gross]);
    table("Deductions", slip.deductions.filter((d) => !d.shownAsReduction), ["Total deductions", slip.totalDeductions]);
    y += 6; doc.rect(48, y, W, 34).fill("#f5efe0"); doc.fillColor("#111827").font("Helvetica-Bold").fontSize(13).text("Net pay", 60, y + 10); doc.text(fmt(slip.net, cur), 48 + W - 200, y + 10, { width: 188, align: "right" }); y += 48;
    if (slip.employer?.length) table("Paid by the employer (not deducted from you)", slip.employer, ["Employer contributions", slip.employerCost]);
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(latin(`Calculated by Inaya Business OS Payroll (${slip.presetVersion || "custom rules"}). Tax and contributions follow the rules your employer confirmed; contact your employer's HR with any question. ${slip.attendance?.unpaidDays ? `Unpaid days: ${slip.attendance.unpaidDays}. ` : ""}${slip.attendance?.overtimeHours ? `Overtime hours: ${slip.attendance.overtimeHours}.` : ""}`), 48, Math.max(y + 10, doc.page.height - 110), { width: W });
    doc.end();
  });
}
