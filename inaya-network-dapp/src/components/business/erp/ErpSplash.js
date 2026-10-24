"use client";

// src/components/business/erp/ErpSplash.js
//
// ERP mode (docs/erp-mode-plan.md): what the window shows while the session
// loads, instead of the website-style "Loading…" page. An application start
// screen in the chosen ERP theme.

import { ERP_THEME_TOKENS } from "./erpThemes";

export default function ErpSplash({ theme = "classic", message = "Signing you in…" }) {
  const t = ERP_THEME_TOKENS[theme] || ERP_THEME_TOKENS.classic;
  return (
    <div className="erp-splash" style={{ background: t["--erp-titlebar-bg"], color: t["--erp-titlebar-fg"] }} role="status" aria-live="polite">
      <div className="erp-splash-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/inaya-logo.png" alt="" className="erp-splash-logo" width={64} height={64} />
        <p className="erp-splash-title">Inaya Network</p>
        <p className="erp-splash-msg" style={{ color: t["--erp-titlebar-muted"] }}>Business Workspace · Your encrypted business operating system</p>
        <p className="erp-splash-msg" style={{ color: t["--erp-titlebar-muted"] }}>{message}</p>
        <div className="erp-splash-bar" aria-hidden="true"><span style={{ background: t["--erp-accent-soft"] }} /></div>
      </div>
    </div>
  );
}
