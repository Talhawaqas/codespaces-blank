"use client";

// src/app/guardian/[token]/page.js
//
// What a parent or guardian sees when the school shares a link: one child's
// fee statement, attendance rate and published results. Read-only, no
// account, printable. The data comes from /api/education-guardian/[token],
// which never returns identifiers, medical notes or addresses.

import { useEffect, useState, use } from "react";
import BrandHeader from "../../../components/BrandHeader";

const money = (minor, currency) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "PKR", maximumFractionDigits: 2 }).format((minor || 0) / 100); }
  catch { return `${currency || ""} ${((minor || 0) / 100).toFixed(2)}`; }
};
const card = "bg-white/[0.03] border border-white/10 rounded-2xl p-5";
const th = "text-left text-[11px] uppercase tracking-wide text-[#8a96ab] font-semibold py-2 pr-3";
const td = "py-2 pr-3 text-sm text-white/90 border-t border-white/5";
const STATUS = { paid: "text-emerald-400", partial: "text-amber-400", unpaid: "text-red-400" };

export default function GuardianPage({ params }) {
  const { token } = use(params);
  const [view, setView] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/education-guardian/${encodeURIComponent(token)}`)
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "This link isn't valid."); setView(d); })
      .catch((e) => setError(e.message));
  }, [token]);

  return (
    <div className="min-h-screen bg-[#0b0f17] text-white">
      <meta name="robots" content="noindex" />
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">
        <BrandHeader />
        {error && <div className={card}><p className="text-red-400 text-sm">{error}</p><p className="text-[#8a96ab] text-xs mt-2">Ask the school office for a new link.</p></div>}
        {!error && !view && <p className="text-[#8a96ab] text-sm">Loading…</p>}
        {view && (
          <>
            <div className={card}>
              <p className="text-[#8a96ab] text-xs uppercase tracking-wide">{view.schoolName}</p>
              <h1 className="text-2xl font-bold mt-1">{view.student.fullName}</h1>
              <p className="text-[#8a96ab] text-sm mt-1">Admission no. {view.student.admissionNo}{view.student.classLabel ? ` · ${view.student.classLabel}` : ""}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
                <Stat label="Fees outstanding" value={money(view.fees.outstandingMinor, view.currency)} tone={view.fees.outstandingMinor > 0 ? "text-amber-400" : "text-emerald-400"} />
                <Stat label="Attendance (90 days)" value={view.attendance.rate === null ? "Not recorded yet" : `${view.attendance.rate}%`} />
                <Stat label="Published results" value={String(view.results.length)} />
              </div>
            </div>

            <div className={card}>
              <h2 className="font-semibold mb-2">Fee invoices</h2>
              {view.fees.invoices.length === 0 ? <p className="text-[#8a96ab] text-sm">No invoices yet.</p> : (
                <div className="overflow-x-auto"><table className="w-full">
                  <thead><tr><th className={th}>Invoice</th><th className={th}>Period</th><th className={th}>Due</th><th className={th}>Total</th><th className={th}>Paid</th><th className={th}>Status</th></tr></thead>
                  <tbody>{view.fees.invoices.map((i) => (
                    <tr key={i.invoiceNo}><td className={td}>{i.invoiceNo}</td><td className={td}>{i.period}</td><td className={td}>{i.dueDate}</td><td className={td}>{money(i.totalMinor, view.currency)}{i.concessionMinor ? <span className="block text-[11px] text-[#8a96ab]">after {money(i.concessionMinor, view.currency)} concession</span> : null}</td><td className={td}>{money(i.paidMinor, view.currency)}</td><td className={`${td} capitalize ${STATUS[i.status] || ""}`}>{i.status}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>

            <div className={card}>
              <h2 className="font-semibold mb-2">Payments received</h2>
              {view.fees.payments.length === 0 ? <p className="text-[#8a96ab] text-sm">No payments recorded yet.</p> : (
                <div className="overflow-x-auto"><table className="w-full">
                  <thead><tr><th className={th}>Receipt</th><th className={th}>Date</th><th className={th}>Amount</th><th className={th}>Method</th></tr></thead>
                  <tbody>{view.fees.payments.map((p) => (
                    <tr key={p.receiptNo}><td className={td}>{p.receiptNo}</td><td className={td}>{p.paidOn}</td><td className={td}>{money(p.amountMinor, view.currency)}</td><td className={`${td} capitalize`}>{p.method.replace(/_/g, " ")}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>

            <div className={card}>
              <h2 className="font-semibold mb-2">Attendance since {view.attendance.since}</h2>
              <p className="text-sm text-white/90">Present {view.attendance.present} · Late {view.attendance.late} · Absent {view.attendance.absent} · Leave {view.attendance.leave}</p>
            </div>

            <div className={card}>
              <h2 className="font-semibold mb-2">Results</h2>
              {view.results.length === 0 ? <p className="text-[#8a96ab] text-sm">No results have been published yet.</p> : (
                <div className="overflow-x-auto"><table className="w-full">
                  <thead><tr><th className={th}>Term</th><th className={th}>Subject</th><th className={th}>Assessment</th><th className={th}>Marks</th><th className={th}>Grade</th></tr></thead>
                  <tbody>{view.results.map((r, i) => (
                    <tr key={i}><td className={td}>{r.term || "—"}</td><td className={td}>{r.subject || "—"}</td><td className={td}>{r.assessment}</td><td className={td}>{r.absent ? "Absent" : `${r.marks} / ${r.maxMarks}`}</td><td className={td}>{r.grade || "—"}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>

            <p className="text-[#8a96ab] text-xs">This page is read-only and was shared by the school. The link stops working on {view.expiresAt.slice(0, 10)}. Please don&apos;t forward it.</p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "text-white" }) {
  return (
    <div className="bg-black/20 border border-white/5 rounded-xl p-3">
      <p className="text-[11px] uppercase tracking-wide text-[#8a96ab]">{label}</p>
      <p className={`text-lg font-semibold mt-1 ${tone}`}>{value}</p>
    </div>
  );
}
