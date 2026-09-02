"use client";

// src/components/business/MfaVerifyScreen.js
//
// Login-time second-factor entry — rendered instead of AuthScreen once
// primary auth (magic link or Google) succeeds AND the account has MFA
// enrolled. Accepts a TOTP code, an SMS code, or a recovery code — the
// server (mfa.js's checkFactor()) tries all three, this UI doesn't need
// to know which method is actually enrolled. Server-side rate limiting
// (5 attempts) means this screen just relays whatever error comes back;
// it doesn't do its own attempt counting.

import { useState } from "react";
import FirebasePhoneAuth from "../FirebasePhoneAuth";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function MfaVerifyScreen({ mfaPendingToken, onVerified, onCancel }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showPhoneVerify, setShowPhoneVerify] = useState(false);

  async function submitCode(rawCode) {
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/mfa/verify", { method: "POST", body: JSON.stringify({ mfaPendingToken, code: rawCode }) });
      onVerified();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    submitCode(code.trim());
  }

  function handlePhoneVerified(idToken) {
    submitCode(idToken);
  }

  return (
    <div className="max-w-sm mx-auto w-full inaya-fade-in-up">
      <h1 className="text-2xl font-extrabold text-[var(--inaya-text-primary)] mb-1">Two-Step Verification</h1>
      <p className="text-[var(--inaya-text-muted)] text-sm mb-6">
        Enter the 6-digit code from your authenticator app, a code we texted you, or one of your recovery codes.
      </p>

      {!showPhoneVerify ? (
        <>
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              placeholder="000000"
              inputMode="numeric"
              className="w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-xl px-4 py-3 text-center text-lg tracking-[0.3em] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]"
            />
            <button disabled={submitting} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
              {submitting ? "Verifying…" : "Verify"}
            </button>
          </form>

          <button onClick={() => setShowPhoneVerify(true)} className="mt-4 text-xs text-[var(--inaya-text-muted)] hover:text-[#00f2fe] block mx-auto">
            Verify by phone instead
          </button>
        </>
      ) : (
        <div className="space-y-3">
          <FirebasePhoneAuth onVerified={handlePhoneVerified} />
          <button onClick={() => setShowPhoneVerify(false)} className="text-xs text-[var(--inaya-text-muted)] hover:text-[#00f2fe] block mx-auto">
            Use a code instead
          </button>
        </div>
      )}

      {error && <p className="text-red-400 text-xs mt-4">{error}</p>}

      <button onClick={onCancel} className="mt-6 text-xs text-[var(--inaya-text-muted)] hover:text-slate-300 block mx-auto">
        ← Back to sign in
      </button>
    </div>
  );
}
