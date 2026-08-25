// src/components/EmptyState.js
//
// Reusable "nothing here yet" treatment. Every empty state in this app
// used to be a one-off bare italic comment line (e.g. "// Drive is
// empty.") with no icon, no CTA, no visual weight -- this replaces that
// pattern once, consistently, matching the card language already used
// everywhere else (bg-black/20, border-white/5, rounded-2xl).

export default function EmptyState({ icon = "📭", title, description, ctaLabel, onCta, compact = false }) {
  if (compact) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[#8a96ab] font-mono italic">
        <span className="not-italic">{icon}</span>
        <span>{description || title}</span>
        {ctaLabel && onCta && (
          <button onClick={onCta} className="text-[#00f2fe] font-bold not-italic underline underline-offset-2 hover:text-white transition-colors">
            {ctaLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-2xl p-10 text-center flex flex-col items-center gap-3">
      <span className="text-3xl opacity-70">{icon}</span>
      <div>
        <div className="text-white font-bold text-sm">{title}</div>
        {description && <p className="text-[#8a96ab] text-xs mt-1.5 max-w-sm mx-auto">{description}</p>}
      </div>
      {ctaLabel && onCta && (
        <button
          onClick={onCta}
          className="mt-2 px-5 py-2 rounded-full text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] transition-transform active:scale-95"
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
