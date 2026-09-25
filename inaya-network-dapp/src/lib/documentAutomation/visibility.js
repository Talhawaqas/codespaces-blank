// src/lib/documentAutomation/visibility.js
//
// Leaf module (imports only the org permission gates) holding the ONE
// definition of "which generated documents can this member see" as a Mongo
// filter, so Unified Search (document-permissions.js getAccessibleScope),
// the Business Brief, the Activity Center and the document list all apply
// the same rule and can never leak a document the member could not open.
// It is a separate leaf file because documentTypes.js -> adapters.js ->
// business-brief.js would otherwise form an import cycle with them.

import { canAccessFinance, canManageOrg } from "../orgs.js";

/** Document types whose source data is Finance data (need finance access). */
export const FINANCE_DOCUMENT_TYPES = ["invoice", "receipt", "statement", "credit_note", "debit_note", "delivery_note"];

export function documentVisibilityFilter({ membership, email, visibleDepartmentIds }) {
  const clauses = [];
  const deptClause = visibleDepartmentIds.length ? { departmentId: { $in: visibleDepartmentIds } } : null;
  const nullDept = canManageOrg(membership) ? { departmentId: null } : email ? { departmentId: null, createdByEmail: email } : null;
  const base = [deptClause, nullDept].filter(Boolean);
  if (base.length === 0) return { _id: null };
  clauses.push(base.length === 1 ? base[0] : { $or: base });
  if (!canAccessFinance(membership)) clauses.push({ documentType: { $nin: FINANCE_DOCUMENT_TYPES } });
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}
