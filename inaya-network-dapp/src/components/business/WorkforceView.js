"use client";

// src/components/business/WorkforceView.js -- Inaya Commerce Phase 6 (Master SOW section 10): clock in/out and breaks for every
// user, rota, Manage users (roles, permissions, branches), commissions, checklists, incidents and workforce reports. Every action
// is checked again on the server (src/lib/workforce/*); hiding a tab here is only a convenience.

import { useState, useEffect, useCallback, useMemo } from "react";
import { ALL, resolveWorkingAt, setWorkingAt } from "../../lib/workforce/workingAt";
import { useErpSection } from "./erp/ErpNavContext";

const f = "w-full min-h-[38px] bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-lg px-2.5 text-sm text-[var(--inaya-text-primary)]";
const pb = "min-h-[38px] px-3 rounded-lg text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-40";
const gb = "min-h-[38px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] disabled:opacity-40";
const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl p-3";
const mu = "text-[var(--inaya-text-muted)]";
const chip = "inline-block text-xs px-2 py-0.5 rounded-md border border-[var(--inaya-border)]";
const key = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–");
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
// The viewer's own calendar date (not UTC): in the evening UTC is already tomorrow in Pakistan/UK-evening edge cases.
const localDay = (t = Date.now()) => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
function monday(d = new Date()) { const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const w = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - w); return x; }
async function api(path, { orgId, method = "GET", body } = {}) {
  const r = await fetch(`/api/orgs/workforce/${path}${method === "GET" ? `${path.includes("?") ? "&" : "?"}orgId=${orgId}` : ""}`, { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(method !== "GET" ? { body: JSON.stringify({ orgId, ...(body || {}) }) } : {}) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { code: d.code }); return d;
}
const csvHref = (path, orgId) => `/api/orgs/workforce/${path}${path.includes("?") ? "&" : "?"}orgId=${orgId}`;
const Msg = ({ ok, err }) => <>{ok && <p className="text-sm text-emerald-600">{ok}</p>}{err && <p className="text-sm text-red-500" role="alert">{err}</p>}</>;
const H = ({ children }) => <h3 className="font-bold text-sm text-[var(--inaya-text-primary)] mb-2">{children}</h3>;
const L = ({ t, children }) => <label className="block text-xs font-semibold text-[var(--inaya-text-secondary)] space-y-1"><span>{t}</span>{children}</label>;
function useAction() { const [ok, setOk] = useState(""); const [err, setErr] = useState(""); const run = async (fn, msg) => { setOk(""); setErr(""); try { const r = await fn(); if (msg) setOk(typeof msg === "function" ? msg(r) : msg); return r; } catch (e) { setErr(e.message); return null; } }; return { ok, err, run }; }
const PUNCH_LABEL = { CLOCK_IN: "Clock in", BREAK_START: "Start break", BREAK_END: "End break", CLOCK_OUT: "Clock out" };
const STATE_LABEL = { WORKING: "Working", ON_BREAK: "On break", OFF: "Not clocked in" };

export default function WorkforceView({ orgId }) {
  const [me, setMe] = useState(null); const [err, setErr] = useState(""); const [loc, setLoc] = useState(null);
  const tabs = [["clock", "My time"], ["rota", me && !me.isManager ? "My shifts" : "Rota"], ...(me?.canManageUsers ? [["users", "Manage users"]] : []), ["commissions", me && !me.isManager ? "My commission" : "Commissions"], ["checklists", "Checklists & incidents"], ...(me?.isManager ? [["reports", "Reports"]] : [])];
  const [tab, setTab] = useErpSection("clock", tabs);
  useEffect(() => { api("me/locations", { orgId }).then((m) => { setMe(m); setLoc(resolveWorkingAt(orgId, m)); }).catch((e) => setErr(e.message)); }, [orgId]);
  useEffect(() => { const on = (e) => { if (e.detail?.orgId === orgId) setLoc(e.detail.id); }; window.addEventListener("inaya:workingAt", on); return () => window.removeEventListener("inaya:workingAt", on); }, [orgId]);
  if (err) return <p className="text-sm text-red-500">{err}</p>; if (!me) return <p className={`text-sm ${mu}`}>Loading…</p>;
  if (!me.locations.length) return <div className={`${card} max-w-lg`}><H>No branches yet</H><p className={`text-sm ${mu}`}>{me.canManageUsers ? "Add a branch first (Inventory › Warehouses). Each branch or shop is a warehouse; staff are then assigned to branches in Manage users." : "You aren't assigned to a branch yet. Ask an admin to assign you in Manage users."}</p></div>;
  const branch = loc === ALL ? null : loc; const names = new Map(me.locations.map((l) => [l.id, l.name]));
  return <div className="space-y-3">
    <div className={`${card} flex flex-wrap items-center gap-3`}>
      <label className="flex items-center gap-2 text-sm"><span className={mu}>Working at</span>
        <select className={f + " w-auto"} value={loc || ""} onChange={(e) => { setLoc(e.target.value); setWorkingAt(orgId, e.target.value); }}>
          {me.locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.city ? ` – ${l.city}` : ""}</option>)}
          {me.canSeeAll && <option value={ALL}>All branches</option>}
        </select></label>
      <span className={`text-xs ${mu}`}>{me.canSeeAll ? "You can see every branch." : "Only the branches you're assigned to are shown."}</span>
    </div>
    <div className="flex flex-wrap gap-2" role="tablist" data-erp-tabs>{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? pb : gb} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === "clock" && <Clock orgId={orgId} branch={branch} names={names} />}
    {tab === "rota" && <Rota orgId={orgId} me={me} branch={branch} names={names} />}
    {tab === "users" && <Users orgId={orgId} me={me} />}
    {tab === "commissions" && <Commissions orgId={orgId} me={me} />}
    {tab === "checklists" && <Checklists orgId={orgId} branch={branch} me={me} />}
    {tab === "reports" && <Reports orgId={orgId} branch={branch} />}
  </div>;
}

// ------------------------------------------------------------------ My time: clock in/out and breaks (every user)
function Clock({ orgId, branch, names }) {
  const [st, setSt] = useState(null); const [sheet, setSheet] = useState(null); const [now, setNow] = useState(() => new Date()); const a = useAction(); const [busy, setBusy] = useState(false);
  const [corr, setCorr] = useState({ open: false, type: "CLOCK_OUT", at: "", reason: "" });
  const load = useCallback(() => { api("time/status", { orgId }).then(setSt).catch(() => null); api(`time/sheet?from=${monday().toISOString()}`, { orgId }).then(setSheet).catch(() => null); }, [orgId]);
  useEffect(() => { load(); const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t); }, [load]);
  const punch = async (type) => { const at = st?.state !== "OFF" && st?.locationId ? st.locationId : branch; if (!at) { a.run(async () => { throw new Error("Choose the branch you're working at first."); }); return; } setBusy(true); await a.run(() => api("time/punch", { orgId, method: "POST", body: { type, locationId: at, idempotencyKey: `p_${key()}` } }), `${PUNCH_LABEL[type]} recorded at ${hm(new Date().toISOString())}.`); setBusy(false); load(); };
  return <div className="grid gap-3 md:grid-cols-2">
    <div className={card + " space-y-3"}>
      <div className="flex items-center gap-4"><div className="text-3xl font-bold tabular-nums">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <div><p className="font-semibold">{st ? STATE_LABEL[st.state] : "…"}</p><p className={`text-xs ${mu}`}>{st?.since ? `since ${hm(st.since)}${st.locationId ? ` · ${names.get(st.locationId) || "branch"}` : ""}` : branch ? `at ${names.get(branch)}` : "Choose a branch above"}</p></div></div>
      <div className="flex flex-wrap gap-2">{(st?.next || ["CLOCK_IN"]).map((t) => <button key={t} disabled={busy} className={t === "CLOCK_IN" || t === "CLOCK_OUT" ? pb : gb} onClick={() => punch(t)}>{PUNCH_LABEL[t]}</button>)}</div>
      <Msg {...a} />
      <button className={`text-xs underline ${mu}`} onClick={() => setCorr({ ...corr, open: !corr.open })}>Forgot to clock in or out? Ask for a correction</button>
      {corr.open && <div className="grid gap-2 sm:grid-cols-3">
        <L t="What"><select className={f} value={corr.type} onChange={(e) => setCorr({ ...corr, type: e.target.value })}>{Object.entries(PUNCH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></L>
        <L t="When"><input type="datetime-local" className={f} value={corr.at} onChange={(e) => setCorr({ ...corr, at: e.target.value })} /></L>
        <L t="Why"><input className={f} value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} /></L>
        <button className={gb} onClick={() => a.run(() => api("time/corrections", { orgId, method: "POST", body: { action: "ADD", type: corr.type, at: corr.at ? new Date(corr.at).toISOString() : "", reason: corr.reason, locationId: st?.locationId || branch } }), "Sent to your manager for approval.")}>Send request</button>
      </div>}
    </div>
    <div className={card}>
      <H>This week</H>
      {!sheet ? <p className={`text-sm ${mu}`}>Loading…</p> : <>
        <table className="w-full text-sm"><thead><tr className={`text-left text-xs ${mu}`}><th>Day</th><th>Worked</th><th>Breaks</th><th>Scheduled</th><th></th></tr></thead>
          <tbody>{sheet.days.map((d) => <tr key={d.date} className="border-t border-[var(--inaya-border)]"><td className="py-1">{d.date}</td><td>{d.workedHours} h</td><td>{d.breakHours} h</td><td>{d.scheduledHours || "–"}</td><td>{d.late && <span className={chip}>Late {d.lateMinutes}m</span>} {d.leftEarly && <span className={chip}>Left early</span>}</td></tr>)}
            {!sheet.days.length && <tr><td colSpan={5} className={`py-2 ${mu}`}>No time recorded this week.</td></tr>}</tbody></table>
        <p className="text-sm mt-2">Total <b>{sheet.totalHours} h</b>{sheet.overtimeHours ? ` · overtime ${sheet.overtimeHours} h` : ""}</p>
        {sheet.exceptions.length > 0 && <p className="text-xs text-amber-600 mt-1">{sheet.exceptions.map((e) => `${e.date}: ${e.kind.replace(/_/g, " ").toLowerCase()}`).join(" · ")}</p>}
      </>}
    </div>
  </div>;
}

// ------------------------------------------------------------------ Rota (managers schedule; staff see and acknowledge their own shifts)
function Rota({ orgId, me, branch, names }) {
  const [wk, setWk] = useState(() => monday()); const [data, setData] = useState(null); const [people, setPeople] = useState([]); const a = useAction();
  const [x, setX] = useState({ email: "", date: localDay(), from: "09:00", to: "17:00", role: "" });
  const load = useCallback(() => api(`rota?weekStart=${wk.toISOString()}${branch ? `&locationId=${branch}` : ""}`, { orgId }).then(setData).catch((e) => a.run(async () => { throw e; })), [orgId, wk, branch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (me.canManageUsers) api("users", { orgId }).then((u) => setPeople(u.users.filter((p) => p.status === "active"))).catch(() => null); }, [orgId, me.canManageUsers]);
  const days = useMemo(() => [...Array(7)].map((_, i) => new Date(wk.getTime() + i * 86400000)), [wk]);
  const staff = useMemo(() => [...new Set([...(data?.shifts || []).map((s) => s.email), ...(me.isManager ? people.filter((p) => !branch || !p.locationIds.length || p.locationIds.includes(branch)).map((p) => p.email) : [])])].sort(), [data, people, me.isManager, branch]);
  const add = () => a.run(async () => { if (!branch) throw new Error("Choose one branch to schedule shifts."); const r = await api("rota/shifts", { orgId, method: "POST", body: { email: x.email, locationId: branch, start: new Date(`${x.date}T${x.from}`).toISOString(), end: new Date(`${x.date}T${x.to}`).toISOString(), role: x.role } }); await load(); return r; }, (r) => (r?.warnings?.length ? `Shift saved as a draft. Note: ${r.warnings.join(" ")}` : "Shift saved as a draft. Publish the week to send it to staff."));
  const shiftChip = (s) => { const c = s.status === "DRAFT" ? "border-dashed" : s.status === "ACKNOWLEDGED" ? "bg-emerald-500/10" : ""; return <span key={s.id} className={`${chip} ${c} mr-1 mb-1`} title={`${s.status}${s.role ? ` · ${s.role}` : ""}`}>{hm(s.start)}–{hm(s.end)}{!me.isManager && s.status === "PUBLISHED" && <button className="ml-1 underline" onClick={() => a.run(() => api(`rota/shifts/${s.id}/ack`, { orgId, method: "POST" }).then(load), "Shift acknowledged.")}>OK</button>}{me.isManager && s.status !== "CANCELLED" && <button className="ml-1" aria-label="Cancel shift" onClick={() => a.run(() => api(`rota/shifts/${s.id}/cancel`, { orgId, method: "POST", body: { reason: "Cancelled by manager" } }).then(load), "Shift cancelled.")}>×</button>}</span>; };
  return <div className="space-y-3">
    <div className={`${card} flex flex-wrap items-center gap-2`}>
      <button className={gb} onClick={() => setWk(new Date(wk.getTime() - 7 * 86400000))}>‹ Previous</button>
      <span className="font-semibold text-sm">Week of {ymd(wk)}{branch ? ` · ${names.get(branch)}` : " · all branches"}</span>
      <button className={gb} onClick={() => setWk(new Date(wk.getTime() + 7 * 86400000))}>Next ›</button>
      {me.isManager && branch && <span className="ml-auto flex flex-wrap gap-2">
        <a className={gb + " inline-flex items-center"} href={csvHref(`rota/export?locationId=${branch}&weekStart=${wk.toISOString()}`, orgId)}>Export CSV</a>
        <button className={pb} onClick={() => a.run(() => api("rota/publish", { orgId, method: "POST", body: { locationId: branch, weekStart: wk.toISOString() } }).then(load), (r) => "Week published; staff can now see their shifts.")}>Publish week</button></span>}
    </div>
    <Msg {...a} />
    <div className={`${card} overflow-x-auto`}>
      <table className="w-full text-sm min-w-[720px]"><thead><tr className={`text-left text-xs ${mu}`}><th className="w-40">Staff</th>{days.map((d) => <th key={d.toISOString()}>{d.toLocaleDateString([], { weekday: "short", day: "numeric", timeZone: "UTC" })}</th>)}</tr></thead>
        <tbody>{staff.map((e) => <tr key={e} className="border-t border-[var(--inaya-border)] align-top"><td className="py-1 pr-2 break-all">{e}</td>{days.map((d) => <td key={d.toISOString()} className="py-1">{(data?.shifts || []).filter((s) => s.email === e && s.start.slice(0, 10) === ymd(d)).map(shiftChip)}</td>)}</tr>)}
          {!staff.length && <tr><td colSpan={8} className={`py-2 ${mu}`}>{me.isManager ? "No shifts this week yet." : "You have no published shifts this week."}</td></tr>}</tbody></table>
      {(data?.coverage || []).filter((c) => c.state !== "OK").map((c) => <p key={`${c.date}${c.fromHour}`} className="text-xs text-amber-600 mt-1">{c.date} {c.fromHour}:00–{c.toHour}:00 {c.state === "UNDERSTAFFED" ? "understaffed" : "overstaffed"} ({c.staffed}/{c.needed})</p>)}
    </div>
    {me.isManager && <div className={`${card} grid gap-2 sm:grid-cols-6 items-end`}>
      <L t="Staff email"><input className={f} list="wf-staff" value={x.email} onChange={(e) => setX({ ...x, email: e.target.value.trim() })} /><datalist id="wf-staff">{people.map((p) => <option key={p.email} value={p.email} />)}</datalist></L>
      <L t="Date"><input type="date" className={f} value={x.date} onChange={(e) => setX({ ...x, date: e.target.value })} /></L>
      <L t="From"><input type="time" className={f} value={x.from} onChange={(e) => setX({ ...x, from: e.target.value })} /></L>
      <L t="To"><input type="time" className={f} value={x.to} onChange={(e) => setX({ ...x, to: e.target.value })} /></L>
      <L t="Role (optional)"><input className={f} value={x.role} onChange={(e) => setX({ ...x, role: e.target.value })} /></L>
      <button className={pb} onClick={add}>Add shift</button>
    </div>}
  </div>;
}

// ------------------------------------------------------------------ Manage users (owner/admin): role template, permissions, branches, status
function Users({ orgId, me }) {
  const [d, setD] = useState(null); const [edit, setEdit] = useState(null); const a = useAction();
  const load = useCallback(() => api("users", { orgId }).then(setD).catch((e) => a.run(async () => { throw e; })), [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  if (!d) return <><p className={`text-sm ${mu}`}>Loading…</p><Msg {...a} /></>;
  const tplLabel = new Map(d.templates.map((t) => [t.key, t.label]));
  const save = () => a.run(async () => { const { email, template, commerceRole, financeRole, hrRole, locationIds, defaultLocationId, status, role } = edit; const body = { email, locationIds, defaultLocationId: defaultLocationId || null, status, commerceRole: commerceRole || null, financeRole: financeRole || null, hrRole: hrRole || null, ...(role ? { role } : {}), ...(template ? { template } : {}) }; if (template) { delete body.commerceRole; delete body.financeRole; delete body.hrRole; } const r = await api("users", { orgId, method: "PUT", body }); setEdit(null); await load(); return r; }, "Access updated and logged.");
  const opt = (arr) => [["", "None"], ...arr.map((v) => [v, v[0].toUpperCase() + v.slice(1)])];
  return <div className="space-y-3">
    <div className={card + " overflow-x-auto"}>
      <table className="w-full text-sm"><thead><tr className={`text-left text-xs ${mu}`}><th>User</th><th>Role</th><th>Branches</th><th>Status</th><th></th></tr></thead>
        <tbody>{d.users.map((u) => <tr key={u.email} className="border-t border-[var(--inaya-border)]"><td className="py-1.5 break-all">{u.name ? <><b>{u.name}</b><br /></> : null}<span className={mu}>{u.email}</span></td>
          <td>{u.role === "owner" ? "Owner" : u.role === "admin" ? "Admin" : tplLabel.get(u.template) || [u.commerceRole && `Shop ${u.commerceRole}`, u.financeRole && `Finance ${u.financeRole}`, u.hrRole && `HR ${u.hrRole}`].filter(Boolean).join(", ") || "Staff"}</td>
          <td>{u.role === "owner" || u.role === "admin" ? <span className={mu}>All branches</span> : u.locations.length ? u.locations.map((n) => <span key={n} className={`${chip} mr-1`}>{n}</span>) : <span className={mu}>All branches</span>}</td>
          <td>{u.status === "active" ? "Active" : u.status}</td>
          <td className="text-right">{u.role !== "owner" && u.email !== me.email && <button className={gb} onClick={() => setEdit({ ...u, template: "", role: "" })}>Edit</button>}</td></tr>)}</tbody></table>
      <p className={`text-xs ${mu} mt-2`}>Staff with no branch ticked can work at every branch. You can't change your own access, and only the owner can make someone an admin. Every change is logged in the audit trail.</p>
    </div>
    <Msg {...a} />
    {edit && <div className={card + " space-y-3"}>
      <H>Edit access · {edit.email}</H>
      <div className="grid gap-2 sm:grid-cols-2">
        <L t="Quick role (sets the permissions below)"><select className={f} value={edit.template} onChange={(e) => setEdit({ ...edit, template: e.target.value })}><option value="">Keep custom permissions</option>{d.templates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></L>
        <L t="Status"><select className={f} value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="active">Active</option><option value="suspended">Suspended</option></select></L>
      </div>
      {!edit.template && <div className="grid gap-2 sm:grid-cols-3">
        <L t="Shop / POS"><select className={f} value={edit.commerceRole || ""} onChange={(e) => setEdit({ ...edit, commerceRole: e.target.value })}>{opt(["cashier", "supervisor", "manager"]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></L>
        <L t="Finance"><select className={f} value={edit.financeRole || ""} onChange={(e) => setEdit({ ...edit, financeRole: e.target.value })}>{opt(["staff", "manager"]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></L>
        <L t="HR"><select className={f} value={edit.hrRole || ""} onChange={(e) => setEdit({ ...edit, hrRole: e.target.value })}>{opt(["staff", "manager"]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></L>
      </div>}
      <div><p className="text-xs font-semibold text-[var(--inaya-text-secondary)] mb-1">Branches this person works at</p>
        <div className="flex flex-wrap gap-3">{d.locations.map((l) => <label key={l.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={edit.locationIds.includes(l.id)} onChange={(e) => setEdit({ ...edit, locationIds: e.target.checked ? [...edit.locationIds, l.id] : edit.locationIds.filter((x) => x !== l.id), defaultLocationId: !e.target.checked && edit.defaultLocationId === l.id ? null : edit.defaultLocationId })} />{l.name}</label>)}</div></div>
      {edit.locationIds.length > 1 && <L t="Opens at"><select className={f + " sm:w-64"} value={edit.defaultLocationId || ""} onChange={(e) => setEdit({ ...edit, defaultLocationId: e.target.value })}><option value="">First branch</option>{d.locations.filter((l) => edit.locationIds.includes(l.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></L>}
      <div className="flex gap-2"><button className={pb} onClick={save}>Save access</button><button className={gb} onClick={() => setEdit(null)}>Cancel</button></div>
    </div>}
  </div>;
}

// ------------------------------------------------------------------ Commissions (managers approve; staff see their own)
function Commissions({ orgId, me }) {
  const [month, setMonth] = useState(() => localDay().slice(0, 7)); const [d, setD] = useState(null); const [rules, setRules] = useState([]); const a = useAction();
  const [r, setR] = useState({ percent: "", category: "", effectiveFrom: localDay() });
  const load = useCallback(() => { api(`commissions?month=${month}`, { orgId }).then(setD).catch((e) => a.run(async () => { throw e; })); api("commissions/rules", { orgId }).then((x) => setRules(x.rules)).catch(() => null); }, [orgId, month]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const from = `${month}-01T00:00:00.000Z`; const to = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString();
  return <div className="space-y-3">
    <div className={`${card} flex flex-wrap items-center gap-2`}>
      <L t="Month"><input type="month" className={f} value={month} onChange={(e) => setMonth(e.target.value)} /></L>
      <span className="text-sm ml-2">Status: <b>{d?.status || "…"}</b>{d?.approvedBy ? ` by ${d.approvedBy}` : ""}</span>
      {me.isManager && <span className="ml-auto flex flex-wrap gap-2">
        <button className={gb} onClick={() => a.run(() => api("commissions/accrue", { orgId, method: "POST", body: { from, to } }).then(load), "Commission recalculated from this month's till sales and refunds.")}>Recalculate</button>
        <a className={gb + " inline-flex items-center"} href={csvHref(`commissions/export?month=${month}`, orgId)}>Export CSV</a>
        <button className={pb} disabled={d?.status === "APPROVED" || d?.status === "EXPORTED"} onClick={() => a.run(() => api("commissions/approve", { orgId, method: "POST", body: { month } }).then(load), "Month approved and locked.")}>Approve period</button></span>}
    </div>
    <Msg {...a} />
    <div className={card}><table className="w-full text-sm"><thead><tr className={`text-left text-xs ${mu}`}><th>Staff</th><th>Sales</th><th>Refunds</th><th>Commission</th></tr></thead>
      <tbody>{(d?.people || []).map((p) => <tr key={p.email} className="border-t border-[var(--inaya-border)]"><td className="py-1 break-all">{p.email}</td><td>{p.sales}</td><td>{p.refunds}</td><td><b>{Number(p.commission).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></td></tr>)}
        {d && !d.people.length && <tr><td colSpan={4} className={`py-2 ${mu}`}>No commission for this month yet.</td></tr>}</tbody></table>
      <p className={`text-xs ${mu} mt-2`}>Refunds are deducted from the person who made the sale. Nobody can approve a month in which they earn commission.</p></div>
    {me.isManager && <div className={card + " space-y-2"}>
      <H>Commission rules</H>
      {rules.map((x) => <p key={x.id} className="text-sm">{x.percent}% {x.category ? `on ${x.category}` : "on all sales"} from {x.effectiveFrom}{x.supersededAt ? <span className={mu}> (replaced)</span> : ""}</p>)}
      <div className="grid gap-2 sm:grid-cols-4 items-end">
        <L t="Percent of net sales"><input className={f} inputMode="decimal" value={r.percent} onChange={(e) => setR({ ...r, percent: e.target.value })} /></L>
        <L t="Product category (blank = all)"><input className={f} value={r.category} onChange={(e) => setR({ ...r, category: e.target.value })} /></L>
        <L t="Starts"><input type="date" className={f} value={r.effectiveFrom} onChange={(e) => setR({ ...r, effectiveFrom: e.target.value })} /></L>
        <button className={pb} onClick={() => a.run(() => api("commissions/rules", { orgId, method: "POST", body: { percent: Number(r.percent), category: r.category || null, effectiveFrom: r.effectiveFrom } }).then(load), "Rule saved. Earlier months keep the rule that applied then.")}>Add rule</button>
      </div></div>}
  </div>;
}

// ------------------------------------------------------------------ Checklists and incidents (per branch)
function Checklists({ orgId, branch, me }) {
  const [date, setDate] = useState(() => localDay()); const [d, setD] = useState(null); const [inc, setInc] = useState([]); const [open, setOpen] = useState(null); const [ticks, setTicks] = useState([]); const a = useAction();
  const [tpl, setTpl] = useState({ name: "", type: "OPENING", items: "", dueTime: "" }); const [ni, setNi] = useState({ summary: "", severity: "LOW" });
  const load = useCallback(() => { if (branch) api(`checklists?locationId=${branch}&date=${date}`, { orgId }).then(setD).catch((e) => a.run(async () => { throw e; })); api("incidents?status=OPEN", { orgId }).then((x) => setInc(x.incidents)).catch(() => null); }, [orgId, branch, date]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  if (!branch) return <p className={`text-sm ${mu}`}>Choose one branch in "Working at" to see its checklists.</p>;
  const tick = (signOff) => a.run(() => api("checklists/tick", { orgId, method: "POST", body: { templateId: open.templateId, locationId: branch, date, ticks, signOff } }).then(() => { setOpen(null); load(); }), signOff ? "Checklist signed off." : "Progress saved.");
  return <div className="grid gap-3 md:grid-cols-2">
    <div className={card + " space-y-2"}>
      <div className="flex items-center gap-2"><H>Checklists</H><input type="date" className={f + " w-auto ml-auto"} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      {(d?.checklists || []).map((c) => <div key={c.templateId} className="border-t border-[var(--inaya-border)] pt-2">
        <div className="flex items-center gap-2"><b className="text-sm">{c.name}</b><span className={chip}>{c.state.replace("_", " ").toLowerCase()}</span><span className={`text-xs ${mu}`}>{c.done}/{c.total}{c.dueTime ? ` · due ${c.dueTime}` : ""}</span>
          {c.state !== "DONE" && <button className={gb + " ml-auto"} onClick={() => { setOpen(c); setTicks(c.items.map(() => false)); }}>Open</button>}</div>
        {open?.templateId === c.templateId && <div className="mt-2 space-y-1">{c.items.map((it, i) => <label key={i} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!ticks[i]} onChange={(e) => setTicks(ticks.map((t, j) => (j === i ? e.target.checked : t)))} />{it}</label>)}
          <div className="flex gap-2 pt-1"><button className={gb} onClick={() => tick(false)}>Save</button><button className={pb} onClick={() => tick(true)}>Sign off</button></div></div>}
      </div>)}
      {d && !d.checklists.length && <p className={`text-sm ${mu}`}>No checklists due on this day.</p>}
      {me.isManager && <div className="border-t border-[var(--inaya-border)] pt-2 grid gap-2 sm:grid-cols-2">
        <L t="New checklist name"><input className={f} value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} /></L>
        <L t="Type"><select className={f} value={tpl.type} onChange={(e) => setTpl({ ...tpl, type: e.target.value })}>{["OPENING", "CLOSING", "CASH_COUNT", "CLEANING_SAFETY", "STOCK_RECEIVING", "TEMPERATURE_MAINTENANCE", "HANDOVER", "CUSTOM"].map((t) => <option key={t} value={t}>{(t[0] + t.slice(1).toLowerCase()).replace(/_/g, " ")}</option>)}</select></L>
        <L t="Items (one per line)"><textarea className={f + " py-2"} rows={3} value={tpl.items} onChange={(e) => setTpl({ ...tpl, items: e.target.value })} /></L>
        <L t="Due by (optional)"><input type="time" className={f} value={tpl.dueTime} onChange={(e) => setTpl({ ...tpl, dueTime: e.target.value })} /></L>
        <button className={gb} onClick={() => a.run(() => api("checklists/templates", { orgId, method: "POST", body: { name: tpl.name, type: tpl.type, items: tpl.items.split("\n").map((s) => s.trim()).filter(Boolean), dueTime: tpl.dueTime || null, locationId: branch, recurrence: "DAILY" } }).then(load), "Checklist added for this branch.")}>Add checklist</button>
      </div>}
    </div>
    <div className={card + " space-y-2"}>
      <H>Open incidents</H>
      {inc.map((i) => <div key={i.id} className="border-t border-[var(--inaya-border)] pt-2 text-sm flex gap-2 items-start"><span className={chip}>{i.severity.toLowerCase()}</span><span className="flex-1">{i.summary}<br /><span className={`text-xs ${mu}`}>{i.reportedBy} · {new Date(i.at).toLocaleString()}</span></span>
        {me.isManager && <button className={gb} onClick={() => { const resolution = window.prompt("How was it resolved?"); if (resolution) a.run(() => api(`incidents/${i.id}/resolve`, { orgId, method: "POST", body: { resolution } }).then(load), "Incident resolved."); }}>Resolve</button>}</div>)}
      {!inc.length && <p className={`text-sm ${mu}`}>No open incidents.</p>}
      <div className="border-t border-[var(--inaya-border)] pt-2 grid gap-2 sm:grid-cols-3 items-end">
        <L t="Report an incident"><input className={f} value={ni.summary} placeholder="What happened" onChange={(e) => setNi({ ...ni, summary: e.target.value })} /></L>
        <L t="Severity"><select className={f} value={ni.severity} onChange={(e) => setNi({ ...ni, severity: e.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></L>
        <button className={gb} onClick={() => a.run(() => api("incidents", { orgId, method: "POST", body: { ...ni, locationId: branch } }).then(() => { setNi({ summary: "", severity: "LOW" }); load(); }), "Incident reported.")}>Report</button>
      </div>
      <Msg {...a} />
    </div>
  </div>;
}

// ------------------------------------------------------------------ Workforce reports and the daily brief (advisory only)
function Reports({ orgId, branch }) {
  const [range, setRange] = useState(() => ({ from: localDay(Date.now() - 6 * 86400000), to: localDay() })); const [d, setD] = useState(null); const [brief, setBrief] = useState(null); const a = useAction();
  const load = useCallback(() => { api(`reports?from=${range.from}T00:00:00.000Z&to=${range.to}T23:59:59.999Z${branch ? `&locationId=${branch}` : ""}`, { orgId }).then(setD).catch((e) => a.run(async () => { throw e; })); if (branch) api(`brief?locationId=${branch}&date=${localDay()}`, { orgId }).then(setBrief).catch(() => setBrief(null)); }, [orgId, branch, range]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const n = (v) => (v === null || v === undefined ? "–" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  return <div className="space-y-3">
    <div className={`${card} flex flex-wrap items-end gap-2`}>
      <L t="From"><input type="date" className={f} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></L>
      <L t="To"><input type="date" className={f} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></L>
      <a className={gb + " inline-flex items-center"} href={csvHref(`time/export?from=${range.from}T00:00:00.000Z&to=${range.to}T23:59:59.999Z`, orgId)}>Payroll CSV</a>
    </div>
    <Msg {...a} />
    {d && <div className="grid gap-2 grid-cols-2 md:grid-cols-5">{[["Hours worked", d.totals.workedHours], ["Hours scheduled", d.totals.scheduledHours], ["Late arrivals", d.totals.lateArrivals], ["Checklists signed off", `${d.totals.checklistsSignedOff}/${d.totals.checklistsStarted}`], ["Labour cost (estimate)", d.totals.labourCostEstimate]].map(([l, v]) => <div key={l} className={card}><p className={`text-xs ${mu}`}>{l}</p><p className="text-lg font-bold">{typeof v === "string" ? v : n(v)}</p></div>)}</div>}
    {d && <div className={card + " overflow-x-auto"}><table className="w-full text-sm min-w-[600px]"><thead><tr className={`text-left text-xs ${mu}`}><th>Staff</th><th>Worked h</th><th>Scheduled h</th><th>Late days</th><th>Sales</th><th>Sales total</th><th>Per hour</th></tr></thead>
      <tbody>{d.people.map((p) => <tr key={p.email} className="border-t border-[var(--inaya-border)]"><td className="py-1 break-all">{p.email}</td><td>{n(p.workedHours)}</td><td>{n(p.scheduledHours)}</td><td>{p.lateDays}</td><td>{p.sales}</td><td>{n(p.salesTotal)}</td><td>{n(p.salesPerHour)}</td></tr>)}</tbody></table>
      {d.notes.map((x) => <p key={x} className={`text-xs ${mu} mt-1`}>{x}</p>)}</div>}
    {brief && <div className={card + " space-y-1"}><H>Today at this branch (suggestions only)</H>{brief.summary.map((s) => <p key={s} className="text-sm">{s}</p>)}{brief.suggestions.map((s) => <p key={s} className="text-sm text-[var(--inaya-text-secondary)]">• {s}</p>)}<p className={`text-xs ${mu}`}>Inaya only suggests; a manager decides.</p></div>}
  </div>;
}
