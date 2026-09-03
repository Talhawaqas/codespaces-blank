"use client";

// src/contexts/OrgContext.js
//
// Enterprise OS SOW, Phase 1 — the identity/org context Business Workspace
// never had. Before this, src/app/business/page.js's BusinessPage owned
// `session`/`selectedOrgId` as plain useState and prop-drilled `email`,
// `membership`, `orgs`, `selectedOrgId`, `onSwitchOrg`, `onLogout` down
// into Workspace and every view component individually. This context owns
// the exact same state (moved, not duplicated) so any component under
// Workspace can read it via useOrg() without a prop being threaded
// through every intermediate component.
//
// The `can` object is a thin wrapper over orgGates.js's pure gate
// functions (canManageOrg, canAccessDepartment, ...) — those are
// re-exported from orgs.js too, but orgs.js itself imports node:crypto
// and the mongodb driver, which can't go in a client bundle. orgGates.js
// is the client-safe extraction of just the pure logic; this file is the
// only thing that should ever need to import it directly on the client.
//
// Mirrors ThemeProvider.js's shape (the only other Context in this
// codebase) deliberately, for the same reason: createContext + a Provider
// owning real state + a use*() hook, nothing more elaborate.

import { createContext, useContext, useState, useCallback, useMemo } from "react";
import {
  canManageOrg,
  canAccessDepartment,
  canManageFinance,
  canAccessFinance,
  canManageHR,
  canAccessHR,
  isDepartmentManager,
} from "../lib/orgGates.js";

const OrgContext = createContext(null);

export function OrgProvider({
  children,
  email,
  membership,
  orgs,
  selectedOrgId,
  onSwitchOrg,
  onLogout,
  refreshSession,
}) {
  // Not new state — BusinessPage already owns session/selectedOrgId and
  // passes the resolved values in as props (it has to, since it also
  // renders PlanSelectionGate/CreateCompanyPrompt above Workspace based on
  // the same values). This provider's job is making those values reachable
  // via context for everything BELOW Workspace, not re-deriving them.
  const can = useMemo(
    () => ({
      manageOrg: () => canManageOrg(membership),
      accessDepartment: (departmentId) => canAccessDepartment(membership, departmentId),
      manageFinance: () => canManageFinance(membership),
      accessFinance: () => canAccessFinance(membership),
      manageHR: () => canManageHR(membership),
      accessHR: () => canAccessHR(membership),
      isDepartmentManager: (departmentId) => isDepartmentManager(membership, departmentId),
    }),
    [membership]
  );

  const value = useMemo(
    () => ({
      email,
      membership,
      orgId: membership?.orgId ?? selectedOrgId,
      orgName: membership?.orgName,
      role: membership?.role,
      orgs,
      selectedOrgId,
      switchOrg: onSwitchOrg,
      logout: onLogout,
      refreshSession,
      can,
    }),
    [email, membership, orgs, selectedOrgId, onSwitchOrg, onLogout, refreshSession, can]
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

/** Throws if called outside an OrgProvider — same fail-loud convention as
 *  every gate function above returning false-not-undefined for a missing
 *  membership, so a wiring mistake surfaces immediately in dev rather than
 *  silently rendering with undefined identity. */
export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg() must be called within an OrgProvider (Business Workspace only).");
  return ctx;
}
