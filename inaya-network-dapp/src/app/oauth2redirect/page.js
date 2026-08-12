"use client";

// src/app/oauth2redirect/page.js
//
// Google OAuth for the mobile app (inaya-mobile) requires an "Authorized
// redirect URI" that ends in a public top-level domain — a raw custom URL
// scheme (inayamobile://oauth2redirect) is rejected by Google's Web
// application client type. This page is that HTTPS landing target, and its
// bounce below is the ACTUAL mechanism that gets the user back into the
// app — not a rare fallback. expo-web-browser's own promise resolution
// can't do this itself: on Android it only resolves 'success' when the URL
// that reopens the app literally starts with the exact redirect_uri string
// that was sent to Google (this https one) — since the real return trip
// goes through a different URL entirely (this page's own custom-scheme
// redirect below), that check always fails there. So inaya-mobile's
// GoogleSignInButton doesn't rely on that promise for the actual result at
// all — it listens for this inbound inayamobile://oauth2redirect deep link
// directly (see its own comment for the full explanation) and extracts the
// id_token from it itself.

import { useEffect, useState } from "react";

export default function OAuthRedirectPage() {
  const [bounced, setBounced] = useState(false);

  useEffect(() => {
    const suffix = window.location.hash || window.location.search;
    window.location.replace(`inayamobile://oauth2redirect${suffix}`);
    setBounced(true);
  }, []);

  return (
    <main className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex flex-col items-center justify-center px-6 text-center">
      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] mb-6" />
      <h1 className="text-lg font-bold">Signing you in&hellip;</h1>
      <p className="text-sm text-[#94a3b8] mt-2 max-w-xs">
        {bounced
          ? "You can close this window and return to the Inaya app."
          : "Redirecting back to the Inaya app."}
      </p>
    </main>
  );
}
