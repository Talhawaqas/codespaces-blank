"use client";

// src/components/CommandPalette.js
//
// Enterprise OS SOW, Phase 4 — Cmd/Ctrl+K overlay, surface-agnostic like
// NotificationsBell.js/TrustHealthCard.js. `onSelect(result)` is left to
// the caller so each surface routes through its OWN existing navigation
// mechanism rather than this component inventing a second one: Business
// Workspace passes its real `navigate(view)` function (SPA, no reload);
// the dApp passes its own tab-switch setter. `searchUrl` is the one
// scope-specific piece of wiring (org vs. wallet endpoint).

import { useState, useEffect, useCallback, useRef } from "react";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function CommandPalette({ searchUrl, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    function onKeyDown(e) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
    else {
      setQuery("");
      setResults([]);
    }
  }, [open]);

  const runSearch = useCallback(
    (q) => {
      if (q.trim().length < 2) {
        setResults([]);
        return;
      }
      setLoading(true);
      api(`${searchUrl}${searchUrl.includes("?") ? "&" : "?"}q=${encodeURIComponent(q)}`)
        .then((data) => setResults(data.results || []))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    },
    [searchUrl]
  );

  function handleChange(e) {
    const value = e.target.value;
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(value), 250);
  }

  function handleSelect(result) {
    setOpen(false);
    onSelect?.(result);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/30 border border-white/10 hover:bg-white/5 text-[var(--inaya-text-muted)] text-[12px]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden sm:inline text-[10px] font-mono bg-white/5 px-1.5 py-0.5 rounded">⌘K</kbd>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-24 px-4" onClick={() => setOpen(false)}>
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg bg-[var(--inaya-surface)] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--inaya-text-muted)] shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={handleChange}
            placeholder="Search everything..."
            className="flex-1 bg-transparent text-[var(--inaya-text-primary)] text-sm outline-none placeholder:text-[var(--inaya-text-muted)]"
          />
          {loading && <span className="text-[10px] text-[var(--inaya-text-muted)]">…</span>}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {query.trim().length >= 2 && !loading && results.length === 0 && (
            <p className="text-[12px] text-[var(--inaya-text-muted)] px-4 py-6 text-center">No matches.</p>
          )}
          {results.map((r) => (
            <button
              key={`${r.entityType}-${r.id}`}
              onClick={() => handleSelect(r)}
              className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-white/5"
            >
              <span className="text-[13px] text-[var(--inaya-text-primary)] truncate">{r.title}</span>
              <span className="text-[10px] uppercase font-bold text-[var(--inaya-text-muted)] shrink-0">{r.subtitle}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
