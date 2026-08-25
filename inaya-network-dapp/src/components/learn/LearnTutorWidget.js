"use client";

// src/components/learn/LearnTutorWidget.js
//
// Floating, always-visible entry point for the Inaya Learn AI Tutor —
// mounted once at the LearnSection level so it's reachable from every
// Learn view (home, search, category, my learning, video), not just
// buried inside an already-open video page. When the user has a video
// open, LearnSection passes its title/channel/category down as
// videoContext so the tutor can ground itself in what's on screen;
// otherwise it's a general-purpose tutor.
//
// Positioned bottom-left specifically to avoid overlapping the existing
// bottom-right "Inaya docs assistant" floating button in app/page.js.

import { useState } from 'react';
import { askLearnTutor } from './useLearnLibrary';

const SUGGESTED_QUESTIONS_GENERAL = [
  'What should I learn first?',
  'Explain blockchain in simple terms',
  'What is Web3?',
  'Quiz me on what I just watched',
];

export default function LearnTutorWidget({ walletAddress, videoContext, open, onOpenChange }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const suggestions = videoContext
    ? [`Summarize "${videoContext.title}"`, 'Explain the key concepts in this video', 'Quiz me on this video', 'What should I watch next?']
    : SUGGESTED_QUESTIONS_GENERAL;

  async function send(overrideText) {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    const nextMessages = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setInput('');
    setSending(true);
    try {
      const data = await askLearnTutor({ walletAddress, videoContext, messages: nextMessages });
      setMessages([...nextMessages, { role: 'assistant', content: data.reply || "Sorry, I couldn't come up with an answer for that." }]);
    } catch {
      setMessages([...nextMessages, { role: 'assistant', content: 'The tutor is temporarily unavailable — please try again in a moment.' }]);
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => onOpenChange(true)}
        className="fixed bottom-5 left-5 z-[9998] flex items-center gap-2.5 pl-3.5 pr-5 h-16 rounded-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] shadow-[0_0_35px_rgba(0,242,254,0.55)] active:scale-95 transition-transform hover:brightness-110"
        title="Ask the Inaya Learn AI Tutor"
      >
        <span className="relative flex h-16 w-16 -m-1 items-center justify-center shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00f2fe] opacity-30" />
          <span className="relative text-3xl">🎓</span>
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[13px] font-extrabold">Ask AI Tutor</span>
          <span className="text-[9px] font-semibold opacity-70">Learn anything, anytime</span>
        </span>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[9998] w-full h-full sm:inset-auto sm:bottom-5 sm:left-5 sm:w-[92vw] sm:max-w-sm sm:h-[70vh] sm:max-h-[560px] bg-[#090e1a]/95 sm:border sm:border-[#00f2fe]/25 sm:rounded-2xl shadow-2xl backdrop-blur-xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-white/10 bg-[#0b1426]/80 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center text-base shrink-0">🎓</span>
          <div className="min-w-0">
            <div className="text-white text-xs font-bold truncate">Inaya Learn AI Tutor</div>
            <div className="text-[9px] text-[#8a96ab] font-mono truncate">
              {videoContext ? `Grounded in: ${videoContext.title}` : 'Ask me anything, I\'m here to teach'}
            </div>
          </div>
        </div>
        <button onClick={() => onOpenChange(false)} className="text-[#8a96ab] hover:text-white text-sm shrink-0 px-1">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div>
            <p className="text-[#94a3b8] text-xs mb-3">
              {videoContext ? 'Ask about this video, or anything else you want to learn:' : 'Not sure what to ask? Try one of these:'}
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  disabled={sending}
                  className="text-xs text-[#cbd5e1] bg-white/5 hover:bg-white/10 hover:text-white border border-white/10 hover:border-[#00f2fe]/40 rounded-full px-3 py-1.5 transition-colors disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                m.role === 'user' ? 'bg-[#00f2fe]/10 text-[#e2e8f0]' : 'bg-white/5 text-[#94a3b8]'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && <p className="text-[#8a96ab] text-xs">Thinking…</p>}
      </div>

      <div className="flex items-center gap-2 px-4 py-3 border-t border-white/10 shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !sending) send(); }}
          placeholder="Ask a question…"
          disabled={sending}
          className="flex-1 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-[#8a96ab] focus:outline-none focus:border-[#00f2fe]/40 disabled:opacity-50"
        />
        <button
          onClick={() => send()}
          disabled={sending || !input.trim()}
          className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-xs rounded-lg px-4 py-2 disabled:opacity-50 whitespace-nowrap"
        >
          Send
        </button>
      </div>
    </div>
  );
}
