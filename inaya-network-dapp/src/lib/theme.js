"use client";

// src/lib/theme.js
//
// Phase 7 — Theme Switch (White/Dark/Neon). Token sets for the ~8 most-
// repeated colors across the site, per the SOW's own scoped-down plan:
// this is NOT an exhaustive rewrite of the ~1,000 hardcoded hex literals
// across page.js/business/page.js/the view components — those stay
// exactly as they are, still rendering the current dark look regardless
// of the selected theme. What DOES respond to the switch is: the landing
// nav/hero, the Business Workspace shell (Sidebar, header, main
// background), and any new/retrofitted component that opts in by using
// these CSS custom properties instead of a literal hex value. The CSS
// vars are available site-wide for incremental future adoption.
//
// "dark" is deliberately the DEFAULT and matches the site's actual
// current dark palette values exactly — so a user who never touches the
// switch sees zero visual change from before this shipped.

export const THEMES = ["white", "dark", "neon"];

export const THEME_TOKENS = {
  dark: {
    "--inaya-bg": "#060913",
    "--inaya-surface": "#090d16",
    "--inaya-surface-2": "#0a0f1e",
    "--inaya-accent": "#00f2fe",
    "--inaya-accent-2": "#4facfe",
    "--inaya-text-primary": "#e2e8f0",
    "--inaya-text-muted": "#94a3b8",
    "--inaya-border": "rgba(255,255,255,0.08)",
  },
  white: {
    "--inaya-bg": "#f4f6fb",
    "--inaya-surface": "#ffffff",
    "--inaya-surface-2": "#eef1f8",
    "--inaya-accent": "#0284c7",
    "--inaya-accent-2": "#0ea5e9",
    "--inaya-text-primary": "#0f172a",
    "--inaya-text-muted": "#64748b",
    "--inaya-border": "rgba(15,23,42,0.10)",
  },
  neon: {
    "--inaya-bg": "#050014",
    "--inaya-surface": "#0d0221",
    "--inaya-surface-2": "#150330",
    "--inaya-accent": "#00ffe1",
    "--inaya-accent-2": "#ff00e5",
    "--inaya-text-primary": "#f5f3ff",
    "--inaya-text-muted": "#b8a9e0",
    "--inaya-border": "rgba(255,0,229,0.25)",
  },
};

export const THEME_LABELS = { white: "White", dark: "Dark", neon: "Neon" };

export const THEME_STORAGE_KEY = "inaya_theme";

export function isValidTheme(value) {
  return THEMES.includes(value);
}
