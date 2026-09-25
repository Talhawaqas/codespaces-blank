"use client";

// Shared helpers for the Document Automation workspace (SOW §32). Same
// self-contained-view pattern as every other business/*View.js: a local
// api() wrapper and real calls against real routes, no client-side
// simulation of a decision, a calculation or a status.

export async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const BASE = "/api/orgs/documents-automation";

export const STATUS_LABELS = {
  DRAFT: "Draft", GENERATED: "Generated", PENDING_APPROVAL: "Pending approval", APPROVED: "Approved", FINALIZED: "Finalized",
  DELIVERED: "Delivered", VIEWED: "Viewed", PAID: "Paid", REJECTED: "Rejected", VOID: "Void", CANCELLED: "Cancelled", EXPIRED: "Expired", SUPERSEDED: "Superseded",
};

const GOOD = "bg-emerald-400/10 text-emerald-400 border-emerald-400/30";
const WARN = "bg-amber-400/10 text-amber-400 border-amber-400/30";
const BAD = "bg-red-400/10 text-red-400 border-red-400/30";
const INFO = "bg-blue-400/10 text-blue-400 border-blue-400/30";
const MUTED = "bg-white/5 text-[var(--inaya-text-muted)] border-white/10";

export const STATUS_STYLES = {
  DRAFT: MUTED, GENERATED: INFO, PENDING_APPROVAL: WARN, APPROVED: GOOD, FINALIZED: GOOD, DELIVERED: GOOD, VIEWED: GOOD, PAID: GOOD,
  REJECTED: BAD, VOID: BAD, CANCELLED: MUTED, EXPIRED: WARN, SUPERSEDED: MUTED,
};

export const PIPELINE_STYLES = { COMPLETE: GOOD, GENERATING: INFO, FINALIZING: INFO, STORAGE_PENDING: WARN, EVIDENCE_PENDING: WARN, GENERATION_FAILED: BAD, STORAGE_FAILED: BAD, DELIVERY_FAILED: BAD, DELIVERY_PENDING: WARN };

export function Pill({ children, className = MUTED, title }) {
  return <span title={title} className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${className}`}>{children}</span>;
}

export function StatusPill({ status }) {
  return <Pill className={STATUS_STYLES[status] || MUTED}>{STATUS_LABELS[status] || status}</Pill>;
}

export function PipelinePill({ state }) {
  if (!state || state === "COMPLETE") return null;
  return <Pill className={PIPELINE_STYLES[state] || MUTED} title="Operational state of the document pipeline">{state.replaceAll("_", " ").toLowerCase()}</Pill>;
}

export function money(amount, currency) {
  if (amount === null || amount === undefined) return "-";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(amount); } catch { return `${currency || ""} ${amount}`; }
}

export function fmtDate(v, withTime = false) {
  if (!v) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

export function shortHash(h) {
  return h ? `${h.slice(0, 12)}...${h.slice(-6)}` : "-";
}

export function Button({ children, onClick, disabled, tone = "default", className = "", type = "button" }) {
  const tones = {
    default: "border-white/20 hover:bg-white/10", primary: "border-cyan-400/50 bg-cyan-400/10 text-cyan-300 hover:bg-cyan-400/20",
    danger: "border-red-400/40 text-red-300 hover:bg-red-400/10", good: "border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10",
  };
  return <button type={type} onClick={onClick} disabled={disabled} className={`rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed ${tones[tone]} ${className}`}>{children}</button>;
}

export function Field({ label, children, hint }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-semibold text-[var(--inaya-text-muted)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--inaya-text-muted)]">{hint}</span>}
    </label>
  );
}

export const inputClass = "w-full rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 text-sm text-[var(--inaya-text-primary,#fff)] outline-none focus:border-cyan-400/60";

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300" role="alert">{error}</div>;
}

export function Section({ title, children, right }) {
  return (
    <section className="rounded-lg border border-white/10 bg-black/20 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)]">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function pdfBlobUrl(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}

export function randomKey() {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Simple editable list of line items {description, quantity, unitPrice, taxPercent}. */
export function LinesEditor({ lines, onChange, showTax = true }) {
  const update = (i, patch) => onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-12 gap-2">
          <input aria-label="Description" className={`${inputClass} col-span-5`} placeholder="Description" value={l.description} onChange={(e) => update(i, { description: e.target.value })} />
          <input aria-label="Quantity" className={`${inputClass} col-span-2`} placeholder="Qty" inputMode="decimal" value={l.quantity} onChange={(e) => update(i, { quantity: e.target.value })} />
          <input aria-label="Unit price" className={`${inputClass} col-span-2`} placeholder="Unit price" inputMode="decimal" value={l.unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value })} />
          {showTax ? <input aria-label="Tax percent" className={`${inputClass} col-span-2`} placeholder="Tax %" inputMode="decimal" value={l.taxPercent ?? ""} onChange={(e) => update(i, { taxPercent: e.target.value })} /> : <div className="col-span-2" />}
          <button type="button" className="col-span-1 text-xs text-red-300" onClick={() => onChange(lines.filter((_, idx) => idx !== i))} aria-label="Remove line">Remove</button>
        </div>
      ))}
      <Button onClick={() => onChange([...lines, { description: "", quantity: "1", unitPrice: "", taxPercent: "" }])}>Add line</Button>
    </div>
  );
}

export function cleanLines(lines) {
  return lines.filter((l) => l.description?.trim()).map((l) => {
    const out = { description: l.description.trim(), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) };
    if (l.taxPercent !== "" && l.taxPercent !== undefined && l.taxPercent !== null) out.taxPercent = Number(l.taxPercent);
    return out;
  });
}
