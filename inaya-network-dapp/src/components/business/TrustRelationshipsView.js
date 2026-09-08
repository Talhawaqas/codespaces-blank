"use client";

// src/components/business/TrustRelationshipsView.js
//
// Institutional Trust Infrastructure SOW, Phase 5 — propose/accept/
// reject/revoke cross-org trust relationships. Self-contained view,
// same pattern as AIActionRequestsView.js/AuditTrailView.js. Deliberately
// thin: this only manages the relationship primitive itself (see
// org-trust.js's header comment on scope) -- it doesn't grant or reflect
// any actual data access.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import ConfirmButton from "./ConfirmButton";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLES = {
  PENDING: "bg-amber-400/10 border-amber-400/30 text-amber-400",
  ACTIVE: "bg-emerald-400/10 border-emerald-400/30 text-emerald-400",
  REJECTED: "bg-red-400/10 border-red-400/30 text-red-400",
  REVOKED: "bg-white/5 border-white/10 text-[var(--inaya-text-muted)]",
  EXPIRED: "bg-white/5 border-white/10 text-[var(--inaya-text-muted)]",
};

export default function TrustRelationshipsView({ orgId }) {
  const [relationships, setRelationships] = useState(null);
  const [error, setError] = useState("");
  const [showPropose, setShowPropose] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/trust-relationships?orgId=${orgId}`);
      setRelationships(data.relationships);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function act(relationshipId, action) {
    try {
      await api(`/api/orgs/trust-relationships/${relationshipId}`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Cross-Organization Trust</h3>
          <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5 max-w-xl">
            Explicit, scoped, time-limited trust relationships with other Inaya organizations. Each side keeps independent control — a proposal can only be accepted or rejected by the organization it was sent to, and either side can revoke at any time. This is the relationship primitive only; it does not by itself grant any data access.
          </p>
        </div>
        <button onClick={() => setShowPropose(true)} className="text-[11px] font-bold uppercase px-3 py-2 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black shrink-0">
          + Propose relationship
        </button>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {showPropose && <ProposeModal orgId={orgId} onClose={() => setShowPropose(false)} onCreated={() => { setShowPropose(false); load(); }} />}

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!relationships ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : relationships.length === 0 ? (
          <EmptyState compact icon="🤝" description="No cross-organization trust relationships yet." />
        ) : (
          <div className="space-y-2">
            {relationships.map((r) => {
              const isFrom = r.fromOrgId === orgId;
              return (
                <div key={r.relationshipId} className="bg-black/20 border border-white/5 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-[var(--inaya-text-primary)] text-sm">
                      {isFrom ? "To" : "From"} org <span className="font-mono">{isFrom ? r.toOrgId : r.fromOrgId}</span>
                    </p>
                    <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">
                      scope: {r.scope.join(", ")} {r.purpose && `· ${r.purpose}`} {r.expiresAt && `· expires ${new Date(r.expiresAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-md border ${STATUS_STYLES[r.status]}`}>{r.status}</span>
                    {!isFrom && r.status === "PENDING" && (
                      <>
                        <button onClick={() => act(r.relationshipId, "accept")} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-emerald-400/15 text-emerald-400">Accept</button>
                        <button onClick={() => act(r.relationshipId, "reject")} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-red-400/15 text-red-400">Reject</button>
                      </>
                    )}
                    {["PENDING", "ACTIVE"].includes(r.status) && (
                      <ConfirmButton onConfirm={() => act(r.relationshipId, "revoke")} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 text-[var(--inaya-text-muted)]">
                        Revoke
                      </ConfirmButton>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ProposeModal({ orgId, onClose, onCreated }) {
  const [toOrgId, setToOrgId] = useState("");
  const [scope, setScope] = useState("");
  const [purpose, setPurpose] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    const scopeList = scope.split(",").map((s) => s.trim()).filter(Boolean);
    if (!toOrgId.trim() || scopeList.length === 0) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/trust-relationships", {
        method: "POST",
        body: JSON.stringify({ orgId, toOrgId: toOrgId.trim(), scope: scopeList, purpose: purpose.trim() || undefined, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit} className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full max-w-md space-y-3">
        <h4 className="text-[var(--inaya-text-primary)] font-bold text-sm">Propose a trust relationship</h4>
        <input value={toOrgId} onChange={(e) => setToOrgId(e.target.value)} placeholder="Target organization ID" className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Scope, comma-separated (e.g. evidence:read)" className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Purpose (optional)" className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="text-xs px-3 py-2 rounded-lg bg-white/5 text-[var(--inaya-text-muted)]">Cancel</button>
          <button type="submit" disabled={submitting} className="text-xs font-bold px-3 py-2 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {submitting ? "Proposing…" : "Propose"}
          </button>
        </div>
      </form>
    </div>
  );
}
