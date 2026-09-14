// src/components/business/ui/FormField.js
//
// Business Workspace UX/UI Makeover SOW -- fixes a real accessibility gap
// found in the audit: no form anywhere in the Workspace has a real
// <label> element (placeholder text doubles as the label everywhere --
// see BUSINESS_WORKSPACE_UX_AUDIT.md #3.4). This wraps an existing input/
// select/textarea (passed as `children`, unchanged) with a real, properly
// associated <label>, so migrating a form means adding this wrapper
// around what's already there rather than rewriting the input itself.
//
// Visual weight is deliberately small (an uppercase micro-label) so
// adopting this doesn't change a form's existing density/look beyond
// adding the one thing that was missing.

export default function FormField({ label, htmlFor, required = false, hint, className = "", children }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="block text-[11px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-[var(--inaya-text-muted)] mt-1">{hint}</p>}
    </div>
  );
}
