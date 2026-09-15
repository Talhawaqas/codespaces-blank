"use client";

// src/components/S3CompatSection.js
//
// Multi-Cloud Enterprise Storage Compatibility SOW — wallet-side S3
// credential management, same self-contained-tab pattern as
// HackathonSection.js. A wallet-only user never has to join an org or
// touch Business Workspace to get an S3-compatible credential for their
// personal vault. Signed with the wallet (no gas, just a signature), same
// convention as every other metadata/* mutation and HackathonSection.js's
// own bug-report signing.

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import EmptyState from "./EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function buildMetadataMessage({ action, resourceId, timestamp }) {
  return ["Inaya Metadata Action", `action: ${action}`, `resourceId: ${resourceId}`, `timestamp: ${timestamp}`].join("\n");
}

export default function S3CompatSection({ walletAddress, getActiveProvider }) {
  const [creds, setCreds] = useState(null);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null);

  const load = useCallback(async () => {
    if (!walletAddress) { setCreds([]); return; }
    try {
      const data = await api(`/api/wallet/s3-compat/credentials?walletAddress=${walletAddress}`);
      setCreds(data.credentials);
    } catch (err) {
      setError(err.message);
    }
  }, [walletAddress]);

  useEffect(() => { load(); }, [load]);

  async function signAction(action, resourceId) {
    const injected = (getActiveProvider && getActiveProvider()) || (typeof window !== "undefined" ? window.ethereum : undefined);
    if (!injected) throw new Error("No wallet provider found.");
    const provider = new ethers.BrowserProvider(injected);
    const signer = await provider.getSigner();
    const timestamp = Date.now();
    const message = buildMetadataMessage({ action, resourceId, timestamp });
    const signature = await signer.signMessage(message);
    return { message, signature, timestamp };
  }

  async function create(e) {
    e.preventDefault();
    if (!walletAddress) return;
    setCreating(true);
    setError("");
    try {
      const { message, signature, timestamp } = await signAction("s3_credential_issue", walletAddress);
      const result = await api("/api/wallet/s3-compat/credentials", {
        method: "POST",
        body: JSON.stringify({ walletAddress, message, signature, timestamp, label: label.trim() || undefined }),
      });
      setJustCreated(result);
      setLabel("");
      load();
    } catch (err) {
      setError(err.shortMessage || err.message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(accessKeyId) {
    try {
      const { message, signature, timestamp } = await signAction("s3_credential_revoke", accessKeyId);
      await api(`/api/wallet/s3-compat/credentials/${accessKeyId}`, { method: "DELETE", body: JSON.stringify({ walletAddress, message, signature, timestamp }) });
      load();
    } catch (err) {
      setError(err.shortMessage || err.message);
    }
  }

  const endpointUrl = typeof window !== "undefined" ? `${window.location.origin}/api/s3` : "/api/s3";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-extrabold text-white">☁️ S3-Compatible Storage</h2>
        <p className="text-[#94a3b8] text-sm mt-1">
          Use your personal vault from any AWS S3-compatible tool — the AWS CLI, an SDK, rclone — no Business
          Workspace or org required. Objects are still real, encrypted, sharded, and redundantly pinned; the
          encryption key for this specific access path is server-managed rather than the passkey-only model the
          rest of your vault uses, since S3 tools don&apos;t speak Inaya&apos;s client-side encryption protocol.
        </p>
      </div>

      <div className="bg-black/20 border border-white/5 rounded-2xl p-4">
        <p className="text-[#8a96ab] text-[11px] font-bold uppercase mb-1">Endpoint</p>
        <code className="text-[12px] text-white break-all">{endpointUrl}</code>
      </div>

      {!walletAddress && <EmptyState compact icon="🔌" description="Connect your wallet to manage S3-compatible credentials." />}

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {justCreated && (
        <div className="rounded-2xl p-4 border bg-emerald-400/10 border-emerald-400/30 space-y-2">
          <p className="text-emerald-400 text-xs font-bold uppercase">Save these now — the secret won&apos;t be shown again</p>
          <div>
            <p className="text-[#8a96ab] text-[11px]">Access Key ID</p>
            <code className="block bg-black/40 rounded-lg p-2.5 text-[12px] text-white break-all">{justCreated.accessKeyId}</code>
          </div>
          <div>
            <p className="text-[#8a96ab] text-[11px]">Secret Access Key</p>
            <code className="block bg-black/40 rounded-lg p-2.5 text-[12px] text-white break-all">{justCreated.secretAccessKey}</code>
          </div>
          <button onClick={() => setJustCreated(null)} className="text-[11px] text-[#8a96ab] underline">Dismiss</button>
        </div>
      )}

      {walletAddress && (
        <form onSubmit={create} className="flex gap-2 flex-wrap">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="flex-1 min-w-[200px] bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/40"
          />
          <button
            type="submit"
            disabled={creating}
            className="px-5 py-2 rounded-full text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] transition-transform active:scale-95 disabled:opacity-50"
          >
            {creating ? "Signing & Creating…" : "+ New S3 credential"}
          </button>
        </form>
      )}

      {walletAddress && (
        <div className="bg-black/20 border border-white/5 rounded-2xl overflow-hidden">
          {!creds ? (
            <p className="text-[#8a96ab] font-mono text-xs p-4">Loading…</p>
          ) : creds.length === 0 ? (
            <EmptyState compact icon="☁️" description="No S3-compatible credentials yet." />
          ) : (
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-white/5 text-[#8a96ab]">
                  <th className="text-left px-4 py-2 font-semibold">Label</th>
                  <th className="text-left px-4 py-2 font-semibold">Access Key ID</th>
                  <th className="text-left px-4 py-2 font-semibold">Created</th>
                  <th className="text-right px-4 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.accessKeyId} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2 text-white">{c.label || "—"}</td>
                    <td className="px-4 py-2 text-[#94a3b8]">{c.accessKeyId}</td>
                    <td className="px-4 py-2 text-[#94a3b8]">{new Date(c.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-2 text-right">
                      {c.revokedAt ? (
                        <span className="text-[#8a96ab]">Revoked</span>
                      ) : (
                        <button onClick={() => revoke(c.accessKeyId)} className="text-[11px] font-bold uppercase px-2.5 py-1 rounded-md bg-white/5 text-[#8a96ab] hover:text-white">
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
