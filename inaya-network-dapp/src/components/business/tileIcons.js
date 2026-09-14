// src/components/business/tileIcons.js
//
// UI Enhancement Specs v2, §1 -- the metric-card watermark glyphs
// OsHomeView.js needs, drawn from the one shared icon set
// (components/business/ui/icons.js) instead of the verbatim-copied local
// paths this file used to carry. Business Workspace UX/UI Makeover SOW
// centralized that set specifically to remove this kind of duplication
// (see BUSINESS_WORKSPACE_UX_AUDIT.md #3.1) -- a module under
// components/business/ui/ has no circular-import risk with OsHomeView.js
// the way importing from page.js directly would have.

import { ICONS } from "./ui/icons";

const NAME_TO_ICON_KEY = {
  Departments: "departments",
  Projects: "projects",
  Documents: "documents",
  "Pending approvals": "approvals",
};

export function TileIcon({ name, className = "w-20 h-20" }) {
  const path = ICONS[NAME_TO_ICON_KEY[name]];
  if (!path) return null;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {path}
    </svg>
  );
}
