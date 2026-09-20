"use client";

// src/components/business/ComplianceEvidenceView.js
//
// Enterprise Adoption SOW, Workstream C -- read-only compliance evidence
// exporter. Same self-contained-view pattern as AuditTrailView.js, but
// aggregates storage protection state + security events + the audit
// chain + a cryptographic export hash into one package, instead of just
// the raw chain. This view triggers nothing but GET requests -- it has no
// write path at all, matching the SOW's own read-only requirement.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function ComplianceEvidenceView({ orgId }) {
  const [pkg, setPkg] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/evidence-export?orgId=${orgId}&format=json`);
      setPkg(data);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Compliance Evidence</h3>
          <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5 max-w-xl">
            Generates structured evidence that organizations can use to support internal, legal, regulatory, and third-party audit processes — from this company&apos;s own existing storage protection settings, security events, and cryptographic audit chain. This is not a certification of compliance with any specific law, regulation, or standard.
          </p>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <a
            href={`/api/orgs/evidence-export?orgId=${orgId}&format=json`}
            className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10"
          >
            Download JSON
          </a>
          <a
            href={`/api/orgs/evidence-export?orgId=${orgId}&format=pdf`}
            className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black hover:opacity-90"
          >
            Download PDF
          </a>
        </div>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {!pkg ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : (
        <>
          <div className={`rounded-2xl p-4 border text-sm font-mono ${pkg.auditEvidence.chainIntegrity.valid ? "bg-emerald-400/10 border-emerald-400/30 text-emerald-400" : "bg-red-400/10 border-red-400/30 text-red-400"}`}>
            {pkg.auditEvidence.chainIntegrity.valid
              ? `Audit chain verified — ${pkg.auditEvidence.chainIntegrity.count} entries, chain intact.`
              : `Audit chain BROKEN at entry #${pkg.auditEvidence.chainIntegrity.brokenAtSeq} — ${pkg.auditEvidence.chainIntegrity.reason}`}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold">Buckets in scope</p>
              <p className="text-[var(--inaya-text-primary)] text-2xl font-bold mt-1">{pkg.storageEvidence.buckets.length}</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold">Security events</p>
              <p className="text-[var(--inaya-text-primary)] text-2xl font-bold mt-1">{pkg.securityEvidence.eventCount}</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold">Audit chain entries</p>
              <p className="text-[var(--inaya-text-primary)] text-2xl font-bold mt-1">{pkg.auditEvidence.entryCount}</p>
            </div>
          </div>

          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
            <p className="text-[var(--inaya-text-primary)] text-sm font-bold mb-2">Storage protection state</p>
            {pkg.storageEvidence.buckets.length === 0 ? (
              <EmptyState compact icon="🗄️" description="No buckets on record for this organization." />
            ) : (
              <div className="space-y-2">
                {pkg.storageEvidence.buckets.map((b) => (
                  <div key={b.bucket} className="bg-black/20 border border-white/5 rounded-lg p-3 flex items-center justify-between gap-3">
                    <p className="text-[var(--inaya-text-primary)] text-sm font-mono truncate">{b.bucket}</p>
                    <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono shrink-0">
                      Versioning: {b.versioningStatus} · Object Lock: {b.objectLockEnabled ? "On" : "Off"} · Lifecycle rules: {b.lifecycleRules.length}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
            <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold">Export integrity hash (SHA-256)</p>
            <p className="text-[var(--inaya-text-primary)] text-xs font-mono mt-1 break-all">{pkg.exportHash}</p>
          </div>
        </>
      )}
    </div>
  );
}
