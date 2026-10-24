"use client";

// src/components/business/erp/useErpPrefs.js
//
// ERP mode (docs/erp-mode-plan.md) -- React bindings for src/lib/erpPrefs.js.
// Every component using the hook stays in sync (Settings > Appearance, the
// title bar menu and the workspace shell) through one window event, and
// other windows of the desktop app through the storage event.

import { useCallback, useEffect, useState } from "react";
import { readErpPrefs, writeErpPrefs, resolveLayout, ERP_PREFS_EVENT, ERP_MIN_WIDTH } from "../../../lib/erpPrefs";

const isBrowser = () => typeof window !== "undefined";

export const isDesktopApp = () => isBrowser() && !!window.__TAURI__;

export function useErpPrefs() {
  const [prefs, setPrefs] = useState(() => (isBrowser() ? readErpPrefs(window.localStorage) : readErpPrefs({ getItem: () => null })));

  useEffect(() => {
    const reload = () => setPrefs(readErpPrefs(window.localStorage));
    window.addEventListener(ERP_PREFS_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(ERP_PREFS_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  const update = useCallback((patch) => {
    const next = { ...readErpPrefs(window.localStorage), ...patch };
    writeErpPrefs(window.localStorage, next);
    setPrefs(next);
    // An explicit choice replaces a one-visit ?layout= override, otherwise
    // the switch would appear to do nothing until the page is reloaded.
    if ("layout" in patch) {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has("layout")) {
          url.searchParams.delete("layout");
          window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
        }
      } catch { /* URL cleanup is cosmetic */ }
    }
    window.dispatchEvent(new CustomEvent(ERP_PREFS_EVENT));
  }, []);

  return [prefs, update];
}

/** Whether ERP mode is showing right now, plus the inputs that decided it. */
export function useErpLayout() {
  const [prefs, update] = useErpPrefs();
  const [wide, setWide] = useState(() => !isBrowser() || window.innerWidth >= ERP_MIN_WIDTH);
  const [search, setSearch] = useState(() => (isBrowser() ? window.location.search : ""));

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${ERP_MIN_WIDTH}px)`);
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    const onUrl = () => setSearch(window.location.search);
    window.addEventListener(ERP_PREFS_EVENT, onUrl);
    window.addEventListener("popstate", onUrl);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener(ERP_PREFS_EVENT, onUrl);
      window.removeEventListener("popstate", onUrl);
    };
  }, []);

  const desktop = isDesktopApp();
  const layout = resolveLayout({ prefs, isDesktop: desktop, search });
  return { active: layout === "erp" && wide, layout, wide, prefs, update, desktop };
}
