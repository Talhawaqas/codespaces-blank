"use client";

// src/components/business/governance/DocGovernancePanel.js
//
// Metadata and classification for one document, shown inside the document card. Only people who can already see the document reach this;
// manager-only fields are hidden from everyone else. Sensitivity changes always carry a reason, and a person's decision is never
// overwritten by automatic rules.

import { useCallback, useEffect, useState } from "react";
import { govApi } from "./GovernanceView";

const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[11px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2.5 py-1.5 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-[12px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return ""; } };

export default function DocGovernancePanel({ orgId, documentId, flags }) {
  const [meta, setMeta] = useState(null); const [cls, setCls] = useState(null); const [draft, setDraft] = useState({}); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const [level, setLevel] = useState(""); const [reason, setReason] = useState(""); const [levels, setLevels] = useState([]);
  const base = `/api/orgs/governance/documents/${documentId}`;
  const load = useCallback(async () => {
    setErr("");
    if (flags.FEATURE_FILE_GOVERNANCE) { try { const m = await govApi(`${base}/metadata?orgId=${orgId}`); setMeta(m); setDraft(Object.fromEntries(Object.entries(m.values))); setLevels(m.fields.find((f) => f.key === "sensitivity")?.options || []); } catch (e) { setErr(e.message); } }
    if (flags.FEATURE_SMART_CLASSIFICATION) { try { setCls(await govApi(`${base}/classification?orgId=${orgId}`)); } catch (e) { setErr(e.message); } }
  }, [base, orgId, flags]);
  useEffect(() => { load(); }, [load]);

  const saveMeta = async () => {
    setErr(""); setMsg("");
    const values = {}; for (const f of meta.fields) { if (f.readOnly || f.key === "sensitivity") continue; const was = meta.values[f.key]; const now = draft[f.key]; if ((now ?? "") !== (was ?? "")) values[f.key] = now === "" || now === undefined ? null : now; }
    if (!Object.keys(values).length) { setMsg("Nothing to save."); return; }
    try { await govApi(`${base}/metadata`, { method: "PUT", body: JSON.stringify({ orgId, values }) }); setMsg("Saved."); load(); } catch (e) { setErr(e.message); }
  };
  const post = async (body, ok) => { setErr(""); setMsg(""); try { const r = await govApi(`${base}/classification`, { method: "POST", body: JSON.stringify({ orgId, ...body }) }); setMsg(typeof ok === "function" ? ok(r) : ok); load(); } catch (e) { setErr(e.message); } };

  if (!flags.FEATURE_FILE_GOVERNANCE && !flags.FEATURE_SMART_CLASSIFICATION) return null;
  return (
    <div className="mt-3 border-t border-[var(--inaya-overlay-10)] pt-3 space-y-3 text-[12px]">
      {cls && (
        <div>
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-1">Classification</p>
          <p>Current: <b>{cls.current || "Not classified"}</b>{cls.source ? <span className={muted}> · set by {cls.source}{cls.confidence != null ? ` (confidence ${Math.round(cls.confidence * 100)}%)` : ""}</span> : null}</p>
          {cls.suggestion && <div className="border border-amber-400/40 bg-amber-400/10 rounded-lg p-2 mt-1 flex flex-wrap items-center gap-2" role="status"><span className="flex-1">Suggested: <b>{cls.suggestion.level}</b> by {cls.suggestion.source} ({Math.round(cls.suggestion.confidence * 100)}%)</span><button className={accent} onClick={() => post({ action: "accept" }, "Suggestion accepted.")}>Accept</button><button className={btn} onClick={() => post({ action: "reject" }, "Suggestion rejected.")}>Reject</button></div>}
          <div className="flex flex-wrap gap-2 mt-2">
            <button className={btn} onClick={() => post({ action: "classify" }, (r) => (r.applied ? `Classified as ${r.proposed}.` : r.suggested ? `Suggested ${r.proposed}; review it above.` : r.blockedBy === "manual" ? "A person set this level, so automatic rules did not change it." : r.proposed ? "Already at that level." : "No rule matched this file's name, location or metadata."))}>Run rules</button>
          </div>
          <div className="flex flex-wrap gap-2 mt-2 items-end">
            <select aria-label="Set classification" className={`${field} !w-auto`} value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Set level…</option>{levels.map((l) => <option key={l} value={l}>{l}</option>)}<option value="__none">Remove classification</option></select>
            <input aria-label="Reason" className={`${field} flex-1 min-w-[160px]`} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className={accent} disabled={!level || reason.trim().length < 5} onClick={() => post({ action: "override", level: level === "__none" ? null : level, reason }, "Classification updated.").then(() => { setReason(""); setLevel(""); })}>Apply</button>
          </div>
          <details className="mt-2"><summary className={`${muted} cursor-pointer text-[11px]`}>History ({cls.history.length})</summary>
            {cls.history.map((h) => <p key={h.historyId} className="py-1 border-t border-[var(--inaya-overlay-10)] first:border-0"><b>{h.to ?? "none"}</b> <span className={muted}>({h.status}, {h.source}) {when(h.at)} by {h.by}{h.reason ? ` · ${h.reason}` : ""}</span>{h.explanation ? <span className={`block ${muted}`}>{h.explanation}</span> : null}</p>)}</details>
        </div>)}
      {meta && (
        <div>
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-1">Metadata</p>
          {meta.sets?.length > 0 && <p className={`${muted} mb-1`}>Applies: {meta.sets.map((s) => s.name).join(", ")}</p>}
          <div className="grid sm:grid-cols-2 gap-2">
            {meta.fields.filter((f) => f.key !== "sensitivity").map((f) => (
              <div key={f.key}><label className={`text-[11px] ${muted}`} htmlFor={`m-${documentId}-${f.key}`}>{f.label}{f.required ? " *" : ""}</label>
                {f.type === "vocabulary" ? <select id={`m-${documentId}-${f.key}`} className={field} disabled={!meta.canEdit || f.readOnly} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}><option value="">-</option>{(f.options || []).map((o) => <option key={o}>{o}</option>)}</select>
                  : f.type === "boolean" ? <select id={`m-${documentId}-${f.key}`} className={field} disabled={!meta.canEdit || f.readOnly} value={draft[f.key] === undefined ? "" : String(draft[f.key])} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value === "" ? undefined : e.target.value === "true" })}><option value="">-</option><option value="true">Yes</option><option value="false">No</option></select>
                  : <input id={`m-${documentId}-${f.key}`} className={field} type={f.type === "date" ? "date" : f.type === "number" ? "number" : f.type === "email" ? "email" : "text"} disabled={!meta.canEdit || f.readOnly} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />}
              </div>))}
          </div>
          {meta.canEdit && <button className={`${accent} mt-2`} onClick={saveMeta}>Save metadata</button>}
        </div>)}
      {err && <p className="text-red-400" role="alert">{err}</p>}{msg && <p className="text-emerald-400" role="status">{msg}</p>}
    </div>
  );
}
