"use client";

// src/components/business/ui/Modal.js
//
// Business Workspace UX/UI Makeover SOW -- extracted verbatim from the 12
// byte-identical local `function Modal(...)` copies found across
// CRMView.js, TasksView.js, FinanceView.js, AttestationsView.js,
// HRView.js, HealthView.js, FinancialView.js, EscrowView.js,
// ProcurementView.js, SignView.js, LegalView.js, InventoryView.js (see
// BUSINESS_WORKSPACE_UX_AUDIT.md #3.1). Behavior and visual output are
// unchanged from the original wherever adopted -- this is a dedup, not a
// redesign. `wide` matches FinanceView's own optional variant.

export default function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full ${wide ? "max-w-lg" : "max-w-md"} max-h-[85vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
