"use client";

// src/components/business/AppLauncherView.js
//
// Business Workspace redesign (2026-10-18) — "All apps": every module this
// person can use (items arrive already filtered by isNavItemVisible),
// grouped in plain language, searchable, and pinnable to the sidebar.
// Styled with the --inaya-* tokens, so it follows Light/Dark/Neon directly.

import { useState, useMemo } from "react";
import { Icon, ICONS } from "./ui/icons";
import { launcherGroups, LAUNCHER_GROUPS, labelFor } from "../../lib/navigation/launcher";

export default function AppLauncherView({ items, describe, pins, onTogglePin, onOpen }) {
  const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState("all");
  const groups = useMemo(() => launcherGroups({ visible: items, query, groupId, describe }), [items, query, groupId, describe]);
  const availableGroups = useMemo(() => launcherGroups({ visible: items, describe }).map((g) => g.id), [items, describe]);
  const chips = [{ id: "all", name: "All" }, ...LAUNCHER_GROUPS.filter((g) => availableGroups.includes(g.id))];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="app-search" className="sr-only">Find an app</label>
        <div className="flex-1 min-w-[16rem] flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-[var(--inaya-border)] bg-[var(--inaya-surface)]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--inaya-text-muted)] shrink-0" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input
            id="app-search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an app — try “invoice”, “backup” or “sign”"
            className="flex-1 bg-transparent outline-none text-sm text-[var(--inaya-text-primary)] placeholder:text-[var(--inaya-text-muted)]"
          />
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by group">
          {chips.map((c) => (
            <button
              key={c.id}
              onClick={() => setGroupId(c.id)}
              aria-pressed={groupId === c.id}
              className={`h-9 px-3.5 rounded-full text-[13px] font-semibold border transition-colors ${
                groupId === c.id
                  ? "bg-[var(--inaya-accent)] border-[var(--inaya-accent)] text-[var(--inaya-on-accent)]"
                  : "bg-[var(--inaya-surface)] border-[var(--inaya-border)] text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)]"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && (
        <p className="rounded-2xl border border-dashed border-[var(--inaya-border)] bg-[var(--inaya-surface)] p-8 text-center text-sm text-[var(--inaya-text-muted)]">
          No app matches “{query}”. Try a simpler word, or ask the AI assistant what you want to do.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`grp-${g.id}`} className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h2 id={`grp-${g.id}`} className="text-[15px] font-bold text-[var(--inaya-text-primary)]">{g.name}</h2>
            {g.blurb && <span className="text-[13px] text-[var(--inaya-text-muted)]">{g.blurb}</span>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {g.items.map((item) => {
              const pinned = pins.includes(item.key);
              return (
                <div key={item.key} className="group flex items-start gap-3 rounded-xl border border-[var(--inaya-border)] bg-[var(--inaya-surface)] p-3.5 hover:border-[var(--inaya-accent)] transition-colors">
                  <button onClick={() => onOpen(item.key)} className="flex flex-1 min-w-0 items-start gap-3 text-left">
                    <span className="w-9 h-9 shrink-0 rounded-lg bg-[var(--inaya-accent-soft)] text-[var(--inaya-accent)] flex items-center justify-center">
                      <Icon path={ICONS[item.icon] || ICONS.dashboard} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-[var(--inaya-text-primary)]">{labelFor(item)}</span>
                      <span className="block text-xs leading-snug text-[var(--inaya-text-muted)] line-clamp-2">{describe(item.key)}</span>
                    </span>
                  </button>
                  <button
                    onClick={() => onTogglePin(item.key)}
                    aria-pressed={pinned}
                    aria-label={pinned ? `Unpin ${labelFor(item)} from the sidebar` : `Pin ${labelFor(item)} to the sidebar`}
                    title={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                    className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-colors ${pinned ? "text-[var(--inaya-accent)]" : "text-[var(--inaya-text-muted)] opacity-60 group-hover:opacity-100 hover:text-[var(--inaya-accent)]"}`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
