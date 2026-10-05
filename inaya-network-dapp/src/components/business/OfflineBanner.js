"use client";

// src/components/business/OfflineBanner.js
//
// A thin, honest connection indicator for the Business Workspace (and its desktop app). Shown only while the device reports no network.
// It says what still works: Secure Chat keeps messages on this device and sends them when the connection returns. Everything else needs a connection.

import { useEffect, useState } from "react";

export default function OfflineBanner() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine !== false); sync();
    window.addEventListener("online", sync); window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);
  if (online) return null;
  return (
    <div role="status" data-testid="offline-banner" className="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-200 text-xs px-3 py-2">
      You are offline. Secure Chat messages you write are saved on this device and send when you reconnect. Other actions need a connection.
    </div>
  );
}
