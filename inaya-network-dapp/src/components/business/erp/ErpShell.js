"use client";

// src/components/business/erp/ErpShell.js
//
// ERP mode (docs/erp-mode-plan.md): the classic desktop-ERP frame around the
// existing Business Workspace screens. Title bar (app, company, signed-in
// user), module tiles, a notice bar, a task panel of collapsible groups, the
// page itself, and a status bar.
//
// It only arranges what the standard layout already offers. Which views a
// person can open still comes from NAV_ITEMS + isNavItemVisible (passed in
// as `visibleItems`), and every screen is the same component the standard
// layout renders (passed in as `children`).

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, ICONS } from "../ui/icons";
import { ERP_ICONS } from "./erpIcons";
import { ERP_THEME_TOKENS, inayaOverridesFor } from "./erpThemes";
import { erpLayout, erpModuleFor, erpActiveItem, erpLabelFor, erpIconFor, erpListsSections, parseErpItem } from "../../../lib/navigation/erpModules";
import { ERP_THEMES, ERP_THEME_LABELS, ERP_THEME_DESCRIPTIONS } from "../../../lib/erpPrefs";
import { useTheme } from "../../ThemeProvider";
import { THEME_STORAGE_KEY, isValidTheme } from "../../../lib/theme";

const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };

/** Forces the workspace's Light theme (unsaved) while ERP mode is showing, with the ERP theme's accent. */
function useErpDocumentTheme(erpTheme) {
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (theme !== "white") { setTheme("white", { persist: false }); return; }
    const root = document.documentElement;
    root.setAttribute("data-erp-theme", erpTheme);
    for (const [k, v] of Object.entries(inayaOverridesFor(erpTheme))) root.style.setProperty(k, v);
  }, [theme, erpTheme, setTheme]);

  // Leaving ERP mode: give the person back the site theme they chose.
  useEffect(() => () => {
    document.documentElement.removeAttribute("data-erp-theme");
    let stored = null;
    try { stored = window.localStorage.getItem(THEME_STORAGE_KEY); } catch { stored = null; }
    setTheme(isValidTheme(stored) ? stored : "white", { persist: false });
  }, [setTheme]);
}

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);
  return online;
}

/** Owners/admins: how many documents in this company are waiting for their approval. */
function usePendingApprovals(orgId, enabled) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) { setCount(0); return undefined; }
    let stopped = false;
    const load = () => fetch("/api/orgs/pending-approvals", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (stopped || !d) return;
        const mine = (list) => (list || []).filter((x) => x.orgId === orgId).length;
        setCount(mine(d.documents) + mine(d.generatedDocuments));
      })
      .catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { stopped = true; clearInterval(t); };
  }, [orgId, enabled]);
  return count;
}

function useAppVersion(desktop) {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    if (!desktop) return;
    try { window.__TAURI__?.app?.getVersion?.().then(setVersion).catch(() => {}); } catch { /* version is informational */ }
  }, [desktop]);
  return version;
}

function useClock() {
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function UserMenu({ email, role, prefs, onUpdatePrefs, onNavigate, onLogout, desktop }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const go = (view) => { setOpen(false); onNavigate(view); };

  return (
    <div className="erp-usermenu" ref={ref}>
      <button type="button" className="erp-titlebar-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon path={ERP_ICONS.user} className="w-3.5 h-3.5" />
        <span className="erp-titlebar-user">{email}</span>
        <span className="erp-titlebar-muted">({ROLE_LABELS[role] || role})</span>
        <Icon path={ERP_ICONS.chevronDown} className="w-3 h-3" />
      </button>
      {open && (
        <div className="erp-menu" role="menu" aria-label="Account and appearance">
          <div className="erp-menu-head">
            <p className="erp-menu-strong">{email}</p>
            <p className="erp-menu-muted">{ROLE_LABELS[role] || role}</p>
          </div>
          <p className="erp-menu-label">Layout</p>
          <button type="button" role="menuitemradio" aria-checked={true} className="erp-menu-item" onClick={() => setOpen(false)}>
            <Icon path={ERP_ICONS.check} className="w-3.5 h-3.5" /> ERP mode
          </button>
          <button type="button" role="menuitemradio" aria-checked={false} className="erp-menu-item erp-menu-item-plain" onClick={() => { setOpen(false); onUpdatePrefs({ layout: "standard" }); }}>
            Standard layout
          </button>
          <p className="erp-menu-label">Theme</p>
          {ERP_THEMES.map((t) => (
            <button key={t} type="button" role="menuitemradio" aria-checked={prefs.theme === t} title={ERP_THEME_DESCRIPTIONS[t]} className={`erp-menu-item ${prefs.theme === t ? "" : "erp-menu-item-plain"}`} onClick={() => onUpdatePrefs({ theme: t })}>
              {prefs.theme === t && <Icon path={ERP_ICONS.check} className="w-3.5 h-3.5" />}
              <span className="erp-swatch" data-swatch={t} aria-hidden="true" />
              {ERP_THEME_LABELS[t]}
            </button>
          ))}
          <div className="erp-menu-sep" />
          <button type="button" role="menuitem" className="erp-menu-item erp-menu-item-plain" onClick={() => go("security")}>Account security</button>
          <a role="menuitem" className="erp-menu-item erp-menu-item-plain" href="/docs/business-workspace-guide.md" download>Download the setup guide</a>
          {!desktop && <a role="menuitem" className="erp-menu-item erp-menu-item-plain" href="/business/download">Get the desktop app</a>}
          <a role="menuitem" className="erp-menu-item erp-menu-item-plain" href="/">Inaya Network dApp</a>
          <div className="erp-menu-sep" />
          <button type="button" role="menuitem" className="erp-menu-item erp-menu-item-plain" onClick={() => { setOpen(false); onLogout(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

export default function ErpShell({
  orgId, orgName, email, role, canManage, orgs, selectedOrgId, onSwitchOrg, onLogout,
  activeView, browseSection, section, screenSections, onNavigate, visibleItems, pins = [],
  title, description, prefs, onUpdatePrefs, desktop, search, notifications, children,
}) {
  useErpDocumentTheme(prefs.theme);
  const online = useOnline();
  const pending = usePendingApprovals(orgId, canManage);
  const version = useAppVersion(desktop);
  const now = useClock();
  const contentRef = useRef(null);

  const modules = useMemo(() => erpLayout({ visibleKeys: visibleItems.map((i) => i.key) }), [visibleItems]);
  const activeModuleId = erpModuleFor(activeView, browseSection);
  const activeModule = modules.find((m) => m.id === activeModuleId) || modules[0];
  const activeItem = erpActiveItem(activeView, browseSection, section);
  // Opens a task-panel item: a screen, one of its sections, or its "New ..." form.
  const open = (it) => onNavigate(it.view, it.section || it.action ? { section: it.section, action: it.action } : undefined);

  // Home's task panel leads with the person's own pinned shortcuts.
  const panelGroups = useMemo(() => {
    if (!activeModule) return [];
    if (activeModule.id !== "home") return activeModule.groups;
    const visible = new Set(visibleItems.map((i) => i.key));
    const shortcuts = [...new Set(pins)].filter((k) => visible.has(k)).map((k) => ({ ...parseErpItem(k), label: erpLabelFor(k), icon: erpIconFor(k) }));
    return shortcuts.length ? [{ id: "shortcuts", label: "My shortcuts", items: shortcuts }, ...activeModule.groups] : activeModule.groups;
  }, [activeModule, pins, visibleItems]);

  const collapsed = new Set(prefs.collapsedGroups);
  const toggleGroup = (gid) => {
    const id = `${activeModule.id}:${gid}`;
    const next = collapsed.has(id) ? prefs.collapsedGroups.filter((g) => g !== id) : [...prefs.collapsedGroups, id];
    onUpdatePrefs({ collapsedGroups: next });
  };

  // Each page starts at the top, like switching screens in a desktop app.
  useEffect(() => { contentRef.current?.scrollTo?.({ top: 0 }); }, [activeView, browseSection]);

  // Alt+1..9 opens the module tiles in order; Alt+0 the tenth.
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const n = e.key === "0" ? 10 : Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > modules.length) return;
      e.preventDefault();
      open(modules[n - 1].home);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules, onNavigate]);

  const groupOfActive = panelGroups.find((g) => g.items.some((i) => i.key === activeItem));
  const themeVars = ERP_THEME_TOKENS[prefs.theme] || ERP_THEME_TOKENS.classic;

  return (
    <div className="bw erp" data-erp-theme={prefs.theme} style={themeVars}>
      <header className="erp-titlebar">
        <div className="erp-titlebar-left">
          <span className="erp-logo" aria-hidden="true">I</span>
          <span className="erp-titlebar-app">Inaya Business Workspace</span>
          <span className="erp-titlebar-sep" aria-hidden="true">|</span>
          {orgs.length > 1 ? (
            <label className="erp-org">
              <span className="sr-only">Company</span>
              <select value={selectedOrgId || ""} onChange={(e) => onSwitchOrg(e.target.value)} className="erp-org-select">
                {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.orgName}</option>)}
              </select>
            </label>
          ) : (
            <span className="erp-titlebar-org">{orgName}</span>
          )}
        </div>
        <UserMenu email={email} role={role} prefs={prefs} onUpdatePrefs={onUpdatePrefs} onNavigate={onNavigate} onLogout={onLogout} desktop={desktop} />
      </header>

      <div className="erp-modbar">
        <nav className="erp-tiles" aria-label="Modules">
          {modules.map((m, i) => {
            const active = m.id === activeModule?.id;
            return (
              <button
                key={m.id}
                type="button"
                className={`erp-tile ${active ? "is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                title={`${m.label}${i < 10 ? ` (Alt+${(i + 1) % 10})` : ""}`}
                onClick={() => open(m.home)}
              >
                <Icon path={ERP_ICONS[m.icon] || ERP_ICONS.home} className="erp-tile-icon" />
                <span className="erp-tile-label">{m.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="erp-tools">
          {search}
          {notifications}
        </div>
      </div>

      <div className="erp-notice" role="status">
        <p className="erp-notice-crumbs">
          <span>{activeModule?.label}</span>
          {groupOfActive && activeModule?.id !== "industry" && <><span aria-hidden="true"> › </span><span>{groupOfActive.label}</span></>}
          <span aria-hidden="true"> › </span>
          <strong>{title}</strong>
        </p>
        {!online ? (
          <p className="erp-notice-alert">You&apos;re offline. Changes can&apos;t be saved until the connection is back.</p>
        ) : pending > 0 ? (
          <button type="button" className="erp-notice-action" onClick={() => onNavigate("approvals")}>
            {pending} {pending === 1 ? "item is" : "items are"} waiting for your approval. Review
          </button>
        ) : null}
      </div>

      <div className="erp-body">
        {prefs.panelCollapsed ? (
          <button type="button" className="erp-panel-rail" onClick={() => onUpdatePrefs({ panelCollapsed: false })} aria-label="Show the task panel" title="Show the task panel">
            <Icon path={ERP_ICONS.chevronRight} className="w-4 h-4" />
          </button>
        ) : (
          <aside className="erp-panel" aria-label={`${activeModule?.label || ""} tasks`}>
            <div className="erp-panel-title">
              <span>{activeModule?.label}</span>
              <button type="button" className="erp-panel-hide" onClick={() => onUpdatePrefs({ panelCollapsed: true })} aria-label="Hide the task panel" title="Hide the task panel">
                <Icon path={ERP_ICONS.panelLeft} className="w-4 h-4" />
              </button>
            </div>
            <nav className="erp-groups">
              {panelGroups.map((g) => {
                const isCollapsed = collapsed.has(`${activeModule.id}:${g.id}`);
                return (
                  <div key={g.id} className="erp-group">
                    <button type="button" className="erp-group-head" aria-expanded={!isCollapsed} onClick={() => toggleGroup(g.id)}>
                      <span>{g.label}</span>
                      <Icon path={isCollapsed ? ERP_ICONS.chevronRight : ERP_ICONS.chevronDown} className="w-3 h-3" />
                    </button>
                    {!isCollapsed && (
                      <ul className="erp-items">
                        {g.items.map((it) => {
                          const sel = !it.action && it.key === activeItem;
                          // The open screen's own sections, when this panel doesn't list them itself.
                          const subs = sel && screenSections?.list?.length && !erpListsSections(it.view) ? screenSections.list : null;
                          const curSub = section || screenSections?.defaultSection;
                          return (
                            <li key={it.key}>
                              <button type="button" className={`erp-item ${it.action ? "erp-item-action" : ""} ${sel ? "is-active" : ""}`} aria-current={sel && !subs ? "page" : undefined} onClick={() => open(it)}>
                                {it.action
                                  ? <span className="erp-item-icon erp-item-plus" aria-hidden="true">+</span>
                                  : it.icon && ICONS[it.icon] ? <Icon path={ICONS[it.icon]} className="erp-item-icon" /> : <span className="erp-item-icon" />}
                                <span className="erp-item-label">{it.label}</span>
                              </button>
                              {subs && (
                                <ul className="erp-subitems">
                                  {subs.map(([key, label]) => (
                                    <li key={key}>
                                      <button type="button" className={`erp-subitem ${key === curSub ? "is-active" : ""}`} aria-current={key === curSub ? "page" : undefined} onClick={() => onNavigate(it.view, { section: key })}>
                                        {label}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </nav>
          </aside>
        )}

        <main className="erp-content" ref={contentRef} id="erp-content">
          <div className="erp-page-header">
            <h1 className="erp-page-title">{title}</h1>
            {description && <p className="erp-page-desc">{description}</p>}
          </div>
          <div className="erp-page">{children}</div>
        </main>
      </div>

      <footer className="erp-status">
        <span className="erp-status-cell">
          <span className={`erp-dot ${online ? "is-ok" : "is-warn"}`} aria-hidden="true" />
          {online ? "Connected" : "Offline"}
        </span>
        <span className="erp-status-cell">
          <Icon path={ERP_ICONS.lock} className="w-3 h-3" /> Encrypted end to end (AES-256, client-side)
        </span>
        <span className="erp-status-cell erp-status-grow">{orgName} · {ROLE_LABELS[role] || role}</span>
        {now && <span className="erp-status-cell">{now.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} {now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
        <span className="erp-status-cell">{desktop ? `Desktop app${version ? ` ${version}` : ""}` : "Web"}</span>
      </footer>
    </div>
  );
}
