"use client";

// src/components/business/shares/AdvancedShareForm.js
//
// Secure Sharing 2.0 link creation (Competitive Expansion SOW workstream B). Used by the document share panel and the Shares view.
// Plain wording about what each protection does and does not do; the new link is shown once.

import { useState } from "react";

export const sharesApi = async (path, opts = {}) => {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
};

const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-[12px] text-[var(--inaya-text-primary)]";
const lbl = "text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-1 block";
const accent = "text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const list = (s) => String(s || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export default function AdvancedShareForm({ orgId, documentId, onCreated }) {
  const [f, setF] = useState({ permission: "download", expirationPreset: "24h", oneTime: false, maxUses: "", maxDownloads: "", password: "", ipAllow: "", domainAllow: "", deviceBinding: false, notifyOnAccess: true, watermark: false, label: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [made, setMade] = useState(null); const [copied, setCopied] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(""); setMade(null); setCopied(false);
    try {
      const body = { orgId, documentId, expirationPreset: f.expirationPreset, permission: f.permission, oneTime: f.oneTime, notifyOnAccess: f.notifyOnAccess, watermark: f.watermark, deviceBinding: f.deviceBinding ? "first-use" : undefined, label: f.label || undefined, password: f.password || undefined, ipAllow: list(f.ipAllow), domainAllow: list(f.domainAllow) };
      if (f.maxUses) body.maxUses = Number(f.maxUses);
      if (f.maxDownloads && f.permission === "download") body.maxDownloads = Number(f.maxDownloads);
      const r = await sharesApi("/api/orgs/shares", { method: "POST", body: JSON.stringify(body) });
      setMade(r); onCreated?.(r); setF((x) => ({ ...x, password: "" }));
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mt-2 border border-[var(--inaya-overlay-10)] rounded-lg p-3 bg-black/20">
      <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-2">New secure link</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div><label className={lbl} htmlFor="sh-perm">What can they do</label>
          <select id="sh-perm" className={field} value={f.permission} onChange={(e) => set("permission", e.target.value)}><option value="download">View and download</option><option value="view">View only</option></select></div>
        <div><label className={lbl} htmlFor="sh-exp">Expires</label>
          <select id="sh-exp" className={field} value={f.expirationPreset} onChange={(e) => set("expirationPreset", e.target.value)}><option value="1h">In 1 hour</option><option value="24h">In 24 hours</option><option value="7d">In 7 days</option><option value="30d">In 30 days</option></select></div>
        <div><label className={lbl} htmlFor="sh-pw">Password (optional)</label>
          <input id="sh-pw" type="password" autoComplete="new-password" className={field} value={f.password} onChange={(e) => set("password", e.target.value)} placeholder="At least 8 characters" /></div>
        <div><label className={lbl} htmlFor="sh-label">Label (only you see it)</label>
          <input id="sh-label" className={field} maxLength={80} value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="e.g. Q3 contract for Acme" /></div>
        <div><label className={lbl} htmlFor="sh-uses">Maximum openings</label>
          <input id="sh-uses" type="number" min="1" className={field} value={f.maxUses} onChange={(e) => set("maxUses", e.target.value)} placeholder="No limit" disabled={f.oneTime} /></div>
        <div><label className={lbl} htmlFor="sh-dl">Maximum downloads</label>
          <input id="sh-dl" type="number" min="1" className={field} value={f.maxDownloads} onChange={(e) => set("maxDownloads", e.target.value)} placeholder="No limit" disabled={f.oneTime || f.permission !== "download"} /></div>
        <div><label className={lbl} htmlFor="sh-ip">Only from these networks (optional)</label>
          <input id="sh-ip" className={field} value={f.ipAllow} onChange={(e) => set("ipAllow", e.target.value)} placeholder="203.0.113.0/24, 198.51.100.7" /></div>
        <div><label className={lbl} htmlFor="sh-dom">Only these email domains (optional)</label>
          <input id="sh-dom" className={field} value={f.domainAllow} onChange={(e) => set("domainAllow", e.target.value)} placeholder="acme.com" /></div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[12px]">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.oneTime} onChange={(e) => set("oneTime", e.target.checked)} />One-time link</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.deviceBinding} onChange={(e) => set("deviceBinding", e.target.checked)} />Lock to the first device that opens it</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.notifyOnAccess} onChange={(e) => set("notifyOnAccess", e.target.checked)} />Tell me when it is opened</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.watermark} onChange={(e) => set("watermark", e.target.checked)} />Stamp the viewer with who and when</label>
      </div>
      <p className="text-[11px] text-[var(--inaya-text-muted)] mt-2">The link only lets someone fetch the encrypted file. They still need the document passkey from you, sent separately. &quot;View only&quot; hides the download button; it cannot stop someone who has the passkey from keeping what they see. You can revoke a link at any time, which stops all further access.</p>
      {err && <p className="text-red-400 text-[12px] mt-2" role="alert">{err}</p>}
      <div className="mt-2"><button className={accent} disabled={busy}>{busy ? "Creating…" : "Create link"}</button></div>
      {made && (
        <div className="mt-2 bg-black/30 border border-[#00f2fe]/30 rounded-lg p-2">
          <p className="text-[11px] text-[var(--inaya-text-muted)] mb-1">Copy this now. It cannot be shown again:</p>
          <p className="text-[12px] text-[#00f2fe] break-all font-mono">{made.shareUrl}</p>
          <button type="button" className={`${accent} mt-2`} onClick={async () => { try { await navigator.clipboard.writeText(made.shareUrl); setCopied(true); } catch { /* shown for manual copy */ } }}>{copied ? "Copied" : "Copy link"}</button>
        </div>)}
    </form>
  );
}
