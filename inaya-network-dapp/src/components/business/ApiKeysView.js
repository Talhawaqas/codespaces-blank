"use client";

// src/components/business/ApiKeysView.js
//
// Institutional Trust Infrastructure SOW, Phase 4 — create/revoke API
// keys for the public/v1 developer platform namespace. Same
// self-contained-view pattern as AuditTrailView.js/TrustRelationshipsView.js.
// The raw key is shown exactly once, right after creation, then never
// again -- matches api-keys.js's own guarantee.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import ConfirmButton from "./ConfirmButton";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function ApiKeysView({ orgId }) {
  const [keys, setKeys] = useState(null);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/api-keys?orgId=${orgId}`);
      setKeys(data.apiKeys);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const result = await api("/api/orgs/api-keys", { method: "POST", body: JSON.stringify({ orgId, label: label.trim() || undefined }) });
      setJustCreated(result);
      setLabel("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(apiKeyId) {
    try {
      await api(`/api/orgs/api-keys/${apiKeyId}?orgId=${orgId}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">API Keys</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5 max-w-xl">
          Keys for the Institutional Developer Platform (api/public/v1) — audit verification, evidence
          trails, and permission checks. A key is shown only once, right after creation.
        </p>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {justCreated && (
        <div className="rounded-2xl p-4 border bg-emerald-400/10 border-emerald-400/30 space-y-2">
          <p className="text-emerald-400 text-xs font-bold uppercase">Save this key now — it won&apos;t be shown again</p>
          <code className="block bg-black/40 rounded-lg p-2.5 text-[12px] text-[var(--inaya-text-primary)] break-all">{justCreated.rawKey}</code>
          <button onClick={() => setJustCreated(null)} className="text-[11px] text-[var(--inaya-text-muted)] underline">Dismiss</button>
        </div>
      )}

      <form onSubmit={create} className="flex gap-2 flex-wrap">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" className="flex-1 min-w-[200px] bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <button type="submit" disabled={creating} className="text-xs font-bold px-3.5 py-2 rounded-xl bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
          {creating ? "Creating…" : "+ New API key"}
        </button>
      </form>

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!keys ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : keys.length === 0 ? (
          <EmptyState compact icon="🔑" description="No API keys yet." />
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div key={k.apiKeyId} className="bg-black/20 border border-white/5 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-[var(--inaya-text-primary)] text-sm">{k.label}</p>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">
                    {k.createdByEmail} · {new Date(k.createdAt).toLocaleDateString()} {k.revokedAt && `· revoked`}
                  </p>
                </div>
                {!k.revokedAt && (
                  <ConfirmButton onConfirm={() => revoke(k.apiKeyId)} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 text-[var(--inaya-text-muted)] shrink-0">
                    Revoke
                  </ConfirmButton>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
