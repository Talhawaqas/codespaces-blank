"use client";

// src/components/business/admin/ReplicationPanel.js -- site replication and failover readiness (Competitive Expansion SOW O). Shows what is MEASURED: how many files have a
// replica at each secondary, how old the oldest un-replicated file is (the real RPO exposure), the last recovery test, and what blocks a failover. It never switches traffic.
import { useCallback, useEffect, useState } from "react";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); } catch { return "-"; } };
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Request failed."); return d; };
const TONE = { SYNCED: "text-emerald-400", PASS: "text-emerald-400", NO_DATA: muted, LAGGING: "text-amber-300", STALE: "text-amber-300", BEHIND_TARGET: "text-red-400", CONFLICT: "text-red-400", ERROR: "text-red-400", FAIL: "text-red-400" };

export default function ReplicationPanel({ orgId, canManage }) {
  const [prof, setProf] = useState(null); const [state, setState] = useState(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ primary: "pinata", secondary: "filebase", rto: 240, rpo: 1440 });
  const load = useCallback(async () => { try { const p = await j(`/api/orgs/replication/profile?orgId=${orgId}`); setProf(p); if (p.profile) { setF({ primary: p.profile.primary, secondary: p.profile.secondaries[0], rto: p.profile.targets.rtoMinutes, rpo: p.profile.targets.rpoMinutes }); setState(await j(`/api/orgs/replication/state?orgId=${orgId}`)); } else setState(null); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, ok) => { setErr(""); setMsg(""); setBusy(true); try { await fn(); if (ok) setMsg(ok); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  if (!prof) return <div className={`${card} p-4`}><h3 className="text-sm font-bold">Site replication</h3><p className={`text-[12px] ${muted}`}>{err || "Loading…"}</p></div>;
  const download = async () => { try { const pkg = await j(`/api/orgs/replication/evidence?orgId=${orgId}`); const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `replication-evidence-${pkg.generatedAt.slice(0, 10)}.json`; a.click(); setMsg(`Evidence exported. Hash ${pkg.sha256.slice(0, 16)}…`); } catch (e) { setErr(e.message); } };
  return (
    <div className={`${card} p-4 space-y-3 text-[12px]`}>
      <div><h3 className="text-sm font-bold">Site replication</h3><p className={muted}>Active-passive: one primary storage provider and read-only replicas at others. Everything below is measured from the replica records and from recovery tests. Active-active operation is not provided, and failover is a manual procedure: this view reports readiness and never switches anything.</p></div>
      {err && <p className="text-red-400" role="alert">{err}</p>}{msg && <p className="text-emerald-400" role="status">{msg}</p>}
      {canManage && <div className="flex flex-wrap gap-2 items-end">
        <label>Primary<br /><select className={field} value={f.primary} onChange={(e) => setF({ ...f, primary: e.target.value })}>{prof.knownProviders.map((p) => <option key={p} value={p}>{p}{prof.availableProviders.includes(p) ? "" : " (not configured here)"}</option>)}</select></label>
        <label>Secondary<br /><select className={field} value={f.secondary} onChange={(e) => setF({ ...f, secondary: e.target.value })}>{prof.knownProviders.filter((p) => p !== f.primary).map((p) => <option key={p} value={p}>{p}{prof.availableProviders.includes(p) ? "" : " (not configured here)"}</option>)}</select></label>
        <label>RPO target (minutes)<br /><input aria-label="RPO target" type="number" min="1" className={`${field} w-28`} value={f.rpo} onChange={(e) => setF({ ...f, rpo: e.target.value })} /></label>
        <label>RTO target (minutes)<br /><input aria-label="RTO target" type="number" min="1" className={`${field} w-28`} value={f.rto} onChange={(e) => setF({ ...f, rto: e.target.value })} /></label>
        <button className={accent} disabled={busy || f.primary === f.secondary} onClick={() => run(() => j("/api/orgs/replication/profile", { method: "PUT", body: JSON.stringify({ orgId, primary: f.primary, secondaries: [f.secondary], targets: { rtoMinutes: Number(f.rto), rpoMinutes: Number(f.rpo) } }) }), "Replication profile saved.")}>Save profile</button></div>}
      {state?.configured ? <>
        {state.sites.map((s) => <div key={s.siteId} className="border-t border-[var(--inaya-overlay-10)] pt-2"><div className="flex flex-wrap gap-2 items-center"><b>{s.siteId}</b><span className={`text-[10px] font-bold uppercase ${TONE[s.state] || muted}`}>{s.state.replace(/_/g, " ")}</span></div>
          <p className={muted}>{s.covered} of {s.total} files have a healthy replica · {s.missing} missing{s.lagMinutes ? ` · oldest missing file is ${s.lagMinutes} minutes old` : ""} · {s.staleChecks} not checked in 24 hours · {s.conflicts} conflicts · {s.corrupted} corrupted</p>{s.note && <p className={muted}>{s.note}</p>}</div>)}
        <p>Measured RPO exposure: <b>{state.measured.rpoMinutes ?? "n/a"} min</b> against a target of {state.targets.rpoMinutes}. <span className={muted}>{state.measured.basis}</span></p>
        <p>Last verified restore: <b>{state.lastVerifiedRestoreAt ? when(state.lastVerifiedRestoreAt) : "never"}</b></p>
        <div className={`${card} p-2`}><p className="font-bold">Failover readiness: <span className={state.failoverReadiness.ready ? "text-emerald-400" : "text-amber-300"}>{state.failoverReadiness.ready ? "no blockers found" : "blocked"}</span></p>{state.failoverReadiness.blockers.map((b, i) => <p key={i} className="text-amber-300">{b.detail}</p>)}<p className={muted}>{state.failoverReadiness.note}</p></div>
        <div className="flex flex-wrap gap-2">{canManage && <button className={accent} disabled={busy} onClick={() => run(() => j("/api/orgs/replication/tests", { method: "POST", body: JSON.stringify({ orgId, secondary: state.sites[0].siteId, sample: 5 }) }), "Recovery test finished.")}>Run recovery test</button>}<button className={btn} onClick={download}>Export evidence</button></div>
        {state.recentTests.length > 0 && <div><p className="font-bold">Recent recovery tests</p>{state.recentTests.map((t) => <p key={t.testId} className={muted}><span className={TONE[t.result] || ""}>{t.result}</span> · {t.secondary} · {when(t.finishedAt)} · {t.verified}/{t.sampled} files verified · {t.measuredSeconds}s for this sample (not a full-site recovery time)</p>)}</div>}
      </> : <p className={muted}>{prof.profile ? "Loading…" : "No replication profile yet. Choose a primary and a secondary above."}</p>}
    </div>
  );
}
