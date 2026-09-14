// src/components/business/ui/StatusBadge.js
//
// Business Workspace UX/UI Makeover SOW -- merges the 6+ independently
// duplicated status-color maps found in TasksView.STATUS_STYLES,
// CRMView.STAGE_STYLES, ProcurementView.PR_STATUS_STYLES/PO_STATUS_STYLES,
// FinanceView.STATUS_COLORS, HRView.STATUS_COLORS,
// AIActionRequestsView.STATUS_STYLES (see BUSINESS_WORKSPACE_UX_AUDIT.md
// #3.1) into one component + one lookup, keeping the exact same visual
// language (same badge shell, same 5-color vocabulary) every one of those
// already converged on independently. A future recolor touches this one
// file instead of six.
//
// SOW §13: never use color as the only status indicator -- the status
// text is always rendered (as every existing implementation already did),
// plus a small solid dot in the same tone for faster scanning.

const TONE_CLASSES = {
  neutral: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  info: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  warning: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  success: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  danger: "bg-red-400/10 text-red-400 border-red-400/30",
  special: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};

// Every literal status string found across the 6 duplicated maps, mapped
// to its tone. Unknown statuses fall back to "neutral" -- matching every
// original file's own `|| "bg-white/10..."` fallback behavior.
const STATUS_TONE = {
  // Generic workflow states (SOW §13's own list)
  DRAFT: "neutral", PENDING: "warning", PENDING_APPROVAL: "warning", UNDER_REVIEW: "warning",
  APPROVED: "success", REJECTED: "danger", ARCHIVED: "neutral", PAID: "success", OVERDUE: "danger",
  ACTIVE: "success", INACTIVE: "neutral", COMPLETED: "success", CANCELLED: "neutral",
  // Tasks
  TODO: "neutral", IN_PROGRESS: "info", BLOCKED: "warning", DONE: "success",
  // CRM deal stages
  NEW: "neutral", QUALIFIED: "info", PROPOSAL: "special", NEGOTIATION: "warning", WON: "success", LOST: "danger",
  // Procurement
  ORDERED: "info", PARTIALLY_RECEIVED: "warning", RECEIVED: "success",
  // Finance
  SENT: "info", RECORDED: "neutral",
  // HR
  ONBOARDING: "info", ON_LEAVE: "warning", TERMINATED: "neutral",
  // AI Action Requests
  QUEUED: "info", EXECUTED: "success", EXPIRED: "neutral",
};

/** `tone` overrides the automatic status->tone lookup for a caller with a
 *  status vocabulary this list doesn't (yet) cover, without needing to
 *  edit this shared file for a one-off. */
export default function StatusBadge({ status, tone, className = "" }) {
  const resolvedTone = tone || STATUS_TONE[status] || "neutral";
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${TONE_CLASSES[resolvedTone]} ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" aria-hidden="true" />
      {status ? String(status).replace(/_/g, " ") : ""}
    </span>
  );
}

export { STATUS_TONE, TONE_CLASSES };
