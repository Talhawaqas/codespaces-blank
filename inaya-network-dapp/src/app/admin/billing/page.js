"use client";

// app/admin/billing/page.js
//
// PKR package requests (companies in Pakistan pay by bank transfer). Send the
// invoice, and once the transfer arrives, activate the request here: the
// company's plan switches on for the months paid and they get an email.

import { useCallback, useEffect, useState } from "react";

const PLAN_NAMES = { starter: "Starter", professional: "Professional", business: "Business", enterprise: "Enterprise" };
const pkr = (n) => `PKR ${Math.round(n || 0).toLocaleString("en-US")}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

function RequestRow({ r, onDone }) {
  const [months, setMonths] = useState(r.interval === "year" ? 12 : 1);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  async function emailInvoiceNow() {
    if (!window.confirm(`Email an invoice for ${Number(months) || 1} month(s) to ${r.requestedByEmail}?`)) return;
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      const res = await fetch("/api/admin/billing-invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "email", requestId: r.id, months: Number(months) || 1 }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed.");
      setInfo(`Invoice ${data.invoice.number} emailed to ${data.invoice.emailedTo}.`);
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function act(action) {
    if (action === "decline" && !window.confirm(`Decline the request from ${r.orgName || r.orgId}?`)) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/admin/billing-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, requestId: r.id, months: Number(months), paymentReference: reference }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed.");
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-white/5 align-top">
      <td className="py-3 pr-3">
        <p className="text-white font-bold">{r.orgName || "(no name)"}</p>
        <p className="text-[#8a96ab] font-mono text-[11px]">{r.orgId}</p>
        <p className="text-[#8a96ab] text-[11px]">{r.requestedByEmail}</p>
      </td>
      <td className="py-3 pr-3">
        <p className="text-white">{PLAN_NAMES[r.planId] || r.planId}{r.extraUsers ? ` + ${r.extraUsers} extra users` : ""}</p>
        {r.addOns && Object.keys(r.addOns).length > 0 && <p className="text-[#d4a537] text-[11px]">Add-ons: {Object.entries(r.addOns).map(([k, v]) => (k === "storageTB" ? `${v} TB storage` : k)).join(", ")}</p>}
        {r.contact && <p className="text-[#8a96ab] text-[11px]">{r.contact.name} · {r.contact.phone} · prefers {r.contact.preferredContact}{r.contact.companySize ? ` · ${r.contact.companySize} people` : ""}</p>}
        <p className="text-[#8a96ab] text-[11px]">{r.paymentMethod === "nayapay" ? "NayaPay" : "Bank transfer"}</p>
        <p className="text-[#8a96ab] text-[11px]">{r.currency === "USD" ? `$${Number(r.amountUsd || 0).toLocaleString("en-US")}` : pkr(r.amountPkr)} per {r.interval}{r.pilot ? " · pilot (30% off)" : ""}{r.setupFeePkr ? ` · setup ${pkr(r.setupFeePkr)} once` : r.setupFeeReason === "promised_in_outreach" ? " · setup free (promised in our first emails)" : r.setupFeeReason === "first_five" ? " · setup free (first 5 pilot companies)" : ""}</p>
      </td>
      <td className="py-3 pr-3 text-[#94a3b8] text-[12px]">{when(r.requestedAt)}</td>
      <td className="py-3">
        {r.status === "pending" ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[11px] text-[#94a3b8]">Months paid
                <input type="number" min="1" max="24" value={months} onChange={(e) => setMonths(e.target.value)} className="ml-1 w-14 bg-black/30 border border-white/10 rounded px-2 py-1 text-white" />
              </label>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bank reference (optional)" className="w-44 bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-[12px]" />
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={`/api/admin/billing-invoices?preview=${r.id}&months=${Number(months) || 1}`} target="_blank" rel="noreferrer" className="text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-[#e2e8f0] px-3 py-1.5 rounded">Preview invoice</a>
              <button onClick={emailInvoiceNow} disabled={busy} className="text-[11px] font-bold uppercase bg-[#00f2fe] text-black px-3 py-1.5 rounded disabled:opacity-50">{busy ? "Working…" : r.invoices?.length ? "Email invoice again" : "Email invoice"}</button>
            </div>
            {r.invoices?.length > 0 && (
              <p className="text-[#8a96ab] text-[11px]">Invoiced: {r.invoices.map((i) => `${i.number} (${i.issuedAt.slice(0, 10)})`).join(", ")}</p>
            )}
            <div className="flex gap-2">
              <button onClick={() => act("activate")} disabled={busy} className="text-[11px] font-bold uppercase bg-emerald-500 text-black px-3 py-1.5 rounded disabled:opacity-50">{busy ? "Working…" : "Payment received: activate"}</button>
              <button onClick={() => act("decline")} disabled={busy} className="text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-[#94a3b8] px-3 py-1.5 rounded">Decline</button>
            </div>
            {info && <p className="text-emerald-400 text-[11px]">{info}</p>}
            {err && <p className="text-red-400 text-[11px]">{err}</p>}
          </div>
        ) : (
          <div className="text-[12px]">
            <p className={r.status === "active" ? "text-emerald-400 font-bold" : "text-[#94a3b8]"}>{r.status}</p>
            {r.paidUntil && <p className="text-[#8a96ab]">paid until {r.paidUntil.slice(0, 10)}</p>}
            {r.paymentReference && <p className="text-[#8a96ab]">ref {r.paymentReference}</p>}
          </div>
        )}
      </td>
    </tr>
  );
}

const CHANNEL_FIELDS = {
  issuer: [["name", "Your business name (on the invoice)"], ["address", "Address"], ["email", "Email for questions"], ["phone", "Phone"]],
  bank: [["bankName", "Bank name"], ["accountTitle", "Account title"], ["accountNumber", "Account number"], ["iban", "IBAN"], ["swift", "SWIFT / BIC (for payments from abroad)"], ["branch", "Branch"]],
  nayapay: [["accountName", "NayaPay account name"], ["nayapayId", "NayaPay ID or number"], ["iban", "NayaPay IBAN"]],
};

function PaymentDetails() {
  const [channels, setChannels] = useState(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch("/api/admin/billing-invoices").then((r) => r.json()).then((d) => { if (d.channels) { setChannels(d.channels); if (!d.channels.updatedAt) setOpen(true); } }).catch(() => {});
  }, []);

  if (!channels) return null;
  const set = (group, key) => (e) => setChannels((c) => ({ ...c, [group]: { ...c[group], [key]: e.target.value } }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/billing-invoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "saveChannels", channels }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not save.");
      setChannels(d.channels);
      setMsg("Saved. New invoices use these details.");
    } catch (err) {
      setMsg(err.message);
    } finally {
      setSaving(false);
    }
  }

  const input = "w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-white text-[12px]";
  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4 mb-6">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
        <span className="text-white text-sm font-bold">Payment details for invoices</span>
        <span className="text-[#94a3b8] text-[11px]">{channels.updatedAt ? `saved ${channels.updatedAt.slice(0, 10)}` : "not set yet"} · {open ? "hide" : "edit"}</span>
      </button>
      {open && (
        <form onSubmit={save} className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          {[["issuer", "On every invoice"], ["bank", "Bank transfer"], ["nayapay", "NayaPay"]].map(([group, title]) => (
            <div key={group} className="space-y-2">
              <p className="text-[#00f2fe] text-[11px] font-bold uppercase tracking-wide">{title}</p>
              {CHANNEL_FIELDS[group].map(([key, label]) => (
                <label key={key} className="block text-[11px] text-[#94a3b8]">{label}
                  <input value={channels[group][key]} onChange={set(group, key)} className={input} />
                </label>
              ))}
            </div>
          ))}
          <label className="md:col-span-3 block text-[11px] text-[#94a3b8]">Note printed under the payment details (optional)
            <input value={channels.note} onChange={(e) => setChannels((c) => ({ ...c, note: e.target.value }))} className={input} />
          </label>
          <div className="md:col-span-3 flex items-center gap-3">
            <button disabled={saving} className="text-[11px] font-bold uppercase bg-[#00f2fe] text-black px-4 py-2 rounded disabled:opacity-50">{saving ? "Saving…" : "Save payment details"}</button>
            {msg && <span className="text-[11px] text-[#94a3b8]">{msg}</span>}
          </div>
        </form>
      )}
    </div>
  );
}

export default function BillingRequestsAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  // The admin layout (app/admin/layout.js) only renders this page once the session is valid.
  const [authed, setAuthed] = useState(true);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/admin/billing-requests");
      if (res.status === 401) { setAuthed(false); return; }
      if (!res.ok) throw new Error("Could not load requests.");
      setRows((await res.json()).requests);
      setAuthed(true);
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLoginError(data.error || "Login failed.");
        return;
      }
      setPassphrase("");
      await load();
    } catch {
      setLoginError("Login failed.");
    } finally {
      setLoading(false);
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Billing requests</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase</p>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none mb-3" placeholder="Passphrase" autoFocus />
          {loginError && <p className="text-red-400 text-xs mb-3">{loginError}</p>}
          <button type="submit" disabled={loading} className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5 disabled:opacity-50">{loading ? "Checking…" : "Sign in"}</button>
        </form>
      </div>
    );
  }

  const pending = (rows || []).filter((r) => r.status === "pending");
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-5xl mx-auto">
        <a href="/admin" className="text-[#94a3b8] hover:text-slate-300 text-xs font-mono">← Admin</a>
        <h1 className="text-2xl font-extrabold text-white mt-2">Billing requests and invoices</h1>
        <p className="text-[#94a3b8] text-sm mt-1 mb-6">
          Companies (USD and PKR) pay by NayaPay or bank transfer. Save your payment details once, then press Email invoice: the invoice is numbered, generated as a PDF with the details for the customer&apos;s payment method, and emailed to them. When the payment arrives, enter the months paid and activate; the company is emailed when its package is active.
        </p>
        <PaymentDetails />
        {loadError && <p className="text-red-400 text-sm mb-4">{loadError}</p>}
        <p className="text-white text-sm font-bold mb-2">{pending.length} waiting for payment</p>
        <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4 overflow-x-auto">
          {!rows ? <p className="text-[#94a3b8] text-sm">Loading…</p> : rows.length === 0 ? <p className="text-[#94a3b8] text-sm">No requests yet.</p> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[#8a96ab]">
                  <th className="pb-2 pr-3">Company</th><th className="pb-2 pr-3">Package</th><th className="pb-2 pr-3">Requested</th><th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>{rows.map((r) => <RequestRow key={r.id} r={r} onDone={load} />)}</tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
