"use client";

// src/components/business/WelcomeView.js
//
// Business Workspace redesign (2026-10-18) — shown once per person per
// company: "What will you mainly use Inaya for?" The answer only decides
// which apps start pinned in the sidebar; everything else stays one click
// away in All apps, and the choice can be changed there any time.

import { useState } from "react";
import { USE_CASES } from "../../lib/navigation/launcher";

export default function WelcomeView({ onChoose, onSkip }) {
  const [pick, setPick] = useState(USE_CASES[0].id);
  return (
    <div className="fixed inset-0 z-[60] flex items-start sm:items-center justify-center overflow-y-auto bg-[rgba(15,23,42,0.45)] p-4" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="w-full max-w-2xl rounded-2xl border border-[var(--inaya-border)] bg-[var(--inaya-surface)] p-6 sm:p-9 shadow-2xl space-y-6">
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-[var(--inaya-accent)]">Welcome to your Business Workspace</p>
          <h1 id="welcome-title" className="text-2xl sm:text-[28px] font-bold leading-tight text-[var(--inaya-text-primary)] [text-wrap:balance]">
            What will you mainly use Inaya for?
          </h1>
          <p className="text-[15px] leading-relaxed text-[var(--inaya-text-muted)]">
            We’ll keep your sidebar short and put the right tools in it. Everything else is one click away in <strong className="text-[var(--inaya-text-primary)]">All apps</strong>, where you can pin or unpin anything later.
          </p>
        </div>
        <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <legend className="sr-only">Choose your main use</legend>
          {USE_CASES.map((u) => {
            const on = pick === u.id;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => setPick(u.id)}
                aria-pressed={on}
                className={`text-left rounded-xl border-2 p-4 transition-colors ${on ? "border-[var(--inaya-accent)] bg-[var(--inaya-accent-soft)]" : "border-[var(--inaya-border)] hover:border-[var(--inaya-accent)]"}`}
              >
                <span className="block text-[15px] font-bold text-[var(--inaya-text-primary)]">{u.title}</span>
                <span className="mt-1 block text-[13px] leading-snug text-[var(--inaya-text-muted)]">{u.desc}</span>
              </button>
            );
          })}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--inaya-border)] pt-5">
          <button type="button" onClick={onSkip} className="text-sm font-semibold text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)]">Skip for now</button>
          <button
            type="button"
            onClick={() => onChoose(pick)}
            className="ml-auto h-11 px-6 rounded-xl bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] text-[15px] font-semibold hover:opacity-90"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
