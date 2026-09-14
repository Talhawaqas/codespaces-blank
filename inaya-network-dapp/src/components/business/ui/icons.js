// src/components/business/ui/icons.js
//
// Business Workspace UX/UI Makeover SOW -- the sidebar's icon system,
// moved here from src/app/business/page.js (previously local/unexported,
// reinvented independently in tileIcons.js and operator/OperatorSidebar.js
// per the UX audit's finding #3.1). A module under components/business/ui/
// has no circular-import risk with OsHomeView.js the way page.js itself
// did (tileIcons.js's own header comment explains that original
// constraint) -- so this is the one real source of truth now.
//
// Deliberately NOT touching operator/OperatorSidebar.js's own small icon
// set: that's a different app section (Node Operator Dashboard) outside
// this SOW's scope, with its own operator-specific icon keys (uptime,
// fleet, etc.) that don't belong in the Business Workspace's icon set.

export function Icon({ path, className = "w-[18px] h-[18px]" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {path}
    </svg>
  );
}

export const ICONS = {
  health: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  legal: (
    <>
      <path d="M12 3v18M5 7h14M5 7l-3 6a3 3 0 0 0 6 0l-3-6M19 7l-3 6a3 3 0 0 0 6 0l-3-6" />
    </>
  ),
  regulated: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  financial: (
    <>
      <path d="M3 17l5-6 4 4 8-9" />
      <path d="M14 6h6v6" />
    </>
  ),
  government: (
    <>
      <path d="M12 3l9 5H3l9-5z" />
      <path d="M5 10v8M9 10v8M15 10v8M19 10v8M3 21h18" />
    </>
  ),
  resilience: (
    <>
      <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  integrations: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M8.5 8.5l7 7M6 9v6a3 3 0 0 0 3 3h3" />
    </>
  ),
  executive: (
    <>
      <path d="M3 21h18M6 21V10l6-4 6 4v11M10 21v-6h4v6" />
    </>
  ),
  dataRooms: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M3 7l3-4h6l2 4" />
    </>
  ),
  enterpriseHardening: (
    <>
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  departments: (
    <>
      <rect x="4" y="3" width="12" height="18" rx="1" />
      <path d="M8 7h1M11 7h1M8 11h1M11 11h1M8 15h1M11 15h1" />
      <path d="M16 21v-7h4v7" />
    </>
  ),
  projects: <path d="M3 7a1 1 0 0 1 1-1h4l2 2h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />,
  documents: (
    <>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5" />
      <rect x="9.5" y="13" width="5" height="4" rx="1" />
      <path d="M10.5 13v-1.5a1.5 1.5 0 0 1 3 0V13" />
    </>
  ),
  approvals: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </>
  ),
  tasks: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M7.5 9l1.8 1.8L12.5 7.5" />
      <path d="M15 8.5h4" />
      <path d="M7.5 16h9" />
    </>
  ),
  crm: (
    <>
      <circle cx="9" cy="7.5" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16.5 8.5a2.5 2.5 0 1 0 0-5" />
      <path d="M15.5 15c3.5 0 5 2 5 5" />
    </>
  ),
  procurement: (
    <>
      <path d="M3 7l2-4h14l2 4" />
      <path d="M3 7h18v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
      <path d="M8 11a4 4 0 0 0 8 0" />
    </>
  ),
  inventory: (
    <>
      <path d="M3 8l9-5 9 5-9 5-9-5Z" />
      <path d="M3 8v9l9 5 9-5V8" />
      <path d="M12 13v9" />
    </>
  ),
  activity: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  aiAssistant: (
    <>
      <path d="M12 3a1 1 0 0 1 1 1v1.06a7.5 7.5 0 0 1 6.94 6.94H21a1 1 0 0 1 0 2h-1.06a7.5 7.5 0 0 1-6.94 6.94V22a1 1 0 0 1-2 0v-1.06a7.5 7.5 0 0 1-6.94-6.94H3a1 1 0 0 1 0-2h1.06A7.5 7.5 0 0 1 11 5.06V4a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
  send: <path d="M4 12l16-8-6 8 6 8-16-8Z" />,
  logout: (
    <>
      <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  chevronRight: <path d="M9 18l6-6-6-6" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  billing: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19" />
      <path d="M6 15h4" />
    </>
  ),
  finance: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10" />
      <path d="M15 9.5a3 3 0 0 0-3-1.5c-1.7 0-3 1-3 2.2 0 3 6 1.5 6 4.3 0 1.2-1.3 2.2-3 2.2a3 3 0 0 1-3-1.5" />
    </>
  ),
  hr: (
    <>
      <circle cx="8.5" cy="7.5" r="3.2" />
      <path d="M2.5 20.5a6 6 0 0 1 12 0" />
      <path d="M16 4.5a3.2 3.2 0 0 1 0 6.4" />
      <path d="M14.5 14.5c2.8 0 5 1.9 5.5 4.6" />
      <path d="M18.5 8.5v3M17 10h3" />
    </>
  ),
  insights: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 15l3-4 3 2.5L17 8" />
      <circle cx="17" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
};

// The gear icon's cutout path above is fiddly to hand-write cleanly; use a
// simpler bolt-free cog approximation instead so it actually renders well
// at 18px.
ICONS.settings = (
  <>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7L16 16M8 8 6.3 6.3" />
  </>
);
