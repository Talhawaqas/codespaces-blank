"use client";

// src/components/business/BetaFeaturesPanel.js
//
// Settings panel for the staged rollout of new capabilities (Competitive Expansion SOW section 55). Owner/admin can opt this
// organization in or out. Only capabilities that are actually built are listed; each says what it is and what it does not do.

import { useCallback, useEffect, useState } from "react";

// Add an entry here only when the capability is built and verified enough to offer.
const OFFERED = {
  FEATURE_SECURE_CHAT: { title: "Secure Chat (beta)", text: "End-to-end encrypted conversations and files inside the workspace. Inaya cannot read messages. A new device sees only new messages." },
  FEATURE_ADVANCED_SHARING: { title: "Advanced sharing", text: "Secure links with passwords, expiry, download and network limits, one-time use, delegated managers and an access log; file requests (people outside the company send you files, encrypted so only you can open them); and file locks. Recipients still need the document passkey from you." },
};

export default function BetaFeaturesPanel({ orgId, canManage }) {
  const [rows, setRows] = useState(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try { const r = await fetch(`/api/orgs/features?orgId=${orgId}`, { credentials: "include" }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not load."); setRows(d.features.filter((f) => OFFERED[f.name])); }
    catch (e) { setErr(e.message); }
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  async function toggle(name, enabled) {
    setBusy(name); setErr("");
    try {
      const r = await fetch("/api/orgs/features", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, name, enabled }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not change.");
      setRows(d.features.filter((f) => OFFERED[f.name]));
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }

  return (
    <div className="bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg p-4">
      <h3 className="text-sm font-bold mb-1">Beta features</h3>
      <p className="text-[12px] text-[var(--inaya-text-muted)] mb-3">New capabilities are off until you turn them on. Turning one off hides it; nothing is deleted.</p>
      {err && <p className="text-red-400 text-[12px] mb-2" role="alert">{err}</p>}
      {rows === null ? <p className="text-[12px] text-[var(--inaya-text-muted)]">Loading…</p> : rows.map((f) => (
        <label key={f.name} className="flex items-start gap-3 py-2 border-t border-[var(--inaya-overlay-10)] first:border-0">
          <input type="checkbox" className="mt-1" checked={f.enabled} disabled={!canManage || busy === f.name || f.source === "platform"} onChange={(e) => toggle(f.name, e.target.checked)} aria-label={OFFERED[f.name].title} />
          <span className="text-[12px]"><b>{OFFERED[f.name].title}</b>{f.source === "platform" ? <span className="text-[var(--inaya-text-muted)]"> (on for everyone)</span> : null}<br /><span className="text-[var(--inaya-text-muted)]">{OFFERED[f.name].text}</span></span>
        </label>))}
    </div>
  );
}
