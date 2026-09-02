"use client";

// src/app/mfa/phone-auth/page.js
//
// Session-free mobile-bounce page for Firebase Phone Auth, mirroring
// oauth2redirect/page.js's exact mechanism: inaya-mobile opens this via
// expo-web-browser (a real browser context, needed because Firebase's
// client SDK + invisible reCAPTCHA can't run inside a native WebView the
// same way), the FirebasePhoneAuth widget runs the real flow here, and on
// success this page bounces straight back into the app via its own
// custom URL scheme with the ID token in the fragment — never sent
// through a query string or server round-trip.
//
// Query params: ?callback=<url-encoded inayamobile://... prefix>
// (mode/phone are accepted too, passed straight through to prefill the
// widget, but callback is the only one this page actually requires).

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import FirebasePhoneAuth from "../../../components/FirebasePhoneAuth";
import { isFirebaseConfigured } from "../../../lib/firebaseClient";

function PhoneAuthInner() {
  const searchParams = useSearchParams();
  const callback = searchParams.get("callback");
  const initialPhoneNumber = searchParams.get("phone") || "";
  // Echoed back verbatim in the bounce fragment below, unmodified -- this page never generates or
  // checks it, that's the mobile app's job (see MfaSettingsScreen.js/MfaVerifyScreen.js's own
  // comment on why: inayamobile:// isn't exclusive to this app, so the mobile side needs to reject
  // an inbound idToken that doesn't carry the nonce IT generated for the request it actually sent).
  const state = searchParams.get("state");
  const [bounced, setBounced] = useState(false);

  function handleVerified(idToken) {
    if (!callback) return;
    setBounced(true);
    const stateSuffix = state ? `&state=${encodeURIComponent(state)}` : "";
    window.location.replace(`${callback}#idToken=${encodeURIComponent(idToken)}${stateSuffix}`);
  }

  return (
    <main className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex flex-col items-center justify-center px-6 text-center">
      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] mb-6" />
      <h1 className="text-lg font-bold mb-1">Verify your phone</h1>
      <p className="text-sm text-[#94a3b8] mb-6 max-w-xs">
        {bounced ? "You can close this window and return to the Inaya app." : "Complete verification below, then you'll be sent back to the app automatically."}
      </p>

      {!callback ? (
        <p className="text-red-400 text-sm">Missing callback — reopen this page from the Inaya app.</p>
      ) : !isFirebaseConfigured() ? (
        <p className="text-red-400 text-sm">Phone verification isn't configured yet.</p>
      ) : !bounced ? (
        <div className="w-full max-w-xs">
          <FirebasePhoneAuth onVerified={handleVerified} initialPhoneNumber={initialPhoneNumber} />
        </div>
      ) : null}
    </main>
  );
}

export default function PhoneAuthPage() {
  return (
    <Suspense fallback={null}>
      <PhoneAuthInner />
    </Suspense>
  );
}
