"use client";

// src/components/NotificationsBell.js
//
// Enterprise OS SOW, Phase 3 — surface-agnostic bell + dropdown, same
// "small self-contained header widget usable from both surfaces" pattern
// ThemeSwitcher.js already establishes (imported into both the Business
// Workspace header and the main site header). Scope-specific identity is
// passed in as props rather than this component importing OrgContext or
// WalletContext itself, so it has no dependency on which surface renders
// it.
//
// Org scope: GET/POST /api/orgs/notifications* (session-cookie auth, via
// requireMembership on the server — no client-side signing needed).
// Wallet scope: GET is unauthenticated (aggregate data only, same trust
// tier as /api/wallet/trust-health); mark-read/mark-all-read need a real
// wallet signature, built via signMessage() from WalletContext using
// verifyMetadataAuth's existing message format so the server can verify
// it with the same function file-rename/delete already use.

import { useState, useEffect, useCallback, useRef } from "react";

const SEVERITY_DOT = { info: "bg-[#00f2fe]", warning: "bg-amber-400", critical: "bg-red-400" };
const POLL_MS = 60000;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function buildSignedAuth({ action, resourceId }) {
  const timestamp = Date.now();
  const message = ["Inaya Metadata Action", `action: ${action}`, `resourceId: ${resourceId}`, `timestamp: ${timestamp}`].join("\n");
  return { message, timestamp };
}

export default function NotificationsBell({ scope, orgId, email, walletAddress, signMessage }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const containerRef = useRef(null);

  const listUrl =
    scope === "org" ? `/api/orgs/notifications?orgId=${orgId}` : `/api/wallet/notifications?address=${walletAddress}`;

  const refresh = useCallback(async () => {
    if (scope === "org" && !orgId) return;
    if (scope === "wallet" && !walletAddress) return;
    try {
      const data = await api(listUrl);
      setItems(data.notifications || []);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [listUrl, scope, orgId, walletAddress]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function handleMarkRead(id) {
    try {
      if (scope === "org") {
        await api(`/api/orgs/notifications/${id}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgId }),
        });
      } else {
        const { message, timestamp } = buildSignedAuth({ action: "markNotificationRead", resourceId: id });
        const signature = await signMessage(message);
        await api(`/api/wallet/notifications/${id}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: walletAddress, message, signature, timestamp }),
        });
      }
      setItems((prev) => prev.map((n) => (n._id === id ? { ...n, read: true } : n)));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleMarkAllRead() {
    try {
      if (scope === "org") {
        await api(`/api/orgs/notifications/mark-all-read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgId }),
        });
      } else {
        const { message, timestamp } = buildSignedAuth({ action: "markAllNotificationsRead", resourceId: "all" });
        const signature = await signMessage(message);
        await api(`/api/wallet/notifications/mark-all-read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: walletAddress, message, signature, timestamp }),
        });
      }
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch (err) {
      setError(err.message);
    }
  }

  const unreadCount = items.filter((n) => !n.read).length;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        className="relative w-9 h-9 flex items-center justify-center rounded-lg bg-black/30 border border-white/10 hover:bg-white/5 text-[var(--inaya-text-primary)]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-400 text-[10px] font-bold text-black flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-[var(--inaya-surface)] border border-white/10 rounded-xl shadow-xl z-50">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5">
            <p className="text-xs font-bold uppercase text-[var(--inaya-text-muted)]">Notifications</p>
            {unreadCount > 0 && (
              <button onClick={handleMarkAllRead} className="text-[11px] font-semibold text-[#00f2fe] hover:underline">
                Mark all read
              </button>
            )}
          </div>
          {error && <p className="text-[11px] text-red-400 px-3 py-2">{error}</p>}
          {items.length === 0 && !error && (
            <p className="text-[12px] text-[var(--inaya-text-muted)] px-3 py-6 text-center">Nothing yet.</p>
          )}
          {items.map((n) => (
            <a
              key={n._id}
              href={n.actionUrl || "#"}
              onClick={() => !n.read && handleMarkRead(n._id)}
              className={`block px-3 py-2.5 border-b border-white/5 last:border-b-0 hover:bg-white/5 ${n.read ? "opacity-60" : ""}`}
            >
              <div className="flex items-start gap-2">
                <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${SEVERITY_DOT[n.severity] || SEVERITY_DOT.info}`} />
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-[var(--inaya-text-primary)] truncate">{n.title}</p>
                  {n.body && <p className="text-[11px] text-[var(--inaya-text-muted)] mt-0.5 line-clamp-2">{n.body}</p>}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
