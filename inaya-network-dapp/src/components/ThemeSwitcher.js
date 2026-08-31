"use client";

// src/components/ThemeSwitcher.js
//
// Phase 7 — the visible White/Dark/Neon control, used in both the
// Business Workspace header and the main site nav (per the SOW's
// explicit requirement that the switcher itself be visible in both
// places). Deliberately tiny and self-contained: three buttons, no
// dropdown, so it reads clearly at a glance in a cramped header.

import { useTheme } from "./ThemeProvider";
import { THEMES, THEME_LABELS } from "../lib/theme";

export default function ThemeSwitcher({ className = "" }) {
  const { theme, setTheme } = useTheme();

  return (
    <div className={`flex items-center bg-black/30 border border-white/10 rounded-lg p-0.5 ${className}`} role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => setTheme(t)}
          aria-pressed={theme === t}
          className={`px-2.5 py-1 text-[10px] font-bold uppercase rounded-md transition-colors ${
            theme === t ? "bg-[#00f2fe]/20 text-[#00f2fe]" : "text-[#94a3b8] hover:text-slate-200"
          }`}
        >
          {THEME_LABELS[t]}
        </button>
      ))}
    </div>
  );
}
