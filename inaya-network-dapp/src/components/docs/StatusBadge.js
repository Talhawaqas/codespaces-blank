// src/components/docs/StatusBadge.js
// Official Documentation Platform SOW -- a small, honest status label.
// Never decorative: this is the one place a reader learns whether a page
// describes something live, testnet-only, beta, planned, or deprecated.

const STYLES = {
  live: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  testnet: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  beta: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  planned: "bg-slate-200 text-slate-700 dark:bg-slate-700/50 dark:text-slate-300",
  deprecated: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const LABELS = {
  live: "Live",
  testnet: "Testnet",
  beta: "Beta",
  planned: "Planned",
  deprecated: "Deprecated",
};

export default function StatusBadge({ status, className = "" }) {
  if (!status) return null;
  const style = STYLES[status] || STYLES.planned;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style} ${className}`}>
      {LABELS[status] || status}
    </span>
  );
}
