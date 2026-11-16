"use client";

// src/components/business/SupportAgentPanel.js
//
// The "Help" side panel for the Inaya Support Agent (POST /api/ai/support-agent). The agent diagnoses
// the problem and fixes what it safely can after the customer confirms; otherwise it hands the case to
// the Inaya team. The conversation is kept for this browser tab only.

import { useEffect, useRef, useState } from "react";

const GREETING = "Hi, I'm the Inaya support assistant. Tell me what's wrong or what you're trying to do, and I'll check your account and fix it if I can. If I can't, I'll pass it to the team.";
const SUGGESTIONS = ["My company name is missing", "A teammate didn't get their invite", "How do I pay for a package?", "I can't see the modules I need"];

export default function SupportAgentPanel({ orgId, open, onClose }) {
  const [messages, setMessages] = useState([{ role: "assistant", content: GREETING }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);
  if (!open) return null;

  async function send(text) {
    const content = String(text || "").trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/ai/support-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, messages: next.filter((m, i) => !(i === 0 && m.content === GREETING)) }),
      });
      const data = await res.json().catch(() => ({}));
      setMessages((m) => [...m, { role: "assistant", content: res.ok ? data.reply : data.error || "Something went wrong. Please email contact@inayanetwork.com." }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "I couldn't reach the server. Please check your connection or email contact@inayanetwork.com." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9998] flex justify-end bg-black/30" onClick={onClose}>
      <aside
        className="h-full w-full max-w-md bg-[var(--inaya-surface)] border-l border-[var(--inaya-border)] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Help and support"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--inaya-border)]">
          <div>
            <p className="text-[var(--inaya-text-primary)] font-extrabold">Help &amp; support</p>
            <p className="text-[var(--inaya-text-muted)] text-[11px]">AI support assistant · can fix common account problems</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]" : "bg-[var(--inaya-overlay-5)] text-[var(--inaya-text-primary)]"}`}>
                {m.content}
              </div>
            </div>
          ))}
          {busy && <p className="text-[var(--inaya-text-muted)] text-xs">Checking your account…</p>}
          {messages.length === 1 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="text-xs border border-[var(--inaya-border)] rounded-full px-3 py-1.5 text-[var(--inaya-text-primary)] hover:border-[var(--inaya-accent)]">{s}</button>
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="p-4 border-t border-[var(--inaya-border)] flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe the problem…"
            maxLength={2000}
            className="flex-1 bg-[var(--inaya-input,transparent)] border border-[var(--inaya-overlay-15)] rounded-xl px-3 py-2 text-sm text-[var(--inaya-text-primary)]"
          />
          <button disabled={busy || !input.trim()} className="px-4 py-2 rounded-xl text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-50">Send</button>
        </form>
      </aside>
    </div>
  );
}
