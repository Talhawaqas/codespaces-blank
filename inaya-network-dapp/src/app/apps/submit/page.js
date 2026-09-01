"use client";

// app/apps/submit/page.js
//
// Submit a community app to the App Store — Option A (IPFS-pinned static
// site, developer already has a CID) or Option B (externally-hosted,
// shown via a strictly sandboxed iframe). Wallet-signed submission (same
// message-signing shape as nftBackupAuth.js's signNftBackup, just a
// different action name — see metadata-auth.js's verifyMetadataAuth on
// the server side for what actually enforces this). Every submission
// lands as "pending" — nothing here makes anything publicly visible;
// see appStoreListings.js's header for the full review/security model.

import { useState } from "react";
import { ethers } from "ethers";

const CATEGORIES = ["Storage", "DeFi", "Social", "Gaming", "Tools", "Other"];

function getBrowserProvider() {
  if (typeof window === "undefined" || !window.ethereum) return null;
  return new ethers.BrowserProvider(window.ethereum);
}

async function signSubmission({ signer, hostType, cid, embedUrl, name }) {
  const resourceId = `${hostType}:${hostType === "ipfs" ? cid : embedUrl}`;
  const timestamp = Date.now();
  const lines = ["Inaya Metadata Action", "action: submitAppListing", `resourceId: ${resourceId}`, `name: ${name}`, `timestamp: ${timestamp}`];
  const message = lines.join("\n");
  const address = await signer.getAddress();
  const signature = await signer.signMessage(message);
  return { address, message, signature, timestamp };
}

export default function SubmitAppPage() {
  const [account, setAccount] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Tools");
  const [hostType, setHostType] = useState("ipfs");
  const [cid, setCid] = useState("");
  const [embedUrl, setEmbedUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function connect() {
    const provider = getBrowserProvider();
    if (!provider) {
      setError("No injected wallet found (MetaMask etc.)");
      return;
    }
    const accounts = await provider.send("eth_requestAccounts", []);
    setAccount(accounts[0]);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setResult(null);
    setSubmitting(true);
    try {
      const provider = getBrowserProvider();
      const signer = await provider.getSigner();
      const { address, message, signature, timestamp } = await signSubmission({ signer, hostType, cid, embedUrl, name });

      const res = await fetch("/api/apps/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, category, hostType, cid: hostType === "ipfs" ? cid : undefined, embedUrl: hostType === "iframe" ? embedUrl : undefined, address, message, signature, timestamp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submission failed.");
      setResult(data);
      setName(""); setDescription(""); setCid(""); setEmbedUrl("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-12 md:px-10">
      <div className="max-w-2xl mx-auto">
        <a href="/apps" className="text-[#8a96ab] text-sm hover:text-[#00f2fe] transition-colors">← App Store</a>

        <div className="mt-6 mb-8">
          <span className="text-[11px] font-bold tracking-wider text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 rounded-full px-2 py-0.5">SUBMIT AN APP</span>
          <h1 className="text-3xl font-black text-white tracking-tight mt-3 mb-2">List Your App</h1>
          <p className="text-[#94a3b8] text-sm leading-relaxed">
            Every submission is reviewed by an Inaya admin before it appears publicly, and checked
            against the live Security Layer threat registry both now and again at review time. Nothing
            here goes live automatically — security is the priority, not speed.
          </p>
        </div>

        {!account ? (
          <button onClick={connect} className="bg-[#00f2fe] text-[#060913] font-bold text-sm px-5 py-2.5 rounded-lg hover:bg-[#5df9ff] transition-colors">
            Connect Wallet to Submit
          </button>
        ) : (
          <form onSubmit={handleSubmit} className="bg-[#0a0f1e] border border-white/10 rounded-xl p-6 space-y-4">
            <p className="text-[#5b6472] text-xs font-mono">Submitting as: {account}</p>

            <label className="block">
              <span className="text-[#94a3b8] text-xs font-bold uppercase tracking-wide">App Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required className="mt-1.5 w-full bg-[#060913] border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00f2fe]/50" />
            </label>

            <label className="block">
              <span className="text-[#94a3b8] text-xs font-bold uppercase tracking-wide">Description</span>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={400} required rows={3} className="mt-1.5 w-full bg-[#060913] border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00f2fe]/50" />
            </label>

            <label className="block">
              <span className="text-[#94a3b8] text-xs font-bold uppercase tracking-wide">Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1.5 w-full bg-[#060913] border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00f2fe]/50">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            <div>
              <span className="text-[#94a3b8] text-xs font-bold uppercase tracking-wide">Hosting</span>
              <div className="mt-1.5 flex gap-2">
                <button type="button" onClick={() => setHostType("ipfs")} className={`flex-1 text-xs font-bold px-3 py-2 rounded-lg border transition-colors ${hostType === "ipfs" ? "bg-[#00f2fe]/10 border-[#00f2fe]/40 text-[#00f2fe]" : "border-white/10 text-[#8a96ab]"}`}>
                  IPFS CID (opens via gateway, new tab)
                </button>
                <button type="button" onClick={() => setHostType("iframe")} className={`flex-1 text-xs font-bold px-3 py-2 rounded-lg border transition-colors ${hostType === "iframe" ? "bg-[#00f2fe]/10 border-[#00f2fe]/40 text-[#00f2fe]" : "border-white/10 text-[#8a96ab]"}`}>
                  External URL (sandboxed iframe)
                </button>
              </div>
            </div>

            {hostType === "ipfs" ? (
              <label className="block">
                <span className="text-[#94a3b8] text-xs font-bold uppercase tracking-wide">IPFS CID (already pinned by you)</span>
                <input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="Qm... or bafy..." required className="mt-1.5 w-full bg-[#060913] border border-white/10 rounded px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/50" />
              </label>
            ) : (
              <label className="block">
                <span className="text-[#94a3b8] text-xs font-bold uppercase tracking-wide">App URL (https:// only)</span>
                <input value={embedUrl} onChange={(e) => setEmbedUrl(e.target.value)} placeholder="https://your-app.example.com" required className="mt-1.5 w-full bg-[#060913] border border-white/10 rounded px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/50" />
              </label>
            )}

            {error && <p className="text-red-400 text-sm">{error}</p>}
            {result && <p className="text-emerald-400 text-sm">✓ Submitted for review — you&apos;ll see it in the App Store once an admin approves it.</p>}

            <button type="submit" disabled={submitting} className="w-full bg-[#00f2fe] text-[#060913] font-bold text-sm px-4 py-2.5 rounded-lg hover:bg-[#5df9ff] transition-colors disabled:opacity-40">
              {submitting ? "Submitting…" : "Sign & Submit for Review"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
