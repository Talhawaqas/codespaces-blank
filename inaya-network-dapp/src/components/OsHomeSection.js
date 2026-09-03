"use client";

// src/components/OsHomeSection.js
//
// Enterprise OS SOW, Phase 7 — the dApp's OS Home, the wallet-scoped
// counterpart to Business Workspace's OsHomeView.js. Same composition
// principle: pure composition of Phases 2-6's already-built pieces, no
// new backend aggregate route, plus a Phase 8 "surfaced, not rebuilt"
// section linking into already-complete dApp features (App Store, NFT
// Vault, Developer Platform, Security).

import { useState, useEffect, useCallback } from "react";
import TrustHealthCard from "./TrustHealthCard";

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function LinkTile({ label, description, href }) {
  return (
    <a href={href} className="block bg-black/20 border border-white/10 rounded-xl p-3.5 hover:bg-white/5 transition-colors">
      <p className="text-[13px] font-bold text-white">{label}</p>
      <p className="text-[11px] text-[#94a3b8] mt-0.5">{description}</p>
    </a>
  );
}

function OsAssistantWidget({ walletAddress }) {
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    if (!question.trim() || asking) return;
    setAsking(true);
    setError("");
    setReply("");
    try {
      const data = await api("/api/ai/os-chat-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress, messages: [{ role: "user", content: question }] }),
      });
      setReply(data.reply);
    } catch (err) {
      setError(err.message);
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="bg-black/20 border border-white/10 rounded-2xl p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-[#94a3b8] mb-2">Ask the OS Assistant</p>
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="How Inaya works, or your own security status..."
          className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-[#00f2fe]/40"
        />
        <button onClick={ask} disabled={asking || !question.trim()} className="px-4 py-2 rounded-lg bg-[#00f2fe]/15 text-[#00f2fe] text-[12px] font-bold disabled:opacity-40">
          {asking ? "…" : "Ask"}
        </button>
      </div>
      {error && <p className="text-[12px] text-red-400 mt-2">{error}</p>}
      {reply && <p className="text-[13px] text-white mt-3 leading-relaxed whitespace-pre-wrap">{reply}</p>}
    </div>
  );
}

export default function OsHomeSection({ walletAddress, onNavigate }) {
  const [trust, setTrust] = useState(null);
  const [trustError, setTrustError] = useState("");
  const [whatChanged, setWhatChanged] = useState(null);

  const load = useCallback(async () => {
    const [trustRes, changedRes] = await Promise.allSettled([
      api(`/api/wallet/trust-health?address=${walletAddress}`),
      api(`/api/wallet/activity-center?address=${walletAddress}&period=weekly`),
    ]);
    if (trustRes.status === "fulfilled") setTrust(trustRes.value);
    else setTrustError(trustRes.reason.message);
    if (changedRes.status === "fulfilled") setWhatChanged(changedRes.value);
  }, [walletAddress]);

  useEffect(() => {
    load();
  }, [load]);

  const topBullets = (whatChanged?.sections || []).flatMap((s) => s.bullets).slice(0, 4);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">OS Home</h2>
        <p className="text-[#94a3b8] text-sm">Your wallet's trust status, recent activity, and an assistant that spans both — in one place.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrustHealthCard snapshot={trust} loading={!trust && !trustError} error={trustError} />
        <OsAssistantWidget walletAddress={walletAddress} />
      </div>

      <div className="bg-black/20 border border-white/10 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold uppercase tracking-wide text-[#94a3b8]">What Changed? — This Week</p>
          <button onClick={() => onNavigate?.("What Changed?")} className="text-[11px] font-bold text-[#00f2fe]">
            View all →
          </button>
        </div>
        {topBullets.length === 0 ? (
          <p className="text-[12px] text-[#94a3b8]">Nothing to report this week.</p>
        ) : (
          <ul className="space-y-1.5">
            {topBullets.map((b, i) => (
              <li key={i} className="text-[13px] text-white flex items-start gap-2">
                <span className="text-[#00f2fe] mt-0.5">•</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-[#94a3b8] mb-2">Explore the Ecosystem</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LinkTile label="Web3 App Store" description="Curated + community-submitted apps, wallet-signed and threat-checked." href="/apps" />
          <LinkTile label="NFT Vault" description="Discover and back up your NFTs with the same encryption as your files." href="/nfts" />
          <LinkTile label="Security Layer" description="Live threat network status and your own recent events." href="/security" />
          <LinkTile label="Build on Inaya" description="custody-sdk, React SDK, CLI, and scaffolding for developers." href="/build" />
        </div>
      </div>
    </div>
  );
}
