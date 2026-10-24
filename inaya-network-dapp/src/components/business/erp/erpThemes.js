// src/components/business/erp/erpThemes.js
//
// ERP mode's two light themes (docs/erp-mode-plan.md). The shell chrome
// reads the --erp-* tokens (globals.css, "ERP mode" section). The existing
// screens inside are rendered with the workspace's Light theme adapter, and
// the --inaya-accent* tokens are re-pointed at each theme's accent so every
// screen's buttons, links and highlights match the chrome. Every text/fill
// pair here meets WCAG AA (4.5:1) for body text.

export const ERP_THEME_TOKENS = {
  // Close to a traditional Windows ERP: charcoal title bar, white module
  // tiles, deep-red notice bar, graphite group headers, steel-blue accent.
  classic: {
    "--erp-titlebar-bg": "#2b3035",
    "--erp-titlebar-fg": "#f1f3f5",
    "--erp-titlebar-muted": "#b4bac1",
    "--erp-modbar-bg": "#e4e6e9",
    "--erp-modbar-border": "#b9bec4",
    "--erp-tile-bg": "#ffffff",
    "--erp-tile-border": "#c4c8cd",
    "--erp-tile-fg": "#363c43",
    "--erp-tile-icon": "#59626c",
    "--erp-tile-hover-bg": "#f2f5f8",
    "--erp-tile-active-bg": "#dbe6f3",
    "--erp-tile-active-border": "#2f5d8a",
    "--erp-tile-active-fg": "#163556",
    "--erp-notice-bg": "#8c1d18",
    "--erp-notice-fg": "#ffffff",
    "--erp-notice-muted": "#f3d4d2",
    "--erp-panel-bg": "#f5f6f7",
    "--erp-panel-border": "#b9bec4",
    "--erp-panel-title": "#1f2328",
    "--erp-group-bg": "#3d434a",
    "--erp-group-fg": "#ffffff",
    "--erp-item-fg": "#262b31",
    "--erp-item-icon": "#5f6770",
    "--erp-item-hover-bg": "#e5e8eb",
    "--erp-item-active-bg": "#cfdcec",
    "--erp-item-active-fg": "#122f4d",
    "--erp-item-active-bar": "#2f5d8a",
    "--erp-workspace-bg": "#dcdfe3",
    "--erp-page-header-bg": "#ffffff",
    "--erp-page-header-border": "#b9bec4",
    "--erp-status-bg": "#2b3035",
    "--erp-status-fg": "#cdd1d6",
    "--erp-ok": "#7fd18b",
    "--erp-warn": "#f2c14e",
    "--erp-accent": "#2f5d8a",
    "--erp-accent-hover": "#244a6f",
    "--erp-accent-soft": "#e3ecf6",
    "--erp-accent-soft-hover": "#d3e1f0",
    "--erp-focus": "#2f5d8a",
    "--erp-h-blue": "#2f5d8a",
    "--erp-h-red": "#8c1d18",
    "--erp-h-green": "#3b6d3a",
    "--erp-h-amber": "#9a5a12",
    "--erp-h-purple": "#5b3f8c",
  },
  // Inaya's brand: deep navy chrome, teal accent derived from the brand cyan.
  brand: {
    "--erp-titlebar-bg": "#0b1f33",
    "--erp-titlebar-fg": "#eef6fb",
    "--erp-titlebar-muted": "#a9bccd",
    "--erp-modbar-bg": "#e7eef4",
    "--erp-modbar-border": "#c3d1dd",
    "--erp-tile-bg": "#ffffff",
    "--erp-tile-border": "#c9d6e2",
    "--erp-tile-fg": "#1e3a5f",
    "--erp-tile-icon": "#46698a",
    "--erp-tile-hover-bg": "#f1f7fb",
    "--erp-tile-active-bg": "#ddf3f5",
    "--erp-tile-active-border": "#0e7490",
    "--erp-tile-active-fg": "#0b4f5c",
    "--erp-notice-bg": "#0e7490",
    "--erp-notice-fg": "#ffffff",
    "--erp-notice-muted": "#cdeef3",
    "--erp-panel-bg": "#f5f8fb",
    "--erp-panel-border": "#c3d1dd",
    "--erp-panel-title": "#0b1f33",
    "--erp-group-bg": "#1e3a5f",
    "--erp-group-fg": "#ffffff",
    "--erp-item-fg": "#16283b",
    "--erp-item-icon": "#4c6b88",
    "--erp-item-hover-bg": "#e5edf4",
    "--erp-item-active-bg": "#d3eef1",
    "--erp-item-active-fg": "#08414c",
    "--erp-item-active-bar": "#0e7490",
    "--erp-workspace-bg": "#e4eaf0",
    "--erp-page-header-bg": "#ffffff",
    "--erp-page-header-border": "#c3d1dd",
    "--erp-status-bg": "#0b1f33",
    "--erp-status-fg": "#bccbd9",
    "--erp-ok": "#6fd6c6",
    "--erp-warn": "#f2c14e",
    "--erp-accent": "#0e7490",
    "--erp-accent-hover": "#0b5d74",
    "--erp-accent-soft": "#ddf3f5",
    "--erp-accent-soft-hover": "#c9ebef",
    "--erp-focus": "#0e7490",
    "--erp-h-blue": "#1e3a5f",
    "--erp-h-red": "#a3341f",
    "--erp-h-green": "#0f766e",
    "--erp-h-amber": "#9a5a12",
    "--erp-h-purple": "#4338ca",
  },
};

/** --inaya-* overrides so the existing screens inside pick up the theme's accent and background. */
export function inayaOverridesFor(theme) {
  const t = ERP_THEME_TOKENS[theme] || ERP_THEME_TOKENS.classic;
  return {
    "--inaya-accent": t["--erp-accent"],
    "--inaya-accent-2": t["--erp-accent-hover"],
    "--inaya-accent-soft": t["--erp-accent-soft"],
    "--inaya-bg": t["--erp-workspace-bg"],
  };
}
