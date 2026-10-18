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

// The "white" key is kept as-is for backward compatibility (anyone with `inaya_theme: "white"`
// already in localStorage must keep resolving to a valid theme, not silently fall back to dark)
// even though the palette it now points to isn't literally white anymore -- see THEME_LABELS.
//
// Every theme also defines --inaya-overlay-{5,10,15}: theme-aware replacements for the ~50+
// hardcoded `bg-white/5`, `hover:bg-white/10`, `border-white/15`-style Tailwind classes used
// throughout the Business Workspace for hover states, subtle icon-container backgrounds, and
// borders. Those were fixed at a WHITE tint, which reads fine against the dark/neon surfaces
// they were designed for but is nearly invisible against a light one -- rows, icon containers,
// and dividers all but disappear, which is the real, structural reason the white theme reads as
// "broken," not (only) a plain color-contrast problem. dark/neon's overlay values below are the
// exact literal rgba(255,255,255,...) values already in use, so adopting the token changes
// nothing visually for those two themes.
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
    "--inaya-overlay-5": "rgba(255,255,255,0.05)",
    "--inaya-overlay-10": "rgba(255,255,255,0.10)",
    "--inaya-overlay-15": "rgba(255,255,255,0.15)",
    // Redesign tokens (2026-10-18). Dark values equal the literals the views already use,
    // so adopting them changes nothing in dark.
    "--inaya-accent-soft": "rgba(0,242,254,0.10)",
    "--inaya-on-accent": "#000000",
    "--inaya-input": "rgba(0,0,0,0.45)",
    "--inaya-success": "#34d399",
    "--inaya-warning": "#fbbf24",
    "--inaya-danger": "#f87171",
  },
  // Business Workspace redesign (2026-10-18, approved design): light-first professional --
  // a cool, neutral grey ground, white cards, slate text and one deep teal accent derived from
  // the brand cyan. Hard-coded dark utility classes in the views are remapped for this theme by
  // the light adapter layer in globals.css (html[data-theme="white"] .bw ...).
  white: {
    "--inaya-bg": "#f5f6f8",
    "--inaya-surface": "#ffffff",
    "--inaya-surface-2": "#f0f2f5",
    "--inaya-accent": "#0b6e75",
    "--inaya-accent-2": "#0e8a93",
    "--inaya-text-primary": "#0f172a",
    "--inaya-text-muted": "#5b6474",
    "--inaya-border": "#e4e7ec",
    "--inaya-overlay-5": "rgba(15,23,42,0.04)",
    "--inaya-overlay-10": "rgba(15,23,42,0.07)",
    "--inaya-overlay-15": "rgba(15,23,42,0.12)",
    "--inaya-accent-soft": "#e7f3f4",
    "--inaya-on-accent": "#ffffff",
    "--inaya-input": "#ffffff",
    "--inaya-success": "#067647",
    "--inaya-warning": "#b54708",
    "--inaya-danger": "#b42318",
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
    "--inaya-overlay-5": "rgba(255,255,255,0.05)",
    "--inaya-overlay-10": "rgba(255,255,255,0.10)",
    "--inaya-overlay-15": "rgba(255,255,255,0.15)",
    "--inaya-accent-soft": "rgba(0,255,225,0.10)",
    "--inaya-on-accent": "#000000",
    "--inaya-input": "rgba(0,0,0,0.45)",
    "--inaya-success": "#34d399",
    "--inaya-warning": "#fbbf24",
    "--inaya-danger": "#f87171",
  },
};

// Label updated from "White" to "Light" -- the palette itself no longer is one, see the module
// comment above. The stored/matched key stays "white" so existing saved preferences keep working.
export const THEME_LABELS = { white: "Light", dark: "Dark", neon: "Neon" };

export const THEME_STORAGE_KEY = "inaya_theme";

export function isValidTheme(value) {
  return THEMES.includes(value);
}
