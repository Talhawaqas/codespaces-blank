"use client";

// src/components/business/financial/shared.js — shared helpers for the Financial OS tabs
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).



export async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export const FUND_STATUS_STYLES = {
  forming: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  active: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  closed: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  wound_down: "bg-red-400/10 text-red-400 border-red-400/30",
};

// ============================================================
// SHARED PRIMITIVES
// ============================================================
export function Section({ title, children }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-1.5">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export function Row({ left, right }) {
  return (
    <div className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5">
      <span className="text-[var(--inaya-text-primary)] text-xs truncate">{left}</span>
      <span className="text-[var(--inaya-text-muted)] text-[11px] font-mono shrink-0 ml-2">{right}</span>
    </div>
  );
}

export function Empty() {
  return <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">None.</p>;
}

export function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[85vh] overflow-y-auto`}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
