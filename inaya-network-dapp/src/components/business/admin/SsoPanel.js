"use client";

// src/components/business/admin/SsoPanel.js -- staff single sign-on settings (Enterprise; src/lib/workforceSso.js).
// The client secret is write-only: it is sent once and never shown again.

import { useCallback, useEffect, useState } from "react";

async function api(path, options) {
  const res = await fetch(path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status}).`); e.status = res.status; throw e; }
  return data;
}
const input = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)]";

export default function SsoPanel({ orgId, canManage }) {
  const [cfg, setCfg] = useState(null); const [form, setForm] = useState(null); const [secret, setSecret] = useState("");
  const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(""); const [locked, setLocked] = useState("");
  const load = useCallback(async () => {
    try { const c = await api(`/api/orgs/sso?orgId=${orgId}`); setCfg(c); setForm({ issuer: c.issuer, clientId: c.clientId, domains: c.domains.join(", "), enabled: c.enabled, enforce: c.enforce, requireVerifiedEmail: c.requireVerifiedEmail }); }
    catch (e) { if (e.status === 403) setLocked(e.message); else setErr(e.message); }
  }, [orgId]);
  useEffect(() => { if (canManage) load(); }, [load, canManage]);
  if (!canManage) return null;

  async function save() {
    setBusy("save"); setErr(""); setMsg("");
    try {
      const body = { orgId, issuer: form.issuer, clientId: form.clientId, domains: form.domains.split(/[\s,]+/).filter(Boolean), enabled: form.enabled, enforce: form.enforce, requireVerifiedEmail: form.requireVerifiedEmail, ...(secret ? { clientSecret: secret } : {}) };
      const c = await api("/api/orgs/sso", { method: "PUT", body: JSON.stringify(body) }); setCfg(c); setSecret(""); setMsg("Saved.");
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }
  async function test() {
    setBusy("test"); setErr(""); setMsg("");
    try { const r = await api("/api/orgs/sso", { method: "POST", body: JSON.stringify({ orgId, action: "test" }) }); setMsg(`Provider answered (${r.issuer}). ${r.note}`); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }

  return (
    <div className="bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-bold">Single sign-on (SSO)</h3>
        <p className="text-[12px] text-[var(--inaya-text-muted)]">Staff sign in with your company&apos;s identity provider: Microsoft Entra ID, Google Workspace, Okta or any OpenID Connect provider. SSO confirms who someone is; they still need to be invited to this company.</p>
      </div>
      {locked ? <p className="text-amber-400 text-[12px]">{locked}</p> : !form ? <p className="text-[12px] text-[var(--inaya-text-muted)]">{err || "Loading…"}</p> : (<>
        <p className="text-[12px] text-[var(--inaya-text-muted)]">Register this redirect URI with your provider as a web application: <code className="text-[var(--inaya-text-primary)] break-all">{cfg.redirectUri}</code></p>
        <label className="block text-[12px]">Issuer URL<input className={input} value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0" /></label>
        <label className="block text-[12px]">Client ID<input className={input} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} /></label>
        <label className="block text-[12px]">Client secret {cfg.clientSecretSet && <span className="text-[var(--inaya-text-muted)]">(saved; enter a new one to replace it)</span>}<input className={input} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
        <label className="block text-[12px]">Staff email domains<input className={input} value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} placeholder="example.com, example.co.uk" /></label>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked, enforce: e.target.checked ? form.enforce : false })} /> SSO is on</label>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.enforce} disabled={!form.enabled} onChange={(e) => setForm({ ...form, enforce: e.target.checked })} /> Require SSO for these domains (turns off email links and Google sign-in for them; passkeys keep working)</label>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.requireVerifiedEmail} onChange={(e) => setForm({ ...form, requireVerifiedEmail: e.target.checked })} /> Refuse email addresses the provider says are not verified</label>
        {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
        {msg && <p className="text-emerald-400 text-[12px]" role="status">{msg}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={save} disabled={!!busy} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-40">{busy === "save" ? "Saving…" : "Save"}</button>
          <button type="button" onClick={test} disabled={!!busy || !cfg.issuer} className="px-3 py-1.5 rounded-lg text-xs font-bold border border-[var(--inaya-border)] disabled:opacity-40">{busy === "test" ? "Testing…" : "Test the provider"}</button>
        </div>
      </>)}
    </div>
  );
}
