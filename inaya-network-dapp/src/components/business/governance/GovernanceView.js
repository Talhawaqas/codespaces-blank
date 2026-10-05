"use client";

// src/components/business/governance/GovernanceView.js
//
// Governance for owners and admins (Competitive Expansion SOW D): versioned policies (DLP rules, classification rules, sharing limits,
// upload restrictions, retention and the rest), the DLP event log and approvals, a rule simulator, and metadata fields. A published policy
// cannot be edited; "New version" creates a draft that supersedes it on publish.

import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[11px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2.5 py-1.5 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-[12px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return "-"; } };
const PILL = { published: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", draft: "bg-slate-400/10 text-slate-300 border-slate-400/30", pending_approval: "bg-amber-400/10 text-amber-300 border-amber-400/30", retired: "bg-slate-500/10 text-slate-400 border-slate-500/30", DENY: "bg-red-400/10 text-red-400 border-red-400/30", QUARANTINE: "bg-red-400/10 text-red-400 border-red-400/30", REQUIRE_APPROVAL: "bg-amber-400/10 text-amber-300 border-amber-400/30", REQUIRE_STRONGER_AUTH: "bg-amber-400/10 text-amber-300 border-amber-400/30", LOG_ONLY: "bg-sky-400/10 text-sky-300 border-sky-400/30", ALLOW: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" };
const Pill = ({ k, children }) => <span className={`text-[10px] font-bold uppercase border rounded-full px-2 py-0.5 ${PILL[k] || PILL.draft}`}>{children || k}</span>;

export const govApi = async (path, opts = {}) => {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts });
  let data = null; try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
};

const TEMPLATES = {
  dlp: { rules: [{ id: "offsite-confidential", name: "Confidential files stay on the corporate network", action: "DENY", when: { actions: ["share_open", "share_download", "download"], classification: ["CONFIDENTIAL", "RESTRICTED"], ipNotIn: ["198.51.100.0/24"] }, message: "Confidential files can only be opened from the corporate network." }] },
  classification: { rules: [{ id: "payroll", name: "Payroll files", level: "CONFIDENTIAL", confidence: 0.8, apply: "suggest", when: { filenameRegex: "^payroll" } }, { id: "ssn", name: "Social security numbers", level: "RESTRICTED", confidence: 0.9, apply: "suggest", when: { pii: { types: ["SSN"], min: 1 } } }] },
  external_sharing: { allowed: true, maxExpiryHours: 168, requirePassword: true },
  public_links: { allowed: false },
  download_limits: { maxPerShare: 5 },
  upload_types: { denyExtensions: ["exe", "bat", "scr"], maxBytes: 104857600, enforceMime: true, inspectArchives: true, requireScan: "static", blockEncryptedArchives: false },
  external_domain: { allowedDomains: ["partner.com"] },
  classification_required: { required: true },
  retention: { days: 2555, afterAction: "review" },
  archival: { afterDaysInactive: 365 },
  deletion: { requireApproval: true, trashDays: 30 },
  legal_hold: { blockDeletion: true },
  device_access: { requireTrustedDevice: true },
  versioning: { keepVersions: 50 },
  file_locking: { maxLeaseMinutes: 120 },
  residency: { allowedRegions: ["eu"] },
  guest_restrictions: { allowGuests: false },
};
const ENFORCED = { dlp: "enforced on shares, S3/Azure downloads and uploads", classification: "evaluated by the classifier", external_sharing: "enforced when a link is created", public_links: "enforced when a link is created", download_limits: "enforced when a link is created", upload_types: "enforced on S3/Azure and file-request uploads", external_domain: "enforced when a link is created" };

function PolicyForm({ types, initial, onDone, onCancel }) {
  const editing = !!initial?.policyId;
  const [type, setType] = useState(initial?.type || "dlp"); const [name, setName] = useState(initial?.name || "");
  const [json, setJson] = useState(JSON.stringify(initial?.config || TEMPLATES.dlp, null, 2)); const [approval, setApproval] = useState(!!initial?.approvalRequired);
  const [precedence, setPrecedence] = useState(initial?.precedence ?? 100); const [roles, setRoles] = useState((initial?.scope?.roles || []).join(", ")); const [path, setPath] = useState(initial?.scope?.pathPrefix || "");
  const [eff, setEff] = useState(initial?.effectiveAt?.slice(0, 16) || ""); const [exp, setExp] = useState(initial?.expiresAt?.slice(0, 16) || ""); const [err, setErr] = useState([]); const [busy, setBusy] = useState(false);
  const pick = (t) => { setType(t); if (!editing) setJson(JSON.stringify(TEMPLATES[t] || {}, null, 2)); };
  async function save() {
    setErr([]); let config; try { config = JSON.parse(json); } catch { setErr(["The settings are not valid JSON."]); return; }
    setBusy(true);
    try {
      const body = { orgId: undefined, type, name, config, approvalRequired: approval, precedence: Number(precedence), effectiveAt: eff ? new Date(eff).toISOString() : null, expiresAt: exp ? new Date(exp).toISOString() : null, scope: { roles: roles.split(",").map((s) => s.trim()).filter(Boolean), pathPrefix: path || null } };
      if (editing) await govApi(`/api/orgs/governance/policies/${initial.policyId}`, { method: "PATCH", body: JSON.stringify({ ...body, orgId: initial.orgId }) });
      else await govApi("/api/orgs/governance/policies", { method: "POST", body: JSON.stringify({ ...body, orgId: initial?.orgId }) });
      onDone();
    } catch (e) { setErr(e.data?.errors?.length ? e.data.errors : [e.message]); } finally { setBusy(false); }
  }
  return (
    <div className={`${card} p-3 space-y-2`}>
      <div className="grid sm:grid-cols-2 gap-2">
        <div><label className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]" htmlFor="gov-type">Type</label><select id="gov-type" className={field} value={type} disabled={editing} onChange={(e) => pick(e.target.value)}>{types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select></div>
        <div><label className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]" htmlFor="gov-name">Name</label><input id="gov-name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. No public links" /></div>
      </div>
      <p className={`text-[11px] ${muted}`}>{ENFORCED[type] ? `This policy is ${ENFORCED[type]}.` : "This policy type is stored and versioned, and is not yet enforced automatically by a specific feature."}</p>
      <label className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]" htmlFor="gov-config">Settings (JSON)</label>
      <textarea id="gov-config" className={`${field} font-mono min-h-[170px]`} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} />
      <div className="grid sm:grid-cols-4 gap-2">
        <div><label className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]" htmlFor="gov-roles">Only roles</label><input id="gov-roles" className={field} value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="member, guest" /></div>
        <div><label className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]" htmlFor="gov-path">Only paths starting</label><input id="gov-path" className={field} value={path} onChange={(e) => setPath(e.target.value)} placeholder="finance/" /></div>
        <div><label className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]" htmlFor="gov-eff">Effective from</label><input id="gov-eff" type="datetime-local" className={field} value={eff} onChange={(e) => setEff(e.target.value)} /></div>
        <div><label className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]" htmlFor="gov-exp">Expires</label><input id="gov-exp" type="datetime-local" className={field} value={exp} onChange={(e) => setExp(e.target.value)} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <label className="flex items-center gap-1"><input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> A second admin must approve before it takes effect</label>
        <label className="flex items-center gap-1">Precedence <input className={`${field} !w-16`} type="number" value={precedence} onChange={(e) => setPrecedence(e.target.value)} aria-label="Precedence" /> <span className={muted}>(lower runs first)</span></label>
      </div>
      {err.length > 0 && <ul className="text-red-400 text-[12px] list-disc ml-4" role="alert">{err.slice(0, 5).map((m, i) => <li key={i}>{m}</li>)}</ul>}
      <div className="flex gap-2"><button className={accent} disabled={busy} onClick={save}>{editing ? "Save draft" : "Create draft"}</button><button className={btn} onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function Policies({ orgId, types }) {
  const [rows, setRows] = useState(null); const [err, setErr] = useState(""); const [form, setForm] = useState(null); const [filter, setFilter] = useState("");
  const load = useCallback(async () => { try { setRows((await govApi(`/api/orgs/governance/policies?orgId=${orgId}`)).policies); setErr(""); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  const act = async (p, action, extra = {}) => { try { await govApi(`/api/orgs/governance/policies/${p.policyId}`, { method: "POST", body: JSON.stringify({ orgId, action, ...extra }) }); load(); } catch (e) { setErr(e.message); } };
  const shown = (rows || []).filter((r) => !filter || r.type === filter);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <select aria-label="Filter by type" className={`${field} !w-auto`} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All types</option>{types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select>
        <button className={`${btn} ml-auto`} onClick={() => setForm({})}>New policy</button>
      </div>
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      {form && <PolicyForm types={types} initial={form.policyId ? { ...form, orgId } : { orgId }} onCancel={() => setForm(null)} onDone={() => { setForm(null); load(); }} />}
      {rows === null ? <p className={`text-[12px] ${muted}`}>Loading…</p> : shown.length === 0 ? <EmptyState compact icon="📜" description="No policies yet. Create one with New policy." /> : shown.map((p) => (
        <div key={p.policyId} className={`${card} p-3`}>
          <div className="flex flex-wrap items-center gap-2"><b className="text-[13px]">{p.name}</b><span className={`text-[11px] ${muted}`}>{types.find((t) => t.type === p.type)?.label || p.type} · version {p.version}</span><Pill k={p.status}>{p.status.replace("_", " ")}</Pill>
            {p.approvalRequired && <span className={`text-[10px] ${muted}`}>needs approval</span>}</div>
          <p className={`text-[11px] ${muted} mt-1`}>Created by {p.createdBy} {when(p.createdAt)}{p.publishedAt ? ` · published ${when(p.publishedAt)} by ${p.publishedBy}` : ""}{p.approvedBy ? ` · approved by ${p.approvedBy}` : ""}{p.submittedBy && p.status === "pending_approval" ? ` · submitted by ${p.submittedBy}` : ""}{p.effectiveAt ? ` · from ${when(p.effectiveAt)}` : ""}{p.expiresAt ? ` · until ${when(p.expiresAt)}` : ""}{p.note ? ` · ${p.note}` : ""}</p>
          <details className="mt-1"><summary className={`text-[11px] ${muted} cursor-pointer`}>Settings</summary><pre className="text-[11px] bg-black/40 rounded p-2 overflow-auto max-h-48">{JSON.stringify(p.config, null, 2)}</pre></details>
          <div className="flex flex-wrap gap-2 mt-2">
            {p.status === "draft" && <><button className={btn} onClick={() => setForm(p)}>Edit</button><button className={accent} onClick={() => act(p, "publish")}>{p.approvalRequired ? "Submit for approval" : "Publish"}</button><button className={`${btn} !text-red-400`} onClick={async () => { try { await govApi(`/api/orgs/governance/policies/${p.policyId}?orgId=${orgId}`, { method: "DELETE" }); load(); } catch (e) { setErr(e.message); } }}>Delete draft</button></>}
            {p.status === "pending_approval" && <><button className={accent} onClick={() => act(p, "approve")}>Approve</button><button className={btn} onClick={() => act(p, "reject", { note: window.prompt("Why? (optional)") || "" })}>Reject</button></>}
            {(p.status === "published" || p.status === "retired") && <button className={btn} onClick={() => act(p, "newVersion")}>New version</button>}
            {p.status === "published" && <button className={`${btn} !text-red-400`} onClick={() => window.confirm("Retire this policy? It stops being enforced immediately.") && act(p, "retire", { reason: "Retired by admin" })}>Retire</button>}
          </div>
        </div>))}
    </div>
  );
}

function Dlp({ orgId }) {
  const [events, setEvents] = useState(null); const [appr, setAppr] = useState([]); const [err, setErr] = useState(""); const [sim, setSim] = useState({ action: "download", ip: "", classification: "", filename: "", destinationDomain: "" }); const [simOut, setSimOut] = useState(null);
  const load = useCallback(async () => { try { const [e, a] = await Promise.all([govApi(`/api/orgs/governance/dlp/events?orgId=${orgId}&limit=50`), govApi(`/api/orgs/governance/dlp/approvals?orgId=${orgId}`)]); setEvents(e.events); setAppr(a.approvals); setErr(""); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  const decide = async (id, approve) => { try { await govApi("/api/orgs/governance/dlp/approvals", { method: "POST", body: JSON.stringify({ orgId, approvalId: id, approve }) }); load(); } catch (e) { setErr(e.message); } };
  const run = async () => { try { setSimOut(await govApi("/api/orgs/governance/dlp/simulate", { method: "POST", body: JSON.stringify({ orgId, context: { ...sim, classification: sim.classification || undefined, ip: sim.ip || undefined, filename: sim.filename || undefined, destinationDomain: sim.destinationDomain || undefined } }) })); setErr(""); } catch (e) { setErr(e.message); } };
  return (
    <div className="space-y-4">
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      <div className={`${card} p-3`}><h3 className="text-[13px] font-bold mb-2">Waiting for approval</h3>
        {appr.length === 0 ? <p className={`text-[12px] ${muted}`}>Nothing is waiting.</p> : appr.map((a) => <div key={a.approvalId} className="flex flex-wrap items-center gap-2 py-1 text-[12px] border-t border-[var(--inaya-overlay-10)] first:border-0"><span className="flex-1">{a.actor} wants to <b>{a.action.replace("_", " ")}</b>{a.filename ? ` “${a.filename}”` : ""}. {a.reason}</span><button className={accent} onClick={() => decide(a.approvalId, true)}>Approve</button><button className={btn} onClick={() => decide(a.approvalId, false)}>Deny</button></div>)}</div>
      <div className={`${card} p-3 space-y-2`}><h3 className="text-[13px] font-bold">Try a rule set</h3>
        <p className={`text-[11px] ${muted}`}>Shows what the published DLP rules would do. Nothing is recorded or enforced.</p>
        <div className="grid sm:grid-cols-5 gap-2">
          <select aria-label="Action" className={field} value={sim.action} onChange={(e) => setSim({ ...sim, action: e.target.value })}>{["upload", "download", "preview", "share_create", "share_open", "share_download", "delete", "external_share", "api_access", "export"].map((a) => <option key={a}>{a}</option>)}</select>
          <input aria-label="IP address" className={field} placeholder="IP address" value={sim.ip} onChange={(e) => setSim({ ...sim, ip: e.target.value })} />
          <input aria-label="Classification" className={field} placeholder="Classification" value={sim.classification} onChange={(e) => setSim({ ...sim, classification: e.target.value.toUpperCase() })} />
          <input aria-label="File name" className={field} placeholder="File name" value={sim.filename} onChange={(e) => setSim({ ...sim, filename: e.target.value })} />
          <input aria-label="Destination domain" className={field} placeholder="Destination domain" value={sim.destinationDomain} onChange={(e) => setSim({ ...sim, destinationDomain: e.target.value })} />
        </div>
        <button className={accent} onClick={run}>Evaluate</button>
        {simOut && <p className="text-[12px]" role="status"><Pill k={simOut.decision} /> {simOut.reason}{simOut.ruleId ? <span className={muted}> (rule {simOut.ruleId}, policy version {simOut.policyVersion})</span> : null}</p>}
      </div>
      <div className={`${card} p-3`}><h3 className="text-[13px] font-bold mb-2">Recent decisions</h3>
        {events === null ? <p className={`text-[12px] ${muted}`}>Loading…</p> : events.length === 0 ? <p className={`text-[12px] ${muted}`}>No restrictions have been applied yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-[11px]"><thead><tr className={`text-left ${muted}`}><th className="pr-2">When</th><th className="pr-2">Who</th><th className="pr-2">Action</th><th className="pr-2">Decision</th><th>Why</th></tr></thead><tbody>
            {events.map((e) => <tr key={e.eventId} className="border-t border-[var(--inaya-overlay-10)] align-top"><td className="pr-2 whitespace-nowrap">{when(e.at)}</td><td className="pr-2">{e.actor}</td><td className="pr-2">{e.action}{e.path ? <div className={muted}>{e.path}</div> : null}</td><td className="pr-2"><Pill k={e.decision} /></td><td>{e.reason}{e.context?.ip ? <span className={muted}> · from {e.context.ip}</span> : null}</td></tr>)}</tbody></table></div>)}</div>
    </div>
  );
}

function Metadata({ orgId }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(""); const [f, setF] = useState({ key: "", label: "", type: "text", options: "", required: false, visibility: "members", editableBy: "edit" });
  const load = useCallback(async () => { try { setData(await govApi(`/api/orgs/governance/metadata/fields?orgId=${orgId}`)); setErr(""); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  const add = async () => { try { await govApi("/api/orgs/governance/metadata/fields", { method: "POST", body: JSON.stringify({ orgId, ...f, options: f.type === "vocabulary" ? f.options.split(",").map((s) => s.trim()).filter(Boolean) : null }) }); setF({ ...f, key: "", label: "", options: "" }); load(); } catch (e) { setErr(e.message); } };
  return (
    <div className="space-y-3">
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      <div className={`${card} p-3 space-y-2`}><h3 className="text-[13px] font-bold">Add a field</h3>
        <div className="grid sm:grid-cols-4 gap-2">
          <input aria-label="Field key" className={field} placeholder="key (contract_value)" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
          <input aria-label="Field label" className={field} placeholder="Label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          <select aria-label="Field type" className={field} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{["text", "number", "boolean", "date", "email", "phone", "vocabulary"].map((t) => <option key={t}>{t}</option>)}</select>
          {f.type === "vocabulary" ? <input aria-label="Options" className={field} placeholder="Options, comma separated" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} /> : <span />}
        </div>
        <div className="flex flex-wrap gap-3 text-[12px] items-center">
          <label className="flex items-center gap-1"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> Required</label>
          <label className="flex items-center gap-1">Visible to <select aria-label="Visibility" className={`${field} !w-auto`} value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}><option value="members">anyone who can view the file</option><option value="managers">managers only</option></select></label>
          <label className="flex items-center gap-1">Editable by <select aria-label="Editable by" className={`${field} !w-auto`} value={f.editableBy} onChange={(e) => setF({ ...f, editableBy: e.target.value })}><option value="edit">editors</option><option value="manage">managers only</option></select></label>
          <button className={accent} disabled={!f.key} onClick={add}>Add field</button>
        </div>
      </div>
      <div className={`${card} p-3`}><h3 className="text-[13px] font-bold mb-2">Fields</h3>
        {!data ? <p className={`text-[12px] ${muted}`}>Loading…</p> : data.fields.map((x) => (
          <div key={x.key} className="flex items-center gap-2 py-1 text-[12px] border-t border-[var(--inaya-overlay-10)] first:border-0"><span className="flex-1"><b>{x.label}</b> <span className={muted}>{x.key} · {x.type}{x.options ? ` (${x.options.slice(0, 6).join(", ")}${x.options.length > 6 ? "…" : ""})` : ""}{x.builtin ? " · built in" : ""}{x.readOnly ? " · set by the system" : ""}{x.required ? " · required" : ""}{x.visibility === "managers" ? " · managers only" : ""}</span></span>
            {!x.builtin && <button className={`${btn} !text-red-400`} onClick={async () => { if (window.confirm(`Archive “${x.label}”? Existing values are kept.`)) { try { await govApi(`/api/orgs/governance/metadata/fields?orgId=${orgId}&key=${x.key}`, { method: "DELETE" }); load(); } catch (e) { setErr(e.message); } } }}>Archive</button>}</div>))}
      </div>
      <p className={`text-[11px] ${muted}`}>Metadata is visible only to people who can already see the file, never to people holding a share link or a file-request link.</p>
    </div>
  );
}

export default function GovernanceView({ orgId, canManage }) {
  const [tab, setTab] = useState("policies"); const [types, setTypes] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { govApi(`/api/orgs/governance/policies?orgId=${orgId}`).then((r) => setTypes(r.types)).catch((e) => setErr(e.message)); }, [orgId]);
  if (!canManage) return <EmptyState title="Governance" description="Only owners and admins can manage governance policies." />;
  if (err) return <EmptyState title="Governance" description={err} />;
  if (!types) return <p className={`text-[12px] ${muted}`}>Loading…</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">{[["policies", "Policies"], ["dlp", "Data protection (DLP)"], ["metadata", "Metadata fields"]].map(([k, l]) => <button key={k} className={`${btn} ${tab === k ? "!bg-[#00f2fe]/15 !border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <p className={`text-[11px] ${muted}`}>Policies are versioned. A published policy never changes: edit it by creating a new version. Rules only ever restrict; they cannot grant access that permissions do not already give. Features are switched on under Settings, Beta features.</p>
      {tab === "policies" && <Policies orgId={orgId} types={types} />}
      {tab === "dlp" && <Dlp orgId={orgId} />}
      {tab === "metadata" && <Metadata orgId={orgId} />}
    </div>
  );
}
