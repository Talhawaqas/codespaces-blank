"use client";

// app/business/app-signin/page.js -- sign the Inaya mobile app in with a passkey or company SSO (src/lib/appHandoff.js).
// Opened by the app in a secure in-app browser tab: ?challenge=<base64url SHA-256>&redirect=inayamobile://auth[&mode=passkey|sso].
// Once signed in on the website, the page gets a one-time code and sends the browser back to the app with it.
// Nothing here is shown to a normal website visitor: without a valid app redirect the page just points to /business.

import { useCallback, useEffect, useState } from "react";

const REDIRECTS = ["inayamobile://auth"];
async function api(path, options) {
  const res = await fetch(path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function AppSignIn() {
  const [params, setParams] = useState(null); const [email, setEmail] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [done, setDone] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setParams({ challenge: q.get("challenge") || "", redirect: q.get("redirect") || "", mode: q.get("mode") || "" });
    if (q.get("ssoError")) setError(q.get("ssoError").slice(0, 200));
  }, []);
  const valid = params && REDIRECTS.includes(params.redirect) && /^[A-Za-z0-9_-]{43}$/.test(params.challenge);

  const handBack = useCallback(async () => {
    const { code } = await api("/api/orgs/app-handoff", { method: "POST", body: JSON.stringify({ challenge: params.challenge }) });
    setDone(true);
    window.location.href = `${params.redirect}?code=${encodeURIComponent(code)}`;
  }, [params]);

  // Straight back from company SSO (?sso=1): offer to continue as that person. The server only issues a code after a fresh
  // sign-in, and only when the person presses the button, never on page load.
  const [signedInAs, setSignedInAs] = useState("");
  useEffect(() => {
    if (!valid || new URLSearchParams(window.location.search).get("sso") !== "1") return;
    fetch("/api/orgs/session", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then((s) => { if (s?.authenticated) setSignedInAs(s.email); }).catch(() => {});
  }, [valid]);
  async function continueToApp() { setBusy("continue"); setError(""); try { await handBack(); } catch (e) { setError(e.message); } finally { setBusy(""); } }

  async function passkey() {
    setBusy("passkey"); setError("");
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options, requestToken } = await api("/api/orgs/login/passkey", { method: "POST", body: JSON.stringify({ step: "start" }) });
      const response = await startAuthentication({ optionsJSON: options });
      await api("/api/orgs/login/passkey", { method: "POST", body: JSON.stringify({ step: "finish", requestToken, response }) });
      await handBack();
    } catch (e) { setError(e?.name === "NotAllowedError" ? "The passkey request was cancelled." : e.message); } finally { setBusy(""); }
  }
  async function sso(e) {
    e.preventDefault(); setBusy("sso"); setError("");
    try {
      const returnTo = `/business/app-signin?challenge=${encodeURIComponent(params.challenge)}&redirect=${encodeURIComponent(params.redirect)}&sso=1`;
      const { url } = await api("/api/orgs/login/sso/start", { method: "POST", body: JSON.stringify({ email, returnTo }) });
      window.location.assign(url);
    } catch (err) { setError(err.message); setBusy(""); }
  }

  const card = "w-full max-w-sm mx-auto bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-6 shadow-sm";
  const btn = "w-full py-3 rounded-xl text-sm font-bold disabled:opacity-40";
  if (!params) return null;
  return (
    <main className="min-h-screen flex items-center px-4 py-10 bg-[var(--inaya-bg,#0b1220)]">
      <div className={card}>
        <p className="text-lg font-extrabold text-[var(--inaya-text-primary)]">Sign in to the Inaya app</p>
        {!valid ? (
          <p className="text-sm text-[var(--inaya-text-muted)] mt-2">Open this page from the Inaya app. To use Inaya in your browser, go to <a className="underline" href="/business">inayanetwork.com/business</a>.</p>
        ) : done ? (
          <p className="text-sm text-emerald-500 mt-3" role="status">Signed in. Returning to the app…</p>
        ) : signedInAs ? (<>
          <p className="text-sm text-[var(--inaya-text-primary)] mt-3 mb-4">Signed in as <b>{signedInAs}</b>.</p>
          <button type="button" onClick={continueToApp} disabled={!!busy} className={`${btn} bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]`}>{busy ? "Returning to the app…" : "Continue to the app"}</button>
          {error && <p className="text-red-400 text-xs mt-4" role="alert">{error}</p>}
        </>) : (<>
          <p className="text-xs text-[var(--inaya-text-muted)] mt-1 mb-5">You will go straight back to the app.</p>
          {params.mode !== "sso" && <button type="button" onClick={passkey} disabled={!!busy} className={`${btn} bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]`}>{busy === "passkey" ? "Waiting for your passkey…" : "🔑 Sign in with a passkey"}</button>}
          {params.mode !== "passkey" && (
            <form onSubmit={sso} className={`space-y-2 ${params.mode !== "sso" ? "mt-5 pt-5 border-t border-[var(--inaya-overlay-10)]" : ""}`}>
              <label className="block text-xs text-[var(--inaya-text-muted)]">Company sign-in (SSO): your work email
                <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required placeholder="you@company.com" className="mt-1 w-full bg-black/30 border border-[var(--inaya-overlay-15)] rounded-xl px-3 py-2.5 text-sm text-[var(--inaya-text-primary)]" />
              </label>
              <button disabled={!!busy} className={`${btn} border border-[var(--inaya-border)] text-[var(--inaya-text-primary)]`}>{busy === "sso" ? "Opening your company sign-in…" : "Sign in with company SSO"}</button>
            </form>
          )}
          {error && <p className="text-red-400 text-xs mt-4" role="alert">{error}</p>}
        </>)}
      </div>
    </main>
  );
}
