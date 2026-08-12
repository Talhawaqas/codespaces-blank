"use client";

// src/app/oauth2redirect/page.js
//
// Google OAuth for the mobile app (inaya-mobile) requires an "Authorized
// redirect URI" that ends in a public top-level domain — a raw custom URL
// scheme (inayamobile://oauth2redirect) is rejected by Google's Web
// application client type. This page is that HTTPS landing target.
//
// In practice it's rarely actually rendered: expo-auth-session's
// WebBrowser.openAuthSessionAsync watches for navigation to this exact URL
// and closes its in-app browser session the moment it's requested, handing
// the full URL (including Google's id_token in the fragment) back to the
// app — this page's own JS never gets a chance to run. It exists as a
// fallback for the rarer case the OS opens this in a real external browser
// instead: bounce into the app via its custom scheme, carrying over
// whatever Google appended.

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
