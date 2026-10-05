"use client";

// src/components/business/shares/SharesView.js
//
// The share manager (Competitive Expansion SOW B2): what I shared, what was shared with me, and (owner/admin) everything in the
// organization. Revoke, edit, delegate, and read each link's access log. Tokens are never shown here (they are not stored).

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import EmptyState from "../../EmptyState";
import AdvancedShareForm, { sharesApi } from "./AdvancedShareForm";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[11px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2.5 py-1.5 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-[12px] text-[var(--inaya-text-primary)]";
const PILL = { active: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", expired: "bg-slate-400/10 text-slate-300 border-slate-400/30", revoked: "bg-red-400/10 text-red-400 border-red-400/30", exhausted: "bg-amber-400/10 text-amber-300 border-amber-400/30" };
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return "-"; } };

function Modal({ title, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`${card} bg-[var(--inaya-bg,#0b0f14)] w-full max-w-lg p-5 max-h-[85vh] overflow-auto`}>
        <div className="flex justify-between items-center mb-3"><h3 className="text-sm font-bold">{title}</h3><button className={btn} onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>, document.body);
}

function EditShare({ orgId, share, onDone }) {
  const [label, setLabel] = useState(share.label || ""); const [note, setNote] = useState(share.note || ""); const [notify, setNotify] = useState(!!share.notifyOnAccess);
  const [days, setDays] = useState(""); const [password, setPassword] = useState(""); const [clearPw, setClearPw] = useState(false); const [managers, setManagers] = useState((share.managerEmails || []).join(", "));
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr("");
    try {
      const patch = { label, note, notifyOnAccess: notify };
      if (days) patch.expiresAt = new Date(Date.now() + Number(days) * 86400_000).toISOString();
      if (password) patch.password = password; else if (clearPw) patch.password = "";
      patch.managerEmails = managers.split(/[\s,;]+/).filter(Boolean);
      await sharesApi(`/api/orgs/shares/${share.shareId}`, { method: "PATCH", body: JSON.stringify({ orgId, ...patch }) });
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <div className="space-y-2 text-[12px]">
      <label className="block"><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Label</span><input className={field} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} /></label>
      <label className="block"><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Note</span><input className={field} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
      <label className="block"><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Change expiry: days from now (1-365, blank = keep)</span><input type="number" min="1" max="365" className={field} value={days} onChange={(e) => setDays(e.target.value)} /></label>
      <label className="block"><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">{share.passwordProtected ? "Set a new password" : "Add a password"}</span><input type="password" autoComplete="new-password" className={field} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {share.passwordProtected && <label className="flex items-center gap-2"><input type="checkbox" checked={clearPw} onChange={(e) => setClearPw(e.target.checked)} />Remove the password</label>}
      <label className="block"><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">People who can manage this link (emails)</span><input className={field} value={managers} onChange={(e) => setManagers(e.target.value)} placeholder="colleague@yourcompany.com" /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Tell me when it is opened</label>
      {err && <p className="text-red-400" role="alert">{err}</p>}
      <button className={btn} onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
    </div>
  );
}

function AccessLog({ orgId, shareId }) {
  const [rows, setRows] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { sharesApi(`/api/orgs/shares/${shareId}/events?orgId=${orgId}&limit=100`).then((d) => setRows(d.events)).catch((e) => setErr(e.message)); }, [orgId, shareId]);
  if (err) return <p className="text-red-400 text-[12px]">{err}</p>;
  if (!rows) return <p className={`text-[12px] ${muted}`}>Loading…</p>;
  if (!rows.length) return <p className={`text-[12px] ${muted}`}>Nobody has opened this link yet.</p>;
  return <div className="space-y-1">{rows.map((e, i) => <div key={i} className="flex justify-between gap-3 text-[12px] border-b border-[var(--inaya-overlay-10)] py-1"><span><b>{e.type.replace(/_/g, " ").toLowerCase()}</b>{e.reason ? ` (${e.reason})` : ""}{e.email ? ` · ${e.email}` : ""}</span><span className={muted}>{e.ipMasked || ""} · {when(e.at)}</span></div>)}<p className={`text-[11px] ${muted} mt-2`}>Network addresses are shortened so a person cannot be identified from this log.</p></div>;
}

export default function SharesView({ orgId, canManage }) {
  const [scope, setScope] = useState("byMe"); const [status, setStatus] = useState(""); const [items, setItems] = useState(null); const [cursor, setCursor] = useState(null);
  const [err, setErr] = useState(""); const [off, setOff] = useState(false); const [modal, setModal] = useState(null); const [creating, setCreating] = useState(false);
  const [q, setQ] = useState(""); const [hits, setHits] = useState([]); const [picked, setPicked] = useState(null);

  const load = useCallback(async (more = false) => {
    try {
      const params = new URLSearchParams({ orgId, scope, limit: "25" });
      if (status && scope !== "withMe") params.set("status", status);
      if (more && cursor) params.set("before", cursor);
      const d = await sharesApi(`/api/orgs/shares?${params}`);
      setItems((x) => (more && x ? [...x, ...d.items] : d.items)); setCursor(d.nextCursor); setErr("");
    } catch (e) { if (e.status === 404) setOff(true); else setErr(e.message); }
  }, [orgId, scope, status, cursor]);
  useEffect(() => { setItems(null); setCursor(null); load(false); }, [orgId, scope, status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (q.trim().length < 2) { setHits([]); return; } const t = setTimeout(async () => { try { const d = await sharesApi(`/api/orgs/search?orgId=${orgId}&q=${encodeURIComponent(q.trim())}`); setHits((d.results || []).filter((r) => r.entityType === "document").slice(0, 8)); } catch { setHits([]); } }, 300); return () => clearTimeout(t); }, [q, orgId]);

  if (off) return <EmptyState title="Advanced sharing is not enabled" description={canManage ? "Turn on “Advanced sharing” under Settings, Beta features." : "Your organization has not turned on advanced sharing yet."} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        {[["byMe", "Shared by me"], ["withMe", "Shared with me"], ...(canManage ? [["org", "Whole organization"]] : [])].map(([k, label]) => <button key={k} className={`${btn} ${scope === k ? "!bg-[#00f2fe]/15 !border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setScope(k)}>{label}</button>)}
        {scope !== "withMe" && <select aria-label="Status" className={`${field} !w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="active">Active</option><option value="expired">Expired</option><option value="revoked">Revoked</option><option value="exhausted">Used up</option></select>}
        <button className={`${btn} ml-auto`} onClick={() => setCreating((v) => !v)}>{creating ? "Close" : "New secure link"}</button>
      </div>

      {creating && (
        <div className={`${card} p-3`}>
          {!picked ? (<>
            <label className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]" htmlFor="doc-search">Find the document to share</label>
            <input id="doc-search" className={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type part of the file name" />
            {hits.map((h) => <button key={h.id} className="block w-full text-left text-[12px] px-2 py-1.5 hover:bg-[var(--inaya-overlay-10)] rounded" onClick={() => setPicked({ id: h.id, name: h.title })}>{h.title}</button>)}
            {q.trim().length >= 2 && !hits.length && <p className={`text-[11px] ${muted} mt-1`}>No matching document you can share. You need Manage access to share it.</p>}
          </>) : (<>
            <p className="text-[12px] mb-1">Sharing <b>{picked.name}</b> <button className="underline text-[11px]" onClick={() => setPicked(null)}>change</button></p>
            <AdvancedShareForm orgId={orgId} documentId={picked.id} onCreated={() => load(false)} />
          </>)}
        </div>)}

      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      {items === null ? <p className={`text-sm ${muted}`}>Loading…</p> : items.length === 0 ? <EmptyState title={scope === "withMe" ? "Nothing has been shared with you" : "No shares yet"} description={scope === "withMe" ? "When a colleague gives you access to a document it appears here." : "Create a secure link from a document, or use New secure link above."} /> : (
        <div className="space-y-2">
          {items.map((s) => s.kind === "member" ? (
            <div key={s.documentId + s.grantedAt} className={`${card} p-3 flex flex-wrap items-center justify-between gap-2 text-[12px]`}>
              <span><b>{s.filename}</b> <span className={muted}>· {s.level.toLowerCase()} access from {s.grantedByEmail}</span></span>
              <span className={muted}>{s.expiresAt ? `until ${when(s.expiresAt)}` : "no expiry"} · <span className={`px-2 py-0.5 rounded-full border ${PILL[s.status]}`}>{s.status}</span></span>
            </div>
          ) : (
            <div key={s.shareId} className={`${card} p-3 text-[12px]`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0"><b className="break-words">{s.filename || "Document"}</b>{s.label ? <span className={muted}> · {s.label}</span> : null}</span>
                <span className={`px-2 py-0.5 rounded-full border text-[11px] ${PILL[s.status]}`}>{s.status}</span>
              </div>
              <p className={`mt-1 ${muted}`}>{s.permission === "view" ? "View only" : "View and download"} · expires {when(s.expiresAt)} · opened {s.useCount}{s.maxUses != null ? `/${s.maxUses}` : ""}×{s.permission === "download" ? ` · downloaded ${s.downloadCount}${s.maxDownloads != null ? `/${s.maxDownloads}` : ""}×` : ""}{s.lastAccessAt ? ` · last ${when(s.lastAccessAt)}` : ""} · by {s.createdByEmail}</p>
              <p className="mt-1 flex flex-wrap gap-1">{[s.passwordProtected && "Password", s.ipRestricted && "Network limit", s.domainRestricted && `Email domain: ${s.domainRestricted.join(", ")}`, s.deviceBound && "First device only", s.watermark && "Watermark", s.oneTime && "One-time", s.managerEmails?.length ? `${s.managerEmails.length} delegate${s.managerEmails.length > 1 ? "s" : ""}` : null].filter(Boolean).map((t) => <span key={t} className="px-2 py-0.5 rounded-full bg-[var(--inaya-overlay-10)] text-[11px]">{t}</span>)}</p>
              {s.canManage && (
                <div className="mt-2 flex gap-2">
                  <button className={btn} onClick={() => setModal({ type: "log", s })}>Access log</button>
                  {s.status !== "revoked" && <button className={btn} onClick={() => setModal({ type: "edit", s })}>Edit</button>}
                  {s.status === "active" && <button className={`${btn} !text-red-400`} onClick={async () => { if (window.confirm("Revoke this link? Everyone using it loses access immediately.")) { try { await sharesApi(`/api/orgs/shares/${s.shareId}?orgId=${orgId}`, { method: "DELETE" }); load(false); } catch (e) { setErr(e.message); } } }}>Revoke</button>}
                </div>)}
            </div>))}
          {cursor && <button className={btn} onClick={() => load(true)}>Load more</button>}
        </div>)}

      {modal?.type === "edit" && <Modal title="Edit link" onClose={() => setModal(null)}><EditShare orgId={orgId} share={modal.s} onDone={() => { setModal(null); load(false); }} /></Modal>}
      {modal?.type === "log" && <Modal title="Access log" onClose={() => setModal(null)}><AccessLog orgId={orgId} shareId={modal.s.shareId} /></Modal>}
    </div>
  );
}
