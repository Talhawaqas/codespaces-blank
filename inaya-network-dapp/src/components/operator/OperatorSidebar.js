"use client";

// src/components/operator/OperatorSidebar.js
//
// Node Operator Dashboard Navigation Update SOW (AuroraX operator
// feedback: "Most dashboards place this kind of navigation on the left").
// Moves the dashboard's 7 existing sections from a horizontal top tab bar
// into a persistent left sidebar, mirroring the exact visual language and
// responsive pattern already established by the Business Workspace's own
// Sidebar (src/app/business/page.js) -- same fixed/overlay mobile
// behavior, same active-item border-l-2 highlight, same group-heading
// style -- redefined locally here rather than importing from business/
// page.js, since that file doesn't export its Sidebar/Icon/ICONS and
// splitting them out is a bigger refactor than this SOW asks for.
//
// Purely a navigation shell: it renders nothing from the 7 section
// components itself and carries no data-fetching of its own, so none of
// the existing node status/uptime/qualification/rewards/telemetry
// functionality is touched.

function Icon({ path, className = "w-[18px] h-[18px]" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {path}
    </svg>
  );
}

const ICONS = {
  overview: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  uptime: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  qualification: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </>
  ),
  rewards: (
    <>
      <path d="M8 4h8v4a4 4 0 0 1-8 0V4Z" />
      <path d="M8 5H5a3 3 0 0 0 3 5M16 5h3a3 3 0 0 1-3 5" />
      <path d="M12 13v3M9 20h6M10 16.5h4v3.5h-4z" />
    </>
  ),
  events: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M7.5 9h9M7.5 12.5h9M7.5 16h5.5" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="4.5" r="2.3" />
      <circle cx="5" cy="18" r="2.3" />
      <circle cx="19" cy="18" r="2.3" />
      <path d="M12 6.8v4.7M10.4 13.6 6.6 16.3M13.6 13.6l3.8 2.7" />
    </>
  ),
  fleet: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
};

const NAV_ITEMS = [
  { key: "overview", label: "Overview", icon: "overview", group: "overview" },
  { key: "uptime", label: "Uptime & Telemetry", icon: "uptime", group: "health" },
  { key: "qualification", label: "Qualification", icon: "qualification", group: "health" },
  { key: "rewards", label: "Tier & Rewards", icon: "rewards", group: "rewards" },
  { key: "events", label: "Events", icon: "events", group: "network" },
  { key: "network", label: "Network", icon: "network", group: "network" },
  { key: "fleet", label: "Fleet", icon: "fleet", group: "network" },
];

const GROUP_LABELS = {
  overview: "Overview",
  health: "Node Health",
  rewards: "Rewards",
  network: "Network",
};

function shortenAddress(address) {
  if (!address || address.length < 10) return address || "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function OperatorSidebar({ activeTab, onNavigate, walletAddress, mobileOpen, onCloseMobile }) {
  return (
    <>
      {mobileOpen && <div onClick={onCloseMobile} className="fixed inset-0 bg-black/60 z-40 md:hidden" />}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-50 w-64 shrink-0 bg-[var(--inaya-surface)] border-r border-[var(--inaya-border)] flex flex-col transition-transform duration-200 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="px-5 py-6 border-b border-[var(--inaya-overlay-5)]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center shrink-0">
              <span className="text-black font-extrabold text-sm">I</span>
            </div>
            <div className="min-w-0">
              <p className="text-[var(--inaya-text-primary)] font-extrabold text-sm leading-tight truncate">Inaya Network</p>
              <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono uppercase tracking-wide">Node Operator</p>
            </div>
          </div>
          <div className="mt-4 bg-black/30 border border-[var(--inaya-overlay-5)] rounded-lg px-3 py-2">
            <p className="text-[#00f2fe] text-[12px] font-mono truncate" title={walletAddress}>{shortenAddress(walletAddress)}</p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {(() => {
            let lastGroup = null;
            return NAV_ITEMS.map((item) => {
              const showHeading = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.key}>
                  {showHeading && (
                    <p className={`px-3 text-[10px] font-bold uppercase tracking-wider text-[var(--inaya-text-muted)] opacity-40 ${item === NAV_ITEMS[0] ? "mb-1.5" : "mt-4 mb-1.5"}`}>
                      {GROUP_LABELS[item.group]}
                    </p>
                  )}
                  <button
                    onClick={() => onNavigate(item.key)}
                    className={`w-full flex items-center gap-3 pl-2.5 pr-3 py-2.5 rounded-lg text-sm font-medium border-l-2 transition-colors ${
                      activeTab === item.key
                        ? "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe] shadow-[-2px_0_8px_rgba(0,242,254,0.35)]"
                        : "text-[var(--inaya-text-muted)] border-transparent hover:bg-[var(--inaya-overlay-5)] hover:text-slate-200"
                    }`}
                  >
                    <Icon path={ICONS[item.icon]} />
                    {item.label}
                  </button>
                </div>
              );
            });
          })()}
        </nav>
      </aside>
    </>
  );
}
