"use client";

// src/components/business/PasskeySettings.js
//
// Passkeys for the signed-in person (src/lib/passkeys.js): add one from this device (Face ID, Touch ID, Windows Hello, Android,
// or a security key), see the list, remove one. A passkey then signs you in from the sign-in screen without an email link.

import { useCallback, useEffect, useState } from "react";

async function api(path, options) {
  const res = await fetch(path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function PasskeySettings() {
  const [rows, setRows] = useState(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(""); const [name, setName] = useState(""); const [ok, setOk] = useState("");
  const supported = typeof window !== "undefined" && !!window.PublicKeyCredential;
  const load = useCallback(async () => { try { setRows((await api("/api/orgs/passkeys")).passkeys); } catch (e) { setError(e.message); } }, []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    setBusy("add"); setError(""); setOk("");
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options, requestToken } = await api("/api/orgs/passkeys/register", { method: "POST", body: JSON.stringify({ step: "start" }) });
      const response = await startRegistration({ optionsJSON: options });
      await api("/api/orgs/passkeys/register", { method: "POST", body: JSON.stringify({ step: "finish", requestToken, response, name: name || deviceLabel() }) });
      setName(""); setOk("Passkey added. You can now sign in with it."); await load();
    } catch (e) { setError(e?.name === "NotAllowedError" ? "The passkey request was cancelled." : e.message); } finally { setBusy(""); }
  }
  async function remove(id) {
    if (!window.confirm("Remove this passkey? You will not be able to sign in with it any more.")) return;
    setBusy(id); setError("");
    try { await api(`/api/orgs/passkeys?id=${encodeURIComponent(id)}`, { method: "DELETE" }); await load(); } catch (e) { setError(e.message); } finally { setBusy(""); }
  }

  return (
    <div className="space-y-3 max-w-lg">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Passkeys</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">Sign in with your fingerprint, face or device PIN instead of an email link. A passkey works only on this website and cannot be phished.</p>
      </div>
      {!supported && <p className="text-amber-400 text-xs">This browser does not support passkeys.</p>}
      {error && <p className="text-red-400 text-xs" role="alert">{error}</p>}
      {ok && <p className="text-emerald-400 text-xs" role="status">{ok}</p>}
      {rows === null ? <p className="text-[var(--inaya-text-muted)] text-xs">Loading…</p> : rows.length === 0 ? <p className="text-[var(--inaya-text-muted)] text-xs">No passkeys yet.</p> : (
        <ul className="divide-y divide-[var(--inaya-overlay-10)] border border-[var(--inaya-overlay-10)] rounded-lg">
          {rows.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <span><b className="text-[var(--inaya-text-primary)]">{p.name}</b><br /><span className="text-[var(--inaya-text-muted)]">Added {new Date(p.createdAt).toLocaleDateString()}{p.lastUsedAt ? `, last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ", not used yet"}{p.rpID !== "inayanetwork.com" ? ` (for ${p.rpID})` : ""}</span></span>
              <button type="button" onClick={() => remove(p.id)} disabled={busy === p.id} className="text-red-400 hover:underline disabled:opacity-40">Remove</button>
            </li>))}
        </ul>)}
      {supported && <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Name (for example: Work laptop)" aria-label="Passkey name" className="flex-1 bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
        <button type="button" onClick={add} disabled={busy === "add"} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-40">{busy === "add" ? "Waiting…" : "Add a passkey"}</button>
      </div>}
    </div>
  );
}

function deviceLabel() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "This device";
  return `${os} passkey`;
}
