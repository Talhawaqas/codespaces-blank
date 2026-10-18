// src/lib/business-nav.js
//
// Business Workspace gap closure, Batch 3 — per-view URLs and breadcrumbs.
// Pure helpers (no React, no window) so they can be unit-tested and reused:
//   viewUrl()      the URL for a view, keeping unrelated query params
//   viewFromUrl()  the view a URL points at, or the fallback
//   breadcrumbs()  Workspace › <nav group> › <view title>

import { NAV_ITEMS, GROUP_LABELS } from "./navigation/navItems.js";

// "browse" is reached from three nav entries (departments / projects / documents).
const BROWSE_KEYS = ["departments", "projects", "documents"];
// Params that belong to one specific view and must not leak into another.
const VIEW_SCOPED_PARAMS = { documentAutomation: ["doc"] };

/** Returns "?view=x&..." for `view`, preserving params other than view-scoped ones of a different view. */
export function viewUrl(view, currentSearch = "") {
  const params = new URLSearchParams(currentSearch);
  const prev = params.get("view");
  if (prev && prev !== view) for (const p of VIEW_SCOPED_PARAMS[prev] || []) params.delete(p);
  if (view && view !== "osHome") params.set("view", view);
  else params.delete("view");
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** The view named in `search`, if it's one of `knownViews`; otherwise `fallback`. */
export function viewFromUrl(search, knownViews, fallback = "osHome") {
  const v = new URLSearchParams(search || "").get("view");
  if (!v) return fallback;
  if (BROWSE_KEYS.includes(v)) return v;
  return knownViews.includes(v) ? v : fallback;
}

/** [{ label, view|null }] from the workspace root to the current view. */
export function breadcrumbs(view, { titles = {}, browseSection = null } = {}) {
  const crumbs = [{ label: "Workspace", view: "osHome" }];
  if (!view || view === "osHome") return [{ label: "Workspace", view: null }];
  const navKey = view === "browse" ? browseSection || "documents" : view;
  const item = NAV_ITEMS.find((i) => i.key === navKey);
  if (item?.group && GROUP_LABELS[item.group]) crumbs.push({ label: GROUP_LABELS[item.group], view: null });
  crumbs.push({ label: titles[view]?.title || item?.label || view, view: null });
  return crumbs;
}
