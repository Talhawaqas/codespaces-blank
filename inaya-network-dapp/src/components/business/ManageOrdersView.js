"use client";

// src/components/business/ManageOrdersView.js -- Manage Orders SOW: one place for Work Orders, Repair Orders, the
// technician scheduler, the Purchase Order register, cheques, the manager review queue and settings. Every action is
// re-checked on the server (src/lib/ops/*); hiding a button here is only a convenience.

import { useState, useEffect, useCallback } from "react";
import { useErpSection } from "./erp/ErpNavContext";

const f = "w-full min-h-[38px] bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-lg px-2.5 text-sm text-[var(--inaya-text-primary)]";
const pb = "min-h-[38px] px-3 rounded-lg text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-40";
const gb = "min-h-[38px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] disabled:opacity-40";
const db = "min-h-[38px] px-3 rounded-lg text-sm font-semibold border border-red-400 text-red-600 bg-[var(--inaya-surface)] disabled:opacity-40";
const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl p-3";
const mu = "text-[var(--inaya-text-muted)]";
const chip = "inline-block text-xs px-2 py-0.5 rounded-md border border-[var(--inaya-border)]";
const th = "text-left text-xs font-semibold text-[var(--inaya-text-secondary)] px-2 py-1.5 border-b border-[var(--inaya-border)]";
const td = "px-2 py-1.5 text-sm border-b border-[var(--inaya-border)] align-top";
const key = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(36).slice(2)}`);
const dt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "–");
const dOnly = (iso) => (iso ? new Date(iso).toLocaleDateString() : "–");
const human = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (x) => x.toUpperCase());
const localInput = (iso) => { if (!iso) return ""; const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const money = (n, cur = "") => (n === null || n === undefined ? "–" : `${cur ? `${cur} ` : ""}${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);

function mkApi(orgId) {
  return async (path, { method = "GET", body, raw, query } = {}) => {
    const qs = new URLSearchParams({ ...(method === "GET" || raw ? { orgId } : {}), ...(query || {}) }).toString();
    const r = await fetch(`/api/orgs/ops/${path}${qs ? `?${qs}` : ""}`, { method, credentials: "include", headers: raw ? { "Content-Type": "application/octet-stream" } : { "Content-Type": "application/json" }, ...(raw ? { body: raw } : method !== "GET" ? { body: JSON.stringify({ orgId, ...(body || {}) }) } : {}) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { code: d.code, problems: d.problems }); return d;
  };
}
const Msg = ({ ok, err }) => <>{ok && <p className="text-sm text-emerald-600">{ok}</p>}{err && <p className="text-sm text-red-500" role="alert">{err}</p>}</>;
const H = ({ children }) => <h3 className="font-bold text-sm text-[var(--inaya-text-primary)] mb-2">{children}</h3>;
const L = ({ t, children }) => <label className="block text-xs font-semibold text-[var(--inaya-text-secondary)] space-y-1"><span>{t}</span>{children}</label>;
function useAction() {
  const [ok, setOk] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const run = async (fn, msg) => { setOk(""); setErr(""); setBusy(true); try { const r = await fn(); if (msg) setOk(typeof msg === "function" ? msg(r) : msg); return r; } catch (e) { setErr(e.message); return { __error: e }; } finally { setBusy(false); } };
  return { ok, err, busy, run, setErr };
}
const STATE_LABEL = { NOT_SCHEDULED: "Not scheduled", SCHEDULED_NOT_STARTED: "Scheduled, not started", CLOCKED_IN_NO_JOB: "Clocked in, no job started", IN_PROGRESS: "Job in progress", PAUSED: "Paused", AWAITING_PARTS: "Awaiting parts", AWAITING_CUSTOMER_APPROVAL: "Awaiting customer approval", AWAITING_INSPECTION: "Awaiting inspection", COMPLETED: "Completed", OVERDUE: "Overdue / review" };
const STATE_TONE = { IN_PROGRESS: "border-emerald-500 text-emerald-700", PAUSED: "border-amber-500 text-amber-700", OVERDUE: "border-red-500 text-red-600", CLOCKED_IN_NO_JOB: "border-red-400 text-red-600", AWAITING_PARTS: "border-amber-500 text-amber-700" };
const ACTIONS = {
  WO: { submit: ["DRAFT"], approve: ["AWAITING_APPROVAL"], reject: ["AWAITING_APPROVAL"], hold: ["READY", "SCHEDULED", "ASSIGNED", "IN_PROGRESS"], await_parts: ["READY", "SCHEDULED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD"], release: ["ON_HOLD", "AWAITING_PARTS"], inspect_pass: ["AWAITING_INSPECTION"], inspect_fail: ["AWAITING_INSPECTION"], close: ["COMPLETED"], cancel: ["DRAFT", "AWAITING_APPROVAL", "READY", "SCHEDULED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD", "AWAITING_PARTS", "AWAITING_INSPECTION"] },
  RO: { check_in: ["DRAFT"], inspect: ["RECEIVED"], diagnose: ["RECEIVED", "INSPECTION"], await_parts: ["APPROVED", "READY", "SCHEDULED", "IN_REPAIR"], ready: ["APPROVED", "AWAITING_PARTS"], qc_pass: ["QUALITY_CHECK"], qc_fail: ["QUALITY_CHECK"], complete: ["READY_FOR_COLLECTION"], close: ["INVOICED"], cancel: ["DRAFT", "RECEIVED", "INSPECTION", "DIAGNOSIS", "ESTIMATE_PREPARED", "AWAITING_APPROVAL", "APPROVED", "AWAITING_PARTS", "READY", "SCHEDULED", "IN_REPAIR", "QUALITY_CHECK", "READY_FOR_COLLECTION"] },
};
const NEEDS_REASON = ["reject", "hold", "inspect_fail", "qc_fail", "cancel"];
const ACTION_LABEL = { submit: "Submit for approval", approve: "Approve", reject: "Send back", hold: "Put on hold", await_parts: "Awaiting parts", release: "Release", inspect_pass: "Pass inspection", inspect_fail: "Fail inspection (rework)", close: "Close", cancel: "Cancel", check_in: "Check in", inspect: "Start inspection", diagnose: "Start diagnosis", ready: "Ready to schedule", qc_pass: "Pass quality check", qc_fail: "Fail quality check", complete: "Collected / delivered" };

export default function ManageOrdersView({ orgId }) {
  const api = useCallback(mkApi(orgId), [orgId]);
  const [me, setMe] = useState(null); const [err, setErr] = useState("");
  const [lists, setLists] = useState({ branches: [], members: [], departments: [] });
  useEffect(() => { api("me").then(setMe).catch((e) => setErr(e.message)); }, [api]);
  useEffect(() => { if (!me?.entitled || !me.role && !me.finance) return; Promise.all(["branches", "departments", ...(me.can.view_all ? ["members"] : [])].map((k) => api("lookups", { query: { kind: k } }).then((r) => [k, r.items]).catch(() => [k, []]))).then((rs) => setLists((p) => ({ ...p, ...Object.fromEntries(rs) }))); }, [api, me]);
  const tabs = !me ? [] : [
    ...(me.can.view_all ? [["dash", "Dashboard"], ["wo", "Work Orders"], ["ro", "Repair Orders"], ["sched", "Scheduler"], ["po", "Purchase Orders"]] : []),
    ...(me.finance ? [["chq", "Checks"]] : []), ...(me.can.work ? [["mine", "My jobs"]] : []), ...(me.can.exceptions ? [["review", "Review queue"]] : []), ...(me.can.settings ? [["settings", "Settings"]] : []),
  ];
  const [tab, setTab] = useErpSection(tabs[0]?.[0] || "mine", tabs);
  const [openJob, setOpenJob] = useState(null);
  if (err) return <p className="text-sm text-red-500">{err}</p>; if (!me) return <p className={`text-sm ${mu}`}>Loading…</p>;
  if (!me.entitled) return <div className={`${card} max-w-lg`}><H>Manage Orders isn&apos;t enabled</H><p className={`text-sm ${mu}`}>Work orders, repair orders, technician scheduling and cheques are part of the Business and Enterprise plans. Contact Inaya to switch it on.</p></div>;
  if (!tabs.length) return <div className={`${card} max-w-lg`}><H>No Manage Orders role</H><p className={`text-sm ${mu}`}>Ask an owner or admin to give you a role (manager, dispatcher, service advisor, technician or storekeeper) in Manage Orders › Settings.</p></div>;
  const ctx = { api, me, lists, orgId, open: (id) => setOpenJob(id) };
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2" role="tablist" data-erp-tabs>{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? pb : gb} onClick={() => { setTab(k); setOpenJob(null); }}>{l}</button>)}</div>
    {openJob ? <JobDetail ctx={ctx} id={openJob} onClose={() => setOpenJob(null)} /> : <>
      {tab === "dash" && <Dashboard ctx={ctx} />}
      {tab === "wo" && <Jobs ctx={ctx} type="WO" />}
      {tab === "ro" && <Jobs ctx={ctx} type="RO" />}
      {tab === "sched" && <Scheduler ctx={ctx} />}
      {tab === "po" && <PoRegister ctx={ctx} />}
      {tab === "chq" && <Cheques ctx={ctx} />}
      {tab === "mine" && <MyJobs ctx={ctx} />}
      {tab === "review" && <Review ctx={ctx} />}
      {tab === "settings" && <Settings ctx={ctx} />}
    </>}
  </div>;
}

// ---------------------------------------------------------------- dashboard
function Dashboard({ ctx }) {
  const [d, setD] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { ctx.api("dashboard").then(setD).catch((e) => setErr(e.message)); }, [ctx]);
  if (err) return <Msg err={err} />; if (!d) return <p className={`text-sm ${mu}`}>Loading…</p>;
  const tiles = [["Open orders", d.open], ["Unassigned", d.unassigned], ["Scheduled today", d.scheduledToday], ["In progress", d.inProgress], ["Awaiting parts", d.awaitingParts], ["Awaiting customer approval", d.awaitingCustomerApproval], ["Awaiting inspection / QC", d.awaitingInspection], ["Overdue", d.overdue], ["Completed", d.completed], ["Average turnaround (h)", d.averageTurnaroundHours ?? "–"], ["Rework rate", d.reworkRatePct === null ? "–" : `${d.reworkRatePct}%`], ["Repeat repairs (30 days)", d.repeatRepairRatePct === null ? "–" : `${d.repeatRepairRatePct}%`]];
  return <div className="space-y-3"><div className="grid grid-cols-2 md:grid-cols-4 gap-2">{tiles.map(([l, v]) => <div key={l} className={card}><div className={`text-xs ${mu}`}>{l}</div><div className="text-xl font-bold">{v}</div></div>)}</div>
    <div className={card}><H>Labour: estimated vs actual (completed orders)</H><p className="text-sm">Estimated {d.labour.estimatedMinutes} min · Actual {d.labour.actualMinutes} min{d.labour.variancePct !== null ? ` · ${d.labour.variancePct > 0 ? "+" : ""}${d.labour.variancePct}%` : ""}</p>{d.cost && <p className={`text-sm ${mu}`}>Estimated cost {money(d.cost.estimated)} · Parts used at cost {money(d.cost.partsUsed)}</p>}</div>
    <div className={card}><H>Workload by technician (open jobs)</H>{Object.keys(d.workloadByTechnician).length ? <ul className="text-sm">{Object.entries(d.workloadByTechnician).map(([e, n]) => <li key={e}>{e}: {n}</li>)}</ul> : <p className={`text-sm ${mu}`}>No open assignments.</p>}</div></div>;
}

// ---------------------------------------------------------------- registers
function Jobs({ ctx, type }) {
  const [rows, setRows] = useState(null); const [total, setTotal] = useState(0); const [fl, setFl] = useState({ q: "", status: "", warehouseId: "", priority: "", sort: "updated" }); const [creating, setCreating] = useState(false); const a = useAction();
  const load = useCallback(() => ctx.api("jobs", { query: Object.fromEntries(Object.entries({ type, ...fl }).filter(([, v]) => v)) }).then((r) => { setRows(r.jobs); setTotal(r.total); }).catch((e) => a.setErr(e.message)), [ctx, type, fl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const canCreate = type === "RO" ? ctx.me.can.create_ro : ctx.me.can.create_wo;
  const statuses = type === "RO" ? ["DRAFT", "RECEIVED", "DIAGNOSIS", "AWAITING_APPROVAL", "APPROVED", "AWAITING_PARTS", "SCHEDULED", "IN_REPAIR", "QUALITY_CHECK", "READY_FOR_COLLECTION", "COMPLETED", "INVOICED", "CLOSED", "CANCELLED"] : ["DRAFT", "AWAITING_APPROVAL", "READY", "SCHEDULED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD", "AWAITING_PARTS", "AWAITING_INSPECTION", "COMPLETED", "CLOSED", "CANCELLED"];
  return <div className="space-y-3">
    <div className={`${card} flex flex-wrap gap-2 items-end`}>
      <L t="Search"><input className={f} value={fl.q} onChange={(e) => setFl({ ...fl, q: e.target.value })} placeholder={type === "RO" ? "RO number, customer, vehicle…" : "WO number or title"} /></L>
      <L t="Status"><select className={f} value={fl.status} onChange={(e) => setFl({ ...fl, status: e.target.value })}><option value="">All</option>{statuses.map((s) => <option key={s} value={s}>{human(s)}</option>)}</select></L>
      <L t="Branch"><select className={f} value={fl.warehouseId} onChange={(e) => setFl({ ...fl, warehouseId: e.target.value })}><option value="">All my branches</option>{ctx.lists.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></L>
      <L t="Priority"><select className={f} value={fl.priority} onChange={(e) => setFl({ ...fl, priority: e.target.value })}><option value="">Any</option>{["URGENT", "HIGH", "NORMAL", "LOW"].map((p) => <option key={p}>{p}</option>)}</select></L>
      <L t="Sort"><select className={f} value={fl.sort} onChange={(e) => setFl({ ...fl, sort: e.target.value })}><option value="updated">Last update</option><option value="created">Created</option><option value="due">Due date</option><option value="priority">Priority</option><option value="status">Status</option></select></L>
      {canCreate && <button className={pb} onClick={() => setCreating((x) => !x)}>{creating ? "Close" : type === "RO" ? "New repair order" : "New work order"}</button>}
    </div>
    {creating && <NewJob ctx={ctx} type={type} onDone={(j) => { setCreating(false); load(); ctx.open(j.id); }} />}
    <Msg err={a.err} />
    {!rows ? <p className={`text-sm ${mu}`}>Loading…</p> : !rows.length ? <p className={`text-sm ${mu}`}>No {type === "RO" ? "repair" : "work"} orders match.</p> :
      <div className="overflow-x-auto"><table className="w-full"><thead><tr>{["Ref", type === "RO" ? "Customer / asset" : "Title", "Branch", "Status", "Priority", "Technician", "Scheduled", "Due", "Last activity"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((j) => <tr key={j.id} className="cursor-pointer hover:bg-[var(--inaya-surface-2,rgba(0,0,0,0.03))]" onClick={() => ctx.open(j.id)}>
          <td className={td}><b>{j.number}</b></td><td className={td}>{type === "RO" ? <>{j.customerName || "–"}<div className={`text-xs ${mu}`}>{j.intake?.assetLabel || j.title}</div></> : j.title}</td>
          <td className={td}>{ctx.lists.branches.find((b) => b.id === j.warehouseId)?.name || "–"}</td><td className={td}><span className={chip}>{human(j.status)}</span></td><td className={td}>{j.priority}</td>
          <td className={td}>{j.assignments.map((x) => x.email.split("@")[0]).join(", ") || <span className={mu}>Unassigned</span>}</td><td className={td}>{dt(j.plannedStart)}</td><td className={td}>{dOnly(j.dueAt)}</td><td className={td}>{dt(j.lastActivityAt)}</td></tr>)}</tbody></table>
        <p className={`text-xs ${mu} mt-1`}>{total} in total{total > rows.length ? `; showing the first ${rows.length}` : ""}.</p></div>}
  </div>;
}

function Picker({ ctx, kind, value, onChange, placeholder }) {
  const [q, setQ] = useState(""); const [items, setItems] = useState([]);
  useEffect(() => { const t = setTimeout(() => ctx.api("lookups", { query: { kind, q } }).then((r) => setItems(r.items)).catch(() => setItems([])), 250); return () => clearTimeout(t); }, [ctx, kind, q]);
  return <div className="space-y-1"><input className={f} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder || "Search…"} /><select className={f} value={value || ""} onChange={(e) => onChange(e.target.value, items.find((i) => i.id === e.target.value))}><option value="">Choose…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name || i.vendor}{i.sku ? ` (${i.sku})` : ""}{i.amount !== undefined ? ` · ${money(i.amount, i.currency)}` : ""}{i.email ? ` · ${i.email}` : ""}</option>)}</select></div>;
}

function NewJob({ ctx, type, onDone }) {
  const [v, setV] = useState({ title: "", description: "", warehouseId: ctx.lists.branches[0]?.id || "", priority: "NORMAL", category: "", dueAt: "", plannedStart: "", estMinutes: "", skills: "", checklist: "", contactId: "", assetId: "", reportedIssue: "", accessories: "", condition: "", expectedAt: "", requireEvidence: false });
  const [assets, setAssets] = useState([]); const [newAsset, setNewAsset] = useState({ type: "", make: "", model: "", identifier: "" }); const a = useAction();
  useEffect(() => { if (type === "RO" && v.contactId) ctx.api("assets", { query: { contactId: v.contactId } }).then((r) => setAssets(r.assets)).catch(() => setAssets([])); }, [ctx, type, v.contactId]);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = () => a.run(async () => {
    let assetId = v.assetId;
    if (type === "RO" && !assetId && newAsset.type) assetId = (await ctx.api("assets", { method: "POST", body: { ...newAsset, contactId: v.contactId } })).asset.id;
    const r = await ctx.api("jobs", { method: "POST", body: { type, title: v.title, description: v.description, warehouseId: v.warehouseId, priority: v.priority, category: v.category, dueAt: v.dueAt || null, plannedStart: v.plannedStart ? new Date(v.plannedStart).toISOString() : null, estMinutes: v.estMinutes ? Number(v.estMinutes) : null, skills: v.skills.split(",").map((s) => s.trim()).filter(Boolean), checklist: v.checklist.split("\n").map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t.replace(/^\[photo\]\s*/i, ""), required: true, evidence: /^\[photo\]/i.test(t) })), requireEvidence: v.requireEvidence, contactId: v.contactId || null, assetId: assetId || null, intake: type === "RO" ? { reportedIssue: v.reportedIssue, accessories: v.accessories, condition: v.condition, expectedAt: v.expectedAt || null } : undefined } });
    onDone(r.job);
  });
  return <div className={`${card} space-y-2`}>
    <H>{type === "RO" ? "New repair order (intake)" : "New work order"}</H>
    <div className="grid md:grid-cols-3 gap-2">
      <L t="Title"><input className={f} value={v.title} onChange={set("title")} /></L>
      <L t="Branch"><select className={f} value={v.warehouseId} onChange={set("warehouseId")}>{ctx.lists.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></L>
      <L t="Priority"><select className={f} value={v.priority} onChange={set("priority")}>{["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => <option key={p}>{p}</option>)}</select></L>
      <L t="Category"><input className={f} value={v.category} onChange={set("category")} placeholder={type === "RO" ? "Repair" : "Maintenance, installation…"} /></L>
      <L t="Planned start"><input type="datetime-local" className={f} value={v.plannedStart} onChange={set("plannedStart")} /></L>
      <L t="Due date"><input type="date" className={f} value={v.dueAt} onChange={set("dueAt")} /></L>
      <L t="Estimated minutes"><input inputMode="numeric" className={f} value={v.estMinutes} onChange={set("estMinutes")} /></L>
      <L t="Required skills (comma separated)"><input className={f} value={v.skills} onChange={set("skills")} placeholder="electrical, hydraulics" /></L>
      <L t="Require a photo/document before completion"><input type="checkbox" checked={v.requireEvidence} onChange={set("requireEvidence")} /></L>
    </div>
    <L t="Description"><textarea className={`${f} min-h-[70px]`} value={v.description} onChange={set("description")} /></L>
    <L t="Checklist (one step per line; start a line with [photo] to require a photo for that step)"><textarea className={`${f} min-h-[70px]`} value={v.checklist} onChange={set("checklist")} /></L>
    {type === "RO" && <div className="grid md:grid-cols-2 gap-2">
      <L t="Customer (CRM)"><Picker ctx={ctx} kind="contacts" value={v.contactId} onChange={(id) => setV({ ...v, contactId: id, assetId: "" })} placeholder="Search customers" /></L>
      <L t="Asset">{assets.length ? <select className={f} value={v.assetId} onChange={set("assetId")}><option value="">New asset…</option>{assets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select> : <p className={`text-xs ${mu}`}>No saved assets for this customer yet.</p>}
        {!v.assetId && <div className="grid grid-cols-2 gap-1 mt-1">{[["type", "Type (car, phone…)"], ["make", "Make"], ["model", "Model"], ["identifier", "Serial / registration"]].map(([k, p]) => <input key={k} className={f} placeholder={p} value={newAsset[k]} onChange={(e) => setNewAsset({ ...newAsset, [k]: e.target.value })} />)}</div>}</L>
      <L t="Customer-reported issue"><textarea className={`${f} min-h-[60px]`} value={v.reportedIssue} onChange={set("reportedIssue")} /></L>
      <L t="Condition at intake"><textarea className={`${f} min-h-[60px]`} value={v.condition} onChange={set("condition")} /></L>
      <L t="Accessories received"><input className={f} value={v.accessories} onChange={set("accessories")} /></L>
      <L t="Expected completion"><input type="date" className={f} value={v.expectedAt} onChange={set("expectedAt")} /></L>
    </div>}
    <button className={pb} disabled={a.busy} onClick={save}>Create</button><Msg ok={a.ok} err={a.err} />
  </div>;
}

// ---------------------------------------------------------------- job detail
function JobDetail({ ctx, id, onClose }) {
  const [d, setD] = useState(null); const a = useAction(); const [reason, setReason] = useState("");
  const load = useCallback(() => ctx.api(`jobs/${id}`).then(setD).catch((e) => a.setErr(e.message)), [ctx, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="space-y-2"><button className={gb} onClick={onClose}>← Back</button><Msg err={a.err} /><p className={`text-sm ${mu}`}>Loading…</p></div>;
  const j = d.job; const can = ctx.me.can; const mine = j.assignments.some((x) => x.email === ctx.me.email) || (j.workers || []).some((w) => w.email === ctx.me.email);
  const act = (path, body, msg) => a.run(() => ctx.api(`jobs/${id}/${path}`, { method: "POST", body }), msg).then((r) => { if (!r?.__error) load(); return r; });
  const allowed = Object.entries(ACTIONS[j.type]).filter(([k, from]) => from.includes(j.status) && (["approve", "reject", "inspect_pass", "inspect_fail", "close", "cancel", "qc_pass", "qc_fail", "hold"].includes(k) ? can.approve : can.edit_job));
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2"><button className={gb} onClick={onClose}>← Back</button><h2 className="text-lg font-bold">{j.number} · {j.title}</h2><span className={chip}>{human(j.status)}</span><span className={chip}>{j.priority}</span>{j.pendingChangeOrder && <span className={`${chip} border-amber-500 text-amber-700`}>Change order awaiting customer</span>}</div>
    <Msg ok={a.ok} err={a.err} />
    <div className="grid lg:grid-cols-3 gap-3">
      <div className="lg:col-span-2 space-y-3">
        <div className={card}><H>Summary</H><p className="text-sm whitespace-pre-wrap">{j.description || <span className={mu}>No description.</span>}</p>
          <div className={`text-xs ${mu} mt-2 grid grid-cols-2 gap-1`}><span>Branch: {ctx.lists.branches.find((b) => b.id === j.warehouseId)?.name || "–"}</span><span>Category: {j.category}</span><span>Planned: {dt(j.plannedStart)} – {dt(j.plannedEnd)}</span><span>Due: {dOnly(j.dueAt)}</span><span>Estimate: {j.estMinutes ? `${j.estMinutes} min` : "–"}</span><span>Skills: {j.skills.join(", ") || "–"}</span>{j.customerName && <span>Customer: {j.customerName}</span>}{d.asset && <span>Asset: {d.asset.label}</span>}</div>
          {allowed.length > 0 && <div className="mt-3 space-y-2"><input className={f} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (needed for send back, hold, fail, cancel)" /><div className="flex flex-wrap gap-2">{allowed.map(([k]) => <button key={k} className={["cancel", "reject", "inspect_fail", "qc_fail"].includes(k) ? db : gb} disabled={a.busy || (NEEDS_REASON.includes(k) && reason.trim().length < 3)} onClick={() => act("transition", { action: k, reason }, `${ACTION_LABEL[k] || human(k)}: done.`).then(() => setReason(""))}>{ACTION_LABEL[k] || human(k)}</button>)}</div></div>}
        </div>
        {mine && can.work && <TechActions ctx={ctx} j={j} onDone={load} />}
        {j.type === "RO" && <RepairPanel ctx={ctx} d={d} act={act} reload={load} />}
        <Checklist j={j} act={act} canTick={mine || can.edit_job} />
        <Parts ctx={ctx} j={j} reload={load} mine={mine} />
        <Evidence ctx={ctx} j={j} reload={load} canAdd={mine || can.edit_job} />
        <Notes j={j} act={act} canInternal={can.edit_job} />
        <div className={card}><H>Activity and history</H><ul className="text-xs space-y-1 max-h-72 overflow-auto">{[...d.activity.map((x) => ({ at: x.at, t: `${x.email}: ${human(x.type)}${x.reason ? ` (${human(x.reason)})` : ""}${x.note ? ` – ${x.note}` : ""}` })), ...j.history.map((h) => ({ at: h.at, t: `${h.by}: ${h.action ? human(h.action) : h.change ? `edited ${h.change.join(", ")}` : "created"}${h.to ? ` → ${human(h.to)}` : ""}${h.reason ? ` (${h.reason})` : ""}${h.email ? ` [${h.email}]` : ""}` }))].sort((x, y) => new Date(y.at) - new Date(x.at)).map((x, i) => <li key={i}><span className={mu}>{dt(x.at)}</span> {x.t}</li>)}</ul></div>
      </div>
      <div className="space-y-3">
        {can.schedule && <Assign ctx={ctx} j={j} reload={load} />}
        {can.edit_job && <PoLink ctx={ctx} j={j} act={act} />}
      </div>
    </div>
  </div>;
}

function TechActions({ ctx, j, onDone }) {
  const me = (j.workers || []).find((w) => w.email === ctx.me.email) || { state: "NOT_STARTED" }; const a = useAction();
  const [reason, setReason] = useState("break"); const [note, setNote] = useState(""); const [site, setSite] = useState(""); const [flag, setFlag] = useState("blocker");
  const send = (type, extra = {}) => a.run(() => ctx.api(`jobs/${j.id}/activity`, { method: "POST", body: { type, idempotencyKey: key(), source: "web", ...extra } }), "Saved.").then((r) => { if (!r?.__error) onDone(); });
  return <div className={card}><H>My work on this job</H><p className="text-sm mb-2">You: <b>{human(me.state)}</b>{me.minutes ? ` · ${me.minutes} min logged` : ""}</p>
    <div className="flex flex-wrap gap-2">
      {!me.ack && <button className={gb} disabled={a.busy} onClick={() => send("ACK")}>Acknowledge</button>}
      {me.state === "NOT_STARTED" && <><input className={`${f} max-w-[160px]`} placeholder="Site code (if any)" value={site} onChange={(e) => setSite(e.target.value)} /><button className={pb} disabled={a.busy} onClick={() => send("START", site ? { siteCode: site } : {})}>Start job</button></>}
      {me.state === "ACTIVE" && <><select className={`${f} max-w-[180px]`} value={reason} onChange={(e) => setReason(e.target.value)}>{["break", "parts", "tools", "customer_approval", "technical_review", "safety", "end_of_shift", "other"].map((r) => <option key={r} value={r}>{human(r)}</option>)}</select><button className={gb} disabled={a.busy} onClick={() => send("PAUSE", { reason, note })}>Pause</button><button className={pb} disabled={a.busy} onClick={() => send("SUBMIT", { note })}>Submit for completion</button></>}
      {me.state === "PAUSED" && <><button className={pb} disabled={a.busy} onClick={() => send("RESUME")}>Resume</button><button className={gb} disabled={a.busy} onClick={() => send("SUBMIT", { note })}>Submit for completion</button></>}
    </div>
    <input className={`${f} mt-2`} placeholder="Note (optional; needed for 'other')" value={note} onChange={(e) => setNote(e.target.value)} />
    <div className="flex gap-2 mt-2"><select className={`${f} max-w-[200px]`} value={flag} onChange={(e) => setFlag(e.target.value)}>{["blocker", "safety", "customer_approval", "parts"].map((r) => <option key={r} value={r}>{human(r)}</option>)}</select><button className={db} disabled={a.busy} onClick={() => send("FLAG", { reason: flag, note })}>Flag to manager</button></div>
    <Msg ok={a.ok} err={a.err} /></div>;
}

function Checklist({ j, act, canTick }) {
  if (!j.checklist.length) return null;
  return <div className={card}><H>Checklist</H><ul className="space-y-1">{j.checklist.map((x) => <li key={x.id} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={!!x.done} disabled={!canTick} onChange={(e) => act("checklist", { itemId: x.id, done: e.target.checked })} aria-label={x.text} /><span>{x.text}{x.required && <span className={`${mu} text-xs`}> (required)</span>}{x.evidence && <span className="text-xs text-amber-700"> · photo needed</span>}{x.done && x.by && <span className={`${mu} text-xs`}> · {x.by} {dt(x.at)}</span>}</span></li>)}</ul></div>;
}

function Parts({ ctx, j, reload, mine }) {
  const a = useAction(); const [pid, setPid] = useState(""); const [qty, setQty] = useState("1");
  const can = ctx.me.can; const canAdd = can.edit_job || mine;
  const doAct = (partId, action, extra = {}) => a.run(() => ctx.api(`jobs/${j.id}/parts/${partId}`, { method: "POST", body: { action, idempotencyKey: key(), ...extra } }), "Done.").then((r) => { if (!r?.__error) reload(); });
  return <div className={card}><H>Parts and materials</H>
    {j.parts.length ? <table className="w-full mb-2"><thead><tr>{["Item", "Qty", "Reserved", "Used", "Returned", ""].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead><tbody>{j.parts.map((p) => <tr key={p.id}><td className={td}>{p.name}{p.requested && !p.approved && <span className="text-xs text-amber-700"> · requested</span>}</td><td className={td}>{p.qty}</td><td className={td}>{p.reserved}</td><td className={td}>{p.consumed}</td><td className={td}>{p.returned}</td>
      <td className={`${td} space-x-1 whitespace-nowrap`}>{!p.approved && (can.edit_job || can.parts) && <button className={gb} onClick={() => doAct(p.id, "approve")}>Approve</button>}
        {p.approved && can.parts && p.qty - p.reserved - p.consumed > 0 && <button className={gb} onClick={() => doAct(p.id, "reserve")}>Reserve</button>}
        {p.approved && (can.parts || mine) && p.qty - p.consumed > 0 && <button className={gb} onClick={() => { const q = window.prompt("Quantity used", String(p.qty - p.consumed)); if (q) doAct(p.id, "consume", { quantity: Number(q) }); }}>Record used</button>}
        {can.parts && p.consumed - p.returned > 0 && <button className={gb} onClick={() => { const q = window.prompt("Quantity returned unused", "1"); if (q) doAct(p.id, "return", { quantity: Number(q) }); }}>Return</button>}
        {can.parts && p.reserved > 0 && <button className={gb} onClick={() => doAct(p.id, "release")}>Release</button>}</td></tr>)}</tbody></table> : <p className={`text-sm ${mu} mb-2`}>No parts yet.</p>}
    {canAdd && <div className="grid md:grid-cols-[1fr_90px_auto] gap-2 items-end"><L t="Product"><Picker ctx={ctx} kind="products" value={pid} onChange={setPid} /></L><L t="Qty"><input className={f} value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" /></L><button className={pb} disabled={!pid || a.busy} onClick={() => a.run(() => ctx.api(`jobs/${j.id}/parts`, { method: "POST", body: { productId: pid, quantity: Number(qty), request: !can.edit_job } }), can.edit_job ? "Part added." : "Parts request sent to your manager.").then((r) => { if (!r?.__error) reload(); })}>{can.edit_job ? "Add part" : "Request part"}</button></div>}
    <p className={`text-xs ${mu} mt-1`}>Stock moves only through Inventory: reserve holds it, &quot;record used&quot; takes it off the shelf once, return puts unused parts back.</p><Msg ok={a.ok} err={a.err} /></div>;
}

function Evidence({ ctx, j, reload, canAdd }) {
  const a = useAction(); const [item, setItem] = useState(""); const [caption, setCaption] = useState("");
  const upload = (file) => a.run(async () => {
    if (file.size > 4 * 1024 * 1024) throw new Error("Files must be 4 MB or smaller.");
    return ctx.api(`jobs/${j.id}/evidence`, { method: "POST", raw: await file.arrayBuffer(), query: { filename: file.name, caption, ...(item ? { checklistItemId: item } : {}) } });
  }, "Uploaded.").then((r) => { if (!r?.__error) { setCaption(""); reload(); } });
  return <div className={card}><H>Photos and documents</H>
    {j.evidence.length ? <ul className="text-sm space-y-1 mb-2">{j.evidence.map((e) => <li key={e.id}><a className="underline" href={`/api/orgs/ops/files/${e.fileId}?orgId=${ctx.orgId}`} target="_blank" rel="noopener noreferrer">{e.name}</a>{e.caption ? ` – ${e.caption}` : ""} <span className={`${mu} text-xs`}>{e.by} {dt(e.at)}</span></li>)}</ul> : <p className={`text-sm ${mu} mb-2`}>Nothing uploaded yet.</p>}
    {canAdd && <div className="grid md:grid-cols-3 gap-2 items-end"><L t="For checklist step (optional)"><select className={f} value={item} onChange={(e) => setItem(e.target.value)}><option value="">General</option>{j.checklist.map((x) => <option key={x.id} value={x.id}>{x.text}</option>)}</select></L><L t="Caption"><input className={f} value={caption} onChange={(e) => setCaption(e.target.value)} /></L><L t="File (photo or PDF, up to 4 MB)"><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="text-sm" disabled={a.busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></L></div>}
    <Msg ok={a.ok} err={a.err} /></div>;
}

function Notes({ j, act, canInternal }) {
  const [t, setT] = useState(""); const [internal, setInternal] = useState(false);
  return <div className={card}><H>Notes and instructions</H><ul className="text-sm space-y-1 mb-2">{j.notes.map((n) => <li key={n.id}><b>{n.by}</b> <span className={`${mu} text-xs`}>{dt(n.at)}{n.internal ? " · internal" : ""}</span><div className="whitespace-pre-wrap">{n.text}</div></li>)}</ul>
    <textarea className={`${f} min-h-[60px]`} value={t} onChange={(e) => setT(e.target.value)} placeholder="Add a note or instruction" />
    <div className="flex items-center gap-3 mt-1">{canInternal && <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal (not shown to technicians)</label>}<button className={gb} disabled={!t.trim()} onClick={() => act("notes", { text: t, internal }).then(() => setT(""))}>Add note</button></div></div>;
}

function Assign({ ctx, j, reload }) {
  const a = useAction(); const [techs, setTechs] = useState([]); const [sug, setSug] = useState(null);
  const [v, setV] = useState({ email: "", start: localInput(j.plannedStart), end: localInput(j.plannedEnd), lead: true, override: "" }); const [problems, setProblems] = useState(null); const [why, setWhy] = useState("");
  useEffect(() => { ctx.api("technicians").then((r) => setTechs(r.technicians)).catch(() => {}); }, [ctx]);
  const assign = () => a.run(async () => { try { return await ctx.api(`jobs/${j.id}/assign`, { method: "POST", body: { email: v.email, lead: v.lead, start: v.start ? new Date(v.start).toISOString() : null, end: v.end ? new Date(v.end).toISOString() : null, override: v.override } }); } catch (e) { if (e.code === "NEEDS_OVERRIDE") setProblems(e.problems || [{ message: e.message }]); throw e; } }, "Assigned.").then((r) => { if (!r?.__error) { setProblems(null); reload(); } });
  return <div className={`${card} space-y-2`}><H>Technicians and schedule</H>
    {j.assignments.length ? <ul className="text-sm">{j.assignments.map((x) => <li key={x.email} className="flex justify-between gap-2"><span>{x.email}{x.lead ? " (lead)" : ""}</span><button className="text-xs underline" onClick={() => { const r = window.prompt("Reason for taking this technician off the job"); if (r) a.run(() => ctx.api(`jobs/${j.id}/unassign`, { method: "POST", body: { email: x.email, reason: r } }), "Removed.").then(() => reload()); }}>Remove</button></li>)}</ul> : <p className={`text-sm ${mu}`}>Unassigned.</p>}
    <L t="Technician"><select className={f} value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })}><option value="">Choose…</option>{techs.filter((t) => t.active !== false).map((t) => <option key={t.email} value={t.email}>{t.email}{t.skills.length ? ` · ${t.skills.join(", ")}` : ""}</option>)}</select></L>
    <button className="text-xs underline" onClick={() => ctx.api(`jobs/${j.id}/suggest`).then(setSug).catch((e) => a.setErr(e.message))}>Suggest technicians</button>
    {sug && <ul className="text-xs space-y-1">{sug.suggestions.slice(0, 6).map((s) => <li key={s.email}><button className="underline" onClick={() => setV({ ...v, email: s.email })}>{s.email}</button> {s.eligible ? "✓ eligible" : s.hardBlocked ? "✗ not allowed" : "needs override"} · {s.openJobs} open{s.problems.length ? ` · ${s.problems.join(" ")}` : ""}</li>)}<li className={mu}>{sug.basis}</li></ul>}
    <L t="Start"><input type="datetime-local" className={f} value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} /></L>
    <L t="End"><input type="datetime-local" className={f} value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} /></L>
    <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={v.lead} onChange={(e) => setV({ ...v, lead: e.target.checked })} /> Lead technician</label>
    {problems && <div className="text-xs text-amber-700 space-y-1"><p>{problems.map((p) => p.message).join(" ")}</p><input className={f} placeholder="Override reason (recorded)" value={v.override} onChange={(e) => setV({ ...v, override: e.target.value })} /></div>}
    <button className={pb} disabled={!v.email || a.busy} onClick={assign}>Assign</button>
    {j.assignments.length > 0 && <div className="space-y-1 border-t border-[var(--inaya-border)] pt-2"><input className={f} placeholder="Reason for rescheduling" value={why} onChange={(e) => setWhy(e.target.value)} /><button className={gb} disabled={a.busy || !v.start || !v.end} onClick={() => a.run(() => ctx.api(`jobs/${j.id}/reschedule`, { method: "POST", body: { start: new Date(v.start).toISOString(), end: new Date(v.end).toISOString(), reason: why, override: v.override } }), "Rescheduled.").then((r) => { if (!r?.__error) reload(); })}>Move to the times above</button></div>}
    <Msg ok={a.ok} err={a.err} /></div>;
}

function PoLink({ ctx, j, act }) {
  const [rows, setRows] = useState([]); const [pick, setPick] = useState("");
  useEffect(() => { ctx.api("pos", { query: { status: "DRAFT,PENDING_APPROVAL,APPROVED,ORDERED,PARTIALLY_RECEIVED" } }).then((r) => setRows(r.orders)).catch(() => {}); }, [ctx]);
  return <div className={`${card} space-y-2`}><H>Purchase orders for parts</H>{j.poIds.length ? <ul className="text-sm">{j.poIds.map((p) => <li key={p}>{rows.find((r) => r.id === p)?.number || p} <button className="text-xs underline" onClick={() => act("po", { purchaseOrderId: p, unlink: true })}>Unlink</button></li>)}</ul> : <p className={`text-sm ${mu}`}>None linked.</p>}
    <select className={f} value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Link an open PO…</option>{rows.map((r) => <option key={r.id} value={r.id}>{r.number} · {r.supplier || "–"} · {human(r.status)}</option>)}</select>
    <button className={gb} disabled={!pick} onClick={() => act("po", { purchaseOrderId: pick }).then(() => setPick(""))}>Link</button><p className={`text-xs ${mu}`}>Create and receive POs in Procurement; they stay the record of truth.</p></div>;
}

function RepairPanel({ ctx, d, act, reload }) {
  const j = d.job; const can = ctx.me.can; const a = useAction();
  const [diag, setDiag] = useState({ findings: j.diagnosis?.findings || "", faultCodes: (j.diagnosis?.faultCodes || []).join(", "), recommended: j.diagnosis?.recommended || "" });
  const [lines, setLines] = useState([{ kind: "labour", description: "Labour", quantity: 1, unitPrice: 0 }]); const [tax, setTax] = useState("0"); const [cur, setCur] = useState("PKR");
  const [dec, setDec] = useState({ customerName: j.customerName || "", method: "in_person", note: "" }); const [comp, setComp] = useState({ summary: "", warrantyNotes: "", customerName: j.customerName || "", collection: "collected" }); const [dep, setDep] = useState(ctx.lists.departments[0]?.id || "");
  const latest = d.estimates.at(-1);
  return <div className={`${card} space-y-3`}><H>Repair</H>
    {j.intake && <div className="text-sm"><b>Intake:</b> {j.intake.reportedIssue || "–"}<div className={`text-xs ${mu}`}>Condition: {j.intake.condition || "–"} · Accessories: {j.intake.accessories || "–"} · Received {dt(j.intake.receivedAt)} by {j.intake.receivedBy || "–"}{j.intake.acknowledgement ? ` · Acknowledged by ${j.intake.acknowledgement.customerName} (${human(j.intake.acknowledgement.method)})` : ""}</div>
      {can.edit_job && !j.intake.acknowledgement && j.intake.receivedAt && <button className="text-xs underline" onClick={() => { const n = window.prompt("Name of the person who handed over the item"); if (n) act("intake-ack", { customerName: n, method: "in_person" }); }}>Record customer acknowledgement</button>}</div>}
    {["RECEIVED", "INSPECTION", "DIAGNOSIS", "ESTIMATE_PREPARED", "IN_REPAIR"].includes(j.status) && <div className="space-y-1"><b className="text-sm">Diagnosis</b><textarea className={`${f} min-h-[60px]`} placeholder="Findings" value={diag.findings} onChange={(e) => setDiag({ ...diag, findings: e.target.value })} /><input className={f} placeholder="Fault codes (comma separated)" value={diag.faultCodes} onChange={(e) => setDiag({ ...diag, faultCodes: e.target.value })} /><textarea className={f} placeholder="Recommended work" value={diag.recommended} onChange={(e) => setDiag({ ...diag, recommended: e.target.value })} /><button className={gb} onClick={() => act("diagnosis", diag, "Diagnosis saved.")}>Save diagnosis</button></div>}
    <div><b className="text-sm">Estimates</b>{d.estimates.length ? <ul className="text-sm">{d.estimates.map((e) => <li key={e.id}>v{e.version}{e.changeOrder ? " (change order)" : ""}: {money(e.total, e.currency)} · <span className={chip}>{human(e.status)}</span>{e.decision ? ` · ${e.decision.customerName} via ${human(e.decision.method)}, ${dt(e.decision.at)}` : ""}</li>)}</ul> : <p className={`text-sm ${mu}`}>No estimate yet.</p>}</div>
    {can.estimate && latest?.status === "SENT" && <div className="space-y-1 border-t border-[var(--inaya-border)] pt-2"><b className="text-sm">Record the customer&apos;s decision on v{latest.version}</b><div className="grid md:grid-cols-3 gap-1"><input className={f} placeholder="Customer name" value={dec.customerName} onChange={(e) => setDec({ ...dec, customerName: e.target.value })} /><select className={f} value={dec.method} onChange={(e) => setDec({ ...dec, method: e.target.value })}>{["in_person", "phone", "email", "whatsapp", "signed", "e_signature"].map((m) => <option key={m} value={m}>{human(m)}</option>)}</select><input className={f} placeholder="Note" value={dec.note} onChange={(e) => setDec({ ...dec, note: e.target.value })} /></div>
      <div className="flex gap-2">{["approve", "revise", "reject"].map((x) => <button key={x} className={x === "approve" ? pb : x === "reject" ? db : gb} onClick={() => act(`estimates/${latest.id}/decision`, { decision: x, ...dec }, `Customer decision recorded: ${x}.`)}>{human(x)}</button>)}</div></div>}
    {can.estimate && ["DIAGNOSIS", "ESTIMATE_PREPARED", "APPROVED", "AWAITING_PARTS", "READY", "SCHEDULED", "IN_REPAIR"].includes(j.status) && <div className="space-y-1 border-t border-[var(--inaya-border)] pt-2"><b className="text-sm">{j.approvedEstimateVersion ? "New version / change order" : "New estimate"}</b>
      {lines.map((l, i) => <div key={i} className="grid grid-cols-[110px_1fr_70px_100px_auto] gap-1"><select className={f} value={l.kind} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, kind: e.target.value } : x)))}>{["part", "labour", "other"].map((k) => <option key={k}>{k}</option>)}</select><input className={f} value={l.description} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} placeholder="Description" /><input className={f} value={l.quantity} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, quantity: e.target.value } : x)))} /><input className={f} value={l.unitPrice} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, unitPrice: e.target.value } : x)))} /><button className={gb} onClick={() => setLines(lines.filter((_, k) => k !== i))} aria-label="Remove line">✕</button></div>)}
      <div className="flex gap-2 items-center"><button className={gb} onClick={() => setLines([...lines, { kind: "part", description: "", quantity: 1, unitPrice: 0 }])}>Add line</button><L t="Tax %"><input className={`${f} w-20`} value={tax} onChange={(e) => setTax(e.target.value)} /></L><L t="Currency"><input className={`${f} w-20`} value={cur} onChange={(e) => setCur(e.target.value.toUpperCase())} /></L></div>
      <button className={pb} onClick={() => act("estimates", { currency: cur, taxPercent: Number(tax), lines: lines.map((l) => ({ ...l, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })) }, "Estimate created and marked as sent. Record the customer's decision when you have it.")}>Create estimate</button></div>}
    {can.edit_job && ["READY_FOR_COLLECTION", "COMPLETED"].includes(j.status) && <div className="space-y-1 border-t border-[var(--inaya-border)] pt-2"><b className="text-sm">Completion report and sign-off</b><textarea className={`${f} min-h-[60px]`} placeholder="What was done" value={comp.summary} onChange={(e) => setComp({ ...comp, summary: e.target.value })} /><input className={f} placeholder="Warranty / workmanship notes" value={comp.warrantyNotes} onChange={(e) => setComp({ ...comp, warrantyNotes: e.target.value })} /><div className="grid grid-cols-2 gap-1"><input className={f} placeholder="Customer name (sign-off)" value={comp.customerName} onChange={(e) => setComp({ ...comp, customerName: e.target.value })} /><select className={f} value={comp.collection} onChange={(e) => setComp({ ...comp, collection: e.target.value })}><option value="collected">Collected</option><option value="delivered">Delivered</option></select></div><button className={gb} onClick={() => act("completion", comp, "Completion recorded.")}>Save completion</button>{j.completion && <p className={`text-xs ${mu}`}>Saved {dt(j.completion.at)} by {j.completion.by}.</p>}</div>}
    {j.status === "COMPLETED" && !j.invoiceId && <div className="flex gap-2 items-end border-t border-[var(--inaya-border)] pt-2"><L t="Invoice department"><select className={f} value={dep} onChange={(e) => setDep(e.target.value)}>{ctx.lists.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></L><button className={pb} disabled={a.busy} onClick={() => a.run(() => ctx.api(`jobs/${j.id}/invoice`, { method: "POST", body: { departmentId: dep } }), (r) => `Invoice created (${money(r.total, r.currency)}). Find it in Finance › Invoices.`).then(() => reload())}>Create invoice</button></div>}
    {j.invoiceId && <p className="text-sm">Invoiced: see Finance › Invoices (reference {j.number}).</p>}
    <Msg ok={a.ok} err={a.err} /></div>;
}

// ---------------------------------------------------------------- scheduler
function Scheduler({ ctx }) {
  const [days, setDays] = useState(7); const [branch, setBranch] = useState(""); const [d, setD] = useState(null); const [err, setErr] = useState("");
  const load = useCallback(() => ctx.api("board", { query: { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + days * 86400000).toISOString(), ...(branch ? { warehouseId: branch } : {}) } }).then(setD).catch((e) => setErr(e.message)), [ctx, days, branch]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  if (err) return <Msg err={err} />; if (!d) return <p className={`text-sm ${mu}`}>Loading…</p>;
  return <div className="space-y-3">
    <div className={`${card} flex flex-wrap gap-2 items-end`}><L t="Show"><select className={f} value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>Today</option><option value={7}>This week</option><option value={31}>This month</option></select></L><L t="Branch"><select className={f} value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">All my branches</option>{ctx.lists.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></L><button className={gb} onClick={load}>Refresh</button>
      <span className={`text-sm ${mu}`}>{d.counts.open} open · {d.counts.inProgress} in progress · {d.counts.unassigned} unassigned · {d.counts.overdue} overdue</span></div>
    <div className="grid lg:grid-cols-4 gap-3">
      <div className="lg:col-span-3 space-y-2">{d.lanes.map((t) => <div key={t.email} className={card}>
        <div className="flex flex-wrap justify-between gap-2"><b className="text-sm">{t.email}</b><span className={`text-xs ${mu}`}>Attendance: {human(t.clock?.clock)}{t.clock?.since ? ` since ${dt(t.clock.since)}` : ""} · {t.skills.join(", ") || "no skills listed"}</span></div>
        {t.jobs.length ? <div className="overflow-x-auto"><table className="w-full mt-1"><thead><tr>{["Job", "Customer", "Scheduled", "Actual start", "Labour (est./actual)", "State", "Last activity"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead><tbody>{t.jobs.map((j) => <tr key={j.id} className="cursor-pointer" onClick={() => ctx.open(j.id)}><td className={td}><b>{j.number}</b> {j.title}</td><td className={td}>{j.customer || "–"}</td><td className={td}>{dt(j.scheduledStart)} – {j.scheduledEnd ? new Date(j.scheduledEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</td><td className={td}>{dt(j.actualStart)}</td><td className={td}>{j.estMinutes ? `${j.estMinutes}` : "–"} / {j.activeMinutes} min</td><td className={td}><span className={`${chip} ${STATE_TONE[j.state] || ""}`}>{STATE_LABEL[j.state] || human(j.state)}</span></td><td className={td}>{dt(j.lastActivityAt)}</td></tr>)}</tbody></table></div> : <p className={`text-sm ${mu}`}>{t.clock?.clock === "WORKING" ? "Clocked in with no job assigned." : "No jobs in this period."}</p>}
      </div>)}{!d.lanes.length && <p className={`text-sm ${mu}`}>No technicians yet. Give people the technician role in Settings.</p>}</div>
      <div className="space-y-2">
        {[["Unassigned", d.unassigned, (j) => `${j.priority}${j.dueAt ? ` · due ${dOnly(j.dueAt)}` : ""}`], ["Overdue", d.overdue, (j) => `due ${dOnly(j.dueAt)}`], ["At risk (due within 24 h, not started)", d.atRisk, (j) => `due ${dt(j.dueAt)}`], ["Stalled (no activity 48 h)", d.stalled, (j) => `last ${dt(j.lastActivityAt)}`]].map(([title, list, sub]) => <div key={title} className={card}><H>{title} ({list.length})</H><ul className="text-sm space-y-1">{list.slice(0, 30).map((j) => <li key={j.id}><button className="underline text-left" onClick={() => ctx.open(j.id)}>{j.number} {j.title}</button><div className={`text-xs ${mu}`}>{sub(j)}</div></li>)}</ul></div>)}
      </div>
    </div>
  </div>;
}

// ---------------------------------------------------------------- PO register
function PoRegister({ ctx }) {
  const [rows, setRows] = useState(null); const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { const t = setTimeout(() => ctx.api("pos", { query: Object.fromEntries(Object.entries({ q, status }).filter(([, v]) => v)) }).then((r) => setRows(r.orders)).catch((e) => setErr(e.message)), 250); return () => clearTimeout(t); }, [ctx, q, status]);
  return <div className="space-y-3"><div className={`${card} flex flex-wrap gap-2 items-end`}><L t="Search"><input className={f} value={q} onChange={(e) => setQ(e.target.value)} placeholder="PO number, supplier or item" /></L><L t="Status"><select className={f} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "REJECTED", "CANCELLED"].map((s) => <option key={s} value={s}>{human(s)}</option>)}</select></L><span className={`text-xs ${mu}`}>Open Procurement to create, approve or receive a PO.</span></div>
    <Msg err={err} />{!rows ? <p className={`text-sm ${mu}`}>Loading…</p> : <div className="overflow-x-auto"><table className="w-full"><thead><tr>{["PO", "Supplier", "Created", "Expected", "Total", "Status", "Received", "Linked orders"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead><tbody>{rows.map((p) => <tr key={p.id}><td className={td}><b>{p.number}</b></td><td className={td}>{p.supplier || "–"}</td><td className={td}>{dOnly(p.createdAt)}</td><td className={td}>{dOnly(p.expectedDeliveryDate)}{p.overdue && <span className="text-xs text-red-600"> · late</span>}</td><td className={td}>{money(p.total, p.currency)}</td><td className={td}>{human(p.status)}</td><td className={td}>{p.receivedPct}%</td><td className={td}>{p.linkedOrders.map((o) => <button key={o.id} className="underline mr-1" onClick={() => ctx.open(o.id)}>{o.number}</button>)}</td></tr>)}</tbody></table>{!rows.length && <p className={`text-sm ${mu}`}>No purchase orders match.</p>}</div>}</div>;
}

// ---------------------------------------------------------------- cheques
function printLayout({ layout, fields }) {
  const L0 = layout; const ox = L0.offsetXMm || 0; const oy = L0.offsetYMm || 0;
  const pos = (p) => `position:absolute;left:${p.x + ox}mm;top:${p.y + oy}mm;${p.width ? `width:${p.width}mm;` : ""}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ymd = String(fields.date || "").slice(0, 10).split("-"); const digits = (L0.date.format === "DDMMYYYY" ? `${ymd[2]}${ymd[1]}${ymd[0]}` : L0.date.format === "DD-MM-YYYY" ? `${ymd[2]}-${ymd[1]}-${ymd[0]}` : `${ymd[2]}/${ymd[1]}/${ymd[0]}`);
  const dateHtml = L0.date.format === "DDMMYYYY" ? digits.split("").map((ch, i) => `<span style="position:absolute;left:${i * L0.date.spacingMm}mm">${esc(ch)}</span>`).join("") : esc(digits);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cheque</title><style>@page{size:${L0.pageWidthMm}mm ${L0.pageHeightMm}mm;margin:0}body{margin:0;width:${L0.pageWidthMm}mm;height:${L0.pageHeightMm}mm;position:relative;font:${L0.fontPt}pt Arial,sans-serif;color:#000}div{white-space:nowrap}.w{white-space:normal;line-height:${L0.amountWords.lineGapMm}mm}</style></head><body>
<div style="${pos(L0.date)}">${dateHtml}</div><div style="${pos(L0.payee)}">${esc(fields.payee)}</div><div class="w" style="${pos(L0.amountWords)}">${esc(fields.amountWords)}</div><div style="${pos(L0.amountFigures)}">${esc(fields.amountFigures)}/-</div>
${L0.memo?.enabled && fields.memo ? `<div style="${pos(L0.memo)}">${esc(fields.memo)}</div>` : ""}${L0.acPayee?.enabled && fields.acPayee ? `<div style="${pos(L0.acPayee)};transform:rotate(-12deg);border-top:1px solid #000;border-bottom:1px solid #000;font-weight:bold;font-size:9pt">${esc(L0.acPayee.text)}</div>` : ""}
<script>window.onload=function(){window.print()}</script></body></html>`;
}
function openPrint(payload) { const w = window.open("", "_blank", "noopener=no,width=900,height=500"); if (!w) throw new Error("Allow pop-ups to print."); w.document.write(printLayout(payload)); w.document.close(); }

function Cheques({ ctx }) {
  const [sub, setSub] = useState("list"); const [rows, setRows] = useState(null); const [books, setBooks] = useState([]); const [tpls, setTpls] = useState({ templates: [], presets: [] }); const [status, setStatus] = useState(""); const a = useAction();
  const load = useCallback(() => { ctx.api("cheques", { query: status ? { status } : {} }).then((r) => setRows(r.cheques)).catch((e) => a.setErr(e.message)); ctx.api("cheques/books").then((r) => setBooks(r.books)).catch(() => {}); ctx.api("cheques/templates").then(setTpls).catch(() => {}); }, [ctx, status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const mgr = ctx.me.financeManager;
  const doIt = (id, sub, body, msg) => a.run(() => ctx.api(sub ? `cheques/${id}/${sub}` : `cheques/${id}`, { method: "POST", body }), msg).then((r) => { if (!r?.__error) load(); return r; });
  const print = async (q, kind) => { const reason = kind === "reprint" ? window.prompt("Reason for the reprint") : null; if (kind === "reprint" && !reason) return; const r = await doIt(q.id, "print", { kind, reason, idempotencyKey: key() }, kind === "reprint" ? "Reprint logged." : "Marked printed."); if (!r?.__error) { try { openPrint(r); } catch (e) { a.setErr(e.message); } } };
  return <div className="space-y-3">
    <div className="flex gap-2">{[["list", "Cheques"], ["new", "Write a cheque"], ["books", "Cheque books"], ["layouts", "Print layouts"], ["report", "Report"]].map(([k, l]) => <button key={k} className={sub === k ? pb : gb} onClick={() => setSub(k)}>{l}</button>)}</div>
    <Msg ok={a.ok} err={a.err} />
    {sub === "list" && <div className="space-y-2"><L t="Status"><select className={`${f} max-w-xs`} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["PENDING_APPROVAL", "APPROVED", "PRINTED", "ISSUED", "CLEARED", "RETURNED", "VOIDED"].map((s) => <option key={s} value={s}>{human(s)}</option>)}</select></L>
      {!rows ? <p className={`text-sm ${mu}`}>Loading…</p> : !rows.length ? <p className={`text-sm ${mu}`}>No cheques yet.</p> : <div className="overflow-x-auto"><table className="w-full"><thead><tr>{["No.", "Bank", "Payee", "Amount", "Date", "Status", "Actions"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead><tbody>{rows.map((q) => <tr key={q.id}><td className={td}><b>{q.numberText}</b></td><td className={td}>{q.bankName} ••{q.accountLast4}</td><td className={td}>{q.payee}<div className={`text-xs ${mu}`}>{q.amountWords}</div></td><td className={td}>{money(q.amount, q.currency)}</td><td className={td}>{q.date}</td><td className={td}><span className={chip}>{human(q.status)}</span>{q.approval && <div className={`text-xs ${mu}`}>Approved by {q.approval.by}</div>}</td>
        <td className={`${td} space-x-1 space-y-1`}>
          {q.status === "PENDING_APPROVAL" && mgr && <><button className={pb} onClick={() => doIt(q.id, "decision", { approve: true }, "Approved.")}>Approve</button><button className={db} onClick={() => { const r = window.prompt("Reason for rejecting"); if (r) doIt(q.id, "decision", { approve: false, reason: r }, "Rejected."); }}>Reject</button></>}
          {["PENDING_APPROVAL", "APPROVED"].includes(q.status) && <button className={gb} onClick={() => { const p = window.prompt("Payee", q.payee); if (p === null) return; const amt = window.prompt("Amount", String(q.amount)); if (amt === null) return; doIt(q.id, "", { payee: p, amount: Number(amt) }, "Saved. A changed payee or amount needs approval again."); }}>Edit</button>}
          {q.status === "APPROVED" && <button className={pb} onClick={() => print(q, "print")}>Print</button>}
          {q.status === "PRINTED" && <><button className={pb} onClick={() => doIt(q.id, "issue", {}, "Issued; the payment is recorded against the expense.")}>Mark issued</button>{mgr && <button className={gb} onClick={() => print(q, "reprint")}>Reprint</button>}{mgr && <button className={gb} onClick={() => { const r = window.prompt("What happened to the leaf? (it will be voided and the cheque moved to the next leaf)"); if (r) doIt(q.id, "spoil", { reason: r }, "Leaf spoiled; cheque moved to the next number."); }}>Leaf spoiled</button>}</>}
          {["ISSUED", "RETURNED"].includes(q.status) && <button className={gb} onClick={async () => { const r = await ctx.api(`cheques/${q.id}/reconcile`).catch((e) => ({ __e: e })); if (r.__e) return a.setErr(r.__e.message); const s = r.suggestions.find((x) => x.matchesNumber && x.matchesAmount) || r.suggestions[0]; if (!s) return a.setErr("No matching bank line yet. Import the statement in AI Bookkeeper."); if (window.confirm(`Clear against bank line ${s.date} ${money(s.amount)} ${s.reference || s.description}?`)) doIt(q.id, "reconcile", { bankTransactionId: s.id }, "Cleared."); }}>Reconcile</button>}
          {mgr && !["ISSUED", "CLEARED", "RETURNED", "VOIDED"].includes(q.status) && <button className={db} onClick={() => { const r = window.prompt("Reason for voiding"); if (r) doIt(q.id, "void", { reason: r }, "Voided."); }}>Void</button>}
          {mgr && q.status === "ISSUED" && <button className={db} onClick={() => { const r = window.prompt("Why was it returned? (bounced / stopped)"); if (r) doIt(q.id, "void", { reason: r, returned: true }, "Marked returned. Reverse or re-pay the expense in Finance."); }}>Returned</button>}
        </td></tr>)}</tbody></table></div>}</div>}
    {sub === "new" && <NewCheque ctx={ctx} books={books} onDone={() => { setSub("list"); load(); }} />}
    {sub === "books" && <Books ctx={ctx} books={books} tpls={tpls} reload={load} mgr={mgr} />}
    {sub === "layouts" && <Layouts ctx={ctx} tpls={tpls} reload={load} mgr={mgr} />}
    {sub === "report" && <ChequeReport ctx={ctx} />}
  </div>;
}
function NewCheque({ ctx, books, onDone }) {
  const [v, setV] = useState({ expenseId: "", bookId: books[0]?.id || "", payee: "", amount: "", date: new Date().toISOString().slice(0, 10), memo: "" }); const a = useAction();
  return <div className={`${card} space-y-2 max-w-2xl`}><H>Write a cheque from an approved expense</H>
    <L t="Approved expense (payable)"><Picker ctx={ctx} kind="expenses" value={v.expenseId} onChange={(id, it) => setV({ ...v, expenseId: id, payee: it?.vendor || v.payee })} placeholder="Search by supplier" /></L>
    <div className="grid md:grid-cols-2 gap-2"><L t="Cheque book"><select className={f} value={v.bookId} onChange={(e) => setV({ ...v, bookId: e.target.value })}>{books.filter((b) => b.active && b.remaining > 0).map((b) => <option key={b.id} value={b.id}>{b.bankName} ••{b.accountLast4} · next {b.nextNumber} ({b.remaining} left)</option>)}</select></L>
      <L t="Payee"><input className={f} value={v.payee} onChange={(e) => setV({ ...v, payee: e.target.value })} /></L><L t="Amount (blank = everything unpaid)"><input className={f} value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} inputMode="decimal" /></L><L t="Cheque date"><input type="date" className={f} value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></L><L t="Memo"><input className={f} value={v.memo} onChange={(e) => setV({ ...v, memo: e.target.value })} /></L></div>
    <button className={pb} disabled={!v.expenseId || !v.bookId || a.busy} onClick={() => a.run(() => ctx.api("cheques", { method: "POST", body: { ...v, amount: v.amount === "" ? undefined : Number(v.amount) } }), (r) => `Cheque ${r.cheque.numberText} written; it now needs a finance manager's approval.`).then((r) => { if (!r?.__error) setTimeout(onDone, 800); })}>Create</button><Msg ok={a.ok} err={a.err} /></div>;
}
function Books({ ctx, books, tpls, reload, mgr }) {
  const [v, setV] = useState({ bankName: "", accountName: "", accountLast4: "", firstNumber: "", lastNumber: "", currency: "PKR", templateId: "" }); const a = useAction();
  return <div className="space-y-3"><div className="overflow-x-auto"><table className="w-full"><thead><tr>{["Bank", "Account", "Numbers", "Next", "Left", "Spoiled / voided leaves"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead><tbody>{books.map((b) => <tr key={b.id}><td className={td}>{b.bankName}</td><td className={td}>{b.accountName} ••{b.accountLast4}</td><td className={td}>{b.firstNumber}–{b.lastNumber}</td><td className={td}>{b.nextNumber}</td><td className={td}>{b.remaining}</td><td className={td}>{b.spoiled.map((s) => `${s.number} (${s.reason})`).join("; ") || "–"}</td></tr>)}</tbody></table></div>
    {mgr && <div className={`${card} space-y-2 max-w-2xl`}><H>Add a cheque book</H><div className="grid md:grid-cols-2 gap-2">{[["bankName", "Bank"], ["accountName", "Account name"], ["accountLast4", "Last 4 digits of the account only"], ["firstNumber", "First cheque number"], ["lastNumber", "Last cheque number"], ["currency", "Currency"]].map(([k, l]) => <L key={k} t={l}><input className={f} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></L>)}
      <L t="Print layout"><select className={f} value={v.templateId} onChange={(e) => setV({ ...v, templateId: e.target.value })}><option value="">Generic</option>{tpls.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.aligned ? "" : " (not aligned yet)"}</option>)}</select></L></div>
      <p className={`text-xs ${mu}`}>Never enter the full account number or any bank login. Inaya stores only the last 4 digits.</p>
      <button className={pb} disabled={a.busy} onClick={() => a.run(() => ctx.api("cheques/books", { method: "POST", body: { ...v, firstNumber: Number(v.firstNumber), lastNumber: Number(v.lastNumber) } }), "Cheque book added.").then((r) => { if (!r?.__error) reload(); })}>Add book</button><Msg ok={a.ok} err={a.err} /></div>}</div>;
}
function Layouts({ ctx, tpls, reload, mgr }) {
  const [sel, setSel] = useState(null); const [preset, setPreset] = useState("GENERIC_PK"); const a = useAction();
  const fields = ["date", "payee", "amountWords", "amountFigures", "memo", "acPayee"];
  const upd = (fld, k, val) => setSel({ ...sel, layout: { ...sel.layout, [fld]: { ...sel.layout[fld], [k]: k === "enabled" ? val : Number(val) } } });
  return <div className="space-y-3"><p className={`text-xs text-amber-700`}>{tpls.presetNote}</p>
    {mgr && <div className="flex gap-2 items-end"><L t="Start from"><select className={f} value={preset} onChange={(e) => setPreset(e.target.value)}>{tpls.presets.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></L><button className={pb} onClick={() => a.run(() => ctx.api("cheques/templates", { method: "POST", body: { preset } }), "Layout created. Align it before use.").then((r) => { if (!r?.__error) { reload(); setSel(r.template); } })}>Create layout</button></div>}
    <div className="flex flex-wrap gap-2">{tpls.templates.map((t) => <button key={t.id} className={sel?.id === t.id ? pb : gb} onClick={() => setSel(t)}>{t.name}{t.aligned ? " ✓" : ""}</button>)}</div>
    {sel && <div className={`${card} space-y-2`}><H>{sel.name}: positions in mm from the top-left of the leaf</H>
      <div className="grid md:grid-cols-4 gap-2">{[["pageWidthMm", "Leaf width"], ["pageHeightMm", "Leaf height"], ["offsetXMm", "Nudge right"], ["offsetYMm", "Nudge down"], ["fontPt", "Font size (pt)"]].map(([k, l]) => <L key={k} t={l}><input className={f} value={sel.layout[k] ?? 0} onChange={(e) => setSel({ ...sel, layout: { ...sel.layout, [k]: Number(e.target.value) } })} disabled={!mgr} /></L>)}</div>
      <table className="w-full"><thead><tr>{["Field", "x", "y", "width", "on"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead><tbody>{fields.map((fl) => <tr key={fl}><td className={td}>{human(fl)}</td>{["x", "y", "width"].map((k) => <td key={k} className={td}>{sel.layout[fl][k] !== undefined ? <input className={`${f} w-20`} value={sel.layout[fl][k]} onChange={(e) => upd(fl, k, e.target.value)} disabled={!mgr} /> : "–"}</td>)}<td className={td}>{sel.layout[fl].enabled !== undefined ? <input type="checkbox" checked={sel.layout[fl].enabled} onChange={(e) => upd(fl, "enabled", e.target.checked)} disabled={!mgr} /> : "–"}</td></tr>)}</tbody></table>
      <div className="flex flex-wrap gap-2"><button className={gb} onClick={() => a.run(() => ctx.api("cheques/test-print", { method: "POST", body: { templateId: sel.id } })).then((r) => { if (!r?.__error) try { openPrint({ ...r, layout: sel.layout }); } catch (e) { a.setErr(e.message); } })}>Alignment test print (plain paper)</button>
        {mgr && <><button className={pb} onClick={() => a.run(() => ctx.api(`cheques/templates/${sel.id}`, { method: "POST", body: { name: sel.name, bank: sel.bank, layout: sel.layout, aligned: sel.aligned } }), "Saved.").then(() => reload())}>Save</button><label className="text-xs flex items-center gap-1"><input type="checkbox" checked={!!sel.aligned} onChange={(e) => setSel({ ...sel, aligned: e.target.checked })} /> I checked this against a real leaf of this bank</label></>}</div>
      <Msg ok={a.ok} err={a.err} /></div>}</div>;
}
function ChequeReport({ ctx }) {
  const [r, setR] = useState(null); useEffect(() => { ctx.api("cheques/report").then(setR).catch(() => {}); }, [ctx]); if (!r) return <p className={`text-sm ${mu}`}>Loading…</p>;
  const T = ({ title, data }) => <div className={card}><H>{title}</H><ul className="text-sm">{Object.entries(data).map(([k, v]) => <li key={k}>{human(k)}: {v.count} · {money(v.amount)}</li>)}</ul></div>;
  return <div className="grid md:grid-cols-3 gap-3"><T title="By status" data={r.byStatus} /><T title="By bank" data={r.byBank} /><T title="By payee" data={r.byPayee} /><div className={card}><H>Outstanding (issued, not cleared)</H><ul className="text-sm">{r.outstanding.map((q) => <li key={q.id}>{q.numberText} · {q.payee} · {money(q.amount, q.currency)}</li>)}</ul></div><div className={card}><H>Reconciliation differences</H><ul className="text-sm">{r.discrepancies.map((q) => <li key={q.id}>{q.numberText} · {q.payee}</li>)}</ul>{!r.discrepancies.length && <p className={`text-sm ${mu}`}>None.</p>}</div><div className={card}><H>Waiting for approval</H><p className="text-xl font-bold">{r.pendingApproval}</p></div></div>;
}

// ---------------------------------------------------------------- technician (web)
function MyJobs({ ctx }) {
  const [d, setD] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { ctx.api("day").then(setD).catch((e) => setErr(e.message)); }, [ctx]);
  if (err) return <Msg err={err} />; if (!d) return <p className={`text-sm ${mu}`}>Loading…</p>;
  const Row = ({ j }) => <li><button className="underline text-left" onClick={() => ctx.open(j.id)}>{j.number} · {j.title}</button><div className={`text-xs ${mu}`}>{human(j.myState)} · {j.mySlot?.start ? dt(j.mySlot.start) : "not scheduled"} · {human(j.status)}</div></li>;
  return <div className="grid md:grid-cols-2 gap-3"><div className={card}><H>Today</H><p className="text-sm">Attendance: <b>{human(d.attendance.state)}</b>{d.attendance.since ? ` since ${dt(d.attendance.since)}` : ""}. Clock in and out under Time &amp; Rota (or in the Inaya app).</p>{d.shifts.map((s) => <p key={s.id} className={`text-xs ${mu}`}>Shift {dt(s.start)} – {dt(s.end)}</p>)}{d.current && <p className="text-sm mt-2">Working on: <button className="underline" onClick={() => ctx.open(d.current.id)}>{d.current.number}</button></p>}</div>
    <div className={card}><H>Jobs today ({d.today.length})</H><ul className="space-y-1">{d.today.map((j) => <Row key={j.id} j={j} />)}</ul></div><div className={card}><H>Upcoming ({d.upcoming.length})</H><ul className="space-y-1">{d.upcoming.map((j) => <Row key={j.id} j={j} />)}</ul></div></div>;
}

// ---------------------------------------------------------------- review queue
function Review({ ctx }) {
  const [rows, setRows] = useState(null); const [status, setStatus] = useState("OPEN,ACKNOWLEDGED,EXPLANATION_REQUESTED,ESCALATED"); const a = useAction();
  const load = useCallback(() => ctx.api("exceptions", { query: { status } }).then((r) => setRows(r.exceptions)).catch((e) => a.setErr(e.message)), [ctx, status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const go = (id, action) => { const needs = ["dismiss", "reject_correction", "escalate", "request_explanation"].includes(action); const reason = needs ? window.prompt("Reason") : ""; if (needs && !reason) return; a.run(() => ctx.api(`exceptions/${id}`, { method: "POST", body: { action, reason } }), "Updated.").then(() => load()); };
  return <div className="space-y-2"><p className={`text-xs ${mu}`}>These are review signals, not findings. Nothing here changes pay or takes disciplinary action. Check the evidence and talk to the person.</p>
    <div className="flex gap-2"><select className={`${f} max-w-xs`} value={status} onChange={(e) => setStatus(e.target.value)}><option value="OPEN,ACKNOWLEDGED,EXPLANATION_REQUESTED,ESCALATED">Needs attention</option><option value="ALL">All</option></select><button className={gb} onClick={() => a.run(() => ctx.api("exceptions/scan", { method: "POST" }), (r) => `${r.raised || 0} new item(s).`).then(() => load())}>Check now</button></div>
    <Msg ok={a.ok} err={a.err} />
    {!rows ? <p className={`text-sm ${mu}`}>Loading…</p> : !rows.length ? <p className={`text-sm ${mu}`}>Nothing to review.</p> : rows.map((x) => <div key={x.id} className={card}><div className="flex flex-wrap justify-between gap-2"><b className="text-sm">{human(x.type)}</b><span className={chip}>{human(x.status)}</span></div><p className="text-sm">{x.rule}</p><p className={`text-xs ${mu}`}>{x.email || ""} · {dt(x.createdAt)}{x.jobId ? " · " : ""}{x.jobId && <button className="underline" onClick={() => ctx.open(x.jobId)}>open job</button>}</p>
      <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(x.evidence, null, 1)}</pre>{x.actions.length > 0 && <ul className={`text-xs ${mu}`}>{x.actions.map((ac, i) => <li key={i}>{dt(ac.at)} {ac.by}: {human(ac.action)}{ac.reason ? ` – ${ac.reason}` : ""}</li>)}</ul>}
      {!["RESOLVED", "DISMISSED"].includes(x.status) && <div className="flex flex-wrap gap-1 mt-1">{(x.type === "LABOUR_CORRECTION" ? ["approve_correction", "reject_correction"] : ["acknowledge", "request_explanation", "escalate", "resolve", "dismiss"]).map((ac) => <button key={ac} className={gb} onClick={() => go(x.id, ac)}>{human(ac)}</button>)}</div>}</div>)}</div>;
}

// ---------------------------------------------------------------- settings
function Settings({ ctx }) {
  const [sub, setSub] = useState("roles"); const [s, setS] = useState(null); const [techs, setTechs] = useState([]); const [sites, setSites] = useState([]); const [pm, setPm] = useState(null); const a = useAction();
  const load = useCallback(() => { ctx.api("settings").then((r) => setS(r.settings)).catch(() => {}); ctx.api("technicians").then((r) => setTechs(r.technicians)).catch(() => {}); ctx.api("sites").then((r) => setSites(r.sites)).catch(() => {}); ctx.api("pm").then(setPm).catch(() => {}); }, [ctx]);
  useEffect(() => { load(); }, [load]);
  const [site, setSite] = useState({ name: "", code: "", warehouseId: "", lat: "", lng: "" }); const [tpl, setTpl] = useState({ title: "", warehouseId: ctx.lists.branches[0]?.id || "", everyDays: "30", nextDue: "", leadDays: "3", checklist: "", skills: "", estMinutes: "", autoApprove: false });
  return <div className="space-y-3"><div className="flex flex-wrap gap-2">{[["roles", "Roles"], ["techs", "Technicians"], ["sites", "Sites and QR codes"], ["pm", "Preventive maintenance"], ["rules", "Review rules"]].map(([k, l]) => <button key={k} className={sub === k ? pb : gb} onClick={() => setSub(k)}>{l}</button>)}</div><Msg ok={a.ok} err={a.err} />
    {sub === "roles" && <div className={card}><H>Manage Orders roles</H><table className="w-full"><thead><tr>{["Member", "Company role", "Manage Orders role"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead><tbody>{ctx.lists.members.map((m) => <tr key={m.email}><td className={td}>{m.email}</td><td className={td}>{m.role}</td><td className={td}>{["owner", "admin"].includes(m.role) ? "Manager (owner/admin)" : <select className={f} defaultValue={m.opsRole || ""} onChange={(e) => a.run(() => ctx.api("roles", { method: "POST", body: { email: m.email, opsRole: e.target.value || null } }), "Role saved.")}><option value="">None</option>{["manager", "dispatcher", "advisor", "technician", "storekeeper"].map((r) => <option key={r} value={r}>{r === "advisor" ? "Service advisor" : human(r)}</option>)}</select>}</td></tr>)}</tbody></table><p className={`text-xs ${mu} mt-1`}>Cheques use the Finance roles (finance staff write cheques, finance managers approve). Branch limits come from Time &amp; Rota › Manage users.</p></div>}
    {sub === "techs" && <div className="space-y-2">{techs.map((t) => <TechRow key={t.email} ctx={ctx} t={t} a={a} reload={load} />)}{!techs.length && <p className={`text-sm ${mu}`}>Give people the technician role first.</p>}</div>}
    {sub === "sites" && <div className={`${card} space-y-2`}><H>Site codes (print as QR or give the code to technicians)</H><ul className="text-sm">{sites.map((x) => <li key={x.id}><b>{x.code}</b> · {x.name}{x.geo ? ` · ${x.geo.lat.toFixed(5)}, ${x.geo.lng.toFixed(5)}` : ""}</li>)}</ul>
      <div className="grid md:grid-cols-5 gap-2">{[["name", "Site name"], ["code", "Code (blank = random)"], ["lat", "Latitude (optional)"], ["lng", "Longitude (optional)"]].map(([k, l]) => <L key={k} t={l}><input className={f} value={site[k]} onChange={(e) => setSite({ ...site, [k]: e.target.value })} /></L>)}<L t="Branch"><select className={f} value={site.warehouseId} onChange={(e) => setSite({ ...site, warehouseId: e.target.value })}><option value="">Any</option>{ctx.lists.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></L></div>
      <button className={pb} onClick={() => a.run(() => ctx.api("sites", { method: "POST", body: { name: site.name, code: site.code, warehouseId: site.warehouseId || null, geo: site.lat && site.lng ? { lat: Number(site.lat), lng: Number(site.lng) } : null } }), "Site saved.").then(() => load())}>Add site</button></div>}
    {sub === "pm" && pm && <div className="space-y-2"><div className={card}><H>Templates</H><ul className="text-sm">{pm.templates.map((t) => <li key={t.id}>{t.title} · every {t.everyDays} days · next {t.nextDue}{t.active ? "" : " (off)"}</li>)}</ul>{pm.overdue.length > 0 && <p className="text-sm text-red-600">Overdue: {pm.overdue.map((x) => x.title).join(", ")}</p>}{pm.overdueOrders.length > 0 && <p className="text-sm text-red-600">Open maintenance orders past due: {pm.overdueOrders.map((x) => x.number).join(", ")}</p>}</div>
      <div className={`${card} space-y-2`}><H>New maintenance schedule</H><div className="grid md:grid-cols-3 gap-2"><L t="Title"><input className={f} value={tpl.title} onChange={(e) => setTpl({ ...tpl, title: e.target.value })} /></L><L t="Branch"><select className={f} value={tpl.warehouseId} onChange={(e) => setTpl({ ...tpl, warehouseId: e.target.value })}>{ctx.lists.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></L><L t="Every (days)"><input className={f} value={tpl.everyDays} onChange={(e) => setTpl({ ...tpl, everyDays: e.target.value })} /></L><L t="Next due"><input type="date" className={f} value={tpl.nextDue} onChange={(e) => setTpl({ ...tpl, nextDue: e.target.value })} /></L><L t="Create this many days before"><input className={f} value={tpl.leadDays} onChange={(e) => setTpl({ ...tpl, leadDays: e.target.value })} /></L><L t="Estimated minutes"><input className={f} value={tpl.estMinutes} onChange={(e) => setTpl({ ...tpl, estMinutes: e.target.value })} /></L><L t="Skills (comma separated)"><input className={f} value={tpl.skills} onChange={(e) => setTpl({ ...tpl, skills: e.target.value })} /></L><L t="Skip approval"><input type="checkbox" checked={tpl.autoApprove} onChange={(e) => setTpl({ ...tpl, autoApprove: e.target.checked })} /></L></div>
        <L t="Checklist (one per line)"><textarea className={`${f} min-h-[60px]`} value={tpl.checklist} onChange={(e) => setTpl({ ...tpl, checklist: e.target.value })} /></L>
        <button className={pb} onClick={() => a.run(() => ctx.api("pm", { method: "POST", body: { ...tpl, everyDays: Number(tpl.everyDays), leadDays: Number(tpl.leadDays), estMinutes: tpl.estMinutes ? Number(tpl.estMinutes) : null, checklist: tpl.checklist.split("\n").map((x) => x.trim()).filter(Boolean), skills: tpl.skills.split(",").map((x) => x.trim()).filter(Boolean) } }), "Schedule saved. Orders are created automatically when due.").then(() => load())}>Save schedule</button></div></div>}
    {sub === "rules" && s && <div className={`${card} space-y-2 max-w-2xl`}><H>Review rules (flags for a manager, never automatic penalties)</H><div className="grid md:grid-cols-2 gap-2">{[["noJobStartMinutes", "Clocked in, no job started after (min)"], ["notAcknowledgedMinutes", "Scheduled job not started after (min)"], ["pausedTooLongMinutes", "Paused too long after (min)"], ["labourVariancePct", "Labour vs estimate difference (%)"], ["manualCorrectionsPerWeek", "Attendance corrections per week"], ["siteRadiusMeters", "Site radius (m)"]].map(([k, l]) => <L key={k} t={l}><input className={f} value={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.value })} /></L>)}
      <L t="Location at job start/finish"><select className={f} value={s.locationCapture} onChange={(e) => setS({ ...s, locationCapture: e.target.value })}><option value="off">Off</option><option value="optional">Optional (technician may share)</option><option value="required">Required, or site code / supervisor</option></select></L>
      <L t="Manager inspection before completion"><input type="checkbox" checked={s.requireInspection} onChange={(e) => setS({ ...s, requireInspection: e.target.checked })} /></L><L t="Cheque writer can't approve own cheque"><input type="checkbox" checked={s.chequeSegregation} onChange={(e) => setS({ ...s, chequeSegregation: e.target.checked })} /></L></div>
      <p className={`text-xs ${mu}`}>Location is captured only at the moment a technician starts or finishes a job, only when switched on, and never outside working hours. If they refuse, a site code or a supervisor can confirm instead.</p>
      <button className={pb} onClick={() => a.run(() => ctx.api("settings", { method: "POST", body: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v])) }), "Saved.")}>Save</button></div>}
  </div>;
}
function TechRow({ ctx, t, a, reload }) {
  const [v, setV] = useState({ skills: t.skills.join(", "), categories: t.categories.join(", "), certs: t.certifications.map((c) => `${c.name}${c.expires ? `|${c.expires.slice(0, 10)}` : ""}`).join("\n"), active: t.active, maxConcurrent: t.maxConcurrent, costRate: t.costRate ?? "" });
  return <div className={card}><b className="text-sm">{t.email}</b><div className="grid md:grid-cols-3 gap-2 mt-1"><L t="Skills"><input className={f} value={v.skills} onChange={(e) => setV({ ...v, skills: e.target.value })} /></L><L t="Job categories (blank = all)"><input className={f} value={v.categories} onChange={(e) => setV({ ...v, categories: e.target.value })} /></L><L t="Certifications (one per line: name|YYYY-MM-DD)"><textarea className={f} value={v.certs} onChange={(e) => setV({ ...v, certs: e.target.value })} /></L><L t="Jobs at the same time"><input className={f} value={v.maxConcurrent} onChange={(e) => setV({ ...v, maxConcurrent: e.target.value })} /></L>{ctx.me.financeManager && <L t="Labour cost rate (per hour, finance only)"><input className={f} value={v.costRate} onChange={(e) => setV({ ...v, costRate: e.target.value })} /></L>}<L t="Active"><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /></L></div>
    <button className={`${gb} mt-2`} onClick={() => a.run(() => ctx.api(`technicians/${encodeURIComponent(t.email)}`, { method: "POST", body: { skills: v.skills, categories: v.categories, certifications: v.certs.split("\n").map((x) => x.trim()).filter(Boolean).map((x) => { const [name, expires] = x.split("|"); return { name, expires: expires || null }; }), active: v.active, maxConcurrent: Number(v.maxConcurrent), ...(ctx.me.financeManager ? { costRate: v.costRate === "" ? null : Number(v.costRate) } : {}) } }), "Saved.").then(() => reload())}>Save</button></div>;
}
