"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const NAV_LINKS = [
  { href: "/docs", label: "Home" },
  { href: "/docs/developer/developer-overview", label: "Developers" },
  { href: "/docs/api", label: "API" },
  { href: "/docs/sdk", label: "SDK" },
  { href: "/docs/cli", label: "CLI" },
  { href: "/docs/release-notes", label: "Release Notes" },
];

/** Theme is scoped to a `dark` class on this shell's own root element, not
 *  the document root -- so it can never affect the rest of the site
 *  (tailwind.config.js's darkMode:"class" applies wherever an ancestor
 *  carries the class, not only <html>). Preference persisted in
 *  localStorage, wrapped in try/catch per this session's own browser-
 *  storage discipline (private windows / blocked storage must not break
 *  the page). */
export default function DocsShell({ children }) {
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("inaya-docs-theme");
      if (saved === "dark" || saved === "light") setTheme(saved);
      else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) setTheme("dark");
    } catch {
      // localStorage unavailable -- default to light, nothing to recover.
    }
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem("inaya-docs-theme", next);
    } catch {
      // Best-effort persistence only.
    }
  }

  return (
    <div className={theme === "dark" ? "dark" : ""}>
      <div className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        <header className="sticky top-0 z-40 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 flex h-14 items-center justify-between gap-4">
            <div className="flex items-center gap-6 min-w-0">
              <Link href="/docs" className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white shrink-0">
                <span className="inline-block h-6 w-6 rounded bg-gradient-to-br from-[#0B63E5] to-[#5AA9FF]" aria-hidden="true" />
                <span>Inaya Docs</span>
              </Link>
              <nav className="hidden md:flex items-center gap-5 text-sm text-slate-600 dark:text-slate-300 min-w-0">
                {NAV_LINKS.map((l) => (
                  <Link key={l.href} href={l.href} className="hover:text-slate-900 dark:hover:text-white whitespace-nowrap">
                    {l.label}
                  </Link>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Link
                href="/docs/search"
                className="hidden sm:flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600"
                aria-label="Search documentation"
              >
                <span>Search docs</span>
                <kbd className="text-[10px] rounded border border-slate-300 dark:border-slate-600 px-1 py-0.5">Ctrl K</kbd>
              </Link>
              <button
                onClick={toggleTheme}
                className="rounded-md p-2 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? "☀️" : "🌙"}
              </button>
              <Link href="/" className="hidden sm:block text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white">
                Main site
              </Link>
            </div>
          </div>
        </header>
        <main>{children}</main>
        <footer className="border-t border-slate-200 dark:border-slate-800 mt-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 text-sm text-slate-500 dark:text-slate-400 flex flex-col sm:flex-row justify-between gap-3">
            <div>© Inaya Network — Official Documentation</div>
            <div className="flex gap-4">
              <Link href="/" className="hover:text-slate-900 dark:hover:text-white">Main site</Link>
              <Link href="/build" className="hover:text-slate-900 dark:hover:text-white">Build</Link>
              <Link href="/security" className="hover:text-slate-900 dark:hover:text-white">Security</Link>
              <Link href="/trust" className="hover:text-slate-900 dark:hover:text-white">Trust</Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
