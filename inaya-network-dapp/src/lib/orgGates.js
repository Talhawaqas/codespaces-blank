// src/lib/orgGates.js
//
// The pure permission-gate functions extracted out of orgs.js so they can
// be imported client-side too (Enterprise OS SOW, Phase 1 — OrgContext
// needs these for its `can` object). orgs.js itself imports node:crypto
// and the mongodb driver, so importing anything from it — even a function
// that never touches either — pulls those server-only modules into a
// client bundle. These seven functions only ever read plain fields off an
// already-resolved `membership` object, so they have zero server-only
// dependencies and were safe to move wholesale.
//
// orgs.js re-exports every one of these under its own name (`import {...}
// from "./orgGates.js"; export {...};`), so none of its ~60 existing
// server-side importers had to change — this file is the single source of
// truth for the logic, orgs.js is still the single import path for
// server-side code.

export function canManageOrg(membership) {
  return membership?.role === "owner" || membership?.role === "admin";
}

/** Members see documents in departments they're assigned to; owner/admin see everything
 *  in the org. Phase 1's whole permission model in one place so Phase 2's workflow logic
 *  has one function to extend rather than re-deriving this in every route. */
export function canAccessDepartment(membership, departmentId) {
  if (!membership) return false;
  if (canManageOrg(membership)) return true;
  return (membership.departmentIds || []).some((id) => id.toString() === departmentId.toString());
}

// ============================================================
// Business Operations, Phase 5 (Finance & HR) — role model
//
// financeRole/hrRole/managedDepartmentIds are new, OPTIONAL fields on the
// same org_members document, not a restructure of the existing
// role:"owner"|"admin"|"member" field. That field is checked in exactly
// one place (canManageOrg, above) and every other Business Operations
// module (Tasks/CRM/Procurement/Inventory) depends on it staying a
// stable three-value string — expanding ROLES itself would mean auditing
// every existing gate for correctness. A member simply has none, one, or
// both of financeRole/hrRole set alongside their normal role, same
// spirit as departmentIds already being an orthogonal, additive
// permission axis on the same doc.
// ============================================================

export function canManageFinance(membership) {
  return canManageOrg(membership) || membership?.financeRole === "manager";
}

export function canAccessFinance(membership) {
  return canManageFinance(membership) || membership?.financeRole === "staff";
}

export function canManageHR(membership) {
  return canManageOrg(membership) || membership?.hrRole === "manager";
}

export function canAccessHR(membership) {
  return canManageHR(membership) || membership?.hrRole === "staff";
}

/** "Department Manager" — a new concept; departments have no manager field
 *  today (canAccessDepartment above only distinguishes org-wide owner/
 *  admin from a plain department-scoped member). Grants read access to
 *  that department's employees without full org-wide HR visibility. */
export function isDepartmentManager(membership, departmentId) {
  if (!membership) return false;
  if (canManageOrg(membership)) return true;
  return (membership.managedDepartmentIds || []).some((id) => id.toString() === departmentId.toString());
}

// ============================================================
// Healthcare & Legal Expansion SOW — role model
//
// healthRole/legalRole are new, OPTIONAL fields on the same org_members
// document, following financeRole/hrRole's exact precedent above: never a
// restructure of the primary role field, just another orthogonal axis a
// member may or may not have set. Two-tier manager/staff shape copied
// verbatim from canManageFinance/canAccessFinance.
// ============================================================

export function canManageHealth(membership) {
  return canManageOrg(membership) || membership?.healthRole === "manager";
}

export function canAccessHealthRecords(membership) {
  return canManageHealth(membership) || membership?.healthRole === "staff";
}

export function canManageLegal(membership) {
  return canManageOrg(membership) || membership?.legalRole === "manager";
}

export function canAccessLegalMatters(membership) {
  return canManageLegal(membership) || membership?.legalRole === "staff";
}

/** Patient/matter visibility is assignment-based, not department-based —
 *  a care team or matter team can span departments, and department
 *  membership alone must not grant patient/matter access (SOW's
 *  minimum-necessary principle). `assignments` is the caller's own
 *  already-fetched list of {patientId, email} rows from
 *  health_care_team_assignments; org owner/admin bypass as usual. */
export function isCareTeamMember(membership, patientId, assignments) {
  if (!membership) return false;
  if (canManageOrg(membership)) return true;
  return (assignments || []).some(
    (a) => a.patientId?.toString() === patientId?.toString() && a.email === membership.email
  );
}

/** Same shape as isCareTeamMember, for legal_matter_team_assignments rows. */
export function isMatterTeamMember(membership, matterId, assignments) {
  if (!membership) return false;
  if (canManageOrg(membership)) return true;
  return (assignments || []).some(
    (a) => a.matterId?.toString() === matterId?.toString() && a.email === membership.email
  );
}

// ============================================================
// Financial Services & Regulated Enterprise SOW, Phase 4 — role model
//
// complianceRole/auditRole are new, OPTIONAL fields on the same
// org_members document, following financeRole/hrRole/healthRole/legalRole's
// exact precedent above. auditRole is deliberately never given a write
// path in the API layer regardless of tier — canAccessAudit only ever
// gates reads, matching the SOW's repeated "Audit Copilot / auditor
// access is read-only by default" principle. Only canManageAudit
// (owner/admin, or an explicit "manager"-tier auditRole assigned by
// them) can create audit plans or transition findings.
// ============================================================

export function canManageCompliance(membership) {
  return canManageOrg(membership) || membership?.complianceRole === "manager";
}

export function canAccessCompliance(membership) {
  return canManageCompliance(membership) || membership?.complianceRole === "staff";
}

export function canManageAudit(membership) {
  return canManageOrg(membership) || membership?.auditRole === "manager";
}

export function canAccessAudit(membership) {
  return canManageAudit(membership) || membership?.auditRole === "staff";
}
