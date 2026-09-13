"use client";

// src/components/business/SignView.js
//
// Inaya Sign — Four High-Impact Business Workspace Extensions SOW,
// Feature 1. Lists signing requests, lets an authorized member create one
// against any of their visible documents, and lets an invited signer sign
// (wallet signature or session-authenticated consent — see
// signing-workflow.js's header comment for why WebAuthn isn't offered:
// no such infrastructure exists in this codebase yet).

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLE = {
  DRAFT: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  SENT: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  PARTIALLY_SIGNED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  FULLY_SIGNED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  EXPIRED: "bg-red-400/10 text-red-400 border-red-400/30",
  REVOKED: "bg-red-400/10 text-red-400 border-red-400/30",
  SUPERSEDED: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};

function buildInayaSignMessage({ requestId, documentHash, timestamp }) {
  return ["Inaya Sign Action", "action: sign", `requestId: ${requestId}`, `documentHash: ${documentHash}`, `timestamp: ${timestamp}`].join("\n");
}

export default function SignView({ orgId, email }) {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      setRequests((await api(`/api/orgs/sign/requests?orgId=${orgId}`)).requests);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[var(--inaya-text-muted)] text-xs max-w-md">Cryptographically sign documents — wallet signature or session-authenticated consent, bound to the exact document version.</p>
        <button onClick={() => setShowCreate(true)} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg shrink-0">+ New signing request</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-5">
        {!requests ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : requests.length === 0 ? (
          <EmptyState compact icon="✍️" description="No signing requests yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <button key={r.id} onClick={() => setSelected(r.id)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{r.signers.length} signer{r.signers.length === 1 ? "" : "s"} · v{r.documentVersion}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{new Date(r.createdAt).toLocaleDateString()}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLE[r.status] || STATUS_STYLE.DRAFT}`}>{r.status.replace(/_/g, " ")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateSigningRequestModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <SigningRequestModal orgId={orgId} email={email} requestId={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function CreateSigningRequestModal({ orgId, onClose, onCreated }) {
  const [documentId, setDocumentId] = useState("");
  const [signers, setSigners] = useState([{ email: "", wallet: "", role: "required" }]);
  const [deadline, setDeadline] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function updateSigner(i, field, value) {
    setSigners((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!documentId.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const validSigners = signers.filter((s) => s.email.trim() || s.wallet.trim()).map((s) => ({
        email: s.email.trim() || undefined, wallet: s.wallet.trim() || undefined, role: s.role,
      }));
      await api("/api/orgs/sign/requests", {
        method: "POST",
        body: JSON.stringify({ orgId, documentId: documentId.trim(), signers: validSigners, deadline: deadline || undefined, message: message.trim() || undefined }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New signing request" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input value={documentId} onChange={(e) => setDocumentId(e.target.value)} required placeholder="Document ID" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Signers</p>
          {signers.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_90px] gap-1.5">
              <input value={s.email} onChange={(e) => updateSigner(i, "email", e.target.value)} placeholder="Email (org member)" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <input value={s.wallet} onChange={(e) => updateSigner(i, "wallet", e.target.value)} placeholder="Wallet (0x…)" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)] font-mono" />
              <select value={s.role} onChange={(e) => updateSigner(i, "role", e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]">
                <option value="required">Required</option>
                <option value="optional">Optional</option>
              </select>
            </div>
          ))}
          <button type="button" onClick={() => setSigners((prev) => [...prev, { email: "", wallet: "", role: "required" }])} className="text-[11px] font-bold text-[#00f2fe]">+ Add signer</button>
        </div>
        <input value={deadline} onChange={(e) => setDeadline(e.target.value)} type="date" placeholder="Deadline (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message (optional)" rows={2} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !documentId.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create request"}</button>
      </form>
    </Modal>
  );
}

function SigningRequestModal({ orgId, email, requestId, onClose, onChanged }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  const [verification, setVerification] = useState(null);
  const [typedName, setTypedName] = useState("");

  const load = useCallback(async () => {
    try {
      setR(await api(`/api/orgs/sign/requests/${requestId}?orgId=${orgId}`));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, requestId]);

  useEffect(() => { load(); }, [load]);

  const mySigner = r?.signers.find((s) => s.email === email);

  async function handleSend() {
    setActing("send"); setError("");
    try {
      await api(`/api/orgs/sign/requests/${requestId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action: "send" }) });
      await load(); onChanged();
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  async function handleRevoke() {
    setActing("revoke"); setError("");
    try {
      await api(`/api/orgs/sign/requests/${requestId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action: "revoke" }) });
      await load(); onChanged();
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  async function handleSignWithWallet() {
    setActing("sign-wallet"); setError("");
    try {
      if (typeof window === "undefined" || !window.ethereum) throw new Error("No wallet extension found.");
      const provider = new ethers.BrowserProvider(window.ethereum);
      const [address] = await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const timestamp = Date.now();
      const message = buildInayaSignMessage({ requestId, documentHash: r.documentHash, timestamp });
      const signature = await signer.signMessage(message);
      await api(`/api/orgs/sign/requests/${requestId}/sign`, {
        method: "POST",
        body: JSON.stringify({ orgId, signerIdentity: { wallet: address }, method: "wallet", proof: { walletAddress: address, message, signature, timestamp } }),
      });
      await load(); onChanged();
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  async function handleSignWithConsent() {
    if (!typedName.trim()) { setError("Type your full name to consent."); return; }
    setActing("sign-consent"); setError("");
    try {
      await api(`/api/orgs/sign/requests/${requestId}/sign`, {
        method: "POST",
        body: JSON.stringify({ orgId, signerIdentity: { email }, method: "session_consent", proof: { typedName: typedName.trim(), consent: true } }),
      });
      await load(); onChanged();
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  async function handleVerify() {
    setActing("verify"); setError("");
    try {
      setVerification(await api(`/api/orgs/sign/requests/${requestId}/verify?orgId=${orgId}`));
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  if (!r) return <Modal title="Signing request" onClose={onClose}>{error ? <p className="text-red-400 text-xs">{error}</p> : <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>}</Modal>;

  return (
    <Modal title="Signing request" onClose={onClose}>
      <div className="space-y-4">
        <span className={`inline-block text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLE[r.status] || STATUS_STYLE.DRAFT}`}>{r.status.replace(/_/g, " ")}</span>
        <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">Document v{r.documentVersion} · {r.documentHash.slice(0, 18)}…</p>

        <div className="space-y-1.5">
          {r.signers.map((s, i) => (
            <div key={i} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg p-2.5 text-xs">
              <span className="text-[var(--inaya-text-primary)]">{s.email || s.wallet} <span className="text-[var(--inaya-text-muted)]">({s.role})</span></span>
              <span className={s.status === "SIGNED" ? "text-emerald-400" : "text-[var(--inaya-text-muted)]"}>{s.status}{s.method ? ` · ${s.method === "wallet" ? "wallet" : "consent"}` : ""}</span>
            </div>
          ))}
        </div>

        {mySigner && mySigner.status === "PENDING" && ["SENT", "PARTIALLY_SIGNED"].includes(r.status) && (
          <div className="space-y-2 border-t border-white/5 pt-3">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Sign this document</p>
            <button onClick={handleSignWithWallet} disabled={!!acting} className="w-full py-2 rounded-lg text-xs font-bold uppercase bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{acting === "sign-wallet" ? "…" : "Sign with wallet"}</button>
            <div className="flex gap-1.5">
              <input value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder="Type your full name" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
              <button onClick={handleSignWithConsent} disabled={!!acting} className="text-[11px] font-bold uppercase px-3 py-2 rounded-lg bg-emerald-400/10 text-emerald-400 border border-emerald-400/30 disabled:opacity-40">{acting === "sign-consent" ? "…" : "Consent & sign"}</button>
            </div>
            <p className="text-[var(--inaya-text-muted)] text-[10px]">Session consent is recorded as your typed consent, not a cryptographic signature.</p>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 border-t border-white/5 pt-3">
          {r.status === "DRAFT" && <button onClick={handleSend} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{acting === "send" ? "…" : "Send"}</button>}
          {["DRAFT", "SENT", "PARTIALLY_SIGNED"].includes(r.status) && <button onClick={handleRevoke} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-red-400/10 text-red-400 border border-red-400/30 disabled:opacity-40">{acting === "revoke" ? "…" : "Revoke"}</button>}
          <button onClick={handleVerify} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">{acting === "verify" ? "…" : "Verify"}</button>
        </div>

        {verification && (
          <div className="bg-black/20 border border-white/5 rounded-lg p-3 text-xs space-y-1">
            <p className={verification.result === "VALID" ? "text-emerald-400 font-bold" : "text-red-400 font-bold"}>{verification.result}</p>
            <p className="text-[var(--inaya-text-muted)]">Hash matches: {String(verification.hashMatches)} · Audit chain valid: {String(verification.auditChainValid)}</p>
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
