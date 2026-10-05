"use client";

// src/components/business/admin/OfficeIntegrationView.js -- Microsoft 365, Office and Outlook (Competitive Expansion SOW J). Shows what the integration does and what it never does,
// the real state of the organization's Microsoft connection, the edit sessions (file leases) in force, the Outlook add-in setup, and the secure links inserted from Outlook.
import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); } catch { return "-"; } };
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Request failed."); return d; };
const PILL = { AVAILABLE: "text-emerald-400", NOT_CONFIGURED: muted, NOT_CONNECTED: "text-amber-300", active: "text-emerald-400", finished: "text-emerald-400", aborted: muted, expired: "text-amber-300", revoked: "text-red-400" };

export default function OfficeIntegrationView({ orgId, canSeeAll }) {
  const [st, setSt] = useState(null); const [sessions, setSessions] = useState([]); const [links, setLinks] = useState([]); const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [url, setUrl] = useState(""); const [out, setOut] = useState(null);
  const load = useCallback(async () => {
    try { setSt(await j(`/api/orgs/office/status?orgId=${orgId}`)); } catch (e) { setErr(e.message); }
    try { setSessions((await j(`/api/orgs/office/sessions?orgId=${orgId}${canSeeAll ? "&scope=org" : ""}`)).sessions); } catch { setSessions([]); }
    try { setLinks((await j(`/api/orgs/office/outlook/links?orgId=${orgId}`)).links); } catch { setLinks([]); }
  }, [orgId, canSeeAll]);
  useEffect(() => { load(); }, [load]);
  if (!st) return <p className={`text-[12px] ${muted}`}>{err || "Loading…"}</p>;
  const act = async (fn, ok) => { setErr(""); setMsg(""); try { await fn(); if (ok) setMsg(ok); load(); } catch (e) { setErr(e.message); } };
  return (
    <div className="space-y-3 text-[12px]">
      <p className={muted}>Work with Microsoft 365 without sending your files to Microsoft. Files stay encrypted in Inaya; Word, Excel and PowerPoint open them on your own device, and Outlook gets an expiring secure link instead of an attachment.</p>
      {err && <p className="text-red-400" role="alert">{err}</p>}{msg && <p className="text-emerald-400" role="status">{msg}</p>}
      <div className={`${card} p-3 space-y-2`}>
        <b>What this integration does</b>
        {st.capabilities.map((c) => <div key={c.id} className="border-t border-[var(--inaya-overlay-10)] pt-2"><div className="flex flex-wrap gap-2 items-center"><b>{c.label}</b><span className={`text-[10px] font-bold uppercase ${PILL[c.status] || ""}`}>{c.status.replace(/_/g, " ")}</span><span className={`text-[10px] uppercase ${muted}`}>{c.mode === "SOVEREIGN" ? "no data leaves Inaya" : "metadata only"}</span></div><p className={muted}>{c.note}</p></div>)}
        <p className="font-bold pt-1">What it never does</p><ul className="list-disc pl-5">{st.neverDoes.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className={muted}>Microsoft connection: {st.connections.length ? st.connections.map((c) => `${c.providerId.replace(/_/g, " ")} (${String(c.state).toLowerCase().replace(/_/g, " ")})`).join(", ") : "none connected"}{st.platformAppRegistered ? "" : " · the platform has no Microsoft app registration configured"}</p>
        <p className={muted}>{st.verified}</p>
      </div>
      <div className={`${card} p-3 space-y-1`}>
        <b>Outlook add-in</b>
        <p className={muted}>Install the add-in for your team from the Microsoft 365 admin center (Settings, Integrated apps, Upload custom apps) with this file, or sideload it for a trial. If Inaya runs on your own address, replace the address inside the file first.</p>
        <a className="underline" href="/outlook/manifest.xml" download>Download the add-in manifest</a>
        <p className={muted}>Then, when writing an e-mail, choose Secure link, find the file, and insert. The link expires, follows your sharing policy, and any password is kept out of the message. Attachments are not converted automatically: upload the file to Inaya first.</p>
      </div>
      <div className={`${card} p-3`}>
        <b>Edit sessions</b><p className={muted}>A file opened for editing is locked to one person for a short lease. The desktop app decrypts it locally, opens it in Office, and saves a new version when you finish.</p>
        {sessions.length === 0 ? <EmptyState compact icon="📝" description="No edit sessions yet." /> : sessions.map((s) => <div key={s.sessionId} className="flex flex-wrap gap-2 border-t border-[var(--inaya-overlay-10)] py-1"><b className="break-all">{s.filename}</b><span className={`text-[10px] font-bold uppercase ${PILL[s.status] || ""}`}>{s.status}</span><span className={muted}>{s.app} · {canSeeAll ? `${s.email} · ` : ""}started {when(s.startedAt)}{s.status === "active" ? ` · lease until ${when(s.expiresAt)}` : ""}{s.newDocumentId ? " · new version saved" : ""}</span></div>)}
      </div>
      <div className={`${card} p-3`}>
        <b>Links you inserted from Outlook</b>
        {links.length === 0 ? <EmptyState compact icon="🔗" description="None yet." /> : links.map((l) => <div key={l.shareId} className="flex flex-wrap items-center gap-2 border-t border-[var(--inaya-overlay-10)] py-1"><b className="break-all">{l.filename || "File"}</b><span className={`text-[10px] font-bold uppercase ${PILL[l.status] || ""}`}>{l.status}</span><span className={muted}>expires {when(l.expiresAt)} · opened {l.opened} time(s){l.passwordProtected ? " · password" : ""}</span>{l.status === "active" && <button className={btn} onClick={() => window.confirm("Revoke this link? The recipient can no longer open it.") && act(() => j(`/api/orgs/office/outlook/links/${l.shareId}?orgId=${orgId}`, { method: "DELETE" }), "Revoked.")}>Revoke</button>}</div>)}
        <div className="flex gap-2 mt-2"><input aria-label="Secure link to check" className={field} placeholder="Paste an Inaya secure link to check it" value={url} onChange={(e) => setUrl(e.target.value)} /><button className={btn} disabled={!url} onClick={() => act(async () => { setOut(await j("/api/orgs/office/outlook/inspect", { method: "POST", body: JSON.stringify({ orgId, url }) })); })}>Check</button></div>
        {out && <p className={muted}>{!out.recognized ? "That link was not found." : `Status ${out.status}${out.expiresAt ? `, expires ${when(out.expiresAt)}` : ""}${out.passwordProtected ? ", password protected" : ""}${out.restrictedToDomains ? ", limited to certain domains" : ""}${out.oneTime ? ", one-time" : ""}.`}</p>}
      </div>
    </div>
  );
}
