"use client";

// src/components/business/CleanerView.js
//
// Inaya Cleaner (Internxt-inspired SOW, Workstream B). All real scanning/cleanup logic (temp-file
// detection, content-hash duplicate grouping, the protected-path denylist, trash-not-permanent-
// delete cleanup) lives natively in inaya-desktop's Rust backend (src-tauri/src/cleaner.rs) --
// this view is a thin control surface over the two Tauri commands it exposes
// (cleaner_scan/cleaner_cleanup), the exact same window.__TAURI__.core.invoke() pattern
// DirectSyncView.js already established. Local-first by construction: this component never
// uploads a file inventory anywhere -- the scan report it receives IS the entire round trip.
//
// Desktop-only, same honest degrade as DirectSyncView: there is no local filesystem to scan from
// inside a browser tab, so this shows a plain message rather than pretending to offer it on web.

import { useState, useCallback } from "react";
import EmptyState from "../EmptyState";

function isDesktop() {
  return typeof window !== "undefined" && !!window.__TAURI__;
}

async function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function CategorySection({ title, description, children }) {
  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-3">
      <div>
        <p className="text-[var(--inaya-text-primary)] font-bold text-sm">{title}</p>
        {description && <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function CandidateRow({ path, size, checked, onToggle }) {
  return (
    <label className="flex items-center gap-3 py-1.5 border-b border-white/5 last:border-0 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onToggle} className="accent-[#00f2fe]" />
      <span className="flex-1 text-[12px] font-mono text-[var(--inaya-text-primary)] truncate" title={path}>{path}</span>
      <span className="text-[11px] text-[var(--inaya-text-muted)] font-mono shrink-0">{formatBytes(size)}</span>
    </label>
  );
}

export default function CleanerView() {
  const [report, setReport] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState(null);

  const scan = useCallback(async () => {
    setBusy(true);
    setError("");
    setSummary(null);
    try {
      const r = await invoke("cleaner_scan", { extraRoots: [] });
      setReport(r);
      setSelected(new Set());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const toggle = (path) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const cleanup = useCallback(async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError("");
    try {
      const result = await invoke("cleaner_cleanup", { paths: Array.from(selected) });
      setSummary(result);
      await scan(); // re-scan so the list reflects what's actually left
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [selected, scan]);

  if (!isDesktop()) {
    return (
      <EmptyState
        icon="🧹"
        title="Cleaner requires the desktop app"
        description="Cleaner scans this computer's local files, so it only runs inside the Inaya desktop app. Download it from the Downloads page to use it."
      />
    );
  }

  const totalBytes = selected.size
    ? [...(report?.temporary_files || []), ...flattenDuplicates(report)].filter((c) => selected.has(c.path)).reduce((s, c) => s + c.size, 0)
    : 0;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Cleaner</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Scans this computer's temporary files and duplicates. Everything stays on this device — nothing is uploaded. Review what's
          found below; nothing is removed until you select items and choose Clean Up, and removed files go to this computer's recycle
          bin, not a permanent delete.
        </p>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}
      {summary && (
        <p className="text-emerald-400 text-xs">
          Done: {summary.files_handled} file{summary.files_handled === 1 ? "" : "s"} moved to the recycle bin, {formatBytes(summary.bytes_reclaimed)} reclaimed.
          {summary.failures?.length > 0 && ` ${summary.failures.length} could not be removed.`}
        </p>
      )}

      <button
        onClick={scan}
        disabled={busy}
        className="px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-50"
      >
        {busy ? "Working…" : report ? "Scan Again" : "Run Scan"}
      </button>

      {report && (
        <>
          <p className="text-[11px] text-[var(--inaya-text-muted)]">
            Scanned {new Date(report.scanned_at).toLocaleString()} · {report.protected_skipped_count} protected item(s) skipped automatically
          </p>

          <CategorySection title="Temporary files" description="Files in standard system/app temporary directories.">
            {report.temporary_files.length === 0 ? (
              <EmptyState compact icon="✨" description="No temporary files found." />
            ) : (
              <div>{report.temporary_files.map((c) => <CandidateRow key={c.path} path={c.path} size={c.size} checked={selected.has(c.path)} onToggle={() => toggle(c.path)} />)}</div>
            )}
          </CategorySection>

          <CategorySection title="Duplicate files" description="Files with identical content. The suggested original (oldest copy) is kept unselected by default.">
            {report.duplicate_groups.length === 0 ? (
              <EmptyState compact icon="✨" description="No duplicate files found." />
            ) : (
              <div className="space-y-3">
                {report.duplicate_groups.map((g) => (
                  <div key={g.hash} className="border border-white/5 rounded-xl p-3">
                    <p className="text-[11px] text-[var(--inaya-text-muted)] mb-1">
                      {g.others.length + 1} copies · {formatBytes(g.total_bytes)} total
                    </p>
                    <p className="text-[11px] font-mono text-emerald-400 truncate mb-1" title={g.keeper}>Keeping: {g.keeper}</p>
                    {g.others.map((p) => (
                      <CandidateRow key={p} path={p} size={g.total_bytes / (g.others.length + 1)} checked={selected.has(p)} onToggle={() => toggle(p)} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </CategorySection>

          <div className="flex items-center justify-between bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
            <p className="text-xs text-[var(--inaya-text-muted)]">
              {selected.size} item{selected.size === 1 ? "" : "s"} selected · {formatBytes(totalBytes)}
            </p>
            <button
              onClick={cleanup}
              disabled={busy || selected.size === 0}
              className="px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide bg-red-500/90 text-white disabled:opacity-40"
            >
              Clean Up Selected
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function flattenDuplicates(report) {
  if (!report) return [];
  const perFile = [];
  for (const g of report.duplicate_groups) {
    const each = g.total_bytes / (g.others.length + 1);
    for (const p of g.others) perFile.push({ path: p, size: each });
  }
  return perFile;
}
