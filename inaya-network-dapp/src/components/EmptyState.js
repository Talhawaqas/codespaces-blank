// src/components/EmptyState.js
//
// Reusable "nothing here yet" treatment, used across the app. Modern look (owner-approved, Nov 2026):
// a calm card with the icon in a soft circle, a sentence-case title, one helpful line and one clear
// action, using the theme tokens so it reads correctly in every theme (light, dark, neon, ERP themes).

export default function EmptyState({ icon = "📭", title, description, ctaLabel, onCta, compact = false }) {
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--inaya-text-muted)]">
        <span aria-hidden="true">{icon}</span>
        <span>{description || title}</span>
        {ctaLabel && onCta && (
          <button onClick={onCta} className="text-[var(--inaya-accent)] font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity">
            {ctaLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-10)] rounded-2xl px-6 py-10 text-center flex flex-col items-center gap-3">
      <span aria-hidden="true" className="w-12 h-12 rounded-full bg-[var(--inaya-accent-soft)] flex items-center justify-center text-2xl">{icon}</span>
      <div>
        {/* Theme tokens, not fixed white: on the Light theme (the Workspace default) a white title was invisible (SQA 17 Nov 2026). */}
        <div className="text-[var(--inaya-text-primary)] font-semibold text-[15px]">{title}</div>
        {description && <p className="text-[var(--inaya-text-muted)] text-[13px] mt-1.5 max-w-sm mx-auto">{description}</p>}
      </div>
      {ctaLabel && onCta && (
        <button
          onClick={onCta}
          className="mt-1 px-4 py-2 rounded-lg text-[13px] font-semibold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] hover:opacity-90 transition-opacity active:scale-95"
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
