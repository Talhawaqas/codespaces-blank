"use client";

// src/components/ThemeProvider.js
//
// Phase 7 — wraps children in a React context exposing {theme, setTheme},
// persists the choice to localStorage, and writes the selected token set
// (theme.js's THEME_TOKENS) onto <html>'s inline style as CSS custom
// properties, plus a data-theme attribute for any component that prefers
// a CSS-only [data-theme="neon"] selector over reading the context.
// Defaults to "dark" (the site's existing look) until localStorage says
// otherwise, so first paint never flashes an unexpected theme.

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { THEME_TOKENS, THEME_STORAGE_KEY, isValidTheme } from "../lib/theme";

const ThemeContext = createContext({ theme: "dark", setTheme: () => {} });

function applyThemeToDocument(theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  const tokens = THEME_TOKENS[theme] || THEME_TOKENS.dark;
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value);
  }
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState("dark");

  useEffect(() => {
    let stored = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Private browsing / storage disabled — fall back to the default,
      // same tolerant handling every other localStorage read in this
      // codebase already uses.
    }
    const initial = isValidTheme(stored) ? stored : "dark";
    setThemeState(initial);
    applyThemeToDocument(initial);
  }, []);

  const setTheme = useCallback((next) => {
    if (!isValidTheme(next)) return;
    setThemeState(next);
    applyThemeToDocument(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Non-fatal — the theme still applies for this session, it just
      // won't persist across a reload.
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
