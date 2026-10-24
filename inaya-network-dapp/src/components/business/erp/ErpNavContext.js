"use client";

// src/components/business/erp/ErpNavContext.js
//
// ERP mode (docs/erp-mode-plan.md). Lets the task panel drive the sections a
// screen already has (Finance's Invoices/Expenses/... tabs) and open a
// screen's own "New ..." form, without threading props through every view.
// Outside ERP mode nothing changes: tabs stay visible, and a screen only
// follows ?section= when the URL names one.
//
//   const [tab, setTab] = useErpSection("invoices", ["invoices", "expenses"]);
//   const [tab, setTab] = useErpSection("overview", TABS);   // [[key, label], ...] also lists them in the task panel
//   const tabsHidden = useErpTabsHidden();
//   useErpCreate("invoices", () => setShowCreate(true));

import { createContext, useContext, useEffect, useRef, useState } from "react";

export const ErpNavContext = createContext({
  erp: false, section: null, request: null,
  consumeRequest: () => {}, reportSection: () => {}, registerSections: () => {},
});

const keyOf = (s) => (Array.isArray(s) ? s[0] : s);

/**
 * A screen's current section. Follows the task panel and ?section=, and falls back to
 * `defaultSection`. `sections` is a list of keys, or of [key, label] pairs: with labels,
 * ERP mode also lists them in the task panel under the screen (pass them only from the
 * screen's top-level tabs, never from a nested panel).
 */
export function useErpSection(defaultSection, sections) {
  const { erp, section, reportSection, registerSections } = useContext(ErpNavContext);
  const keys = sections.map(keyOf);
  const valid = (s) => !!s && keys.includes(s);
  const [tab, setTabState] = useState(() => (valid(section) ? section : defaultSection));

  useEffect(() => {
    setTabState(valid(section) ? section : defaultSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // Labelled sections are listed in the task panel while this screen is open.
  const labelled = sections.every(Array.isArray) ? JSON.stringify(sections) : null;
  useEffect(() => {
    if (!erp || !labelled) return undefined;
    registerSections({ list: JSON.parse(labelled), defaultSection });
    return () => registerSections(null);
  }, [erp, labelled, defaultSection, registerSections]);

  // A screen switching its own section (a "View contact" link, say) keeps the
  // task panel and the URL in step in ERP mode.
  const setTab = (next) => {
    setTabState(next);
    if (erp) reportSection(next);
  };
  return [tab, setTab];
}

/** True in ERP mode, where the task panel replaces a screen's own tab bar. */
export function useErpTabsHidden() {
  return useContext(ErpNavContext).erp;
}

/** Runs `open` once for each "New ..." request from the task panel aimed at this section. The
 *  request is then consumed, so coming back to the screen later doesn't reopen the form. */
export function useErpCreate(section, open) {
  const { request, consumeRequest } = useContext(ErpNavContext);
  const handled = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!request || request.action !== "new" || request.section !== section || handled.current === request.id) return;
    handled.current = request.id;
    openRef.current();
    consumeRequest(request.id);
  }, [request, section, consumeRequest]);
}
