"use client";

// src/components/business/S3CompatView.js
//
// Multi-Cloud Enterprise Storage Compatibility SOW — create/revoke
// S3/Azure-compatible credentials for this org, entirely inside Business
// Workspace. Same self-contained-view pattern as ApiKeysView.js. The raw
// secretAccessKey is shown exactly once, right after creation, never again.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import ConfirmButton from "./ConfirmButton";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function S3CompatView({ orgId }) {
  const [creds, setCreds] = useState(null);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/s3-compat/credentials?orgId=${orgId}`);
      setCreds(data.credentials);
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
      const result = await api("/api/orgs/s3-compat/credentials", { method: "POST", body: JSON.stringify({ orgId, label: label.trim() || undefined }) });
      setJustCreated(result);
      setLabel("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(accessKeyId) {
    try {
      await api(`/api/orgs/s3-compat/credentials/${accessKeyId}`, { method: "DELETE", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const endpointUrl = typeof window !== "undefined" ? `${window.location.origin}/api/s3` : "/api/s3";

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">S3-Compatible Storage</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5 max-w-xl">
          Consume this org&apos;s Business Workspace storage from any AWS S3-compatible tool — the AWS CLI, an SDK,
          rclone — without ever leaving Business Workspace or connecting a wallet. Objects written this way are
          still encrypted, sharded, and redundantly pinned exactly like every other Inaya document, using a
          server-managed encryption key scoped to this org (not the zero-knowledge, browser-only key model the
          rest of Business Workspace uses — see the SOW report for why that distinction is necessary for
          protocol compatibility, and how the key is protected).
        </p>
      </div>

      <div className="bg-black/20 border border-white/5 rounded-lg p-3">
        <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-1">Endpoint</p>
        <code className="text-[12px] text-[var(--inaya-text-primary)] break-all">{endpointUrl}</code>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {justCreated && (
        <div className="rounded-2xl p-4 border bg-emerald-400/10 border-emerald-400/30 space-y-2">
          <p className="text-emerald-400 text-xs font-bold uppercase">Save these now — the secret won&apos;t be shown again</p>
          <div>
            <p className="text-[var(--inaya-text-muted)] text-[11px]">Access Key ID</p>
            <code className="block bg-black/40 rounded-lg p-2.5 text-[12px] text-[var(--inaya-text-primary)] break-all">{justCreated.accessKeyId}</code>
          </div>
          <div>
            <p className="text-[var(--inaya-text-muted)] text-[11px]">Secret Access Key</p>
            <code className="block bg-black/40 rounded-lg p-2.5 text-[12px] text-[var(--inaya-text-primary)] break-all">{justCreated.secretAccessKey}</code>
          </div>
          <button onClick={() => setJustCreated(null)} className="text-[11px] text-[var(--inaya-text-muted)] underline">Dismiss</button>
        </div>
      )}

      <form onSubmit={create} className="flex gap-2 flex-wrap">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" className="flex-1 min-w-[200px] bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <button type="submit" disabled={creating} className="text-xs font-bold px-3.5 py-2 rounded-xl bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
          {creating ? "Creating…" : "+ New S3 credential"}
        </button>
      </form>

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!creds ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : creds.length === 0 ? (
          <EmptyState compact icon="☁️" description="No S3-compatible credentials yet." />
        ) : (
          <div className="space-y-2">
            {creds.map((c) => (
              <div key={c.accessKeyId} className="bg-black/20 border border-white/5 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-[var(--inaya-text-primary)] text-sm">{c.label || c.accessKeyId}</p>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">
                    {c.accessKeyId} · {new Date(c.createdAt).toLocaleDateString()} {c.revokedAt && `· revoked`}
                  </p>
                </div>
                {!c.revokedAt && (
                  <ConfirmButton onConfirm={() => revoke(c.accessKeyId)} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 text-[var(--inaya-text-muted)] shrink-0">
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
