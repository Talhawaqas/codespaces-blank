// src/components/business/ui/RecordRow.js
//
// Business Workspace UX/UI Makeover SOW -- codifies the clickable
// row-card pattern found byte-identical across CRMView.js/FinanceView.js/
// etc. (see BUSINESS_WORKSPACE_UX_AUDIT.md #3.1: "bg-black/20 border
// border-white/5 rounded-lg p-3" rows inside a "bg-[var(--inaya-surface)]
// border border-white/5 rounded-2xl p-5" card, space-y-2 between rows).
//
// One real, low-risk mobile fix folded in here (SOW §10/§30): rows stack
// vertically on the smallest screens instead of forcing `left`/`right`
// content into one cramped line -- every file that adopts RecordRow gets
// this for free instead of needing its own responsive pass.

export function RecordList({ children, className = "" }) {
  return <div className={`bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 ${className}`}>{children}</div>;
}

export function RecordRows({ children }) {
  return <div className="space-y-2">{children}</div>;
}

export default function RecordRow({ onClick, left, right, className = "" }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 sm:justify-between bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5 ${className}`}
    >
      <div className="min-w-0">{left}</div>
      {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
    </button>
  );
}
