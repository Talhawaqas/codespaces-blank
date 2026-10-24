// src/lib/erpPrefs.js
//
// ERP mode (docs/erp-mode-plan.md) -- which Business Workspace layout and
// ERP theme this person uses. Personal and per-device, so it lives in the
// browser (or the desktop app's own WebView storage), never on the org.
// Framework-free and pure apart from the storage handle passed in, so it is
// unit-tested directly (test-ui/erpPrefs.test.js).
//
// Defaults: ERP mode is on in the desktop app and off on the web. Either can
// be switched in Settings > Appearance or the title bar's user menu. A
// ?layout=erp|standard query parameter overrides for one visit (support and
// demos), without being saved.

export const ERP_PREFS_KEY = "inaya_erp_prefs";
export const ERP_PREFS_EVENT = "inaya:erp-prefs";
export const LAYOUTS = ["erp", "standard"];
export const ERP_THEMES = ["classic", "brand"];
export const ERP_THEME_LABELS = { classic: "Classic", brand: "Inaya" };
export const ERP_THEME_DESCRIPTIONS = {
  classic: "Charcoal, graphite and deep red, like a traditional desktop ERP.",
  brand: "Navy and teal, in Inaya's own colours.",
};
// Narrower than this, ERP mode's fixed panels don't fit, so the standard
// (responsive) layout is used whatever the setting says.
export const ERP_MIN_WIDTH = 1024;

const DEFAULTS = { layout: null, theme: "classic", panelCollapsed: false, collapsedGroups: [] };

export function readErpPrefs(storage) {
  try {
    const v = JSON.parse(storage.getItem(ERP_PREFS_KEY) || "null");
    if (!v || typeof v !== "object") return { ...DEFAULTS };
    return {
      layout: LAYOUTS.includes(v.layout) ? v.layout : null,
      theme: ERP_THEMES.includes(v.theme) ? v.theme : DEFAULTS.theme,
      panelCollapsed: !!v.panelCollapsed,
      collapsedGroups: Array.isArray(v.collapsedGroups) ? v.collapsedGroups.filter((g) => typeof g === "string").slice(0, 100) : [],
    };
  } catch {
    // Storage blocked or bad JSON: defaults.
    return { ...DEFAULTS };
  }
}

export function writeErpPrefs(storage, prefs) {
  try {
    storage.setItem(ERP_PREFS_KEY, JSON.stringify({ ...DEFAULTS, ...prefs }));
    return true;
  } catch {
    return false;
  }
}

/** The layout to use: one-visit ?layout= override, then the saved choice, then the platform default. */
export function resolveLayout({ prefs, isDesktop, search = "" }) {
  let override = null;
  try { override = new URLSearchParams(search).get("layout"); } catch { override = null; }
  if (LAYOUTS.includes(override)) return override;
  if (prefs?.layout) return prefs.layout;
  return isDesktop ? "erp" : "standard";
}
