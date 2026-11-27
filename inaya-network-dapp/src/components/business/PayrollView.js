"use client";

// src/components/business/PayrollView.js -- People > Payroll (src/lib/payroll/*). Tabs: Payroll runs, Employees' pay,
// Loans, Settings (country rules to review and confirm). MyPayslips (exported below) is every employee's own page:
// view, Download PDF, and their payslip password + WhatsApp number for protected PDFs.
import { useCallback, useEffect, useState } from "react";

async function api(path, options) {
  const res = await fetch(path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status}).`); e.code = data.code; throw e; }
  return data;
}
const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-10)] rounded-2xl p-5";
const input = "bg-transparent border border-[var(--inaya-overlay-15)] rounded-lg px-2.5 py-1.5 text-sm text-[var(--inaya-text-primary)]";
const btn = "px-3 py-1.5 rounded-lg text-sm font-bold disabled:opacity-40";
const primary = `${btn} bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]`;
const ghost = `${btn} border border-[var(--inaya-border)] text-[var(--inaya-text-primary)]`;
const money = (n, c) => `${c || ""} ${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`.trim();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (p) => `${MONTHS[Number(String(p).slice(5, 7)) - 1]} ${String(p).slice(0, 4)}`;
const STATUS = { DRAFT: "Draft", SUBMITTED: "Waiting for approval", APPROVED: "Approved", PAYING: "Paying", PAID: "Paid", CANCELLED: "Cancelled" };

export default function PayrollView({ orgId }) {
  const [tab, setTab] = useState("runs"); const [err, setErr] = useState(""); const [blocked, setBlocked] = useState("");
  const [settings, setSettings] = useState(undefined);
  const loadSettings = useCallback(async () => { try { setSettings((await api(`/api/orgs/payroll/settings?orgId=${orgId}`)).settings); } catch (e) { if (e.code === "PLAN_UPGRADE_REQUIRED" || /package|plan/i.test(e.message)) setBlocked(e.message); else setErr(e.message); } }, [orgId]);
  useEffect(() => { loadSettings(); }, [loadSettings]);
  if (blocked) return <div className={`${card} max-w-2xl`}><p className="font-bold text-[var(--inaya-text-primary)]">Payroll</p><p className="text-sm text-amber-500 mt-2">{blocked}</p><p className="text-xs text-[var(--inaya-text-muted)] mt-2">Payroll is included in Business and Enterprise, and is a $35 / PKR 7,500 a month add-on for Professional (Billing &gt; Add-ons).</p></div>;
  if (settings === undefined) return <p className="text-sm text-[var(--inaya-text-muted)]">{err || "Loading…"}</p>;
  const needsSetup = !settings || !settings.confirmed;
  const tabs = [["runs", "Payroll runs"], ["employees", "Employees' pay"], ["loans", "Loans & advances"], ["settings", needsSetup ? "Settings (start here)" : "Settings"]];
  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex flex-wrap gap-2">{tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={tab === k ? primary : ghost}>{l}</button>)}</div>
      {needsSetup && tab !== "settings" && <p className="text-sm text-amber-500">Choose your country and confirm its payroll rules in Settings before the first payroll run.</p>}
      {err && <p className="text-sm text-red-400">{err}</p>}
      {tab === "runs" && <Runs orgId={orgId} settings={settings} />}
      {tab === "employees" && <Employees orgId={orgId} settings={settings} />}
      {tab === "loans" && <Loans orgId={orgId} settings={settings} />}
      {tab === "settings" && <Settings orgId={orgId} settings={settings} onSaved={loadSettings} />}
    </div>
  );
}

function Settings({ orgId, settings, onSaved }) {
  const [presets, setPresets] = useState([]); const [s, setS] = useState(settings || {}); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/api/orgs/payroll/presets?orgId=${orgId}`).then((d) => setPresets(d.presets)).catch((e) => setMsg(e.message)); }, [orgId]);
  const p = presets.find((x) => x.country === s.country);
  const set = (k, v) => setS((x) => ({ ...x, [k]: v })); const setG = (g, k, v) => setS((x) => ({ ...x, [g]: { ...(x[g] || p?.defaults?.[g] || {}), [k]: v } }));
  async function save() { setBusy(true); setMsg(""); try { await api("/api/orgs/payroll/settings", { method: "PUT", body: JSON.stringify({ orgId, ...s }) }); setMsg("Saved."); onSaved(); } catch (e) { setMsg(e.message); } finally { setBusy(false); } }
  async function confirm() { if (!window.confirm(`Confirm that you have reviewed the ${p?.name} payroll rules (${p?.version}) and that they are right for your company?`)) return; setBusy(true); try { await api("/api/orgs/payroll/settings/confirm", { method: "POST", body: JSON.stringify({ orgId }) }); setMsg("Rules confirmed. You can run payroll."); onSaved(); } catch (e) { setMsg(e.message); } finally { setBusy(false); } }
  const g = (grp, k) => s[grp]?.[k] ?? p?.defaults?.[grp]?.[k] ?? "";
  return (
    <div className={`${card} space-y-4`}>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-xs text-[var(--inaya-text-muted)]">Country rules<br /><select className={input} value={s.country || ""} onChange={(e) => { const np = presets.find((x) => x.country === e.target.value); setS({ country: e.target.value, currency: np?.currency }); }}><option value="">Choose…</option>{presets.map((x) => <option key={x.country} value={x.country}>{x.name}</option>)}</select></label>
        <label className="text-xs text-[var(--inaya-text-muted)]">Currency<br /><input className={input} value={s.currency || ""} onChange={(e) => set("currency", e.target.value.toUpperCase())} size={6} /></label>
        <label className="text-xs text-[var(--inaya-text-muted)]">Overtime x<br /><input className={input} type="number" step="0.05" value={s.overtimeMultiplier ?? p?.defaults?.overtimeMultiplier ?? ""} onChange={(e) => set("overtimeMultiplier", e.target.value)} size={4} /></label>
        <label className="text-xs text-[var(--inaya-text-muted)]">Hours a month<br /><input className={input} type="number" value={s.standardMonthlyHours ?? p?.defaults?.standardMonthlyHours ?? ""} onChange={(e) => set("standardMonthlyHours", e.target.value)} size={5} /></label>
        <label className="text-xs text-[var(--inaya-text-muted)] flex items-center gap-1.5"><input type="checkbox" checked={s.requireSecondApprover !== false} onChange={(e) => set("requireSecondApprover", e.target.checked)} /> A second person approves</label>
      </div>
      {p && <div className="text-xs text-[var(--inaya-text-muted)] space-y-1 border-l-2 border-[var(--inaya-accent)] pl-3"><p className="text-[var(--inaya-text-primary)] font-bold">{p.name} rules · {p.version}{p.checkedOn ? ` · checked ${p.checkedOn}` : ""}</p><p>{p.source}</p>{p.notes.map((n) => <p key={n}>• {n}</p>)}</div>}
      {s.country === "PK" && <div className="flex flex-wrap gap-3 text-xs text-[var(--inaya-text-muted)]">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={g("eobi", "enabled") !== false} onChange={(e) => setG("eobi", "enabled", e.target.checked)} /> EOBI</label>
        <label>Minimum wage (PKR) <input className={input} type="number" value={g("eobi", "minimumWage")} onChange={(e) => setG("eobi", "minimumWage", e.target.value)} size={7} /></label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!g("providentFund", "enabled")} onChange={(e) => setG("providentFund", "enabled", e.target.checked)} /> Provident fund</label>
        <label>PF rate <input className={input} type="number" step="0.01" value={g("providentFund", "employeeRate")} onChange={(e) => { setG("providentFund", "employeeRate", e.target.value); setG("providentFund", "employerRate", e.target.value); }} size={4} /></label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!g("socialSecurity", "enabled")} onChange={(e) => setG("socialSecurity", "enabled", e.target.checked)} /> Provincial social security (employer)</label>
      </div>}
      {s.country === "AE" && <div className="flex flex-wrap gap-3 text-xs text-[var(--inaya-text-muted)]">
        <label>MOHRE establishment ID <input className={input} value={s.uae?.establishmentId || ""} onChange={(e) => set("uae", { ...(s.uae || {}), establishmentId: e.target.value })} size={14} /></label>
        <label>WPS bank/agent routing code <input className={input} value={s.uae?.routingCode || ""} onChange={(e) => set("uae", { ...(s.uae || {}), routingCode: e.target.value })} size={10} /></label>
      </div>}
      {s.country === "US" && <label className="text-xs text-[var(--inaya-text-muted)] flex items-center gap-1.5"><input type="checkbox" checked={s.futa !== false} onChange={(e) => set("futa", e.target.checked)} /> Calculate FUTA (employer)</label>}
      {s.country === "UZ" && <label className="text-xs text-[var(--inaya-text-muted)] flex items-center gap-1.5"><input type="checkbox" checked={!!s.itPark} onChange={(e) => set("itPark", e.target.checked)} /> IT Park resident (7.5% income tax, no social tax)</label>}
      {s.country === "OTHER" && <label className="text-xs text-[var(--inaya-text-muted)]">Flat income tax % <input className={input} type="number" value={s.flatTaxRate ?? 0} onChange={(e) => set("flatTaxRate", e.target.value)} size={5} /></label>}
      <div className="text-xs text-[var(--inaya-text-muted)] space-y-1">
        <p className="font-bold text-[var(--inaya-text-primary)]">WhatsApp payslips (Inaya Connect)</p>
        <p>Create a WhatsApp message template in Meta (category Utility) with a <b>Document</b> header and a body with two variables: the employee&apos;s name and the month, e.g. &quot;Hello {"{{1}}"}, your payslip for {"{{2}}"} is attached. Open it with your payslip password.&quot; Enter its name once Meta approves it.</p>
        <div className="flex gap-2"><input className={input} placeholder="template name, e.g. payslip_notice" value={s.whatsappTemplate?.name || ""} onChange={(e) => set("whatsappTemplate", { ...(s.whatsappTemplate || {}), name: e.target.value })} /><input className={input} placeholder="en_US" size={6} value={s.whatsappTemplate?.language || ""} onChange={(e) => set("whatsappTemplate", { ...(s.whatsappTemplate || {}), language: e.target.value })} /></div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <button className={primary} disabled={busy || !s.country} onClick={save}>Save settings</button>
        {settings?.country && <button className={ghost} disabled={busy} onClick={confirm}>{settings.confirmed ? `Rules confirmed by ${settings.confirmed.by} · confirm again` : "I've reviewed these rules: confirm"}</button>}
        {msg && <span className="text-xs text-[var(--inaya-text-muted)]">{msg}</span>}
      </div>
      <p className="text-[11px] text-[var(--inaya-text-muted)]">Inaya calculates pay from the rules you confirm. It does not file tax returns or pay tax authorities for you. Check the rules with your tax adviser.</p>
    </div>
  );
}

function Employees({ orgId, settings }) {
  const [list, setList] = useState(null); const [edit, setEdit] = useState(null); const [msg, setMsg] = useState("");
  const load = useCallback(async () => { try { setList((await api(`/api/orgs/payroll/employees?orgId=${orgId}`)).employees); } catch (e) { setMsg(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  async function open(e) { try { const d = await api(`/api/orgs/payroll/employees/${e.employeeId}/profile?orgId=${orgId}`); setEdit({ emp: e, p: d.profile || { basic: "", allowances: [], deductions: [] } }); } catch (x) { setMsg(x.message); } }
  async function save() { try { await api(`/api/orgs/payroll/employees/${edit.emp.employeeId}/profile`, { method: "PUT", body: JSON.stringify({ orgId, ...edit.p }) }); setEdit(null); load(); } catch (x) { setMsg(x.message); } }
  const P = edit?.p; const setP = (k, v) => setEdit((x) => ({ ...x, p: { ...x.p, [k]: v } }));
  const rows = (k) => (P?.[k] || []); const setRow = (k, i, f, v) => setP(k, rows(k).map((r, j) => (j === i ? { ...r, [f]: v } : r)));
  if (!list) return <p className="text-sm text-[var(--inaya-text-muted)]">{msg || "Loading…"}</p>;
  return (
    <div className="space-y-3">
      {msg && <p className="text-sm text-red-400">{msg}</p>}
      <div className={card}><table className="w-full text-sm"><thead><tr className="text-left text-[var(--inaya-text-muted)] text-xs"><th>Employee</th><th>Basic salary</th><th>Payslip password</th><th>WhatsApp</th><th /></tr></thead><tbody>
        {list.map((e) => <tr key={e.employeeId} className="border-t border-[var(--inaya-overlay-10)]"><td className="py-2 text-[var(--inaya-text-primary)]">{e.name}<span className="block text-[11px] text-[var(--inaya-text-muted)]">{e.jobTitle || ""} {e.email || "no email"}</span></td><td>{e.hasProfile ? money(e.basic, settings?.currency) : <span className="text-amber-500">not set</span>}</td><td>{e.hasPayslipPassword ? "set" : "-"}</td><td>{e.hasWhatsapp ? "yes" : "-"}</td><td><button className={ghost} onClick={() => open(e)}>{e.hasProfile ? "Edit pay" : "Set up pay"}</button></td></tr>)}
        {list.length === 0 && <tr><td className="py-3 text-[var(--inaya-text-muted)]" colSpan={5}>Add employees under People &gt; Employees first.</td></tr>}
      </tbody></table></div>
      {edit && <div className={`${card} space-y-3`}>
        <p className="font-bold text-[var(--inaya-text-primary)]">Pay for {edit.emp.name}</p>
        <div className="flex flex-wrap gap-3 text-xs text-[var(--inaya-text-muted)]">
          <label>Basic monthly salary ({settings?.currency})<br /><input className={input} type="number" value={P.basic ?? ""} onChange={(e) => setP("basic", e.target.value)} /></label>
          <label>Employee ID on payslip<br /><input className={input} value={P.employeeRef || ""} onChange={(e) => setP("employeeRef", e.target.value)} /></label>
          <label>Payslip email<br /><input className={input} value={P.payslipEmail || ""} placeholder={edit.emp.email || ""} onChange={(e) => setP("payslipEmail", e.target.value)} /></label>
          <label>WhatsApp number<br /><input className={input} value={P.whatsapp || ""} placeholder="+923001234567" onChange={(e) => setP("whatsapp", e.target.value)} /></label>
        </div>
        {["allowances", "deductions"].map((k) => <div key={k} className="text-xs text-[var(--inaya-text-muted)] space-y-1"><p className="font-bold">{k === "allowances" ? "Monthly allowances" : "Fixed monthly deductions"}</p>{rows(k).map((r, i) => <div key={i} className="flex gap-2 items-center"><input className={input} placeholder="name" value={r.name} onChange={(e) => setRow(k, i, "name", e.target.value)} /><input className={input} type="number" placeholder="amount" value={r.amount} onChange={(e) => setRow(k, i, "amount", e.target.value)} />{k === "allowances" && <label className="flex items-center gap-1"><input type="checkbox" checked={r.taxable !== false} onChange={(e) => setRow(k, i, "taxable", e.target.checked)} /> taxable</label>}<button className="text-red-400" onClick={() => setP(k, rows(k).filter((_, j) => j !== i))}>remove</button></div>)}<button className={ghost} onClick={() => setP(k, [...rows(k), { name: "", amount: "", taxable: true }])}>+ add</button></div>)}
        <div className="flex flex-wrap gap-3 text-xs text-[var(--inaya-text-muted)]">
          <label>Bank<br /><input className={input} value={P.bankName || ""} onChange={(e) => setP("bankName", e.target.value)} /></label>
          <label>Account number<br /><input className={input} value={P.accountNumber || ""} onChange={(e) => setP("accountNumber", e.target.value)} /></label>
          <label>IBAN<br /><input className={input} value={P.iban || ""} onChange={(e) => setP("iban", e.target.value)} /></label>
          {settings?.country === "US" && <label>Routing number<br /><input className={input} value={P.routingCode || ""} onChange={(e) => setP("routingCode", e.target.value)} /></label>}
          {settings?.country === "AE" && <label>Labour person ID (WPS)<br /><input className={input} value={P.personId || ""} onChange={(e) => setP("personId", e.target.value)} /></label>}
        </div>
        {settings?.country === "US" && <div className="flex flex-wrap gap-3 text-xs text-[var(--inaya-text-muted)]">
          <label>W-4 filing status<br /><select className={input} value={P.w4?.filingStatus || "single"} onChange={(e) => setP("w4", { ...(P.w4 || {}), filingStatus: e.target.value })}><option value="single">Single / married filing separately</option><option value="married">Married filing jointly</option><option value="head">Head of household</option></select></label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={!!P.w4?.step2} onChange={(e) => setP("w4", { ...(P.w4 || {}), step2: e.target.checked })} /> Step 2 box</label>
          {[["credits", "Step 3 credits (yearly)"], ["otherIncome", "4(a) other income"], ["deductions", "4(b) deductions"], ["extraWithholding", "4(c) extra per pay"]].map(([k, l]) => <label key={k}>{l}<br /><input className={input} type="number" value={P.w4?.[k] || ""} onChange={(e) => setP("w4", { ...(P.w4 || {}), [k]: e.target.value })} size={8} /></label>)}
          <label>State/local tax %<br /><input className={input} type="number" step="0.01" value={P.statePercent || ""} onChange={(e) => setP("statePercent", e.target.value)} size={5} /></label>
        </div>}
        {settings?.country === "AE" && <label className="text-xs text-[var(--inaya-text-muted)] flex items-center gap-1"><input type="checkbox" checked={!!P.uaeNational} onChange={(e) => setP("uaeNational", e.target.checked)} /> UAE/GCC national (GPSSA pension instead of gratuity)</label>}
        {settings?.country === "KZ" && <div className="flex gap-3 text-xs text-[var(--inaya-text-muted)]"><label className="flex items-center gap-1"><input type="checkbox" checked={!!P.kzStandardDeduction} onChange={(e) => setP("kzStandardDeduction", e.target.checked)} /> Standard deduction application on file</label><label className="flex items-center gap-1"><input type="checkbox" checked={!!P.kzBornBefore1975} onChange={(e) => setP("kzBornBefore1975", e.target.checked)} /> Born before 1975 (no OPVR)</label></div>}
        {settings?.country === "PK" && <div className="flex gap-3 text-xs text-[var(--inaya-text-muted)]"><label className="flex items-center gap-1"><input type="checkbox" checked={!!P.eobiExempt} onChange={(e) => setP("eobiExempt", e.target.checked)} /> Not covered by EOBI</label><label className="flex items-center gap-1"><input type="checkbox" checked={!!P.pfExempt} onChange={(e) => setP("pfExempt", e.target.checked)} /> Not in provident fund</label></div>}
        <div className="flex gap-2"><button className={primary} onClick={save}>Save pay</button><button className={ghost} onClick={() => setEdit(null)}>Close</button></div>
        <p className="text-[11px] text-[var(--inaya-text-muted)]">Salary, bank and tax details are stored encrypted. The employee chooses their own payslip password in My payslips.</p>
      </div>}
    </div>
  );
}

function Loans({ orgId, settings }) {
  const [d, setD] = useState(null); const [emps, setEmps] = useState([]); const [f, setF] = useState({ employeeId: "", name: "Salary advance", principal: "", installment: "" }); const [msg, setMsg] = useState("");
  const load = useCallback(async () => { try { setD((await api(`/api/orgs/payroll/loans?orgId=${orgId}`)).loans); setEmps((await api(`/api/orgs/payroll/employees?orgId=${orgId}`)).employees); } catch (e) { setMsg(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  async function add() { try { await api("/api/orgs/payroll/loans", { method: "POST", body: JSON.stringify({ orgId, ...f }) }); setF({ ...f, principal: "", installment: "" }); load(); } catch (e) { setMsg(e.message); } }
  const name = (id) => emps.find((e) => e.employeeId === id)?.name || "-";
  return (
    <div className="space-y-3">
      <div className={`${card} flex flex-wrap gap-2 items-end text-xs text-[var(--inaya-text-muted)]`}>
        <label>Employee<br /><select className={input} value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Choose…</option>{emps.map((e) => <option key={e.employeeId} value={e.employeeId}>{e.name}</option>)}</select></label>
        <label>What for<br /><input className={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Amount<br /><input className={input} type="number" value={f.principal} onChange={(e) => setF({ ...f, principal: e.target.value })} size={8} /></label>
        <label>Monthly instalment<br /><input className={input} type="number" value={f.installment} onChange={(e) => setF({ ...f, installment: e.target.value })} size={8} /></label>
        <button className={primary} disabled={!f.employeeId} onClick={add}>Add loan / advance</button>
      </div>
      {msg && <p className="text-sm text-red-400">{msg}</p>}
      <div className={card}>{!d ? "Loading…" : d.length === 0 ? <p className="text-sm text-[var(--inaya-text-muted)]">No loans or advances.</p> : <table className="w-full text-sm"><tbody>{d.map((l) => <tr key={l.id} className="border-t border-[var(--inaya-overlay-10)]"><td className="py-2">{name(l.employeeId)}</td><td>{l.name}</td><td>{money(l.principal, settings?.currency)}</td><td>{money(l.installment, settings?.currency)} / month</td><td>{money(l.remaining, settings?.currency)} left</td><td>{l.status === "REPAID" ? "Repaid" : "Active"}</td></tr>)}</tbody></table>}</div>
    </div>
  );
}

function Runs({ orgId, settings }) {
  const [runs, setRuns] = useState(null); const [open, setOpen] = useState(null); const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7)); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { setRuns((await api(`/api/orgs/payroll/runs?orgId=${orgId}`)).runs); } catch (e) { setMsg(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  const view = async (id) => { try { setOpen(await api(`/api/orgs/payroll/runs/${id}?orgId=${orgId}`)); } catch (e) { setMsg(e.message); } };
  async function create() { setBusy("create"); setMsg(""); try { const r = await api("/api/orgs/payroll/runs", { method: "POST", body: JSON.stringify({ orgId, period }) }); await load(); view(r.run.id); } catch (e) { setMsg(e.message); } finally { setBusy(""); } }
  async function act(id, action) { if (action === "pay" && !window.confirm("Mark this payroll as paid? Payslips are published to employees and the ledger entry is posted.")) return; if (action === "cancel" && !window.confirm("Cancel this payroll?")) return; setBusy(action); setMsg(""); try { await api(`/api/orgs/payroll/runs/${id}/${action}`, { method: "POST", body: JSON.stringify({ orgId }) }); await load(); if (action !== "cancel") view(id); else setOpen(null); } catch (e) { setMsg(e.message); } finally { setBusy(""); } }
  async function deliver(id, channels) { setBusy("deliver"); setMsg(""); try { const r = await api(`/api/orgs/payroll/runs/${id}/deliver`, { method: "POST", body: JSON.stringify({ orgId, channels }) }); setMsg(`Email: ${r.email.sent} PDFs, ${r.email.noticeOnly} notices${r.email.failed ? `, ${r.email.failed} failed` : ""}. WhatsApp: ${r.whatsapp.sent} sent${r.whatsapp.skipped ? `, ${r.whatsapp.skipped} skipped (no number or no payslip password)` : ""}${r.whatsapp.failed ? `, ${r.whatsapp.failed} failed: ${r.whatsapp.errors.join("; ")}` : ""}.`); view(id); } catch (e) { setMsg(e.message); } finally { setBusy(""); } }
  const R = open?.run; const cur = settings?.currency;
  return (
    <div className="space-y-3">
      <div className={`${card} flex flex-wrap gap-2 items-end`}>
        <label className="text-xs text-[var(--inaya-text-muted)]">Month<br /><input className={input} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <button className={primary} disabled={!!busy || !settings?.confirmed} onClick={create}>{busy === "create" ? "Calculating…" : "Prepare payroll"}</button>
        <p className="text-xs text-[var(--inaya-text-muted)] flex-1 min-w-[220px]">Uses each employee&apos;s pay, approved unpaid leave, overtime from clock-ins, loan instalments and the confirmed tax rules.</p>
      </div>
      {msg && <p className="text-sm text-[var(--inaya-text-muted)]">{msg}</p>}
      <div className={card}>{!runs ? "Loading…" : runs.length === 0 ? <p className="text-sm text-[var(--inaya-text-muted)]">No payroll yet.</p> : <table className="w-full text-sm"><tbody>{runs.map((r) => <tr key={r.id} className="border-t border-[var(--inaya-overlay-10)]"><td className="py-2 font-bold text-[var(--inaya-text-primary)]">{label(r.period)}</td><td>{STATUS[r.status]}</td><td>{r.employees} people</td><td>{r.totals ? `Net ${money(r.totals.net, cur)}` : ""}</td><td><button className={ghost} onClick={() => view(r.id)}>Open</button></td></tr>)}</tbody></table>}</div>
      {R && <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap justify-between gap-2"><p className="font-bold text-[var(--inaya-text-primary)]">{label(R.period)} · {STATUS[R.status]}</p><p className="text-xs text-[var(--inaya-text-muted)]">Prepared by {R.preparedBy}{R.approvedBy ? ` · approved by ${R.approvedBy}` : ""}{R.paidBy ? ` · paid by ${R.paidBy}` : ""}</p></div>
        {R.totals && <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">{[["Gross", R.totals.gross], ["Tax", R.totals.tax], ["Deductions", R.totals.deductions], ["Net pay", R.totals.net], ["Employer cost", R.totals.employerCost]].map(([k, v]) => <div key={k} className="border border-[var(--inaya-overlay-10)] rounded-xl p-2"><p className="text-[11px] text-[var(--inaya-text-muted)]">{k}</p><p className="font-bold text-[var(--inaya-text-primary)]">{money(v, cur)}</p></div>)}</div>}
        {R.warnings?.length > 0 && <ul className="text-xs text-amber-500">{R.warnings.map((w) => <li key={w}>• {w}</li>)}</ul>}
        <table className="w-full text-sm"><thead><tr className="text-left text-xs text-[var(--inaya-text-muted)]"><th>Employee</th><th>Gross</th><th>Tax</th><th>Deductions</th><th>Net</th><th>Employer</th><th /></tr></thead><tbody>{open.slips.map((s) => <tr key={s.id} className="border-t border-[var(--inaya-overlay-10)]"><td className="py-1.5">{s.employeeName}{s.attendance?.unpaidDays ? <span className="text-[11px] text-amber-500"> · {s.attendance.unpaidDays} unpaid days</span> : null}{s.attendance?.overtimeHours ? <span className="text-[11px] text-[var(--inaya-text-muted)]"> · {s.attendance.overtimeHours} h OT</span> : null}</td><td>{money(s.gross)}</td><td>{money(s.tax)}</td><td>{money(s.totalDeductions)}</td><td className="font-bold">{money(s.net)}</td><td>{money(s.employerCost)}</td><td><a className="text-xs text-[var(--inaya-accent)] hover:underline" href={`/api/orgs/payroll/payslips/${s.id}/pdf?orgId=${orgId}`}>Download PDF</a></td></tr>)}</tbody></table>
        <div className="flex flex-wrap gap-2">
          {R.status === "DRAFT" && <><button className={ghost} disabled={!!busy} onClick={async () => { setBusy("recalc"); try { await api(`/api/orgs/payroll/runs/${R.id}/recalc`, { method: "POST", body: JSON.stringify({ orgId }) }); view(R.id); load(); } catch (e) { setMsg(e.message); } finally { setBusy(""); } }}>Recalculate</button><button className={primary} disabled={!!busy} onClick={() => act(R.id, "submit")}>Submit for approval</button><button className={ghost} disabled={!!busy} onClick={() => act(R.id, "cancel")}>Cancel</button></>}
          {R.status === "SUBMITTED" && <><button className={primary} disabled={!!busy} onClick={() => act(R.id, "approve")}>Approve</button><button className={ghost} disabled={!!busy} onClick={() => act(R.id, "reopen")}>Send back to draft</button></>}
          {R.status === "APPROVED" && <><a className={ghost} href={`/api/orgs/payroll/runs/${R.id}/bank-file?orgId=${orgId}`}>Bank file (CSV)</a>{settings?.country === "AE" && <a className={ghost} href={`/api/orgs/payroll/runs/${R.id}/bank-file?orgId=${orgId}&format=wps`}>WPS SIF file</a>}<button className={primary} disabled={!!busy} onClick={() => act(R.id, "pay")}>Mark as paid</button></>}
          {R.status === "PAID" && <><a className={ghost} href={`/api/orgs/payroll/runs/${R.id}/bank-file?orgId=${orgId}`}>Bank file (CSV)</a><button className={primary} disabled={!!busy} onClick={() => deliver(R.id, ["email"])}>Email payslips</button><button className={primary} disabled={!!busy} onClick={() => deliver(R.id, ["whatsapp"])}>Send on WhatsApp</button></>}
        </div>
        <p className="text-[11px] text-[var(--inaya-text-muted)]">Emailed and WhatsApp payslips are PDFs locked with each employee&apos;s own payslip password. Employees without one get an email that their payslip is in the app, and are skipped on WhatsApp.</p>
      </div>}
    </div>
  );
}

/** Every employee: their own payslips, Download PDF, and their payslip password / WhatsApp number. */
export function MyPayslips({ orgId }) {
  const [d, setD] = useState(null); const [pw, setPw] = useState(""); const [wa, setWa] = useState(""); const [msg, setMsg] = useState("");
  const load = useCallback(async () => { try { const r = await api(`/api/orgs/payroll/my/payslips?orgId=${orgId}`); setD(r); setWa(r.options?.whatsapp || ""); } catch (e) { setMsg(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  async function save() { setMsg(""); try { await api("/api/orgs/payroll/my/options", { method: "PUT", body: JSON.stringify({ orgId, ...(pw ? { payslipPassword: pw } : {}), whatsapp: wa }) }); setPw(""); setMsg("Saved."); load(); } catch (e) { setMsg(e.message); } }
  if (!d) return <p className="text-sm text-[var(--inaya-text-muted)]">{msg || "Loading…"}</p>;
  return (
    <div className="space-y-4 max-w-3xl">
      <div className={card}>
        <p className="font-bold text-[var(--inaya-text-primary)]">My payslips</p>
        {d.payslips.length === 0 ? <p className="text-sm text-[var(--inaya-text-muted)] mt-2">No payslips yet.</p> : <table className="w-full text-sm mt-2"><tbody>{d.payslips.map((p) => <tr key={p.id} className="border-t border-[var(--inaya-overlay-10)]"><td className="py-2 text-[var(--inaya-text-primary)]">{label(p.period)}</td><td>Gross {money(p.gross, p.currency)}</td><td className="font-bold">Net {money(p.net, p.currency)}</td><td><a className={primary} href={`/api/orgs/payroll/payslips/${p.id}/pdf?orgId=${orgId}`}>Download PDF</a></td></tr>)}</tbody></table>}
      </div>
      {d.options && <div className={`${card} space-y-2`}>
        <p className="font-bold text-[var(--inaya-text-primary)]">Payslips by email and WhatsApp</p>
        <p className="text-xs text-[var(--inaya-text-muted)]">Choose a payslip password (6+ characters). Payslips sent to you by email or WhatsApp are PDFs that only open with it. Don&apos;t reuse your Inaya password. {d.options.hasPayslipPassword ? "A password is set." : "No password yet: you'll get an email notice instead of the PDF."}</p>
        <div className="flex flex-wrap gap-2"><input className={input} type="password" autoComplete="new-password" placeholder={d.options.hasPayslipPassword ? "New payslip password" : "Payslip password"} value={pw} onChange={(e) => setPw(e.target.value)} /><input className={input} placeholder="WhatsApp number, e.g. +923001234567" value={wa} onChange={(e) => setWa(e.target.value)} /><button className={primary} onClick={save}>Save</button></div>
        {msg && <p className="text-xs text-[var(--inaya-text-muted)]">{msg}</p>}
      </div>}
    </div>
  );
}
