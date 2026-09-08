// src/components/business/tileIcons.js
//
// UI Enhancement Specs v2, §1 -- the 4 metric-card watermark glyphs
// OsHomeView.js needs, factored out to a small standalone module rather
// than importing from business/page.js directly: page.js already imports
// OsHomeView.js to render it, so an import the other way around would be
// a circular module dependency. Path data copied verbatim from page.js's
// own ICONS.departments/projects/documents/approvals so the watermark
// matches the sidebar icon exactly, not a redrawn approximation.

export function TileIcon({ name, className = "w-20 h-20" }) {
  const paths = {
    Departments: (
      <>
        <rect x="4" y="3" width="12" height="18" rx="1" />
        <path d="M8 7h1M11 7h1M8 11h1M11 11h1M8 15h1M11 15h1" />
        <path d="M16 21v-7h4v7" />
      </>
    ),
    Projects: <path d="M3 7a1 1 0 0 1 1-1h4l2 2h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />,
    Documents: (
      <>
        <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M14 3v5h5" />
        <rect x="9.5" y="13" width="5" height="4" rx="1" />
        <path d="M10.5 13v-1.5a1.5 1.5 0 0 1 3 0V13" />
      </>
    ),
    "Pending approvals": (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.5 2.5L16 9.5" />
      </>
    ),
  };
  const path = paths[name];
  if (!path) return null;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {path}
    </svg>
  );
}
