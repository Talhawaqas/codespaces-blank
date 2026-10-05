"use client";

// src/components/business/endpoint/RansomwareView.js
//
// Cloud-file ransomware signals for owners and admins (Competitive Expansion SOW F). Shows signals with the rule, counts and confidence that
// raised them, the credentials currently contained, the policy, a rollback planner that restores previous versions, tripwire placement and an
// incident export. Signals are heuristics, not proof; the page says so.

import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return "-"; } };
const LEVEL = { CRITICAL: "text-red-400 border-red-400/40", HIGH: "text-orange-300 border-orange-400/40", MEDIUM: "text-amber-300 border-amber-400/40", LOW: "text-sky-300 border-sky-400/40" };
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); let d = {}; try { d = await r.json(); } catch { /* empty */ } if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { status: r.status }); return d; };

export default function RansomwareView({ orgId, canManage }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [off, setOff] = useState(false);
  const [plan, setPlan] = useState(null); const [pol, setPol] = useState(null); const [bucket, setBucket] = useState(""); const [picked, setPicked] = useState(new Set());
  const load = useCallback(async () => { try { const d = await j(`/api/orgs/security/ransomware?orgId=${orgId}`); setData(d); setPol((p) => p || { enabled: d.policy.enabled, autoContainLevel: d.policy.autoContainLevel, containMinutes: d.policy.containMinutes }); setErr(""); } catch (e) { if (e.status === 404) setOff(true); else setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  const post = async (body, ok) => { setErr(""); setMsg(""); try { const r = await j("/api/orgs/security/ransomware", { method: "POST", body: JSON.stringify({ orgId, ...body }) }); if (ok) setMsg(typeof ok === "function" ? ok(r) : ok); load(); return r; } catch (e) { setErr(e.message); } };
  if (!canManage) return <EmptyState title="Ransomware signals" description="Only owners and admins can see security signals." />;
  if (off) return <EmptyState title="Ransomware signals are not enabled" description="Turn on “Ransomware signals” under Settings, Beta features." />;
  if (!data) return <p className={`text-[12px] ${muted}`}>{err || "Loading…"}</p>;
  return (
    <div className="space-y-3 text-[12px]">
      {err && <p className="text-red-400" role="alert">{err}</p>}{msg && <p className="text-emerald-400" role="status">{msg}</p>}
      <p className={muted}>Signals are measured from file activity (mass overwrites and deletes, encryption-like rewrites, known ransomware extensions, ransom-note names, burst downloads and sharing, and a hidden tripwire file). They are heuristics with a recorded rule and confidence, not proof of an attack. Impossible-travel checks are not offered because Inaya does not collect location.</p>
      {data.containments.length > 0 && <div className={`${card} p-3 border-red-400/40`}><p className="font-bold text-red-400 mb-1">Writes paused</p>{data.containments.map((c) => <div key={c.actorKey} className="flex items-center gap-2 py-1"><span className="flex-1"><code>{c.actorKey}</code> · {c.level} · until {when(c.until)}</span><button className={accent} onClick={() => post({ action: "lift", actorKey: c.actorKey }, "Containment lifted.")}>Lift</button></div>)}<p className={muted}>Reads keep working. Containment always expires.</p></div>}
      <div className={`${card} p-3`}><p className="font-bold mb-2">Signals</p>
        {data.signals.length === 0 ? <p className={muted}>No unusual activity has been detected.</p> : data.signals.map((s) => (
          <div key={s.signalId} className="border-t border-[var(--inaya-overlay-10)] py-2 first:border-0">
            <div className="flex flex-wrap items-center gap-2"><span className={`text-[10px] font-bold uppercase border rounded-full px-2 py-0.5 ${LEVEL[s.level] || ""}`}>{s.level}</span><code>{s.actorKey}</code><span className={muted}>{when(s.at)} · score {s.score} · confidence {Math.round(s.confidence * 100)}% · {s.state}{s.contained ? " · contained" : ""}</span></div>
            <ul className="list-disc ml-5">{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul><p className={muted}>Rules: {s.rules.join(", ")} · source {s.source}</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {s.state === "open" && <><button className={btn} onClick={() => post({ action: "resolve", signalId: s.signalId, resolution: "false_positive" }, "Marked as a false positive.")}>False positive</button><button className={btn} onClick={() => post({ action: "resolve", signalId: s.signalId, resolution: "confirmed" }, "Marked as confirmed.")}>Confirmed</button><button className={btn} onClick={() => post({ action: "resolve", signalId: s.signalId, resolution: "acknowledged" }, "Acknowledged.")}>Acknowledge</button></>}
              <button className={btn} onClick={async () => { const r = await post({ action: "rollbackPreview", actorKey: s.actorKey, since: new Date(new Date(s.at).getTime() - 3 * 3600_000).toISOString() }); if (r) { setPlan(r); setPicked(new Set(r.objects.filter((o) => o.restorableVersionId).map((o) => `${o.bucket}/${o.key}`))); } }}>Plan rollback</button>
              <button className={btn} onClick={async () => { const r = await post({ action: "incident", signalId: s.signalId }); if (r) { const u = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = u; a.download = `incident-${s.signalId}.json`; a.click(); URL.revokeObjectURL(u); } }}>Export incident</button>
            </div></div>))}</div>
      {plan && <div className={`${card} p-3`}><p className="font-bold mb-1">Rollback plan for <code>{plan.actorKey}</code></p>
        {plan.objects.length === 0 ? <p className={muted}>This credential has no recorded changes in that window.</p> : <>{plan.objects.map((o) => { const id = `${o.bucket}/${o.key}`; return <label key={id} className="flex items-center gap-2 py-0.5"><input type="checkbox" disabled={!o.restorableVersionId} checked={picked.has(id)} onChange={(e) => { const n = new Set(picked); e.target.checked ? n.add(id) : n.delete(id); setPicked(n); }} /><span className="flex-1 truncate">{id} <span className={muted}>({o.changedAs}) {o.note}</span></span></label>; })}
          <button className={`${accent} mt-2`} disabled={!picked.size} onClick={() => window.confirm(`Restore ${picked.size} file(s) to their earlier versions? The current versions are kept as older versions.`) && post({ action: "rollbackExecute", items: plan.objects.filter((o) => picked.has(`${o.bucket}/${o.key}`)).map((o) => ({ bucket: o.bucket, key: o.key, versionId: o.restorableVersionId })) }, (r) => `${r.restored} restored${r.failed.length ? `, ${r.failed.length} failed` : ""}.`)}>Restore selected</button></>}</div>}
      <div className={`${card} p-3 space-y-2`}><p className="font-bold">Policy</p>
        {pol && <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-1"><input type="checkbox" checked={pol.enabled} onChange={(e) => setPol({ ...pol, enabled: e.target.checked })} /> Detection on</label>
          <label className="flex items-center gap-1">Pause writes automatically at <select aria-label="Auto containment level" className={`${field} !w-auto`} value={pol.autoContainLevel} onChange={(e) => setPol({ ...pol, autoContainLevel: e.target.value })}><option value="NONE">never (alert only)</option><option value="HIGH">high</option><option value="CRITICAL">critical</option></select></label>
          <label className="flex items-center gap-1">for <input aria-label="Minutes" type="number" className={`${field} !w-20`} value={pol.containMinutes} onChange={(e) => setPol({ ...pol, containMinutes: Number(e.target.value) })} /> minutes</label>
          <button className={accent} onClick={() => post({ action: "policy", ...pol }, "Policy saved.")}>Save</button></div>}
        <div className="flex flex-wrap gap-2 items-center"><input aria-label="Bucket for the tripwire" className={`${field} !w-56`} placeholder="Bucket for a tripwire file" value={bucket} onChange={(e) => setBucket(e.target.value)} /><button className={btn} disabled={!bucket} onClick={() => post({ action: "tripwire", bucket }, (r) => `Tripwire placed at ${r.key}.`)}>Place tripwire</button><span className={muted}>A hidden file nobody should touch. Any change to it raises a critical signal.</span></div></div>
    </div>
  );
}
