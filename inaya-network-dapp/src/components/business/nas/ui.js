"use client";

// Shared building blocks for the NAS management console (SOW Workstream T).
// Same self-contained pattern as the rest of the Business Workspace: a local
// fetch wrapper, real calls to real API routes, no client-side simulation.

import { useState, useEffect, useCallback } from "react";

export async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export function useLoad(url, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError("");
    try { setData(await api(url)); } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [url]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload, ...deps]);
  return { data, error, loading, reload };
}

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return "unknown";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n); let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "never";
}

const TONE = {
  OK: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", HEALTHY: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", ONLINE: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", READY: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", COMPLETED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", REACHABLE: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30", NORMAL: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  ATTENTION: "bg-amber-400/10 text-amber-400 border-amber-400/30", WARNING: "bg-amber-400/10 text-amber-400 border-amber-400/30", DEGRADED: "bg-amber-400/10 text-amber-400 border-amber-400/30", NEAR_LIMIT: "bg-amber-400/10 text-amber-400 border-amber-400/30", NOT_VERIFIED: "bg-amber-400/10 text-amber-400 border-amber-400/30", MEDIUM: "bg-amber-400/10 text-amber-400 border-amber-400/30", PENDING: "bg-amber-400/10 text-amber-400 border-amber-400/30", RETRYING: "bg-amber-400/10 text-amber-400 border-amber-400/30", COMPLETED_WITH_ERRORS: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  CRITICAL: "bg-red-400/10 text-red-400 border-red-400/30", FAILED: "bg-red-400/10 text-red-400 border-red-400/30", UNREACHABLE: "bg-red-400/10 text-red-400 border-red-400/30", HARD_LIMIT: "bg-red-400/10 text-red-400 border-red-400/30", FULL: "bg-red-400/10 text-red-400 border-red-400/30", HIGH: "bg-red-400/10 text-red-400 border-red-400/30", NO_BACKUP: "bg-red-400/10 text-red-400 border-red-400/30",
};

export function Pill({ value, label }) {
  const cls = TONE[value] || "border-white/10 text-[var(--inaya-text-muted)]";
  return <span className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>{label || String(value ?? "unknown").replace(/_/g, " ")}</span>;
}

export function Card({ title, right, children }) {
  return (
    <section className="rounded-lg border border-white/10 p-4 space-y-3">
      {(title || right) && (
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <div className="flex items-center gap-2">{right}</div>
        </div>
      )}
      {children}
    </section>
  );
}

export function Note({ children, tone = "muted" }) {
  const cls = tone === "warn" ? "text-amber-400" : tone === "bad" ? "text-red-400" : "text-[var(--inaya-text-muted)]";
  return <p className={`text-xs ${cls}`}>{children}</p>;
}

export function Err({ error }) {
  return error ? <div className="text-sm text-red-400" role="alert">{error}</div> : null;
}

export function Btn({ children, onClick, danger, disabled, busy, small }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy}
      className={`rounded border px-3 ${small ? "py-1 text-xs" : "py-1.5 text-sm"} font-medium disabled:opacity-50 ${danger ? "border-red-400/40 text-red-400" : "border-white/20"}`}>
      {busy ? "Working…" : children}
    </button>
  );
}

/** Runs an async action with a shared busy/error/result state. */
export function useAction(after) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const run = useCallback(async (fn, confirmText) => {
    if (confirmText && typeof window !== "undefined" && !window.confirm(confirmText)) return;
    setBusy(true); setError(""); setResult(null);
    try { const r = await fn(); setResult(r); if (after) await after(r); return r; } catch (e) { setError(e.message); } finally { setBusy(false); }
  }, [after]);
  return { busy, error, result, run, setError, setResult };
}

export function Input({ label, value, onChange, type = "text", placeholder, id, width = "w-full" }) {
  return (
    <label className={`block text-xs ${width}`}>
      <span className="text-[var(--inaya-text-muted)]">{label}</span>
      <input id={id} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-sm" />
    </label>
  );
}

export function Select({ label, value, onChange, options, id }) {
  return (
    <label className="block text-xs">
      <span className="text-[var(--inaya-text-muted)]">{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-sm">
        {options.map((o) => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
      </select>
    </label>
  );
}

export function Table({ columns, rows, empty = "Nothing here yet." }) {
  if (!rows || rows.length === 0) return <Note>{empty}</Note>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead><tr className="text-xs text-[var(--inaya-text-muted)]">{columns.map((c) => <th key={c.key || c.label} className="py-1 pr-3 font-medium">{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={r._id || r.id || i} className="border-t border-white/5">{columns.map((c) => <td key={c.key || c.label} className="py-1.5 pr-3 align-top">{c.render ? c.render(r) : String(r[c.key] ?? "")}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function Result({ result }) {
  if (!result) return null;
  return <pre className="max-h-48 overflow-auto rounded border border-white/10 p-2 text-xs">{JSON.stringify(result, null, 2)}</pre>;
}
