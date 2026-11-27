"use client";

// app/business/powerbi-authorize/page.js -- the sign-in window Power BI opens when someone connects the Inaya connector
// (OAuth 2.0 authorise step; src/lib/analytics/oauth.js). The person signs in (passkey, company SSO or an emailed code),
// sees exactly what Power BI will be able to read, picks the company and approves. Power BI then receives a one-time code.

import { useCallback, useEffect, useState } from "react";

async function api(path, options) {
  const res = await fetch(path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error_description || data.error || `Request failed (${res.status}).`); e.status = res.status; throw e; }
  return data;
}
const input = "w-full bg-black/30 border border-[var(--inaya-overlay-15)] rounded-xl px-3 py-2.5 text-sm text-[var(--inaya-text-primary)]";
const btn = "w-full py-2.5 rounded-xl text-sm font-bold disabled:opacity-40";

export default function PowerBiAuthorize() {
  const [params, setParams] = useState(null); const [me, setMe] = useState(undefined); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");
  const [email, setEmail] = useState(""); const [codeSent, setCodeSent] = useState(false); const [code, setCode] = useState(""); const [mfa, setMfa] = useState(null); const [mfaCode, setMfaCode] = useState("");
  const load = useCallback(async () => { try { setMe(await api("/api/analytics/oauth/companies")); } catch (e) { if (e.status === 401) setMe(null); else setErr(e.message); } }, []);
  useEffect(() => {
    const q = Object.fromEntries(new URLSearchParams(window.location.search).entries()); setParams(q);
    if (q.ssoError) setErr(q.ssoError.slice(0, 200));
    load();
  }, [load]);
  const valid = params && params.response_type === "code" && params.client_id === "inaya-powerbi" && params.code_challenge && params.state;

  async function passkey() {
    setBusy("passkey"); setErr("");
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options, requestToken } = await api("/api/orgs/login/passkey", { method: "POST", body: JSON.stringify({ step: "start" }) });
      const response = await startAuthentication({ optionsJSON: options });
      await api("/api/orgs/login/passkey", { method: "POST", body: JSON.stringify({ step: "finish", requestToken, response }) });
      await load();
    } catch (e) { setErr(e?.name === "NotAllowedError" ? "The passkey request was cancelled." : e.message); } finally { setBusy(""); }
  }
  async function sso() {
    setBusy("sso"); setErr("");
    try { const returnTo = `/business/powerbi-authorize${window.location.search}`; const { url } = await api("/api/orgs/login/sso/start", { method: "POST", body: JSON.stringify({ email, returnTo }) }); window.location.assign(url); }
    catch (e) { setErr(e.message); setBusy(""); }
  }
  async function sendCode() { setBusy("send"); setErr(""); try { await api("/api/analytics/oauth/email-code", { method: "POST", body: JSON.stringify({ email }) }); setCodeSent(true); } catch (e) { setErr(e.message); } finally { setBusy(""); } }
  async function verifyCode() {
    setBusy("verify"); setErr("");
    try { const r = await api("/api/analytics/oauth/email-code", { method: "POST", body: JSON.stringify({ email, code }) }); if (r.mfaRequired) setMfa(r.mfaPendingToken); else await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  }
  async function verifyMfa() { setBusy("mfa"); setErr(""); try { await api("/api/orgs/mfa/verify", { method: "POST", body: JSON.stringify({ mfaPendingToken: mfa, code: mfaCode }) }); setMfa(null); await load(); } catch (e) { setErr(e.message); } finally { setBusy(""); } }
  async function approve(orgId) {
    setBusy(orgId); setErr("");
    try { const { redirect } = await api("/api/analytics/oauth/approve", { method: "POST", body: JSON.stringify({ orgId, params }) }); window.location.assign(redirect); }
    catch (e) { setErr(e.message); setBusy(""); }
  }

  if (!params) return null;
  return (
    <main className="min-h-screen flex items-center px-4 py-8 bg-[var(--inaya-bg,#0b1220)]">
      <div className="w-full max-w-md mx-auto bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-6 shadow-sm space-y-4">
        <div>
          <p className="text-lg font-extrabold text-[var(--inaya-text-primary)]">Connect Power BI to Inaya</p>
          <p className="text-xs text-[var(--inaya-text-muted)] mt-1">Microsoft Power BI is asking to <b>read</b> your company&apos;s Inaya data for reports. It can&apos;t change anything in Inaya.</p>
        </div>
        {!valid ? <p className="text-sm text-red-400">This sign-in link is not valid. Start again from Power BI: Get data &gt; Inaya Business OS.</p>
        : me === undefined ? <p className="text-sm text-[var(--inaya-text-muted)]">Loading…</p>
        : me === null ? (
          <div className="space-y-4">
            <p className="text-sm text-[var(--inaya-text-primary)]">Sign in to Inaya first.</p>
            <button type="button" onClick={passkey} disabled={!!busy} className={`${btn} bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]`}>{busy === "passkey" ? "Waiting for your passkey…" : "🔑 Sign in with a passkey"}</button>
            <div className="space-y-2 pt-3 border-t border-[var(--inaya-overlay-10)]">
              <input className={input} type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Work email" />
              {!codeSent ? (<>
                <button type="button" onClick={sendCode} disabled={!!busy || !email} className={`${btn} border border-[var(--inaya-border)] text-[var(--inaya-text-primary)]`}>{busy === "send" ? "Sending…" : "Email me a sign-in code"}</button>
                <button type="button" onClick={sso} disabled={!!busy || !email} className="w-full text-xs font-bold text-[var(--inaya-accent)] hover:underline disabled:opacity-40">{busy === "sso" ? "Opening your company sign-in…" : "Sign in with company SSO"}</button>
              </>) : mfa ? (<>
                <input className={input} inputMode="numeric" placeholder="Authenticator code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} aria-label="Authenticator code" />
                <button type="button" onClick={verifyMfa} disabled={!!busy || !mfaCode} className={`${btn} bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]`}>{busy ? "Checking…" : "Continue"}</button>
              </>) : (<>
                <input className={input} inputMode="numeric" maxLength={6} placeholder="6-digit code from the email" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Sign-in code" />
                <button type="button" onClick={verifyCode} disabled={!!busy || code.length !== 6} className={`${btn} bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]`}>{busy ? "Checking…" : "Sign in"}</button>
                <button type="button" onClick={() => { setCodeSent(false); setCode(""); }} className="w-full text-xs text-[var(--inaya-text-muted)] hover:underline">Use a different email</button>
              </>)}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-[var(--inaya-text-muted)]">Signed in as <b className="text-[var(--inaya-text-primary)]">{me.email}</b>. Choose the company to connect:</p>
            <button type="button" disabled={!!busy} className="text-xs font-bold text-[var(--inaya-accent)] hover:underline disabled:opacity-40"
              onClick={async () => { setBusy("switch"); try { await fetch("/api/orgs/logout", { method: "POST", credentials: "include" }); } catch { /* signed out anyway below */ } setMe(null); setCodeSent(false); setCode(""); setEmail(""); setErr(""); setBusy(""); }}>
              Not you? Use a different account
            </button>
            {me.companies.length === 0 && <p className="text-sm text-[var(--inaya-text-muted)]">You are not a member of any company.</p>}
            {me.companies.map((c) => (
              <div key={c.orgId} className="border border-[var(--inaya-overlay-10)] rounded-xl p-3">
                <p className="text-sm font-bold text-[var(--inaya-text-primary)]">{c.name}</p>
                {c.ok ? (
                  <button type="button" onClick={() => approve(c.orgId)} disabled={!!busy} className={`${btn} mt-2 bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]`}>{busy === c.orgId ? "Connecting…" : "Allow Power BI to read this company's data"}</button>
                ) : <p className="text-xs text-[var(--inaya-text-muted)] mt-1">{c.reason}</p>}
              </div>
            ))}
            <ul className="text-[11px] text-[var(--inaya-text-muted)] list-disc pl-4 space-y-0.5">
              <li>Power BI only sees what you can see in Inaya: your role, departments and branches.</li>
              <li>Read-only. Disconnect any time in Inaya: Admin &gt; Integrations &gt; Power BI.</li>
              <li>Data Power BI has already downloaded stays in your Power BI files; Inaya cannot erase those copies.</li>
            </ul>
          </div>
        )}
        {err && <p className="text-red-400 text-xs" role="alert">{err}</p>}
      </div>
    </main>
  );
}
