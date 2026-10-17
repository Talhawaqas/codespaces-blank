"use client";

// src/components/business/RecordSharingPanel.js
//
// Visibility + "share with" controls for a task or deal (Batch 2 record-level
// permissions, lib/record-grants.js). `basePath` is the record's API path,
// e.g. /api/orgs/tasks/<id> or /api/orgs/crm/deals/<id>.

import { useState, useEffect, useCallback } from "react";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const inputCls = "bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)]";

export default function RecordSharingPanel({ orgId, basePath, idPrefix = "share" }) {
  const [state, setState] = useState(null);
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState("VIEW");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setState(await api(`${basePath}/sharing?orgId=${orgId}`)); setError(""); } catch (err) { setError(err.message); }
  }, [orgId, basePath]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true); setError("");
    try { await fn(); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const setVisibility = (visibility) => run(() => api(`${basePath}/sharing`, { method: "PATCH", body: JSON.stringify({ orgId, visibility }) }));
  const grant = () => run(async () => {
    await api(`${basePath}/sharing`, { method: "POST", body: JSON.stringify({ orgId, email, level, expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null }) });
    setEmail(""); setExpiresAt("");
  });
  const revoke = (e) => run(() => api(`${basePath}/sharing?orgId=${orgId}&email=${encodeURIComponent(e)}`, { method: "DELETE" }));

  if (!state) return error ? <p className="text-red-400 text-xs">{error}</p> : null;
  const isPrivate = state.visibility === "PRIVATE";

  return (
    <div className="space-y-2 border-t border-white/10 pt-3">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">Who can see this</p>
        {state.canManage ? (
          <select id={`${idPrefix}-visibility`} value={state.visibility} disabled={busy} onChange={(e) => setVisibility(e.target.value)} className={inputCls}>
            <option value="DEPARTMENT">Everyone in the department</option>
            <option value="PRIVATE">Private — only people I choose</option>
          </select>
        ) : (
          <span className="text-xs text-[var(--inaya-text-primary)]">{isPrivate ? "Private" : "Everyone in the department"}</span>
        )}
      </div>
      {isPrivate && (
        <>
          <p className="text-[11px] text-[var(--inaya-text-muted)]">The creator, assignee and org owners/admins always have access.</p>
          {state.grants.length > 0 && (
            <ul className="space-y-1">
              {state.grants.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className={g.expired ? "line-through text-[var(--inaya-text-muted)]" : "text-[var(--inaya-text-primary)]"}>{g.email} · {g.level === "EDIT" ? "can edit" : "can view"}{g.expiresAt ? ` · until ${g.expiresAt.slice(0, 10)}` : ""}</span>
                  {state.canManage && <button disabled={busy} onClick={() => revoke(g.email)} className="text-[10px] font-bold uppercase text-red-400">Remove</button>}
                </li>
              ))}
            </ul>
          )}
          {state.canManage && (
            <div className="flex gap-1.5 flex-wrap">
              <input id={`${idPrefix}-email`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" className={`${inputCls} flex-1 min-w-[10rem]`} />
              <select id={`${idPrefix}-level`} value={level} onChange={(e) => setLevel(e.target.value)} className={inputCls}><option value="VIEW">Can view</option><option value="EDIT">Can edit</option></select>
              <input id={`${idPrefix}-expires`} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="Access ends" className={inputCls} />
              <button disabled={busy || !email.trim()} onClick={grant} className="text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">Share</button>
            </div>
          )}
        </>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}
