"use client";

// src/components/business/erp/AppearancePanel.js
//
// ERP mode (docs/erp-mode-plan.md) -- Settings > Appearance. Personal to
// this person on this device: the workspace layout (ERP mode or the standard
// layout) and ERP mode's theme. Shown in Settings and, for everyone, from
// the "Appearance" entry in the standard header and the ERP title bar menu.

import { useErpLayout } from "./useErpPrefs";
import { ERP_THEMES, ERP_THEME_LABELS, ERP_THEME_DESCRIPTIONS, ERP_MIN_WIDTH } from "../../../lib/erpPrefs";
import { ERP_THEME_TOKENS } from "./erpThemes";

function ThemePreview({ theme }) {
  const t = ERP_THEME_TOKENS[theme];
  return (
    <div aria-hidden="true" className="rounded-md overflow-hidden border" style={{ borderColor: t["--erp-panel-border"], background: t["--erp-workspace-bg"] }}>
      <div style={{ background: t["--erp-titlebar-bg"], height: 8 }} />
      <div className="flex gap-1 p-1" style={{ background: t["--erp-modbar-bg"] }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex-1 h-4 rounded-sm border" style={{ background: i === 1 ? t["--erp-tile-active-bg"] : t["--erp-tile-bg"], borderColor: i === 1 ? t["--erp-tile-active-border"] : t["--erp-tile-border"] }} />
        ))}
      </div>
      <div style={{ background: t["--erp-notice-bg"], height: 5 }} />
      <div className="flex" style={{ height: 46 }}>
        <div className="w-1/4 p-1 space-y-1" style={{ background: t["--erp-panel-bg"] }}>
          <div style={{ background: t["--erp-group-bg"], height: 5 }} />
          <div style={{ background: t["--erp-item-active-bg"], height: 5 }} />
          <div style={{ background: t["--erp-group-bg"], height: 5 }} />
        </div>
        <div className="flex-1 grid grid-cols-2 gap-1 p-1">
          {["--erp-h-blue", "--erp-h-red", "--erp-h-green", "--erp-h-purple"].map((h) => (
            <div key={h} className="bg-white rounded-sm overflow-hidden"><div style={{ background: t[h], height: 4 }} /></div>
          ))}
        </div>
      </div>
      <div style={{ background: t["--erp-status-bg"], height: 5 }} />
    </div>
  );
}

export default function AppearancePanel() {
  const { layout, wide, prefs, update, desktop } = useErpLayout();
  const option = (value, label, hint) => (
    <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${layout === value ? "border-[var(--inaya-accent)] bg-[var(--inaya-accent-soft)]" : "border-[var(--inaya-border)]"}`}>
      <input type="radio" name="bw-layout" className="mt-1" checked={layout === value} onChange={() => update({ layout: value })} />
      <span>
        <span className="block text-sm font-bold text-[var(--inaya-text-primary)]">{label}</span>
        <span className="block text-[13px] text-[var(--inaya-text-muted)]">{hint}</span>
      </span>
    </label>
  );

  return (
    <section className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl p-5 space-y-5" aria-labelledby="bw-appearance-title">
      <div>
        <h2 id="bw-appearance-title" className="text-[var(--inaya-text-primary)] font-bold text-base">Appearance</h2>
        <p className="text-[var(--inaya-text-muted)] text-[13px] mt-1">
          Your own choice on this {desktop ? "computer" : "browser"}. It doesn&apos;t change anything for the rest of your team.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[12px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-2">Layout</legend>
        <div className="grid gap-2 md:grid-cols-2">
          {option("erp", "ERP mode", "Module tiles across the top and a task panel on the left, like a classic desktop ERP.")}
          {option("standard", "Standard layout", "The sidebar layout, which also works on tablets and phones.")}
        </div>
        {layout === "erp" && !wide && (
          <p className="text-[13px] text-[var(--inaya-warning)]">ERP mode needs a window at least {ERP_MIN_WIDTH}px wide. Until it&apos;s wider, the standard layout is shown.</p>
        )}
      </fieldset>

      <fieldset>
        <legend className="text-[12px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-2">ERP mode theme</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {ERP_THEMES.map((t) => (
            <label key={t} className={`block p-3 rounded-lg border cursor-pointer ${prefs.theme === t ? "border-[var(--inaya-accent)] bg-[var(--inaya-accent-soft)]" : "border-[var(--inaya-border)]"}`}>
              <ThemePreview theme={t} />
              <span className="flex items-start gap-2 mt-3">
                <input type="radio" name="bw-erp-theme" className="mt-1" checked={prefs.theme === t} onChange={() => update({ theme: t })} />
                <span>
                  <span className="block text-sm font-bold text-[var(--inaya-text-primary)]">{ERP_THEME_LABELS[t]}</span>
                  <span className="block text-[13px] text-[var(--inaya-text-muted)]">{ERP_THEME_DESCRIPTIONS[t]}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
