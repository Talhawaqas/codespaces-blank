"use client";

// src/components/business/LicenseBilling.js -- the company side of Business Workspace licenses (License Manager SOW 7, 8.1, 18.2).
//   <LicenseBanner>       sign-in / in-app notice while payment is overdue or the license is restricted (dismissible per session)
//   <LicenseCard>         Billing: package, state, cycle, amount, dates, grace countdown, payment instructions,
//                         payment history and the company data export (Owner/Admin)
//   <RestrictedWorkspace> what a suspended / cancelled / expired company sees instead of the Workspace:
//                         Owners/Admins get Billing, the export and read-only document download; members a neutral notice
// Every date, deadline and "time left" comes from the server (src/lib/licensing/dates.js); nothing is calculated here.

import { useCallback, useEffect, useState } from "react";
import { saveDocument } from "../viewer/documentFiles";
import { fetchShardFromIPFS } from "../../lib/ipfsGateways";

async function getJson(url, init) {
  const res = await fetch(url, { cache: "no-store", ...(init || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
// Dates an admin entered as a calendar day (payment received) are stored at UTC midnight: show that day, not the
// viewer's local shift of it (found in the browser walkthrough: 17 Nov showed as 16 Nov in a US-timezone browser).
const calendarDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { timeZone: "UTC" }) : "—");
const money = (a, c) => (a == null ? "—" : c === "PKR" ? `PKR ${Number(a).toLocaleString("en-US")}` : `$${Number(a).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-5)] rounded-2xl p-5";
const label = "text-[var(--inaya-text-muted)] text-[12px] font-bold uppercase tracking-wide";
const btn = "px-3 py-2 rounded-lg text-[13px] font-bold disabled:opacity-40";
const primary = `${btn} bg-[#00f2fe] text-black`;
const ghost = `${btn} border border-[var(--inaya-overlay-10)] text-[var(--inaya-text-primary)]`;
const TONE = { active: "text-emerald-400", admin_override: "text-emerald-400", grace_period: "text-amber-400", pending_activation: "text-sky-400", suspended: "text-red-400", cancelled: "text-[var(--inaya-text-muted)]", expired: "text-[var(--inaya-text-muted)]" };

/** The license status for this company (any member; Owners/Admins also get the deadline). Refreshes every 5 minutes. */
export function useLicenseStatus(orgId) {
  const [status, setStatus] = useState(null);
  const load = useCallback(async () => {
    if (!orgId) return;
    try { setStatus((await getJson(`/api/orgs/license/status?orgId=${orgId}`)).license); } catch { /* keep the last known state */ }
  }, [orgId]);
  useEffect(() => { load(); const t = setInterval(load, 5 * 60 * 1000); return () => clearInterval(t); }, [load]);
  return { status, reload: load };
}

export function LicenseBanner({ orgId, status, onOpenBilling }) {
  const key = `inaya-license-banner-${orgId}-${status?.state}`;
  const [hidden, setHidden] = useState(false);
  useEffect(() => { try { setHidden(sessionStorage.getItem(key) === "1"); } catch { setHidden(false); } }, [key]);
  if (!status || hidden || !["grace_period"].includes(status.state)) return null;
  const dismiss = () => { setHidden(true); try { sessionStorage.setItem(key, "1"); } catch { /* not stored */ } };
  return (
    <div role="status" className="mb-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-[13px] text-[var(--inaya-text-primary)] flex flex-wrap items-center gap-3 justify-between">
      <span>
        <b>Payment overdue.</b>{" "}
        {status.isManager
          ? <>Your license will be suspended in <b>{status.remaining}</b>, on <b>{status.deadlineText}</b>, if payment is not confirmed. You can keep using Business Workspace until then.</>
          : <>Your company's subscription payment is overdue. Please let your company's owner or admin know. Everything keeps working for now.</>}
      </span>
      <span className="flex gap-2">
        {status.isManager && onOpenBilling && <button className={primary} onClick={onOpenBilling}>Open Billing</button>}
        <button className={ghost} onClick={dismiss} aria-label="Hide this notice for this session">Hide</button>
      </span>
    </div>
  );
}

function ExportSection({ orgId, exports: initial }) {
  const [exports, setExports] = useState(initial || []);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const refresh = useCallback(async () => { try { setExports((await getJson(`/api/orgs/exports?orgId=${orgId}`)).exports); } catch { /* ignore */ } }, [orgId]);
  const working = exports.some((x) => ["queued", "running"].includes(x.status));
  useEffect(() => { if (!working) return; const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [working, refresh]);
  async function request() {
    setBusy(true); setErr("");
    try { await getJson(`/api/orgs/exports?orgId=${orgId}`, { method: "POST" }); await refresh(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className={card}>
      <p className={label}>Download company data</p>
      <p className="text-[var(--inaya-text-muted)] text-[13px] mt-1 mb-3">A ZIP of every record your company owns plus the files in your S3 and NAS storage, with a manifest of exactly what is included. Available at any time, including during a grace period and after suspension. Nothing is deleted when a license is suspended.</p>
      <div className="flex flex-wrap gap-2">
        <button className={primary} onClick={request} disabled={busy || working}>{working ? "Preparing your export…" : busy ? "Starting…" : "Prepare a new export"}</button>
        <a className={ghost} href={`/api/orgs/export-zip?orgId=${orgId}`}>Download records now (quick, no files)</a>
      </div>
      {err && <p className="text-red-400 text-[13px] mt-2" role="alert">{err}</p>}
      {exports.length > 0 && (
        <ul className="mt-3 divide-y divide-[var(--inaya-overlay-5)] text-[13px]">
          {exports.map((x) => (
            <li key={x.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[var(--inaya-text-primary)]">{new Date(x.requestedAt).toLocaleString()} · {{ queued: "waiting to start", running: "being prepared", ready: `ready${x.bytes ? ` (${(x.bytes / 1048576).toFixed(1)} MB)` : ""}`, failed: "failed", expired: "expired" }[x.status] || x.status}{x.status === "ready" && x.expiresAt ? ` · available until ${new Date(x.expiresAt).toLocaleDateString()}` : ""}{x.error ? ` · ${x.error}` : ""}</span>
              {x.status === "ready" && <a className={ghost} href={`/api/orgs/exports/${x.id}/download?orgId=${orgId}`}>Download ZIP</a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PaymentInstructions({ p }) {
  if (!p) return null;
  const Lines = ({ title, o, names }) => (o ? <div className="text-[13px]"><p className="font-bold text-[var(--inaya-text-primary)]">{title}</p>{Object.entries(o).map(([k, v]) => <p key={k} className="text-[var(--inaya-text-muted)]">{names[k] || k}: <span className="text-[var(--inaya-text-primary)] font-mono">{v}</span></p>)}</div> : null);
  return (
    <div className="mt-4 rounded-xl bg-[var(--inaya-overlay-5)] p-4 space-y-3">
      <p className={label}>How to pay</p>
      <p className="text-[13px] text-[var(--inaya-text-muted)]">{p.text}</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Lines title="NayaPay" o={p.nayapay} names={{ accountName: "Account name", nayapayId: "NayaPay ID", iban: "IBAN" }} />
        <Lines title="Bank transfer" o={p.bank} names={{ bankName: "Bank", accountTitle: "Account title", accountNumber: "Account number", iban: "IBAN", swift: "SWIFT / BIC", branch: "Branch" }} />
      </div>
      <p className="text-[13px] text-[var(--inaya-text-muted)]">After paying, email <a className="underline" href={`mailto:${p.contact}`}>{p.contact}</a> with your company name and the payment reference, or use Help &amp; Support.</p>
    </div>
  );
}

/** Billing: the company's license (Owner/Admin). */
export function LicenseCard({ orgId }) {
  const [d, setD] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { getJson(`/api/orgs/license?orgId=${orgId}`).then(setD).catch((e) => setErr(e.message)); }, [orgId]);
  if (err) return <p className="text-red-400 text-sm" role="alert">{err}</p>;
  if (!d) return <p className="text-[var(--inaya-text-muted)] text-sm">Loading your license…</p>;
  const l = d.license;
  return (
    <div className="space-y-4">
      {l && (
        <div className={card}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className={label}>Business Workspace license</p>
              <p className="text-[var(--inaya-text-primary)] text-xl font-extrabold">{l.plan?.name} <span className="text-[13px] font-normal text-[var(--inaya-text-muted)]">· {l.billingCycle === "yearly" ? "Yearly" : "Monthly"} · {money(l.amount, l.currency)} per {l.billingCycle === "yearly" ? "year" : "month"}</span></p>
            </div>
            <span className={`text-[13px] font-bold ${TONE[l.state] || ""}`}>● {l.label}{l.cancelling ? " (cancelling)" : ""}</span>
          </div>
          {l.state === "grace_period" && <p className="mt-3 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-[13px] text-[var(--inaya-text-primary)]">Your subscription payment is overdue. Your license will be suspended in <b>{l.graceRemaining}</b>, on <b>{l.graceEndsText}</b>, if payment is not confirmed. You can continue using Business Workspace during this grace period.</p>}
          {l.state === "suspended" && <p className="mt-3 rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-[13px] text-[var(--inaya-text-primary)]">Your Business Workspace license is suspended because payment was not received within the {d.policy.graceDays}-day grace period. You can use Billing, contact support and download your company data. Nothing has been deleted; access returns when payment is confirmed.</p>}
          {l.state === "pending_activation" && <p className="mt-3 text-[13px] text-[var(--inaya-text-muted)]">Your license is ready and starts as soon as your first payment is confirmed.</p>}
          {l.state === "active" && l.nextPaymentDueText && <p className="mt-3 text-[13px] text-[var(--inaya-text-muted)]">Your Business Workspace license is active. Your next payment is due on <b className="text-[var(--inaya-text-primary)]">{l.nextPaymentDueText}</b>.</p>}
          {l.cancelling && l.cancelEffectiveText && <p className="mt-2 text-[13px] text-[var(--inaya-text-muted)]">Cancelled: access continues until {l.cancelEffectiveText}.</p>}
          <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-[13px]">
            {[["Activated", l.activatedAt ? new Date(l.activatedAt).toLocaleDateString() : "—"], ["Paid until", l.paidThroughText || "—"], ["Next payment due", l.nextPaymentDueText || "—"], ["Last payment", calendarDay(l.lastPaymentAt)]].map(([k, v]) => (
              <div key={k}><dt className="text-[var(--inaya-text-muted)] text-[12px]">{k}</dt><dd className="text-[var(--inaya-text-primary)] font-semibold">{v}</dd></div>
            ))}
          </dl>
          <p className="mt-2 text-[11px] text-[var(--inaya-text-muted)]">Payments are due by the end of the due date ({d.policy.timezone}). A missed payment has {d.policy.graceDays} days of grace with normal access.</p>
          <PaymentInstructions p={d.paymentInstructions} />
        </div>
      )}
      {l && (
        <div className={card}>
          <p className={label}>Payment history</p>
          {d.payments.length === 0 ? <p className="text-[13px] text-[var(--inaya-text-muted)] mt-2">No payments recorded yet.</p> : (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-[13px]">
                <thead className="text-[var(--inaya-text-muted)] text-left"><tr><th className="py-1 pr-3">Received</th><th className="py-1 pr-3">Amount</th><th className="py-1 pr-3">Method</th><th className="py-1 pr-3">Reference</th><th className="py-1 pr-3">Covers until</th><th className="py-1">Status</th></tr></thead>
                <tbody>{d.payments.map((p) => <tr key={p.id} className="border-t border-[var(--inaya-overlay-5)] text-[var(--inaya-text-primary)]"><td className="py-1 pr-3">{p.receivedAt ? calendarDay(p.receivedAt) : p.confirmedAt ? new Date(p.confirmedAt).toLocaleDateString() : "—"}</td><td className="py-1 pr-3">{money(p.amount, p.currency)}</td><td className="py-1 pr-3">{p.method}</td><td className="py-1 pr-3 font-mono">{p.reference || "—"}</td><td className="py-1 pr-3">{p.periodTo || "—"}</td><td className="py-1">{p.status === "confirmed" ? "Confirmed" : p.status === "reversed" ? "Reversed" : p.status === "reversal" ? "Correction" : p.status}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <ExportSection orgId={orgId} exports={d.exports} />
    </div>
  );
}

function DocumentDownloads({ orgId }) {
  const [docs, setDocs] = useState(null); const [passkey, setPasskey] = useState(""); const [busy, setBusy] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { getJson(`/api/orgs/license/documents?orgId=${orgId}`).then((d) => setDocs(d.documents)).catch((e) => setErr(e.message)); }, [orgId]);
  async function download(doc) {
    if (!passkey) { setErr("Enter your company passkey first."); return; }
    setBusy(doc.id); setErr("");
    try {
      const info = await getJson(`/api/orgs/documents/${doc.id}/retrieve?orgId=${orgId}`);
      const [a, b] = info.chunked ? [info.chunked.alpha, info.chunked.beta] : await Promise.all([fetchShardFromIPFS(info.cidAlpha), fetchShardFromIPFS(info.cidBeta)]);
      await saveDocument(a, b, passkey, info.filename || doc.filename);
    } catch (e) { setErr(e.message || "Could not decrypt: check the passkey."); } finally { setBusy(""); }
  }
  return (
    <div className={card}>
      <p className={label}>Download documents</p>
      <p className="text-[13px] text-[var(--inaya-text-muted)] mt-1 mb-3">Documents are encrypted with your company passkey on your own device, so they are decrypted here in your browser. Inaya never sees the passkey or the files.</p>
      <label className="block text-[12px] text-[var(--inaya-text-muted)] mb-3 max-w-sm">Company passkey<input type="password" autoComplete="off" value={passkey} onChange={(e) => setPasskey(e.target.value)} className="mt-1 w-full rounded-lg bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-3 py-2 text-[var(--inaya-text-primary)]" /></label>
      {err && <p className="text-red-400 text-[13px] mb-2" role="alert">{err}</p>}
      {!docs ? <p className="text-[13px] text-[var(--inaya-text-muted)]">Loading…</p> : docs.length === 0 ? <p className="text-[13px] text-[var(--inaya-text-muted)]">No documents.</p> : (
        <ul className="divide-y divide-[var(--inaya-overlay-5)] text-[13px] max-h-96 overflow-y-auto">
          {docs.map((doc) => <li key={doc.id} className="py-2 flex items-center justify-between gap-2"><span className="text-[var(--inaya-text-primary)] break-all">{doc.filename}<span className="block text-[11px] text-[var(--inaya-text-muted)]">{[doc.department, doc.project].filter(Boolean).join(" / ")}</span></span><button className={ghost} disabled={!!busy} onClick={() => download(doc)}>{busy === doc.id ? "Decrypting…" : "Download"}</button></li>)}
        </ul>
      )}
    </div>
  );
}

/** Shown instead of the Workspace when the company's license is suspended, cancelled or expired. */
export function RestrictedWorkspace({ orgId, status, orgName, onHelp }) {
  const what = status?.state === "cancelled" ? "cancelled" : status?.state === "expired" ? "expired" : "suspended";
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className={card} role="alert">
        <p className="text-[var(--inaya-text-primary)] text-xl font-extrabold">{orgName ? `${orgName}: ` : ""}Business Workspace is {what}</p>
        {status?.isManager ? (
          <p className="text-[14px] text-[var(--inaya-text-muted)] mt-2">{what === "suspended" ? "Your license is suspended because payment was not received within the grace period." : `Your license is ${what}.`} You can still use Billing, contact support and download all your company data below. Nothing has been deleted, and access returns as soon as payment is confirmed.</p>
        ) : (
          <p className="text-[14px] text-[var(--inaya-text-muted)] mt-2">Your company's Business Workspace access is paused. Please contact your company's owner or admin.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2"><button className={ghost} onClick={onHelp}>Contact Inaya support</button></div>
      </div>
      {status?.isManager && <><LicenseCard orgId={orgId} /><DocumentDownloads orgId={orgId} /></>}
    </div>
  );
}
