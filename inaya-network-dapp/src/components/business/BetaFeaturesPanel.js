"use client";

// src/components/business/BetaFeaturesPanel.js
//
// Settings panel for the staged rollout of new capabilities (Competitive Expansion SOW section 55). Owner/admin can opt this
// organization in or out. Only capabilities that are actually built are listed; each says what it is and what it does not do.

import { useCallback, useEffect, useState } from "react";

const flagCache = new Map();
/** { FEATURE_X: boolean } for the current organization, fetched once per page load and shared by every component that asks. */
export function useOrgFeatureFlags(orgId) {
  const [flags, setFlags] = useState(() => flagCache.get(orgId)?.value || {});
  useEffect(() => {
    if (!orgId) return; let live = true;
    let entry = flagCache.get(orgId);
    if (!entry || Date.now() - entry.at > 60_000) {
      entry = { at: Date.now(), promise: fetch(`/api/orgs/features?orgId=${orgId}`, { credentials: "include" }).then((r) => (r.ok ? r.json() : { features: [] })).then((d) => Object.fromEntries((d.features || []).map((f) => [f.name, !!f.enabled]))).catch(() => ({})) };
      flagCache.set(orgId, entry); entry.promise.then((v) => { entry.value = v; });
    }
    entry.promise.then((v) => { if (live) setFlags(v); });
    return () => { live = false; };
  }, [orgId]);
  return flags;
}

// Add an entry here only when the capability is built and verified enough to offer.
const OFFERED = {
  FEATURE_SECURE_CHAT: { title: "Secure Chat (beta)", text: "End-to-end encrypted conversations and files inside the workspace. Inaya cannot read messages. A new device sees only new messages." },
  FEATURE_SECURE_NOTES: { title: "Secure Notes (beta)", text: "Encrypted notes (text, rich text, Markdown, checklists, code) with history, private tags and sharing with colleagues. Each person sets a notes passphrase that Inaya cannot recover; search happens in the browser." },
  FEATURE_DEVICE_CONTROL: { title: "Device inventory and control", text: "Each browser and app that signs in is listed with its platform, version and last check-in. Administrators can trust, block, remove or sign out a device and ask the app to wipe its own offline data. A wipe only deletes the app's data, never the device itself, and applies when the device next checks in." },
  FEATURE_RANSOMWARE_SIGNALS: { title: "Ransomware signals", text: "Watches file activity through the storage API for mass overwrites and deletes, encryption-like rewrites, known ransomware extensions and a hidden tripwire file; alerts, can pause writes from a credential, and helps roll files back. Signals are heuristics, not proof." },
  FEATURE_ENDPOINT_BACKUP_V2: { title: "Endpoint backup profiles", text: "Backup profiles for the desktop app (folders, schedule, bandwidth, version retention), health, integrity checks against stored files, and restores to the original or another location. Restores during unusual file activity use an earlier point in time and need a second approver." },
  FEATURE_DATA_ROOM_V2: { title: "Data Room 2.0", text: "Per-section visitor access, view-only or download per document, watermark, locked and final-version documents, network restriction, questions and answers, room health and a timeline. Visitors read documents in a secure viewer; view-only is a viewer mode, not a guarantee against someone who holds the passkey." },
  FEATURE_DRM_VIEWER: { title: "Secure viewer and preview", text: "A viewer for PDFs, images, text, Markdown, CSV, Word, Excel and DICOM that runs in your browser, with preview in the workspace, watermark, view-only and restricted modes. It cannot stop photographs, operating-system screenshots or someone who holds the decryption passkey." },
  FEATURE_FILE_GOVERNANCE: { title: "File governance", text: "Versioned governance policies (sharing limits, upload restrictions, retention and more) and metadata fields on files. Policies only ever restrict what permissions already allow." },
  FEATURE_DLP: { title: "Data loss prevention", text: "Rules that allow, block, log or require approval for actions on files (who, where from, which file, where it is going), with a log of every decision. Rules never grant access." },
  FEATURE_SMART_CLASSIFICATION: { title: "Smart classification", text: "Rule-based classification (file name, type, metadata, and content where Inaya is allowed to read it) with suggestions, history and manual override. Encrypted files are classified in your browser or scanner, never decrypted by Inaya." },
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
