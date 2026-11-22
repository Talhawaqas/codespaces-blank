"use client";

// app/admin/licenses/page.js -- License Manager (Business Workspace company licenses, License Manager SOW section 6).
// Dashboard counters, a searchable / filterable / paged license register, assigning a license, and one company's
// license with every action (payments, renewals, plan and cycle changes, grace extension, suspension, override,
// cancellation, notes) and its full history. High-impact actions show current -> proposed values and need a confirm.
// Everything is read from and written through /api/admin/licenses (src/lib/licensing/*).

import { useCallback, useEffect, useMemo, useState } from "react";

const input = "bg-black/30 border border-white/10 rounded px-2 py-1.5 text-white text-[12px] w-full";
const btn = "px-3 py-1.5 rounded text-[12px] font-bold disabled:opacity-40";
const primary = `${btn} bg-[#00f2fe] text-black`;
const ghost = `${btn} border border-white/15 text-[#cbd5e1] hover:bg-white/5`;
const danger = `${btn} border border-red-400/40 text-red-300 hover:bg-red-500/10`;
const STATUS_STYLE = { active: "text-emerald-300", admin_override: "text-emerald-300", grace_period: "text-amber-300", pending_activation: "text-sky-300", suspended: "text-red-300", cancelled: "text-[#94a3b8]", expired: "text-[#94a3b8]" };
const money = (a, c) => (a == null ? "—" : c === "PKR" ? `PKR ${Number(a).toLocaleString("en-US")}` : `$${Number(a).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const day = (v) => (v ? String(v).slice(0, 10) : "—");
const today = () => new Date().toISOString().slice(0, 10);

async function api(url, opts) {
  const res = await fetch(url, opts ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) } : { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function Card({ label, value, tone = "text-white" }) {
  return <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-3"><p className="text-[#94a3b8] text-[11px]">{label}</p><p className={`text-xl font-bold ${tone}`}>{value ?? "—"}</p></div>;
}

export default function LicenseManagerPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [filters, setFilters] = useState({ status: "", cycle: "", plan: "", currency: "", method: "", q: "", dueFrom: "", dueTo: "", renewalsWithinDays: "" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [assigning, setAssigning] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const qs = useMemo(() => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v); return p; }, [filters]);

  const load = useCallback(async () => {
    setErr("");
    try { const p = new URLSearchParams(qs); p.set("page", String(page)); p.set("pageSize", "25"); setData(await api(`/api/admin/licenses?${p}`)); }
    catch (e) { setErr(e.message); }
  }, [qs, page]);
  useEffect(() => { load(); }, [load]);

  const s = data?.summary;
  const set = (k) => (e) => { setPage(1); setFilters((f) => ({ ...f, [k]: e.target.value })); };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-white text-xl font-bold">License Manager</h1>
          <p className="text-[#94a3b8] text-xs">One license per company. Payments are confirmed here; a missed payment gets 14 days of grace.{s && !s.autoSuspend ? " Automatic suspension is OFF (dry run): overdue companies keep access until it is switched on." : ""}</p>
        </div>
        <div className="flex gap-2">
          <a className={ghost} href={`/api/admin/licenses/export?${qs}`}>Export Excel (.xlsx)</a>
          <button className={ghost} onClick={() => setMigrating(true)}>Launch migration</button>
          <button className={primary} onClick={() => setAssigning(true)}>Assign a license</button>
        </div>
      </div>
      {err && <p className="text-red-300 text-sm" role="alert">{err}</p>}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Card label="Companies with a license" value={s.total} />
          <Card label="Active" value={s.active} tone="text-emerald-300" />
          <Card label="Awaiting first payment" value={s.pendingActivation} tone="text-sky-300" />
          <Card label="Payment overdue (grace)" value={s.gracePeriod} tone="text-amber-300" />
          <Card label="Suspended" value={s.suspended} tone="text-red-300" />
          <Card label="Cancelled / expired" value={s.cancelledOrExpired} />
          <Card label="Monthly" value={s.monthly} /><Card label="Yearly" value={s.yearly} />
          <Card label={`Renewals due in ${s.renewalDays} days`} value={s.renewalsDue} />
          <Card label="Would be suspended (dry run)" value={s.suspensionDue} tone={s.suspensionDue ? "text-red-300" : "text-white"} />
          <Card label="Needs review" value={s.needsReview} tone={s.needsReview ? "text-amber-300" : "text-white"} />
        </div>
      )}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-3 grid grid-cols-2 md:grid-cols-5 lg:grid-cols-9 gap-2 text-[11px] text-[#94a3b8]">
        <label className="col-span-2">Search (company, id, license)<input className={input} value={filters.q} onChange={set("q")} placeholder="Acme or 6af..." /></label>
        <label>Status<select className={input} value={filters.status} onChange={set("status")}><option value="">All</option><option value="active">Active</option><option value="pending_activation">Awaiting payment</option><option value="grace_period">Overdue (grace)</option><option value="suspended">Suspended</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option><option value="admin_override">Override</option></select></label>
        <label>Cycle<select className={input} value={filters.cycle} onChange={set("cycle")}><option value="">All</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        <label>Package<select className={input} value={filters.plan} onChange={set("plan")}><option value="">All</option>{(data?.plans || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Currency<select className={input} value={filters.currency} onChange={set("currency")}><option value="">All</option><option>USD</option><option>PKR</option></select></label>
        <label>Method<select className={input} value={filters.method} onChange={set("method")}><option value="">All</option><option value="nayapay">NayaPay</option><option value="bank_transfer">Bank transfer</option><option value="other_manual">Other</option></select></label>
        <label>Due from<input type="date" className={input} value={filters.dueFrom} onChange={set("dueFrom")} /></label>
        <label>Due to<input type="date" className={input} value={filters.dueTo} onChange={set("dueTo")} /></label>
        <label>Renewals within (days)<input type="number" min="1" className={input} value={filters.renewalsWithinDays} onChange={set("renewalsWithinDays")} /></label>
      </div>
      <div className="overflow-x-auto bg-[#090d16]/80 border border-white/5 rounded-xl">
        <table className="w-full text-[12px] text-left">
          <thead className="text-[#94a3b8]"><tr>{["Company", "Package", "Cycle", "Amount", "Status", "Activated", "Paid through", "Next due", "Grace ends", "Last payment", "Method", "Updated"].map((h) => <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody>
            {!data && !err && <tr><td className="px-3 py-6 text-[#94a3b8]" colSpan={12}>Loading…</td></tr>}
            {data?.rows?.length === 0 && <tr><td className="px-3 py-6 text-[#94a3b8]" colSpan={12}>No licenses match. Assign one to a company to start.</td></tr>}
            {data?.rows?.map((r) => (
              <tr key={r.licenseId} className="border-t border-white/5 hover:bg-white/5 cursor-pointer" onClick={() => setSelected(r.orgId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSelected(r.orgId)}>
                <td className="px-3 py-2 text-white"><span className="font-semibold">{r.companyName}</span><br /><span className="text-[10px] text-[#94a3b8]">{r.orgId}</span></td>
                <td className="px-3 py-2">{r.plan}</td><td className="px-3 py-2">{r.billingCycle}</td><td className="px-3 py-2 whitespace-nowrap">{money(r.amount, r.currency)}</td>
                <td className={`px-3 py-2 font-semibold whitespace-nowrap ${STATUS_STYLE[r.status] || ""}`}>{r.statusLabel}{r.suspensionDue ? " · suspension due" : ""}{r.needsReview ? " · review" : ""}</td>
                <td className="px-3 py-2">{day(r.activatedAt)}</td><td className="px-3 py-2">{day(r.paidThroughDate)}</td><td className="px-3 py-2">{day(r.nextPaymentDueDate)}</td>
                <td className="px-3 py-2">{r.status === "grace_period" ? day(r.graceEndsAt) : "—"}</td><td className="px-3 py-2">{day(r.lastPaymentAt)}</td><td className="px-3 py-2">{r.lastPaymentMethod || "—"}</td><td className="px-3 py-2">{day(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.pageSize && (
        <div className="flex items-center gap-3 text-[12px] text-[#94a3b8]">
          <button className={ghost} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span>Page {data.page} of {Math.ceil(data.total / data.pageSize)} · {data.total} licenses</span>
          <button className={ghost} disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
      {assigning && <AssignPanel plans={data?.plans || []} pk={data?.pkPackages || {}} onClose={() => setAssigning(false)} onDone={(orgId) => { setAssigning(false); load(); setSelected(orgId); }} />}
      {migrating && <MigrationPanel onClose={() => setMigrating(false)} onChanged={load} />}
      {selected && <LicenseDetail orgId={selected} plans={data?.plans || []} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function Panel({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-3xl h-full overflow-y-auto bg-[#0b1220] border-l border-white/10 p-5 space-y-4">
        <div className="flex items-center justify-between"><h2 className="text-white text-lg font-bold">{title}</h2><button className={ghost} onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}

function AssignPanel({ plans, pk, onClose, onDone }) {
  const [q, setQ] = useState(""); const [companies, setCompanies] = useState([]); const [org, setOrg] = useState(null);
  const [f, setF] = useState({ planId: "professional", billingCycle: "monthly", currency: "USD", amount: "", startDate: today(), first: "awaiting", method: "bank_transfer", reference: "", receivedAt: today(), note: "" });
  const [step, setStep] = useState("form"); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const plan = plans.find((p) => p.id === f.planId);
  const suggested = f.currency === "USD" ? (f.billingCycle === "yearly" ? plan?.priceYearlyUsd : plan?.priceMonthlyUsd) : (f.billingCycle === "yearly" ? pk[f.planId]?.yearly : pk[f.planId]?.monthly);
  useEffect(() => { const t = setTimeout(() => { api(`/api/admin/licenses?companies=${encodeURIComponent(q)}`).then((d) => setCompanies(d.companies || [])).catch(() => {}); }, 250); return () => clearTimeout(t); }, [q]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function submit() {
    setBusy(true); setErr("");
    try {
      await api(`/api/admin/licenses/${org.orgId}`, { action: "assign", confirm: true, idempotencyKey: `${org.orgId}:${f.startDate}:${f.planId}`, planId: f.planId, billingCycle: f.billingCycle, currency: f.currency, amount: Number(f.amount || suggested), startDate: f.startDate, note: f.note || null, firstPayment: f.first === "confirmed" ? { status: "confirmed", method: f.method, reference: f.reference, receivedAt: f.receivedAt } : { status: "awaiting" } });
      onDone(org.orgId);
    } catch (e) { setErr(e.message); setStep("form"); } finally { setBusy(false); }
  }
  return (
    <Panel title="Assign a license" onClose={onClose}>
      {!org ? (
        <div className="space-y-2">
          <label className="text-[11px] text-[#94a3b8] block">Find the company (name or id)<input className={input} value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></label>
          <ul className="divide-y divide-white/5 border border-white/5 rounded">
            {companies.map((c) => (
              <li key={c.orgId} className="p-2 flex items-center justify-between text-[12px]">
                <span className="text-white">{c.name}<br /><span className="text-[10px] text-[#94a3b8]">{c.orgId} · {c.ownerEmail || "no owner email"}</span></span>
                {c.licenseId && !["cancelled", "expired"].includes(c.licenseStatus) ? <span className="text-[#94a3b8]">has a license ({c.licenseStatus})</span> : <button className={ghost} onClick={() => setOrg(c)}>Select</button>}
              </li>
            ))}
            {companies.length === 0 && <li className="p-2 text-[12px] text-[#94a3b8]">No companies found.</li>}
          </ul>
        </div>
      ) : step === "form" ? (
        <div className="space-y-3 text-[11px] text-[#94a3b8]">
          <p className="text-white text-sm">{org.name} <span className="text-[#94a3b8] text-[11px]">({org.orgId})</span> <button className="underline ml-2" onClick={() => setOrg(null)}>change</button></p>
          <div className="grid grid-cols-2 gap-3">
            <label>Package<select className={input} value={f.planId} onChange={set("planId")}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Billing cycle<select className={input} value={f.billingCycle} onChange={set("billingCycle")}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
            <label>Currency<select className={input} value={f.currency} onChange={set("currency")}><option>USD</option><option>PKR</option></select></label>
            <label>Agreed amount per {f.billingCycle === "yearly" ? "year" : "month"} (price book: {suggested ?? "—"}; pilot prices are honoured)<input type="number" min="0" step="0.01" className={input} value={f.amount} placeholder={String(suggested ?? "")} onChange={set("amount")} /></label>
            <label>Start date (PKT)<input type="date" className={input} value={f.startDate} onChange={set("startDate")} /></label>
            <label>First period<select className={input} value={f.first} onChange={set("first")}><option value="awaiting">Awaiting payment (company not active yet)</option><option value="confirmed">Already paid: record and confirm the payment</option></select></label>
            {f.first === "confirmed" && <>
              <label>Method<select className={input} value={f.method} onChange={set("method")}><option value="bank_transfer">Bank transfer</option><option value="nayapay">NayaPay</option><option value="other_manual">Other (manual)</option></select></label>
              <label>Reference / transaction id<input className={input} value={f.reference} onChange={set("reference")} /></label>
              <label>Received on<input type="date" className={input} value={f.receivedAt} onChange={set("receivedAt")} /></label>
            </>}
            <label className="col-span-2">Internal note (never shown to the company)<input className={input} value={f.note} onChange={set("note")} /></label>
          </div>
          {err && <p className="text-red-300 text-sm" role="alert">{err}</p>}
          <button className={primary} onClick={() => setStep("review")} disabled={!f.startDate || (f.first === "confirmed" && f.method !== "other_manual" && f.reference.length < 3)}>Review</button>
        </div>
      ) : (
        <div className="space-y-3 text-[12px] text-[#cbd5e1]">
          <p className="text-white font-bold">Check before assigning</p>
          <ul className="space-y-1">
            <li>Company: <b>{org.name}</b></li><li>Package: <b>{plan?.name}</b>, {f.billingCycle}</li><li>Amount: <b>{money(f.amount || suggested, f.currency)}</b> per {f.billingCycle === "yearly" ? "year" : "month"}</li>
            <li>Start: <b>{f.startDate}</b></li>
            <li>First period: <b>{f.first === "confirmed" ? `paid (${{ bank_transfer: "Bank transfer", nayapay: "NayaPay", other_manual: "Other (manual)" }[f.method]}, ref ${f.reference || "—"}) — the company becomes active now` : "awaiting payment — the company stays inactive until a payment is confirmed"}</b></li>
          </ul>
          <div className="flex gap-2"><button className={ghost} onClick={() => setStep("form")}>Back</button><button className={primary} onClick={submit} disabled={busy}>{busy ? "Assigning…" : "Confirm and assign"}</button></div>
        </div>
      )}
    </Panel>
  );
}

function LicenseDetail({ orgId, plans, onClose, onChanged }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false); const [form, setForm] = useState(null);
  const load = useCallback(async () => { setErr(""); try { setD(await api(`/api/admin/licenses/${orgId}`)); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  const lic = d?.license;
  async function act(body, summary) {
    if (summary && !window.confirm(summary)) return;
    setBusy(true); setErr(""); setMsg("");
    try { await api(`/api/admin/licenses/${orgId}`, { ...body, confirm: true }); setMsg("Saved."); setForm(null); await load(); onChanged(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const pending = (d?.history?.payments || []).filter((p) => p.paymentStatus === "pending");
  const confirmed = (d?.history?.payments || []).filter((p) => p.paymentStatus === "confirmed");
  const F = (k) => (e) => setForm((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Panel title={d ? `${d.company.name}` : "License"} onClose={onClose}>
      {err && <p className="text-red-300 text-sm" role="alert">{err}</p>}
      {msg && <p className="text-emerald-300 text-sm" role="status">{msg}</p>}
      {d?.company?.addons && <div className="bg-black/20 border border-white/10 rounded p-3 text-[12px] space-y-1.5">
        <p className="text-[#94a3b8] text-[10px] uppercase">Paid add-ons</p>
        {d.company.addons.map((a) => <div key={a.key} className="flex items-center gap-2"><span className="flex-1 text-white">{a.label}: <b className={a.enabled ? "text-emerald-300" : "text-[#94a3b8]"}>{a.enabled ? "on" : "off"}</b></span>
          <button className={a.enabled ? danger : primary} disabled={busy} onClick={() => { const reason = window.prompt(a.enabled ? `Reason for switching ${a.label} off (customers keep their data):` : `Reason / invoice reference for switching ${a.label} on:`); if (reason) act({ action: "set_addon", addon: a.key, enabled: !a.enabled, reason }, `${a.enabled ? "Switch off" : "Switch on"} ${a.label} for ${d.company.name}?`); }}>{a.enabled ? "Switch off" : "Switch on"}</button></div>)}
      </div>}
      {!d ? <p className="text-[#94a3b8] text-sm">Loading…</p> : !lic ? (
        <p className="text-[#94a3b8] text-sm">This company has no license yet. Use "Assign a license".</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[12px]">
            {[["Status", <span key="s" className={`font-bold ${STATUS_STYLE[lic.status] || ""}`}>{lic.stateLabel}{lic.suspensionDue ? " (suspension due — dry run)" : ""}</span>], ["Package", `${lic.plan} (${lic.billingCycle})`], ["Amount", money(lic.amount, lic.currency)], ["Paid through", day(lic.paidThroughDate)], ["Next payment due", day(lic.nextPaymentDueDate)], ["Deadline", lic.deadlineText || "—"], ["Activated", day(lic.activatedAt)], ["Last payment", `${day(lic.lastPaymentAt)} ${lic.lastPaymentMethod || ""}`], ["Grace extension", `${lic.graceExtensionDays} days`], ["License id", lic.licenseId], ["Billing contacts", d.company.billingContacts.map((c) => c.email).join(", ") || "none"], ["Pending change", lic.pendingChange ? `${lic.pendingChange.planId} / ${lic.pendingChange.billingCycle} / ${lic.pendingChange.amount} at next renewal` : "—"]].map(([k, v]) => (
              <div key={k} className="bg-black/20 rounded p-2"><p className="text-[#94a3b8] text-[10px]">{k}</p><div className="text-white break-words">{v}</div></div>
            ))}
          </div>
          {lic.needsReview && <p className="text-amber-300 text-[12px]">Needs review: a payment that was not the latest renewal was reversed. Check the paid-through date.</p>}

          <div className="flex flex-wrap gap-2">
            <button className={primary} onClick={() => setForm({ kind: "payment", method: "bank_transfer", amount: d.renewalPreview?.expectedAmount ?? lic.amount, periods: 1, reference: "", receivedAt: today() })}>Record a payment</button>
            <button className={ghost} onClick={() => setForm({ kind: "change", planId: lic.planId, billingCycle: lic.billingCycle, amount: lic.amount, applyAt: "now", reason: "" })}>Change package / cycle / amount</button>
            <button className={ghost} onClick={() => setForm({ kind: "extend", days: 7, reason: "" })}>Extend grace</button>
            {lic.status !== "suspended" ? <button className={danger} onClick={() => setForm({ kind: "suspend", reason: "" })}>Suspend</button> : <button className={ghost} onClick={() => setForm({ kind: "reactivate", reason: "", untilDate: "" })}>Reactivate without payment</button>}
            <button className={danger} onClick={() => setForm({ kind: "cancel", reason: "", immediate: false })}>Cancel</button>
            <button className={ghost} onClick={() => setForm({ kind: "note", text: "" })}>Add note</button>
          </div>

          {form && (
            <div className="bg-black/30 border border-white/10 rounded p-3 space-y-2 text-[11px] text-[#94a3b8]">
              {form.kind === "payment" && <>
                <div className="grid grid-cols-2 gap-2">
                  <label>Amount ({lic.currency})<input type="number" step="0.01" className={input} value={form.amount} onChange={F("amount")} /></label>
                  <label>Periods paid<input type="number" min="1" max="12" className={input} value={form.periods} onChange={F("periods")} /></label>
                  <label>Method<select className={input} value={form.method} onChange={F("method")}><option value="bank_transfer">Bank transfer</option><option value="nayapay">NayaPay</option><option value="other_manual">Other (manual)</option></select></label>
                  <label>Reference / transaction id<input className={input} value={form.reference} onChange={F("reference")} /></label>
                  <label>Received on<input type="date" className={input} value={form.receivedAt} onChange={F("receivedAt")} /></label>
                </div>
                <p>Recorded as <b>pending</b>. It changes nothing until you confirm it below.</p>
                <button className={primary} disabled={busy} onClick={() => act({ action: "record_payment", amount: Number(form.amount), currency: lic.currency, method: form.method, reference: form.reference, receivedAt: form.receivedAt, periods: Number(form.periods), idempotencyKey: `${orgId}:${form.method}:${form.reference}` })}>Record (pending)</button>
              </>}
              {form.kind === "change" && <>
                <div className="grid grid-cols-2 gap-2">
                  <label>Package<select className={input} value={form.planId} onChange={F("planId")}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                  <label>Cycle<select className={input} value={form.billingCycle} onChange={F("billingCycle")}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
                  <label>Agreed amount per period<input type="number" step="0.01" className={input} value={form.amount} onChange={F("amount")} /></label>
                  <label>When<select className={input} value={form.applyAt} onChange={F("applyAt")}><option value="now">Now (package limits change today)</option><option value="next_renewal">At the next renewal</option></select></label>
                  <label className="col-span-2">Reason<input className={input} value={form.reason} onChange={F("reason")} /></label>
                </div>
                <button className={primary} disabled={busy} onClick={() => act({ action: "change", planId: form.planId, billingCycle: form.billingCycle, amount: Number(form.amount), applyAt: form.applyAt, reason: form.reason }, `Change ${lic.plan} / ${lic.billingCycle} / ${money(lic.amount, lic.currency)}\n→ ${form.planId} / ${form.billingCycle} / ${money(form.amount, lic.currency)} (${form.applyAt === "now" ? "now" : "at the next renewal"})?\nNo payment is recorded and nothing is prorated.`)}>Review and save</button>
              </>}
              {form.kind === "extend" && <><label>Extra days (1–30)<input type="number" min="1" max="30" className={input} value={form.days} onChange={F("days")} /></label><label>Reason<input className={input} value={form.reason} onChange={F("reason")} /></label>
                <button className={primary} disabled={busy} onClick={() => act({ action: "extend_grace", days: Number(form.days), reason: form.reason }, `Extend the grace period by ${form.days} days (current deadline: ${lic.deadlineText || day(lic.graceEndsAt)})?`)}>Review and extend</button></>}
              {form.kind === "suspend" && <><label>Reason (recorded)<input className={input} value={form.reason} onChange={F("reason")} /></label>
                <button className={danger} disabled={busy} onClick={() => act({ action: "suspend", reason: form.reason }, `Suspend ${d.company.name} now? Normal access stops; Billing and data export stay available. Nothing is deleted.`)}>Suspend now</button></>}
              {form.kind === "reactivate" && <><label>Access until (at most 30 days)<input type="date" className={input} value={form.untilDate} onChange={F("untilDate")} /></label><label>Reason (recorded)<input className={input} value={form.reason} onChange={F("reason")} /></label>
                <button className={primary} disabled={busy} onClick={() => act({ action: "reactivate", reason: form.reason, untilDate: form.untilDate }, `Restore access without a payment until ${form.untilDate}?`)}>Reactivate</button></>}
              {form.kind === "cancel" && <><label>Reason (recorded)<input className={input} value={form.reason} onChange={F("reason")} /></label><label className="flex items-center gap-2"><input type="checkbox" checked={form.immediate} onChange={(e) => setForm((x) => ({ ...x, immediate: e.target.checked }))} />End access immediately (otherwise at the paid-through date {day(lic.paidThroughDate)})</label>
                <button className={danger} disabled={busy} onClick={() => act({ action: "cancel", reason: form.reason, immediate: form.immediate }, `Cancel ${d.company.name}'s license ${form.immediate ? "now" : `at the end of ${day(lic.paidThroughDate)}`}? Company data is kept; Billing and export stay available.`)}>Cancel license</button></>}
              {form.kind === "note" && <><label>Internal note<input className={input} value={form.text} onChange={F("text")} /></label><button className={primary} disabled={busy} onClick={() => act({ action: "note", text: form.text })}>Add note</button></>}
              <button className={ghost} onClick={() => setForm(null)}>Close</button>
            </div>
          )}

          <Section title="Pending payments">
            {pending.length === 0 ? <Empty /> : pending.map((p) => (
              <Row key={p._id}>
                <span>{money(p.amount, p.currency)} · {p.method} · ref {p.reference || "—"} · {p.periods} period(s) · received {day(p.receivedAt)}</span>
                <span className="flex gap-2">
                  <button className={primary} disabled={busy} onClick={async () => { const pv = await api(`/api/admin/licenses/${orgId}`, { action: "preview_renewal", periods: p.periods }); const reason = Math.abs(pv.preview.expectedAmount - p.amount) > 0.005 ? window.prompt(`Expected ${pv.preview.expectedAmount}; received ${p.amount}. Reason to accept a different amount:`) : null; act({ action: "confirm_payment", paymentId: p._id, adjustmentReason: reason }, `Confirm ${money(p.amount, p.currency)}?\nPaid through ${day(lic.paidThroughDate)} → ${pv.preview.newPaidThroughDate}.\nThe company becomes active if it was overdue or suspended.`); }}>Confirm</button>
                  <button className={ghost} disabled={busy} onClick={() => { const r = window.prompt("Reason for rejecting this payment:"); if (r) act({ action: "reject_payment", paymentId: p._id, reason: r }); }}>Reject</button>
                </span>
              </Row>
            ))}
          </Section>
          <Section title="Confirmed payments">
            {confirmed.length === 0 ? <Empty /> : confirmed.map((p) => (
              <Row key={p._id}><span>{money(p.amount, p.currency)} · {p.method} · ref {p.reference || "—"} · confirmed {day(p.confirmedAt)} by {p.confirmedBy} · {p.renewal ? `${p.renewal.fromPaidThroughDate || "start"} → ${p.renewal.toPaidThroughDate}` : ""}</span>
                <button className={danger} disabled={busy} onClick={() => { const r = window.prompt("Reason for reversing this payment (the original stays on record):"); if (r) act({ action: "reverse_payment", paymentId: p._id, reason: r }, "Reverse this payment? If it was the latest renewal, the paid-through date goes back."); }}>Reverse</button></Row>
            ))}
          </Section>
          <Section title="Subscription history">{(d.history.periods || []).map((p) => <Row key={p._id}><span>v{p.version} · {p.planSnapshot?.name} · {p.billingCycle} · {money(p.amount, p.currency)} · {p.periodStartDate} → {p.periodEndDate || "—"} · {p.periodStatus} · {p.changeReason}</span></Row>)}</Section>
          <Section title="Activity (audit)">{(d.history.events || []).map((e) => <Row key={e._id}><span>{String(e.at).replace("T", " ").slice(0, 16)} · <b>{e.eventType}</b> · {e.actorId} · {e.previousState || ""}{e.newState ? ` → ${e.newState}` : ""}{e.reason ? ` · ${e.reason}` : ""}</span></Row>)}</Section>
          <Section title="Notices sent">{(d.notices || []).length === 0 ? <Empty /> : d.notices.map((n) => <Row key={n._id}><span>{String(n.createdAt).slice(0, 16)} · {n.noticeType} · {n.noticeStatus} · {(n.recipients || []).length} recipient(s)</span></Row>)}</Section>
          <Section title="Data exports">{(d.exports || []).length === 0 ? <Empty /> : d.exports.map((x) => <Row key={x._id}><span>{String(x.requestedAt).slice(0, 16)} · {x.exportStatus} · {x.requestedBy}{x.downloadedAt ? ` · downloaded ${day(x.downloadedAt)}` : ""}</span></Row>)}</Section>
          <Section title="Internal notes">{(lic.notes || []).length === 0 ? <Empty /> : lic.notes.slice().reverse().map((n, i) => <Row key={i}><span>{day(n.at)} · {n.by}: {n.text}</span></Row>)}</Section>
        </>
      )}
    </Panel>
  );
}

const Section = ({ title, children }) => <div><p className="text-[#00f2fe] text-[11px] font-bold uppercase tracking-wide mb-1">{title}</p><div className="space-y-1">{children}</div></div>;
const Row = ({ children }) => <div className="bg-black/20 rounded px-2 py-1.5 text-[11px] text-[#cbd5e1] flex items-center justify-between gap-2">{children}</div>;
const Empty = () => <p className="text-[11px] text-[#94a3b8]">None.</p>;

/** Launch migration (SOW 20): adopt pre-license subscriptions, and bulk-assign licenses (preview first, never confirms payment). */
function MigrationPanel({ onClose, onChanged }) {
  const [legacy, setLegacy] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const [csv, setCsv] = useState("orgId,planId,billingCycle,currency,amount,startDate\n"); const [result, setResult] = useState(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setLegacy((await api("/api/admin/licenses/migration")).legacy); } catch (e) { setErr(e.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const rows = () => csv.trim().split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const [orgId, planId, billingCycle, currency, amount, startDate] = l.split(",").map((x) => x.trim()); return { orgId, planId, billingCycle, currency, amount: Number(amount), startDate }; });
  async function adopt(r) {
    const amount = window.prompt(`Agreed amount per ${r.billingInterval === "year" ? "year" : "month"} (${r.currency || "PKR"}) for ${r.companyName}. Leave empty to use the last activation request.`, "");
    if (amount === null) return;
    if (!window.confirm(`Adopt ${r.companyName}'s ${r.plan} subscription as a license, active until ${String(r.currentPeriodEnd || "").slice(0, 10)}? No payment is recorded.`)) return;
    setBusy(true); setErr(""); setMsg("");
    try { await api("/api/admin/licenses/migration", { action: "adopt", orgId: r.orgId, amount: amount === "" ? null : Number(amount), confirm: true }); setMsg(`${r.companyName} adopted.`); await load(); onChanged(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function bulk(preview) {
    if (!preview && !window.confirm(`Assign licenses to the valid rows? Each starts awaiting its first payment; no payment is confirmed.`)) return;
    setBusy(true); setErr(""); setMsg("");
    try { setResult(await api("/api/admin/licenses/migration", { action: "bulk", rows: rows(), preview, confirm: !preview })); if (!preview) onChanged(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Panel title="Launch migration" onClose={onClose}>
      {err && <p className="text-red-300 text-sm" role="alert">{err}</p>}
      {msg && <p className="text-emerald-300 text-sm" role="status">{msg}</p>}
      <Section title="Paid companies from before licenses">
        <p className="text-[11px] text-[#94a3b8] mb-1">These were activated on Billing before licenses existed. Adopting keeps their paid-through date; nothing is charged or confirmed.</p>
        {!legacy ? <Empty /> : legacy.length === 0 ? <p className="text-[11px] text-[#94a3b8]">None: every subscription is already a license.</p> : legacy.map((r) => (
          <Row key={r.orgId}><span>{r.companyName} · {r.plan || "no package"} · {r.status} · {r.billingInterval || "—"} · {r.currency || "—"} · paid until {String(r.currentPeriodEnd || "—").slice(0, 10)}</span><button className={ghost} disabled={busy || !r.plan} onClick={() => adopt(r)}>Adopt</button></Row>
        ))}
      </Section>
      <Section title="Bulk assignment">
        <p className="text-[11px] text-[#94a3b8] mb-1">One company per line. Preview checks every row and changes nothing. Assigned licenses wait for their first payment.</p>
        <textarea className={`${input} h-40 font-mono`} value={csv} onChange={(e) => setCsv(e.target.value)} aria-label="Companies to assign, as CSV" />
        <div className="flex gap-2 mt-2"><button className={ghost} disabled={busy} onClick={() => bulk(true)}>Preview</button><button className={primary} disabled={busy || !result?.preview || !result.results.some((x) => x.status === "valid")} onClick={() => bulk(false)}>Assign valid rows</button></div>
        {result && <div className="mt-2 space-y-1">{result.results.map((x) => <Row key={x.row}><span>Row {x.row} · {x.companyName || x.orgId} · <b>{x.status}</b>{x.reason ? ` · ${x.reason}` : ""}</span></Row>)}</div>}
      </Section>
    </Panel>
  );
}
