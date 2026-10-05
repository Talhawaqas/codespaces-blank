"use client";

// src/components/business/shares/FileRequestsView.js
//
// File requests, requester side: create a request (the key pair is made in this browser; the private key is locked with a passphrase only the
// requester knows), watch uploads arrive, unlock with the passphrase to read them (decrypted here), save or delete them, close the request.

import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";
import { sharesApi } from "./AdvancedShareForm";
import { generateRequestKeys, unwrapPrivateKey, decryptFromRequest } from "../../../lib/filerequests/clientCrypto";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[11px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2.5 py-1.5 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-[12px] text-[var(--inaya-text-primary)]";
const PILL = { open: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", expired: "bg-slate-400/10 text-slate-300 border-slate-400/30", revoked: "bg-red-400/10 text-red-400 border-red-400/30", full: "bg-amber-400/10 text-amber-300 border-amber-400/30" };
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return "-"; } };
const sizeOf = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const b64u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function NewRequest({ orgId, onCreated }) {
  const [f, setF] = useState({ title: "", instructions: "", expirationPreset: "7d", maxFiles: 10, maxMb: 25, ext: "", needCompany: false, passphrase: "", again: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [made, setMade] = useState(null); const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e) {
    e.preventDefault(); setErr(""); if (f.passphrase !== f.again) { setErr("The two passphrases do not match."); return; }
    setBusy(true);
    try {
      const keys = await generateRequestKeys(f.passphrase);
      const r = await sharesApi("/api/orgs/file-requests", { method: "POST", body: JSON.stringify({ orgId, title: f.title, instructions: f.instructions || undefined, expirationPreset: f.expirationPreset, maxFiles: Number(f.maxFiles), maxFileBytes: Math.round(Number(f.maxMb) * 1048576),
        allowedExtensions: f.ext.split(/[\s,;]+/).filter(Boolean), requireIdentity: { name: true, email: true, company: f.needCompany }, publicKeyJwk: keys.publicKeyJwk, wrappedPrivateKey: keys.wrappedPrivateKey }) });
      setMade(r); setF((x) => ({ ...x, passphrase: "", again: "" })); onCreated?.();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className={`${card} p-3 space-y-2 text-[12px]`}>
      <label className="block"><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">What are you asking for</span><input className={field} value={f.title} maxLength={120} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Signed onboarding forms" required /></label>
      <label className="block"><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Instructions (optional)</span><textarea className={field} rows={2} maxLength={1000} value={f.instructions} onChange={(e) => set("instructions", e.target.value)} /></label>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <label><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Expires</span><select className={field} value={f.expirationPreset} onChange={(e) => set("expirationPreset", e.target.value)}><option value="24h">1 day</option><option value="7d">7 days</option><option value="30d">30 days</option></select></label>
        <label><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Max files</span><input type="number" min="1" max="100" className={field} value={f.maxFiles} onChange={(e) => set("maxFiles", e.target.value)} /></label>
        <label><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Max MB each</span><input type="number" min="1" max="25" className={field} value={f.maxMb} onChange={(e) => set("maxMb", e.target.value)} /></label>
        <label><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Only these types</span><input className={field} value={f.ext} onChange={(e) => set("ext", e.target.value)} placeholder="pdf, docx" /></label>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={f.needCompany} onChange={(e) => set("needCompany", e.target.checked)} />Also ask for their company</label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Passphrase to open the files</span><input type="password" autoComplete="new-password" className={field} value={f.passphrase} onChange={(e) => set("passphrase", e.target.value)} placeholder="At least 10 characters" required /></label>
        <label><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Repeat it</span><input type="password" autoComplete="new-password" className={field} value={f.again} onChange={(e) => set("again", e.target.value)} required /></label>
      </div>
      <p className={`text-[11px] ${muted}`}>Files are encrypted on the sender&apos;s device so only you can open them, using this passphrase. <b>Inaya cannot recover it. If you forget it, the files cannot be opened.</b> Because files are encrypted before they arrive, they are not virus-scanned on upload; open them on a device you trust.</p>
      {err && <p className="text-red-400" role="alert">{err}</p>}
      <button className={accent} disabled={busy}>{busy ? "Creating…" : "Create request"}</button>
      {made && <div className="bg-black/30 border border-[#00f2fe]/30 rounded-lg p-2"><p className={`text-[11px] ${muted}`}>Send this link to the people who should upload. It is shown once:</p><p className="text-[#00f2fe] break-all font-mono">{made.uploadUrl}</p><button type="button" className={`${accent} mt-2`} onClick={() => navigator.clipboard?.writeText(made.uploadUrl)}>Copy link</button></div>}
    </form>
  );
}

function RequestDetail({ orgId, requestId, onChanged }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(""); const [pass, setPass] = useState(""); const [key, setKey] = useState(null); const [opened, setOpened] = useState({}); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setD(await sharesApi(`/api/orgs/file-requests/${requestId}?orgId=${orgId}`)); } catch (e) { setErr(e.message); } }, [orgId, requestId]);
  useEffect(() => { load(); }, [load]);

  async function unlock(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const k = await unwrapPrivateKey(d.wrappedPrivateKey, pass); setKey(k); setPass("");
      const out = {};
      for (const u of d.uploads) {
        try {
          const parts = [];
          for (let i = 0; i < u.partCount; i++) parts.push(b64u8((await sharesApi(`/api/orgs/file-requests/${requestId}/uploads/${u.uploadId}?orgId=${orgId}&index=${i}`)).data));
          const total = parts.reduce((n, p) => n + p.length, 0); const all = new Uint8Array(total); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
          out[u.uploadId] = await decryptFromRequest(k, u.keyEnvelope, all, requestId);
        } catch { out[u.uploadId] = { error: "This file could not be opened (it may have been altered)." }; }
      }
      setOpened(out);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  const save = (o) => { const url = URL.createObjectURL(new Blob([o.bytes], { type: o.meta.type })); const a = document.createElement("a"); a.href = url; a.download = o.meta.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); };

  if (!d) return <p className={`text-[12px] ${muted}`}>{err || "Loading…"}</p>;
  return (
    <div className="space-y-2 text-[12px]">
      <p className={muted}>{d.received} of {d.maxFiles} received · expires {when(d.expiresAt)} · <span className={`px-2 py-0.5 rounded-full border ${PILL[d.status]}`}>{d.status}</span></p>
      {d.uploads.length > 0 && !key && (
        <form onSubmit={unlock} className="flex gap-2 items-end"><label className="flex-1"><span className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)]">Passphrase</span><input type="password" autoComplete="off" className={field} value={pass} onChange={(e) => setPass(e.target.value)} /></label><button className={accent} disabled={busy || !pass}>{busy ? "Opening…" : "Unlock files"}</button></form>)}
      {err && <p className="text-red-400" role="alert">{err}</p>}
      {d.uploads.map((u) => { const o = opened[u.uploadId]; return (
        <div key={u.uploadId} className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--inaya-overlay-10)] pt-2">
          <span className="min-w-0"><b className="break-words">{o?.meta ? o.meta.name : "Encrypted file"}</b> <span className={muted}>{sizeOf(u.size)} · from {u.uploaderName || "?"} {u.uploaderEmail ? `<${u.uploaderEmail}>` : ""}{u.uploaderCompany ? `, ${u.uploaderCompany}` : ""} · {when(u.receivedAt)}</span>{u.note && <span className="block">&ldquo;{u.note}&rdquo;</span>}{o?.error && <span className="block text-red-400">{o.error}</span>}</span>
          <span className="flex gap-2">{o?.bytes && <button className={btn} onClick={() => save(o)}>Save</button>}<button className={`${btn} !text-red-400`} onClick={async () => { if (window.confirm("Delete this file permanently?")) { try { await sharesApi(`/api/orgs/file-requests/${requestId}/uploads/${u.uploadId}?orgId=${orgId}`, { method: "DELETE" }); load(); onChanged?.(); } catch (e) { setErr(e.message); } } }}>Delete</button></span>
        </div>); })}
      {d.uploads.length === 0 && <p className={muted}>Nothing received yet.</p>}
      {d.status === "open" && <button className={`${btn} !text-red-400`} onClick={async () => { if (window.confirm("Close this request now? People with the link can no longer upload.")) { try { await sharesApi(`/api/orgs/file-requests/${requestId}?orgId=${orgId}`, { method: "DELETE" }); load(); onChanged?.(); } catch (e) { setErr(e.message); } } }}>Close request</button>}
    </div>
  );
}

export default function FileRequestsView({ orgId, canManage }) {
  const [scope, setScope] = useState("mine"); const [items, setItems] = useState(null); const [err, setErr] = useState(""); const [off, setOff] = useState(false); const [creating, setCreating] = useState(false); const [open, setOpen] = useState(null);
  const load = useCallback(async () => { try { const d = await sharesApi(`/api/orgs/file-requests?orgId=${orgId}&scope=${scope}&limit=50`); setItems(d.items); setErr(""); } catch (e) { if (e.status === 404) setOff(true); else setErr(e.message); } }, [orgId, scope]);
  useEffect(() => { setItems(null); load(); }, [load]);
  if (off) return <EmptyState title="File requests are not enabled" description={canManage ? "Turn on “Advanced sharing” under Settings, Beta features." : "Your organization has not turned on file requests yet."} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        {[["mine", "My requests"], ...(canManage ? [["org", "Whole organization"]] : [])].map(([k, l]) => <button key={k} className={`${btn} ${scope === k ? "!bg-[#00f2fe]/15 !border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setScope(k)}>{l}</button>)}
        <button className={`${btn} ml-auto`} onClick={() => setCreating((v) => !v)}>{creating ? "Close" : "New file request"}</button>
      </div>
      {creating && <NewRequest orgId={orgId} onCreated={load} />}
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      {items === null ? <p className={`text-sm ${muted}`}>Loading…</p> : items.length === 0 ? <EmptyState title="No file requests yet" description="Ask a customer or partner to send you files securely, without an account." /> : items.map((r) => (
        <div key={r.requestId} className={`${card} p-3`}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]"><b>{r.title}</b><span className={`px-2 py-0.5 rounded-full border text-[11px] ${PILL[r.status]}`}>{r.status}</span></div>
          <p className={`text-[12px] ${muted}`}>{r.received}/{r.maxFiles} files · expires {when(r.expiresAt)} · by {r.createdByEmail}</p>
          <button className={`${btn} mt-2`} onClick={() => setOpen(open === r.requestId ? null : r.requestId)}>{open === r.requestId ? "Hide" : "Open"}</button>
          {open === r.requestId && <div className="mt-2"><RequestDetail orgId={orgId} requestId={r.requestId} onChanged={load} /></div>}
        </div>))}
    </div>
  );
}
