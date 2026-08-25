"use client";

// app/security/page.js
//
// Public Security Layer transparency page — no wallet, no login. Anyone
// can check a destination or see network-wide stats for the decentralized
// threat-intelligence system (Security Layer SOW). Every number here comes
// from the same public routes the mobile app's Security screen and the
// desktop app's link-checker already use (/api/security/stats,
// /api/security/threat, /api/security/feed) — nothing admin-only is ever
// exposed here (no raw node addresses, no report-level detail — see
// getPublicSecurityStats()'s own comment in src/lib/security.js).
//
// The AI Assistant is the flagship feature on this page (open by default,
// gradient-glow card, suggested questions) rather than a buried collapsible
// — most visitors have no idea a chat-grounded security explainer exists
// until they see it.

import { useState, useEffect, useCallback, useRef } from "react";
import NetworkVisualization from "../../components/security/NetworkVisualization";

const CATEGORY_META = [
  { label: "Unknown", color: "#94a3b8", icon: "❔" },
  { label: "Phishing", color: "#f87171", icon: "🎣" },
  { label: "Malware", color: "#fb923c", icon: "🦠" },
  { label: "Scam", color: "#facc15", icon: "⚠️" },
  { label: "Botnet/C2", color: "#c084fc", icon: "🕸️" },
  { label: "Spam", color: "#60a5fa", icon: "📧" },
  { label: "Other", color: "#94a3b8", icon: "❓" },
];

const SUGGESTED_QUESTIONS = [
  "What is phishing?",
  "How does node reputation work?",
  "How are threats confirmed on-chain?",
  "What should I do if a site is flagged?",
];

function categoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META[0];
}

function formatPct(bps) {
  return bps == null ? "—" : `${(bps / 100).toFixed(1)}%`;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function SecurityTransparencyPage() {
  const [stats, setStats] = useState(null);
  const [feed, setFeed] = useState([]);
  const [loadError, setLoadError] = useState("");

  const [checkInput, setCheckInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);

  const [identityId, setIdentityId] = useState(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);

  const assistantRef = useRef(null);
  const scrollToAssistant = () => assistantRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  useEffect(() => {
    let id = localStorage.getItem("inaya_visitor_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("inaya_visitor_id", id);
    }
    setIdentityId(id);
  }, []);

  const loadData = useCallback(async () => {
    setLoadError("");
    try {
      const [statsRes, feedRes] = await Promise.all([fetch("/api/security/stats"), fetch("/api/security/feed")]);
      if (!statsRes.ok || !feedRes.ok) throw new Error("Could not load Security Layer data.");
      setStats(await statsRes.json());
      setFeed((await feedRes.json()).items.slice(0, 20));
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleCheck(e) {
    e.preventDefault();
    const indicator = checkInput.trim();
    if (!indicator) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch(`/api/security/threat?indicator=${encodeURIComponent(indicator)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Check failed.");
      setCheckResult(data);
    } catch (err) {
      setCheckResult({ error: err.message });
    } finally {
      setChecking(false);
    }
  }

  async function handleSendChat(overrideText) {
    const text = (overrideText ?? chatInput).trim();
    if (!text || !identityId || chatSending) return;
    const nextMessages = [...chatMessages, { role: "user", content: text }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatSending(true);
    try {
      const res = await fetch("/api/ai/security-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityId, messages: nextMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Chat failed.");
      setChatMessages([...nextMessages, { role: "assistant", content: data.reply }]);
    } catch (err) {
      setChatMessages([...nextMessages, { role: "assistant", content: `Sorry, I couldn't answer that: ${err.message}` }]);
    } finally {
      setChatSending(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-12 md:px-10 overflow-hidden">
      {/* Ambient background glow — purely decorative, keeps the page from reading as flat dark cards */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
        <div className="absolute top-1/3 -right-24 w-96 h-96 rounded-full bg-[#c084fc]/10 blur-[120px]" />
        <div className="absolute bottom-0 left-1/4 w-96 h-96 rounded-full bg-[#f87171]/5 blur-[120px]" />
      </div>

      <div className="relative max-w-4xl mx-auto">
        <button
          onClick={scrollToAssistant}
          className="w-full text-left mb-6 rounded-2xl overflow-hidden border border-[#f2a900]/20 hover:border-[#f2a900]/40 transition-colors"
          title="Explore the Inaya Firewall"
        >
          <img
            src="/inaya-firewall-banner.jpg"
            alt="Inaya Firewall — Smarter Protection. Greater Control. The decentralized firewall that protects your data, detects threats, and keeps you one step ahead."
            className="w-full h-auto block"
          />
        </button>

        <div className="relative overflow-hidden bg-[#050810] border border-white/10 rounded-2xl mb-8">
          <NetworkVisualization height={280} />
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 pointer-events-none bg-gradient-to-b from-transparent via-transparent to-[#050810]/70">
            <div className="flex items-center gap-2 bg-black/40 border border-emerald-400/30 rounded-full px-3 py-1 mb-3">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
              </span>
              <span className="text-emerald-300 text-[12px] font-bold tracking-wider">LIVE NETWORK</span>
            </div>
            <h1 className="text-3xl font-extrabold text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]">Inaya Security Layer</h1>
            <p className="text-[#cbd5e1] text-xs sm:text-sm mt-2 drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
              Independent nodes, reputation-weighted, on-chain anchored
            </p>
          </div>
        </div>

        <p className="text-[#94a3b8] text-sm max-w-2xl mb-8">
          Decentralized threat intelligence backed by independent Inaya nodes — a destination is only ever marked
          confirmed once several reputation-weighted, independent reports agree, and every confirmation is anchored
          on-chain so the record can&apos;t quietly change later.{" "}
          <span className="text-[#8a96ab]">Currently running on BNB Chain Testnet.</span>
        </p>

        {loadError && <p className="text-red-400 text-sm mb-6">{loadError}</p>}

        {/* ============================================================
            🛡️ AI SECURITY ASSISTANT — flagship feature, front and center
           ============================================================ */}
        <div ref={assistantRef} className="relative mb-10 scroll-mt-6">
          <div className="absolute -inset-[1px] rounded-2xl bg-gradient-to-r from-[#00f2fe] via-[#4facfe] to-[#c084fc] opacity-60 blur-[2px]" />
          <div className="relative bg-[#0a0f1e] rounded-2xl overflow-hidden">
            <button
              onClick={() => setChatOpen((o) => !o)}
              className="w-full flex items-center justify-between px-6 py-5 text-left"
            >
              <span className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center text-xl shrink-0">
                  🛡️
                </span>
                <span>
                  <span className="flex items-center gap-2">
                    <span className="text-white text-base font-extrabold">Ask the Security Assistant</span>
                    <span className="text-[11px] font-bold tracking-wider text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 rounded-full px-2 py-0.5">
                      AI-POWERED
                    </span>
                  </span>
                  <span className="block text-[#8a96ab] text-xs mt-0.5">Grounded in real network data — never invents evidence</span>
                </span>
              </span>
              <span className="text-[#8a96ab] text-xs shrink-0 ml-2">{chatOpen ? "▲" : "▼"}</span>
            </button>

            {chatOpen && (
              <div className="px-6 pb-6 space-y-4">
                {chatMessages.length === 0 && (
                  <div>
                    <p className="text-[#94a3b8] text-xs mb-3">Not sure what to ask? Try one of these:</p>
                    <div className="flex flex-wrap gap-2">
                      {SUGGESTED_QUESTIONS.map((q) => (
                        <button
                          key={q}
                          onClick={() => handleSendChat(q)}
                          disabled={chatSending}
                          className="text-xs text-[#cbd5e1] bg-white/5 hover:bg-white/10 hover:text-white border border-white/10 hover:border-[#00f2fe]/40 rounded-full px-3 py-1.5 transition-colors disabled:opacity-50"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {chatMessages.length > 0 && (
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {chatMessages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                            m.role === "user" ? "bg-[#00f2fe]/10 text-[#e2e8f0]" : "bg-white/5 text-[#94a3b8]"
                          }`}
                        >
                          {m.content}
                        </div>
                      </div>
                    ))}
                    {chatSending && <p className="text-[#8a96ab] text-xs">Thinking…</p>}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !chatSending) handleSendChat(); }}
                    placeholder="Ask about a threat, a category, or how confirmation works…"
                    disabled={chatSending}
                    className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-xs text-white placeholder:text-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/40 disabled:opacity-50"
                  />
                  <button
                    onClick={() => handleSendChat()}
                    disabled={chatSending || !chatInput.trim()}
                    className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-xs rounded-lg px-4 py-2.5 disabled:opacity-50 whitespace-nowrap"
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
          <div className="group bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#f87171]/60 rounded-xl p-5 hover:-translate-y-0.5 hover:border-white/20 transition-all">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xl">🎯</span>
              <span className="text-[#8a96ab] text-[12px] uppercase tracking-wider">Confirmed</span>
            </div>
            <div className="text-3xl font-extrabold text-[#f87171]">{stats ? stats.confirmedThreatsCount : "—"}</div>
            <div className="text-[#8a96ab] text-xs mt-1">Confirmed Threats</div>
          </div>
          <div className="group bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#00f2fe]/60 rounded-xl p-5 hover:-translate-y-0.5 hover:border-white/20 transition-all">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xl">🌐</span>
              <span className="text-[#8a96ab] text-[12px] uppercase tracking-wider">Active</span>
            </div>
            <div className="text-3xl font-extrabold text-white">{stats ? stats.reportingNodesCount : "—"}</div>
            <div className="text-[#8a96ab] text-xs mt-1">Reporting Nodes</div>
          </div>
          <div className="group bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#c084fc]/60 rounded-xl p-5 hover:-translate-y-0.5 hover:border-white/20 transition-all">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xl">⭐</span>
              <span className="text-[#8a96ab] text-[12px] uppercase tracking-wider">Trust</span>
            </div>
            <div className="text-3xl font-extrabold text-white">{stats ? formatPct(stats.avgReputationBps) : "—"}</div>
            <div className="text-[#8a96ab] text-xs mt-1">Avg Node Reputation</div>
          </div>
        </div>

        <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6 mb-10">
          <h2 className="text-white font-bold text-sm mb-1 flex items-center gap-2"><span>🔍</span> Check a destination</h2>
          <p className="text-[#8a96ab] text-xs mb-4">See whether a domain or IP has been reported and confirmed by the network.</p>
          <form onSubmit={handleCheck} className="flex flex-col sm:flex-row gap-3">
            <input
              value={checkInput}
              onChange={(e) => setCheckInput(e.target.value)}
              placeholder="e.g. example.com or an IP address"
              autoCapitalize="off"
              autoCorrect="off"
              className="flex-1 bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none"
            />
            <button
              type="submit"
              disabled={checking || !checkInput.trim()}
              className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-6 py-2.5 disabled:opacity-50 whitespace-nowrap"
            >
              {checking ? "Checking…" : "Check"}
            </button>
          </form>

          {checkResult && (
            <div className="mt-4 pt-4 border-t border-white/5">
              {checkResult.error ? (
                <p className="text-red-400 text-sm">{checkResult.error}</p>
              ) : !checkResult.known ? (
                <p className="text-[#94a3b8] text-sm">No recorded observations for this destination — that means nothing has been reported, not that it&apos;s confirmed safe.</p>
              ) : (
                <div>
                  <p className={`font-bold text-lg ${checkResult.statusLabel === "confirmed" ? "text-[#f87171]" : "text-[#94a3b8]"}`}>
                    {checkResult.statusLabel.toUpperCase()}
                  </p>
                  <p className="text-[#8a96ab] text-xs mt-1">
                    {categoryMeta(checkResult.category).icon} {categoryMeta(checkResult.category).label} · {formatPct(checkResult.confidenceBps)} confidence ·{" "}
                    {(checkResult.contributingNodes || []).length} independent reporter(s)
                  </p>
                  {checkResult.onChainTxHash && (
                    <a
                      href={`https://testnet.bscscan.com/tx/${checkResult.onChainTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#00f2fe] hover:underline text-xs mt-2 inline-block"
                    >
                      View on-chain confirmation ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <h2 className="text-white font-bold text-sm mb-3 flex items-center gap-2"><span>📡</span> Recently confirmed threats</h2>
          <div className="space-y-2">
            {feed.map((t) => {
              const meta = categoryMeta(t.category);
              return (
                <div
                  key={t._id}
                  style={{ borderLeftColor: meta.color }}
                  className="bg-[#090d16]/80 border border-white/5 border-l-2 rounded-xl p-4 flex items-center justify-between flex-wrap gap-2 hover:bg-[#0d1220] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{meta.icon}</span>
                    <div>
                      <p className="text-white text-sm font-semibold">{t.indicator}</p>
                      <p className="text-[#8a96ab] text-[13px] font-mono mt-0.5">
                        <span style={{ color: meta.color }}>{meta.label}</span> · {(t.contributingNodes || []).length} independent reporter(s)
                      </p>
                    </div>
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-[#f87171] font-bold">{formatPct(t.confidenceBps)}</p>
                    <p className="text-[#8a96ab] font-mono text-[12px]">{formatDate(t.lastUpdated)}</p>
                  </div>
                </div>
              );
            })}
            {feed.length === 0 && <p className="text-[#8a96ab] text-sm">No confirmed threats yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
