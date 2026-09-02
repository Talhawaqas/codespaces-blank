"use client";

// src/components/business/MfaSettings.js
//
// Enroll/manage MFA for the logged-in member's own account (identity-
// scoped, see mfa.js's header — this protects every org they're in, not
// just the one currently selected). Two independent methods, either or
// both can be enabled; disabling always requires a live code first
// (mfa/disable's own server-side check), never a bare toggle.

import { useState, useEffect, useCallback } from "react";
import FirebasePhoneAuth from "../FirebasePhoneAuth";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function MfaSettings() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");

  const [totpEnrollment, setTotpEnrollment] = useState(null); // { qrDataUri, secret, uri }
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setStatus(await api("/api/orgs/mfa/status"));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function startTotpEnrollment() {
    setError(""); setBusy("totp-start");
    try {
      setTotpEnrollment(await api("/api/orgs/mfa/totp/enroll", { method: "POST" }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function confirmTotp() {
    setError(""); setBusy("totp-confirm");
    try {
      const result = await api("/api/orgs/mfa/totp/confirm", { method: "POST", body: JSON.stringify({ code: totpCode.trim() }) });
      if (result.recoveryCodes) setRecoveryCodes(result.recoveryCodes);
      setTotpEnrollment(null);
      setTotpCode("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function handlePhoneVerified(idToken) {
    setError(""); setBusy("sms-enroll");
    try {
      const result = await api("/api/orgs/mfa/sms/enroll", { method: "POST", body: JSON.stringify({ idToken }) });
      if (result.recoveryCodes) setRecoveryCodes(result.recoveryCodes);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function disable() {
    setError(""); setBusy("disable");
    try {
      await api("/api/orgs/mfa/disable", { method: "POST", body: JSON.stringify({ code: disableCode.trim() }) });
      setDisableCode("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  if (!status) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  const mfaEnabled = status.totpEnabled || status.smsEnabled;

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Two-Step Verification</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Protects sign-in for your account across every company you belong to — not just this one.
        </p>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {recoveryCodes && (
        <div className="bg-amber-400/10 border border-amber-400/30 rounded-2xl p-5">
          <p className="text-amber-400 font-bold text-xs uppercase mb-2">Save your recovery codes — shown only once</p>
          <div className="grid grid-cols-2 gap-1.5 font-mono text-xs text-[var(--inaya-text-primary)]">
            {recoveryCodes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <button onClick={() => { navigator.clipboard?.writeText(recoveryCodes.join("\n")); }} className="mt-3 text-[11px] font-bold uppercase text-amber-400">
            Copy all
          </button>
          <button onClick={() => setRecoveryCodes(null)} className="mt-3 ml-4 text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">
            I've saved these
          </button>
        </div>
      )}

      {/* Authenticator app (QR code) */}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <p className="text-[var(--inaya-text-primary)] text-sm font-bold">Authenticator App (QR Code)</p>
          {status.totpEnabled && <span className="text-[11px] font-bold uppercase text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 rounded-full px-2 py-0.5">Enabled</span>}
        </div>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-1">Google Authenticator, Authy, or any standard authenticator app.</p>

        {!status.totpEnabled && !totpEnrollment && (
          <button onClick={startTotpEnrollment} disabled={busy === "totp-start"} className="mt-3 text-xs font-bold uppercase px-3 py-1.5 rounded-lg bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
            Set up
          </button>
        )}

        {totpEnrollment && (
          <div className="mt-3 space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={totpEnrollment.qrDataUri} alt="Scan with your authenticator app" className="w-40 h-40 bg-white p-2 rounded-lg" />
            <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono break-all">Or enter manually: {totpEnrollment.secret}</p>
            <div className="flex gap-2">
              <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="6-digit code" className="flex-1 bg-black/45 border border-white/10 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
              <button onClick={confirmTotp} disabled={busy === "totp-confirm"} className="text-xs font-bold uppercase px-3 py-2 rounded-lg bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
                Confirm
              </button>
            </div>
          </div>
        )}
      </div>

      {/* SMS */}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <p className="text-[var(--inaya-text-primary)] text-sm font-bold">Phone Number (SMS)</p>
          {status.smsEnabled && <span className="text-[11px] font-bold uppercase text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 rounded-full px-2 py-0.5">Enabled · •••{status.smsPhoneLast4}</span>}
        </div>

        {!status.smsEnabled && (
          <div className="mt-3">
            <FirebasePhoneAuth onVerified={handlePhoneVerified} />
          </div>
        )}
      </div>

      {mfaEnabled && (
        <div className="bg-red-400/5 border border-red-400/20 rounded-2xl p-5">
          <p className="text-red-400 text-sm font-bold mb-2">Disable Two-Step Verification</p>
          <p className="text-[var(--inaya-text-muted)] text-xs mb-3">Requires a current code first — this can't be turned off with just a click.</p>
          <div className="flex gap-2">
            <input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder="Current code" className="flex-1 bg-black/45 border border-white/10 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
            <button onClick={disable} disabled={busy === "disable"} className="text-xs font-bold uppercase px-3 py-2 rounded-lg bg-red-400/10 text-red-400 border border-red-400/30 disabled:opacity-40">
              Disable
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
