"use client";

// src/components/business/AIWidget.js
//
// Floating AI assistant bubble, mirroring the main dApp's docs-assistant
// widget (the "AI DOCS ASSISTANT" section in app/page.js) so Business
// Workspace has the same proactive "opens itself and offers help"
// behavior -- layered on top of whatever view the user is already on,
// rather than navigating them away to the dedicated AI Assistant tab
// (AIAssistantView, still there unchanged for anyone who wants the full
// page). Same backend (/api/ai/business-chat, session-cookie authenticated)
// as that view; a separate, shorter-lived chat history is an acceptable
// tradeoff for not hijacking the user's current view to auto-open it.

import { useState, useEffect, useRef } from "react";

const SUGGESTIONS = [
  "What's overdue for my approval?",
  "Summarize this week's activity",
  "Which documents need review?",
];

export default function AIWidget({ orgId }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: "assistant", content: "👋 Hi — I can help with your company's departments, projects, documents, and approvals. What do you need?" },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Proactively open once per browser session, a few seconds after the
  // workspace loads -- same reasoning as the dApp widget's identical
  // effect: offer help again on a fresh visit, don't re-interrupt every
  // SPA view change within the same session.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("inaya_business_ai_auto_opened")) return;
    const timer = setTimeout(() => {
      setIsOpen(true);
      sessionStorage.setItem("inaya_business_ai_auto_opened", "1");
    }, 4000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus();
  }, [isOpen]);

  async function send(text) {
    const trimmed = (text ?? input).trim();
    if (!trimmed || sending) return;
    const next = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/ai/business-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, messages: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-5 right-5 z-[9998] w-14 h-14 rounded-full bg-gradient-to-r from-violet-400 to-[#00f2fe] text-[#060913] shadow-[0_0_25px_rgba(167,139,250,0.35)] flex items-center justify-center text-2xl active:scale-95 transition-transform hover:brightness-110"
        title="Ask the Business AI Assistant"
      >
        🤖
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[9998] w-full h-full sm:inset-auto sm:bottom-24 sm:right-5 sm:w-[92vw] sm:max-w-sm sm:h-[70vh] sm:max-h-[560px] bg-[#090e1a]/95 sm:border sm:border-violet-400/25 sm:rounded-2xl shadow-2xl backdrop-blur-xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-white/10 bg-[#0b1426]/80 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg shrink-0 bg-violet-400/15 border border-violet-400/30 flex items-center justify-center text-sm">🤖</div>
          <div className="min-w-0">
            <div className="text-white text-xs font-bold font-mono truncate">Business AI Assistant</div>
            <div className="text-[11px] text-[#8a96ab] font-mono">Grounded in your org's real data</div>
          </div>
        </div>
        <button onClick={() => setIsOpen(false)} className="text-[#8a96ab] hover:text-white font-mono text-sm shrink-0 px-1">✕</button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 pb-6 space-y-3 overscroll-contain">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words ${
                m.role === "user" ? "bg-gradient-to-r from-violet-400 to-[#00f2fe] text-[#060913] font-semibold" : "bg-white/[0.04] border border-white/10 text-slate-200"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-white/[0.04] border border-white/10 text-[#8a96ab] rounded-2xl px-3.5 py-2.5 text-xs font-mono flex items-center gap-1.5">
              <span className="animate-pulse">●</span> Thinking…
            </div>
          </div>
        )}
        {messages.length <= 1 && !sending && (
          <div className="flex flex-wrap gap-2 pt-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} className="text-[12px] text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-3 py-1.5">
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-red-400 text-[12px] px-4 pb-2">{error}</p>}

      <div className="flex items-center gap-2 p-3 border-t border-white/10 shrink-0">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask about documents, approvals, activity…"
          disabled={sending}
          className="flex-1 bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-xs text-white placeholder-[#8a96ab]"
        />
        <button
          onClick={() => send()}
          disabled={sending || !input.trim()}
          className="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-r from-violet-400 to-[#00f2fe] flex items-center justify-center disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 text-black">
            <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
