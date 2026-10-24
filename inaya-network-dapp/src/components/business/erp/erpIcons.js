// src/components/business/erp/erpIcons.js
//
// ERP mode's module-tile and chrome icons. Same 24x24 stroke style as the
// workspace's own icon set (ui/icons.js), drawn with the shared Icon
// component; kept separate because these are ERP-only shapes.

export const ERP_ICONS = {
  home: (<><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>),
  sales: (<><circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 4.5a3.5 3.5 0 010 7" /><path d="M18 14c2 .7 3 2.8 3 6" /></>),
  purchasing: (<><path d="M3 6h11v10H3z" /><path d="M14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>),
  inventory: (<><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9" /></>),
  accounting: (<><circle cx="12" cy="12" r="9" /><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .9-3 2s1.3 1.7 3 2 3 .9 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5" /><path d="M12 6v2M12 16v2" /></>),
  people: (<><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="10" r="3" /><path d="M8 17c.7-1.8 2.2-3 4-3s3.3 1.2 4 3" /></>),
  documents: (<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />),
  workplace: (<><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" /><path d="M3 13h18" /></>),
  reports: (<><path d="M4 20h16" /><rect x="6" y="11" width="3" height="7" /><rect x="11" y="7" width="3" height="11" /><rect x="16" y="13" width="3" height="5" /></>),
  industry: (<><path d="M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16" /><path d="M15 9h4a1 1 0 011 1v11" /><path d="M8 8h3M8 12h3M8 16h3" /><path d="M2 21h20" /></>),
  admin: (<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>),
  chevronDown: (<path d="M6 9l6 6 6-6" />),
  chevronRight: (<path d="M9 6l6 6-6 6" />),
  panelLeft: (<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>),
  user: (<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></>),
  lock: (<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>),
  check: (<path d="M5 12l5 5L20 7" />),
};
