"use client";

// src/components/business/admin/ComplianceReadinessView.js -- compliance readiness (Competitive Expansion SOW P and Q): the NIST SP 800-53 internal catalog with control status, responsibility,
// owners, evidence and exceptions; the government security profile; cryptography and FIPS status; the evidence package; customer-managed keys. It never claims certification, and it says
// plainly when something is not assessed, not collected or not verified.
import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); } catch { return "-"; } };
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Request failed."); return d; };
const TONE = { implemented: "text-emerald-400", partially_implemented: "text-amber-300", not_implemented: "text-red-400", inherited: "text-sky-300", not_applicable: muted, not_assessed: muted, available: "text-emerald-400", required: "text-amber-300", none: muted, OK: "text-emerald-400", ATTENTION: "text-amber-300", NO_DATA: muted, NOT_ENABLED: muted, UNKNOWN: muted };
const label = (s) => String(s).replace(/_/g, " ");

export default function ComplianceReadinessView({ orgId, canManage, isOwner }) {
  const [tab, setTab] = useState("overview"); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const act = async (fn, ok) => { setErr(""); setMsg(""); try { const r = await fn(); if (ok) setMsg(ok); return r; } catch (e) { setErr(e.message); } };
  const tabs = [["overview", "Overview"], ["controls", "Controls"], ["government", "Government profile"], ["crypto", "Cryptography"], ["keys", "Encryption keys"], ["package", "Evidence package"]];
  return (
    <div className="space-y-3 text-[12px]">
      <p className={muted}>Track how controls are implemented, who is responsible, and what evidence supports them. These states describe how controls are being tracked. They are not a statement of compliance, authorization or certification.</p>
      <div className="flex flex-wrap gap-1">{tabs.map(([k, l]) => <button key={k} className={tab === k ? accent : btn} onClick={() => { setTab(k); setErr(""); setMsg(""); }}>{l}</button>)}</div>
      {err && <p className="text-red-400" role="alert">{err}</p>}{msg && <p className="text-emerald-400" role="status">{msg}</p>}
      {tab === "overview" && <Overview orgId={orgId} act={act} canManage={canManage} />}
      {tab === "controls" && <Controls orgId={orgId} act={act} canManage={canManage} />}
      {tab === "government" && <Government orgId={orgId} act={act} isOwner={isOwner} />}
      {tab === "crypto" && <Crypto orgId={orgId} act={act} />}
      {tab === "keys" && <Keys orgId={orgId} act={act} isOwner={isOwner} />}
      {tab === "package" && <Package orgId={orgId} act={act} setMsg={setMsg} />}
    </div>
  );
}

function Overview({ orgId, act, canManage }) {
  const [s, setS] = useState(null); const [facts, setFacts] = useState([]);
  const load = useCallback(async () => { await act(async () => { setS(await j(`/api/orgs/compliance/summary?orgId=${orgId}`)); setFacts((await j(`/api/orgs/compliance/facts?orgId=${orgId}`)).facts); }); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]); if (!s) return <p className={muted}>Loading…</p>; const t = s.totals;
  return (<div className="space-y-2">
    <div className={`${card} p-3`}><b>{s.catalog.id.replace(/_/g, " ")} (internal catalog {s.catalog.version})</b><p className={muted}>{s.catalog.note}</p>
      <p>{t.controls} controls · {t.assessed} assessed by your team · {t.owned} with an owner · evidence available for {t.evidence.available}, still required for {t.evidence.required} · {t.exceptionsApproved} exception(s) in force, {t.exceptionsExpired} expired</p>
      <p className={muted}>{Object.entries(t.byImplementation).map(([k, v]) => `${v} ${label(k)}`).join(" · ")}</p></div>
    <div className={`${card} p-3 overflow-x-auto`}><table className="w-full text-left"><thead><tr className={muted}><th className="pr-3">Family</th><th className="pr-3">Controls</th><th className="pr-3">Implemented</th><th className="pr-3">Partial</th><th className="pr-3">Inherited</th><th className="pr-3">Not assessed</th><th>Evidence needed</th></tr></thead>
      <tbody>{s.families.map((f) => <tr key={f.family} className="border-t border-[var(--inaya-overlay-10)]"><td className="pr-3 py-1"><b>{f.family}</b> {f.name}</td><td className="pr-3">{f.controls}</td><td className="pr-3">{f.implemented}</td><td className="pr-3">{f.partial}</td><td className="pr-3">{f.inherited}</td><td className="pr-3">{f.notAssessed}</td><td className={f.evidenceRequired ? "text-amber-300" : ""}>{f.evidenceRequired}</td></tr>)}</tbody></table></div>
    <div className={`${card} p-3 space-y-1`}><div className="flex gap-2 items-center"><b>Live facts</b>{canManage && <button className={btn} onClick={() => act(async () => { await j("/api/orgs/compliance/snapshot", { method: "POST", body: JSON.stringify({ orgId }) }); }, "Snapshot taken. You can attach its facts to a control as evidence.")}>Take snapshot</button>}</div>
      {facts.map((f) => <div key={f.id} className="flex gap-2 border-t border-[var(--inaya-overlay-10)] py-1"><b className="w-48 shrink-0">{f.label}</b><span className={`text-[10px] font-bold uppercase w-24 shrink-0 ${TONE[f.state] || ""}`}>{label(f.state)}</span><span className={muted}>{f.summary}</span></div>)}
      <p className={muted}>Facts are what was observed right now, from your own records. A fact is not an assessment: a person decides each control's status.</p></div>
  </div>);
}

function Controls({ orgId, act, canManage }) {
  const [list, setList] = useState(null); const [f, setF] = useState({ family: "", implementation: "", evidence: "", q: "" }); const [sel, setSel] = useState(null); const [ev, setEv] = useState({ url: "", label: "" }); const [ex, setEx] = useState({ reason: "", compensating: "", expiresAt: "" });
  const qs = () => Object.entries(f).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");
  const load = useCallback(async () => { await act(async () => { const r = await j(`/api/orgs/compliance/controls?orgId=${orgId}${qs()}`); setList(r); }); }, [orgId, f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const open = (id) => act(async () => { setSel((await j(`/api/orgs/compliance/controls/${id}?orgId=${orgId}`)).control); });
  const patch = (id, body) => act(async () => { setSel((await j(`/api/orgs/compliance/controls/${id}`, { method: "PATCH", body: JSON.stringify({ orgId, ...body }) })).control); load(); }, "Saved.");
  if (!list) return <p className={muted}>Loading…</p>;
  return (<div className="space-y-2">
    <div className="flex flex-wrap gap-2"><select aria-label="Family" className={field} value={f.family} onChange={(e) => setF({ ...f, family: e.target.value })}><option value="">All families</option>{Object.entries(list.catalog.families).map(([k, v]) => <option key={k} value={k}>{k} {v}</option>)}</select>
      <select aria-label="Implementation" className={field} value={f.implementation} onChange={(e) => setF({ ...f, implementation: e.target.value })}><option value="">Any status</option>{["implemented", "partially_implemented", "not_implemented", "inherited", "not_applicable", "not_assessed"].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>
      <select aria-label="Evidence" className={field} value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })}><option value="">Any evidence state</option><option value="available">Evidence available</option><option value="required">Evidence required</option></select>
      <input aria-label="Search controls" className={`${field} w-56`} placeholder="Search by id or title" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
    <p className={muted}>{list.controls.length} control(s) shown.</p>
    <div className={`${card} p-2 max-h-96 overflow-y-auto`}>{list.controls.length === 0 ? <EmptyState compact icon="🗂️" description="No controls match." /> : list.controls.map((c) => <button key={c.controlId} className="w-full text-left flex gap-2 py-1 border-t border-[var(--inaya-overlay-10)] first:border-0 hover:bg-[var(--inaya-overlay-10)]" onClick={() => open(c.controlId)}><b className="w-14 shrink-0">{c.controlId}</b><span className="flex-1">{c.title}</span><span className={`text-[10px] font-bold uppercase w-32 shrink-0 ${TONE[c.implementation]}`}>{label(c.implementation)}</span><span className="w-20 shrink-0">{c.responsibility}</span><span className={`text-[10px] uppercase w-16 shrink-0 ${TONE[c.evidence.state]}`}>{c.evidence.state}</span></button>)}</div>
    {sel && <div className={`${card} p-3 space-y-2`}>
      <div className="flex flex-wrap items-center gap-2"><b>{sel.controlId} · {sel.title}</b><span className={muted}>{sel.familyName}</span><span className={`text-[10px] uppercase ${sel.source === "default" ? muted : ""}`}>{sel.source === "default" ? "default, not yet confirmed by your team" : "assessed"}</span></div>
      <p>{sel.statement}</p>
      {canManage && <div className="flex flex-wrap gap-2 items-end">
        <label>Status<br /><select aria-label="Set implementation" className={field} value={sel.implementation} onChange={(e) => patch(sel.controlId, { implementation: e.target.value })}>{["implemented", "partially_implemented", "not_implemented", "inherited", "not_applicable", "not_assessed"].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></label>
        <label>Responsibility<br /><select aria-label="Set responsibility" className={field} value={sel.responsibility} onChange={(e) => patch(sel.controlId, { responsibility: e.target.value })}>{["provider", "customer", "shared", "inherited"].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        <label>Owner (member e-mail)<br /><input aria-label="Owner" className={`${field} w-56`} defaultValue={sel.owner || ""} onBlur={(e) => e.target.value !== (sel.owner || "") && patch(sel.controlId, { ownerEmail: e.target.value })} /></label></div>}
      <div><b>Evidence: <span className={TONE[sel.evidence.state]}>{sel.evidence.state}</span></b>{sel.evidence.why && <span className={muted}> · {sel.evidence.why}</span>}
        {sel.facts.map((x) => <p key={x.id} className={muted}>Live fact, {x.label}: {x.summary}</p>)}
        {sel.evidence.refs.map((r) => <div key={r.refId} className="flex gap-2 items-center"><span>{r.kind}: {r.label || r.url || r.collectorId}</span>{r.reviewStatus && <span className={muted}>({r.reviewStatus})</span>}{canManage && <button className={`${btn} !text-red-400`} onClick={() => act(async () => { setSel((await j(`/api/orgs/compliance/controls/${sel.controlId}/evidence/${r.refId}?orgId=${orgId}`, { method: "DELETE" })).control); load(); })}>Remove</button>}</div>)}
        {canManage && <div className="flex gap-2 mt-1"><input aria-label="Evidence link" className={`${field} w-64`} placeholder="https:// link to a document" value={ev.url} onChange={(e) => setEv({ ...ev, url: e.target.value })} /><input aria-label="Evidence label" className={`${field} w-40`} placeholder="Label" value={ev.label} onChange={(e) => setEv({ ...ev, label: e.target.value })} /><button className={accent} disabled={!ev.url} onClick={() => act(async () => { setSel((await j(`/api/orgs/compliance/controls/${sel.controlId}/evidence`, { method: "POST", body: JSON.stringify({ orgId, ref: { kind: "link", url: ev.url, label: ev.label } }) })).control); setEv({ url: "", label: "" }); load(); }, "Evidence attached.")}>Attach link</button></div>}</div>
      <div><b>Exception</b>{sel.exception ? <p className={sel.exception.state === "approved" ? "text-amber-300" : muted}>{sel.exception.state}: {sel.exception.reason} (compensating: {sel.exception.compensating}) until {when(sel.exception.expiresAt)}{canManage && sel.exception.state === "approved" && <button className={`${btn} ml-2`} onClick={() => act(async () => { setSel((await j(`/api/orgs/compliance/controls/${sel.controlId}/exception?orgId=${orgId}`, { method: "DELETE" })).control); load(); })}>Close</button>}</p> : canManage ? <div className="space-y-1"><input aria-label="Exception reason" className={`${field} w-full`} placeholder="Why this control cannot be met for now (at least 20 characters)" value={ex.reason} onChange={(e) => setEx({ ...ex, reason: e.target.value })} /><div className="flex gap-2"><input aria-label="Compensating measure" className={`${field} flex-1`} placeholder="Compensating measure" value={ex.compensating} onChange={(e) => setEx({ ...ex, compensating: e.target.value })} /><input aria-label="Expires" type="date" className={field} value={ex.expiresAt} onChange={(e) => setEx({ ...ex, expiresAt: e.target.value })} /><button className={btn} disabled={!ex.reason || !ex.compensating || !ex.expiresAt} onClick={() => act(async () => { setSel((await j(`/api/orgs/compliance/controls/${sel.controlId}/exception`, { method: "POST", body: JSON.stringify({ orgId, reason: ex.reason, compensating: ex.compensating, expiresAt: new Date(ex.expiresAt).toISOString() }) })).control); setEx({ reason: "", compensating: "", expiresAt: "" }); load(); }, "Exception approved. It expires on its date.")}>Approve exception</button></div><p className={muted}>An exception always expires within a year and is never silent.</p></div> : <p className={muted}>None.</p>}</div>
    </div>}
  </div>);
}

function Government({ orgId, act, isOwner }) {
  const [g, setG] = useState(null); const [log, setLog] = useState([]); const [auth, setAuth] = useState({ authority: "", reference: "", boundary: "", grantedOn: "" });
  const load = useCallback(async () => { await act(async () => { setG(await j(`/api/orgs/compliance/government?orgId=${orgId}`)); setLog((await j(`/api/orgs/compliance/government/access?orgId=${orgId}&limit=20`)).events); }); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]); if (!g) return <p className={muted}>Loading…</p>;
  const set = (state, extra = {}) => act(async () => { setG(await j("/api/orgs/compliance/government", { method: "PUT", body: JSON.stringify({ orgId, state, ...extra }) })); load(); }, "Profile saved.");
  return (<div className="space-y-2">
    <div className="rounded-lg border border-amber-300/40 p-3 text-amber-200">{g.notice}</div>
    <div className={`${card} p-3 space-y-2`}><b>Current profile: {g.label}</b>
      {isOwner && <div className="flex flex-wrap gap-2 items-center"><select aria-label="Profile" className={field} value={g.state} onChange={(e) => e.target.value !== "CUSTOMER_SPECIFIC_AUTHORIZATION" && set(e.target.value)}>{g.states.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        <label className="flex items-center gap-1">Client address in access records <select aria-label="Address policy" className={field} value={g.ipPolicy} onChange={(e) => set(g.state, { ipPolicy: e.target.value })}><option value="masked">masked</option><option value="full">full</option><option value="none">not recorded</option></select></label></div>}
      {isOwner && <details><summary className="cursor-pointer">Record a customer-specific authorization</summary><div className="grid gap-1 mt-1"><input aria-label="Authorizing body" className={field} placeholder="Authorizing body" value={auth.authority} onChange={(e) => setAuth({ ...auth, authority: e.target.value })} /><input aria-label="Authorization reference" className={field} placeholder="Reference" value={auth.reference} onChange={(e) => setAuth({ ...auth, reference: e.target.value })} /><input aria-label="Boundary" className={field} placeholder="System boundary" value={auth.boundary} onChange={(e) => setAuth({ ...auth, boundary: e.target.value })} /><input aria-label="Granted on" type="date" className={field} value={auth.grantedOn} onChange={(e) => setAuth({ ...auth, grantedOn: e.target.value })} /><button className={btn} onClick={() => set("CUSTOMER_SPECIFIC_AUTHORIZATION", { authorization: auth })}>Record (Inaya does not verify it)</button></div></details>}
      {g.authorization && <p className={muted}>Recorded by {g.authorization.recordedBy}: {g.authorization.authority}, {g.authorization.reference}. Not verified by Inaya.</p>}
      {g.technicalChecks.total > 0 && <div><p><b>{g.technicalChecks.met} of {g.technicalChecks.total}</b> technical checks currently met{g.technicalChecks.unevaluated ? ` (${g.technicalChecks.unevaluated} could not be evaluated)` : ""}.</p>{g.technicalChecks.checks.map((c) => <div key={c.id} className="flex gap-2 border-t border-[var(--inaya-overlay-10)] py-1"><span className={c.met ? "text-emerald-400" : c.evaluated ? "text-amber-300" : muted}>{c.met ? "met" : c.evaluated ? "not met" : "unknown"}</span><b className="w-72 shrink-0">{c.label}</b><span className={muted}>{c.detail}</span></div>)}</div>}</div>
    {isOwner && <div className={`${card} p-3`}><b>Government data labels</b><p className={muted}>Adds Sensitive, Controlled class A and Export-controlled class (both customer-defined, neutral names), Legal Hold and Mission Critical next to your existing labels. Existing labels are not changed.</p><button className={btn} onClick={() => act(async () => { const r = await j("/api/orgs/compliance/government/labels", { method: "POST", body: JSON.stringify({ orgId }) }); return r; }, "Labels applied.")}>Apply label set</button></div>}
    <div className={`${card} p-3`}><b>Enhanced access records</b>{!g.enhancedAudit ? <p className={muted}>Off under the General profile.</p> : log.length === 0 ? <p className={muted}>No document reads recorded yet.</p> : log.map((e, i) => <p key={i} className={muted}>{when(e.at)} · {e.user} ({e.role}) · {e.action} {e.object?.type} · {e.result} · {e.policyDecision} · address {e.ip || "not recorded"}</p>)}</div>
  </div>);
}

function Crypto({ orgId, act }) {
  const [c, setC] = useState(null); useEffect(() => { act(async () => setC(await j(`/api/orgs/compliance/crypto?orgId=${orgId}`))); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <p className={muted}>Loading…</p>;
  return (<div className="space-y-2">
    <div className={`${card} p-3`}><b>FIPS status: <span className={c.fips.status === "FIPS_READY" ? "text-emerald-400" : "text-amber-300"}>{label(c.fips.status)}</span></b><p>{c.fips.explanation}</p><p className={muted}>{c.fips.claim}</p><p className={muted}>Cryptographic mode: {c.mode.replace("_", "-")}.</p></div>
    <div className={`${card} p-3`}><b>Self-tests (published vectors)</b><p className={c.selfTest.passed && c.selfTestNoble.passed ? "text-emerald-400" : "text-red-400"}>{c.selfTest.passed ? "Node crypto: all passed." : "Node crypto: FAILED."} {c.selfTestNoble.passed ? "noble libraries: all passed." : "noble libraries: FAILED or unavailable."}</p><p className={muted}>{[...c.selfTest.results, ...c.selfTestNoble.results].map((r) => `${r.provider} ${r.id} ${r.pass ? "ok" : "FAIL"}`).join(" · ")}</p></div>
    <div className={`${card} p-3`}><b>Providers</b>{c.providers.map((p) => <p key={p.id}><b>{p.label}</b> <span className={muted}>{p.available ? "available" : "not available"} · {p.validated ? "validated" : "not validated"} · {p.note}</span></p>)}</div>
    <div className={`${card} p-3 overflow-x-auto`}><b>Where cryptography is used</b><table className="w-full text-left"><tbody>{c.usage.map((u) => <tr key={u.subsystem} className="border-t border-[var(--inaya-overlay-10)] align-top"><td className="pr-3 py-1"><b>{u.subsystem}</b><br /><span className={muted}>{u.purpose}</span></td><td className="pr-3">{u.algorithms.join(", ")}</td><td className={u.allApproved ? "text-emerald-400" : "text-amber-300"}>{u.allApproved ? "all NIST-approved" : `not NIST-approved: ${u.notApproved.join(", ")}`}</td><td className={muted}>{u.keyHolder}</td></tr>)}</tbody></table></div>
    <div className={`${card} p-3`}><b>Cryptographic module dependencies</b>{c.dependencies.modules.map((m) => <p key={m.name} className={muted}><b className="text-[var(--inaya-text-primary)]">{m.name}</b> {m.version || ""} · {m.validated ? "validated" : "not a validated module"}</p>)}</div>
  </div>);
}

function Keys({ orgId, act, isOwner }) {
  const [s, setS] = useState(null); const [aud, setAud] = useState([]); const [f, setF] = useState({ provider: "kms", keyRef: "", region: "", ack: false });
  const load = useCallback(async () => { await act(async () => { setS(await j(`/api/orgs/compliance/keys?orgId=${orgId}`)); setAud((await j(`/api/orgs/compliance/keys/audit?orgId=${orgId}&limit=15`)).events); }); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]); if (!s) return <p className={muted}>Loading…</p>; const c = s.config;
  const post = (path, body, ok) => act(async () => { setS(await j(`/api/orgs/compliance/keys/${path}`, { method: "POST", body: JSON.stringify({ orgId, ...body }) })); load(); }, ok);
  return (<div className="space-y-2">
    <div className="rounded-lg border border-red-400/40 p-3 text-red-200">{s.warning}</div>
    <div className={`${card} p-3 space-y-1`}><b>Key provider: {c.provider === "platform" ? "Platform-managed (default)" : `${c.provider} · ${c.keyRef}`}</b> <span className={`text-[10px] uppercase ${c.state === "active" ? "text-emerald-400" : "text-red-400"}`}>{c.state}</span>
      <p className={muted}>Version {c.version} · environment {c.environment} · data key protected by {s.dataKey.protectedBy || "nothing yet (created with the first storage credential)"}.</p>
      <p className={muted}>The key provider only ever wraps a small data key. It never receives your file content.</p>
      {c.history.map((h) => <p key={h.version} className={muted}>v{h.version} · {h.provider} · {h.keyRef} · {h.state}</p>)}
      <p>Last 30 days: {s.telemetry.operations} key operation(s), <span className={s.telemetry.failures ? "text-amber-300" : ""}>{s.telemetry.failures} failed</span>{s.telemetry.lastFailure ? `; last failure ${s.telemetry.lastFailure.code} at ${when(s.telemetry.lastFailure.at)}` : ""}.</p></div>
    {isOwner ? <div className={`${card} p-3 space-y-2`}><b>Change key management (owner only)</b>
      <div className="flex flex-wrap gap-2"><select aria-label="Provider" className={field} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option value="kms">AWS KMS (your key)</option><option value="local">Local key material</option><option value="platform">Platform-managed</option></select>
        {f.provider !== "platform" && <input aria-label="Key reference" className={`${field} w-72`} placeholder="Key ARN, alias or local key id" value={f.keyRef} onChange={(e) => setF({ ...f, keyRef: e.target.value })} />}{f.provider === "kms" && <input aria-label="Region" className={`${field} w-32`} placeholder="Region" value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} />}</div>
      {f.provider !== "platform" && <label className="flex items-start gap-2"><input type="checkbox" checked={f.ack} onChange={(e) => setF({ ...f, ack: e.target.checked })} /><span>I understand that destroying or revoking this key makes the data encrypted under it permanently unreadable, and that Inaya keeps no copy once it is in use.</span></label>}
      <div className="flex gap-2"><button className={accent} disabled={f.provider !== "platform" && (!f.keyRef || !f.ack)} onClick={() => post("configure", { provider: f.provider, keyRef: f.keyRef, region: f.region || undefined, acknowledgeDestruction: f.ack }, "Key provider changed. The data key was re-wrapped; your files were not touched.")}>Apply</button>
        {c.provider !== "platform" && <><button className={btn} onClick={() => window.confirm("Rotate to the key reference above (or the same key's new version)?") && post("rotate", { keyRef: f.keyRef || undefined }, "Rotated.")}>Rotate</button><button className={btn} onClick={() => post("state", { state: c.state === "active" ? "disabled" : "active" }, c.state === "active" ? "Disabled in Inaya. Your key itself is untouched." : "Enabled.")}>{c.state === "active" ? "Disable in Inaya" : "Enable"}</button></>}</div></div> : <p className={muted}>Only the organization owner can change key management.</p>}
    <div className={`${card} p-3`}><b>Recent key operations</b>{aud.length === 0 ? <p className={muted}>None yet.</p> : aud.map((e, i) => <p key={i} className={e.ok ? muted : "text-amber-300"}>{when(e.at)} · {e.op} · {e.ok ? "ok" : `failed (${e.code})`} · {e.keyRef || ""}</p>)}</div>
  </div>);
}

function Package({ orgId, act, setMsg }) {
  const download = () => act(async () => { const pkg = await j(`/api/orgs/compliance/package?orgId=${orgId}`); const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `evidence-package-${pkg.generatedAt.slice(0, 10)}.json`; a.click(); setMsg(`Exported. SHA-256 ${pkg.sha256.slice(0, 16)}… Structure check: ${pkg.shapeCheck.ok ? "passed" : `${pkg.shapeCheck.problems.length} problem(s)`}.`); });
  return (<div className={`${card} p-3 space-y-2`}><b>Evidence package</b>
    <p className={muted}>One JSON file with an OSCAL-shaped system security plan (control status, evidence links, components) plus the system description, policy versions, audit-chain verification, configuration snapshots, deployment profile, identity integrations, incidents, resilience results, data residency, encryption and key-management mode, cryptography and a customer-responsibility statement. It contains metadata only: no file content and no secrets.</p>
    <p className={muted}>It is OSCAL-shaped, not validated against the official OSCAL schema. Vulnerability results are reported as not collected. It is evidence for your assessors, not an assessment or certification.</p>
    <button className={accent} onClick={download}>Export evidence package</button></div>);
}
