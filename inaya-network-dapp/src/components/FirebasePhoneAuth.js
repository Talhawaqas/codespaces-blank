"use client";

// src/components/FirebasePhoneAuth.js
//
// Reusable Firebase Phone Auth widget: phone number -> invisible
// reCAPTCHA -> Firebase sends + verifies its own SMS code -> emits the
// resulting signed ID token via onVerified(idToken). This component never
// talks to Inaya's own backend at all — that's the caller's job (POST the
// ID token to /api/orgs/mfa/sms/enroll or /api/orgs/mfa/verify, which
// independently re-verify it server-side via firebaseAdmin.js). Used by
// MfaSettings.js (browser enrollment), MfaVerifyScreen.js (browser login
// verification), and app/mfa/phone-auth/page.js (the mobile-bounce page).
//
// A fresh RecaptchaVerifier + container id per mount avoids Firebase's
// "reCAPTCHA has already been rendered" error if this component is
// remounted (e.g. the user cancels and retries).

import { useState, useRef, useId } from "react";
import { RecaptchaVerifier, signInWithPhoneNumber } from "firebase/auth";
import { getFirebaseAuth, isFirebaseConfigured } from "../lib/firebaseClient";

export default function FirebasePhoneAuth({ onVerified, initialPhoneNumber = "" }) {
  const recaptchaContainerId = `firebase-recaptcha-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const verifierRef = useRef(null);
  const confirmationRef = useRef(null);

  const [phoneNumber, setPhoneNumber] = useState(initialPhoneNumber);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function sendCode() {
    setError("");
    if (!isFirebaseConfigured()) {
      setError("Phone verification isn't configured yet.");
      return;
    }
    setBusy(true);
    try {
      const auth = getFirebaseAuth();
      if (!verifierRef.current) {
        verifierRef.current = new RecaptchaVerifier(auth, recaptchaContainerId, { size: "invisible" });
      }
      confirmationRef.current = await signInWithPhoneNumber(auth, phoneNumber.trim(), verifierRef.current);
      setCodeSent(true);
    } catch (err) {
      setError(err.message || "Could not send a verification code — check the phone number and try again.");
      // A failed send can leave the widget unusable for a retry with the same verifier instance.
      verifierRef.current?.clear?.();
      verifierRef.current = null;
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode() {
    if (!confirmationRef.current) return;
    setError("");
    setBusy(true);
    try {
      const result = await confirmationRef.current.confirm(code.trim());
      const idToken = await result.user.getIdToken();
      onVerified(idToken, result.user.phoneNumber);
    } catch (err) {
      setError(err.message || "That code doesn't match — check it and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div id={recaptchaContainerId} />

      {!codeSent ? (
        <div className="flex gap-2">
          <input
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+15551234567"
            className="flex-1 bg-black/45 border border-white/10 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary,#fff)]"
          />
          <button onClick={sendCode} disabled={busy || !phoneNumber.trim()} className="text-xs font-bold uppercase px-3 py-2 rounded-lg bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
            {busy ? "Sending…" : "Send code"}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            inputMode="numeric"
            className="flex-1 bg-black/45 border border-white/10 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary,#fff)]"
          />
          <button onClick={confirmCode} disabled={busy || !code.trim()} className="text-xs font-bold uppercase px-3 py-2 rounded-lg bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
            {busy ? "Verifying…" : "Confirm"}
          </button>
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}
