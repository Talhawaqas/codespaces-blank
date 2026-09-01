"use client";

// src/components/business/AuditTrailView.js
//
// Org-scoped self-service equivalent of the internal /admin/audit chain
// browser: an integrity banner (Verified / Broken, with the exact
// brokenAtSeq + reason if not), a chain browser table, and Export
// JSON/CSV buttons — same real, verifiable data as the admin panel
// (auditChain.js's listAuditChain/verifyChainIntegrity), just gated by
// org membership (owner/admin) instead of internal admin auth. Same
// self-contained-view pattern as AIActionRequestsView.js.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function truncateHash(hash) {
  if (!hash) return "—";
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export default function AuditTrailView({ orgId }) {
  const [entries, setEntries] = useState(null);
  const [integrity, setIntegrity] = useState(null);
  const [error, setError] = useState("");
  const [copiedSeq, setCopiedSeq] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/audit?orgId=${orgId}`);
      setEntries(data.entries);
      setIntegrity(data.integrity);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function copyHash(seq, hash) {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedSeq(seq);
      setTimeout(() => setCopiedSeq(null), 1500);
    } catch {
      // Clipboard API unavailable (non-HTTPS, permissions) — silently no-op,
      // the hash is still visible (truncated) in the row itself.
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Audit Trail</h3>
          <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5 max-w-xl">
            A tamper-evident, cryptographically hash-chained record of this company&apos;s activity. Each entry commits to every entry before it — altering or deleting any past entry breaks every hash after it, which is exactly what the integrity check below verifies.
          </p>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <a
            href={`/api/orgs/audit/export?orgId=${orgId}&format=json`}
            className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10"
          >
            Export JSON
          </a>
          <a
            href={`/api/orgs/audit/export?orgId=${orgId}&format=csv`}
            className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10"
          >
            Export CSV
          </a>
        </div>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {integrity && (
        <div className={`rounded-2xl p-4 border text-sm font-mono ${integrity.valid ? "bg-emerald-400/10 border-emerald-400/30 text-emerald-400" : "bg-red-400/10 border-red-400/30 text-red-400"}`}>
          {integrity.valid
            ? `Verified — ${integrity.count} ${integrity.count === 1 ? "entry" : "entries"}, chain intact.`
            : `Broken at entry #${integrity.brokenAtSeq} — ${integrity.reason}`}
        </div>
      )}

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!entries ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : entries.length === 0 ? (
          <EmptyState compact icon="🔗" description="No audit chain entries yet." />
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.eventId} className="bg-black/20 border border-white/5 rounded-lg p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[var(--inaya-text-primary)] text-sm truncate">
                    #{e.seq} · {e.recordType} · {e.action}
                  </p>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">
                    {e.actorEmail || "system"} · {new Date(e.timestamp).toLocaleString()}
                  </p>
                </div>
                <button
                  onClick={() => copyHash(e.seq, e.entryHash)}
                  className="text-[11px] font-mono px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-muted)] hover:bg-white/10 shrink-0"
                  title="Copy full hash"
                >
                  {copiedSeq === e.seq ? "Copied" : truncateHash(e.entryHash)}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
