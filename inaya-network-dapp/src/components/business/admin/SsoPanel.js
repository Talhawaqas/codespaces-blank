"use client";

// src/components/business/admin/SsoPanel.js -- staff single sign-on settings (Enterprise; src/lib/workforceSso.js).
// OpenID Connect or SAML 2.0. The client secret is write-only: it is sent once and never shown again.

import { useCallback, useEffect, useState } from "react";

async function api(path, options) {
  const res = await fetch(path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status}).`); e.status = res.status; throw e; }
  return data;
}
const input = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)]";
const Code = ({ children }) => <code className="text-[var(--inaya-text-primary)] break-all block">{children}</code>;

export default function SsoPanel({ orgId, canManage }) {
  const [cfg, setCfg] = useState(null); const [form, setForm] = useState(null); const [secret, setSecret] = useState(""); const [cert, setCert] = useState("");
  const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(""); const [locked, setLocked] = useState("");
  const load = useCallback(async () => {
    try {
      const c = await api(`/api/orgs/sso?orgId=${orgId}`); setCfg(c);
      setForm({ protocol: c.protocol, issuer: c.issuer, clientId: c.clientId, samlEntryPoint: c.samlEntryPoint, samlIdpIssuer: c.samlIdpIssuer, domains: c.domains.join(", "), enabled: c.enabled, enforce: c.enforce, requireVerifiedEmail: c.requireVerifiedEmail });
    } catch (e) { if (e.status === 403) setLocked(e.message); else setErr(e.message); }
  }, [orgId]);
  useEffect(() => { if (canManage) load(); }, [load, canManage]);
  if (!canManage) return null;
  const saml = form?.protocol === "saml";

  async function save() {
    setBusy("save"); setErr(""); setMsg("");
    try {
      const body = { orgId, protocol: form.protocol, issuer: form.issuer, clientId: form.clientId, samlEntryPoint: form.samlEntryPoint, samlIdpIssuer: form.samlIdpIssuer, domains: form.domains.split(/[\s,]+/).filter(Boolean), enabled: form.enabled, enforce: form.enforce, requireVerifiedEmail: form.requireVerifiedEmail, ...(secret ? { clientSecret: secret } : {}), ...(cert ? { samlIdpCert: cert } : {}) };
      const c = await api("/api/orgs/sso", { method: "PUT", body: JSON.stringify(body) }); setCfg(c); setSecret(""); setCert(""); setMsg("Saved.");
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }
  async function test() {
    setBusy("test"); setErr(""); setMsg("");
    try {
      const r = await api("/api/orgs/sso", { method: "POST", body: JSON.stringify({ orgId, action: "test" }) });
      setMsg(r.protocol === "saml" ? `Certificate OK (valid until ${new Date(r.certificate.validTo).toLocaleDateString()}). ${r.note}` : `Provider answered (${r.issuer}). ${r.note}`);
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }

  return (
    <div className="bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-bold">Single sign-on (SSO)</h3>
        <p className="text-[12px] text-[var(--inaya-text-muted)]">Staff sign in with your company&apos;s identity provider: Microsoft Entra ID, Google Workspace, Okta, ADFS or any OpenID Connect or SAML 2.0 provider. SSO confirms who someone is; they still need to be invited to this company.</p>
      </div>
      {locked ? <p className="text-amber-400 text-[12px]">{locked}</p> : !form ? <p className="text-[12px] text-[var(--inaya-text-muted)]">{err || "Loading…"}</p> : (<>
        <div className="flex gap-2 text-[12px]" role="radiogroup" aria-label="Protocol">
          {[["oidc", "OpenID Connect"], ["saml", "SAML 2.0"]].map(([v, l]) => (
            <label key={v} className={`cursor-pointer rounded-lg border px-3 py-1 ${form.protocol === v ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)]" : "border-[var(--inaya-overlay-15)]"}`}>
              <input type="radio" name="sso-protocol" value={v} checked={form.protocol === v} onChange={() => setForm({ ...form, protocol: v })} className="sr-only" />{l}
            </label>))}
        </div>
        {!saml ? (<>
          <div className="text-[12px] text-[var(--inaya-text-muted)]">Register both redirect URIs with your provider as a web application:{(cfg.redirectUris || [cfg.redirectUri]).map((u) => <Code key={u}>{u}</Code>)}</div>
          <label className="block text-[12px]">Issuer URL<input className={input} value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0" /></label>
          <label className="block text-[12px]">Client ID<input className={input} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} /></label>
          <label className="block text-[12px]">Client secret {cfg.clientSecretSet && <span className="text-[var(--inaya-text-muted)]">(saved; enter a new one to replace it)</span>}<input className={input} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
        </>) : (<>
          <div className="text-[12px] text-[var(--inaya-text-muted)] space-y-1">
            <div>In your identity provider, create a SAML application with:</div>
            <div>Identifier (Entity ID): <Code>{cfg.saml.spEntityId}</Code></div>
            <div>Reply URLs (Assertion Consumer Service):{cfg.saml.acsUrls.map((u) => <Code key={u}>{u}</Code>)}</div>
            <div>Send the user&apos;s email address as the NameID (or an email claim). Or import the metadata: <Code>{cfg.saml.metadataUrl}</Code></div>
          </div>
          <label className="block text-[12px]">SAML sign-in URL (Login URL)<input className={input} value={form.samlEntryPoint} onChange={(e) => setForm({ ...form, samlEntryPoint: e.target.value })} placeholder="https://login.microsoftonline.com/<tenant-id>/saml2" /></label>
          <label className="block text-[12px]">Identity provider issuer (optional)<input className={input} value={form.samlIdpIssuer} onChange={(e) => setForm({ ...form, samlIdpIssuer: e.target.value })} placeholder="https://sts.windows.net/<tenant-id>/" /></label>
          <label className="block text-[12px]">Signing certificate (Base64) {cfg.samlCert && <span className="text-[var(--inaya-text-muted)]">(saved, valid until {new Date(cfg.samlCert.validTo).toLocaleDateString()}; paste a new one to replace it)</span>}<textarea className={input} rows={3} value={cert} onChange={(e) => setCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE----- …" /></label>
        </>)}
        <label className="block text-[12px]">Staff email domains<input className={input} value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} placeholder="example.com, example.co.uk" /></label>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked, enforce: e.target.checked ? form.enforce : false })} /> SSO is on</label>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.enforce} disabled={!form.enabled} onChange={(e) => setForm({ ...form, enforce: e.target.checked })} /> Require SSO for these domains (turns off email links and Google sign-in for them; passkeys keep working)</label>
        {!saml && <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.requireVerifiedEmail} onChange={(e) => setForm({ ...form, requireVerifiedEmail: e.target.checked })} /> Refuse email addresses the provider says are not verified</label>}
        {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
        {msg && <p className="text-emerald-400 text-[12px]" role="status">{msg}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={save} disabled={!!busy} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-40">{busy === "save" ? "Saving…" : "Save"}</button>
          <button type="button" onClick={test} disabled={!!busy} className="px-3 py-1.5 rounded-lg text-xs font-bold border border-[var(--inaya-border)] disabled:opacity-40">{busy === "test" ? "Testing…" : saml ? "Check the certificate" : "Test the provider"}</button>
        </div>
        <p className="text-[11px] text-[var(--inaya-text-muted)]">Save first, then test. Leave &quot;Require SSO&quot; off until a test sign-in works.</p>
      </>)}
    </div>
  );
}
