// src/lib/documentAutomation/documentTypes.js
//
// Document Automation SOW §37 -- the reusable abstraction. One registry
// entry composes, per document type:
//
//   DocumentType       id / label / source record type
//   DataAdapter        adapters.js (authorized source data + snapshot)
//   Template           templateStore.js (default template id)
//   Renderer           renderer.js (shared)
//   Validator          validators.js (shared, type-aware)
//   CalculationPolicy  calculations.js (decimal-safe) or an adapter override
//   ApprovalPolicy     who may generate / approve / deliver + the SoD rule
//   StoragePolicy      encrypted sovereign storage, retention lock
//   DeliveryPolicy     link and/or Data Room, default expiry
//   EvidencePolicy     Business Event subject + relationship vocabulary
//
// There is no per-type pipeline: pipeline.js is written once against this
// interface, so adding a document type is one entry here plus an adapter and
// a template -- not a new code path.

import { canManageFinance, canAccessFinance, canManageOrg, canAccessDepartment } from "../orgs.js";
import { ADAPTERS } from "./adapters.js";
import { DEFAULT_TEMPLATE_BY_TYPE } from "./systemTemplates.js";

const financeGates = {
  finance: true,
  canGenerate: (m) => canManageFinance(m),
  canApprove: (m) => canManageFinance(m),
  canDeliver: (m) => canManageFinance(m),
  canView: (m) => canAccessFinance(m),
};
const orgGates = {
  finance: false,
  canGenerate: (m) => !!m,
  canApprove: (m) => canManageOrg(m),
  canDeliver: (m) => canManageOrg(m),
  canView: (m) => !!m,
};

const common = {
  sodRule: "requester_approves_own_request",
  storage: { encrypted: "server-managed AES-256-GCM, sharded, DePIN-pinned", retentionLock: true },
  delivery: { modes: ["link", "data_room"], defaultExpiry: "7d" },
  evidence: { subjectType: "GENERATED_DOCUMENT" },
};

export const DOCUMENT_TYPE_REGISTRY = {
  invoice: { id: "invoice", label: "Invoice", labelKey: "invoice", sourceKind: "invoice", sourceRecordType: "INVOICE", options: [], ...financeGates, ...common },
  purchase_order: { id: "purchase_order", label: "Purchase Order", labelKey: "purchaseOrder", sourceKind: "purchase order", sourceRecordType: "PURCHASE_ORDER", options: [], ...orgGates, ...common },
  quotation: { id: "quotation", label: "Quotation", labelKey: "quotation", sourceKind: "deal", sourceRecordType: "CRM_DEAL", options: ["currency", "lineItems", "validUntil", "issueDate", "notes", "terms", "paymentTerms", "taxPercent", "discountPercent"], ...orgGates, canApprove: (m) => canManageOrg(m) || canManageFinance(m), ...common },
  receipt: { id: "receipt", label: "Receipt", labelKey: "receipt", sourceKind: "approved payment", sourceRecordType: "PAYMENT", options: [], ...financeGates, ...common },
  statement: { id: "statement", label: "Customer Statement", labelKey: "statement", sourceKind: "customer", sourceRecordType: "CRM_CONTACT", options: ["periodFrom", "periodTo", "currency"], ...financeGates, ...common },
  credit_note: { id: "credit_note", label: "Credit Note", labelKey: "creditNote", sourceKind: "invoice", sourceRecordType: "INVOICE", options: ["lineItems", "reason", "taxPercent", "issueDate", "notes", "terms"], ...financeGates, ...common },
  debit_note: { id: "debit_note", label: "Debit Note", labelKey: "debitNote", sourceKind: "invoice", sourceRecordType: "INVOICE", options: ["lineItems", "reason", "taxPercent", "issueDate", "notes", "terms"], ...financeGates, ...common },
  delivery_note: { id: "delivery_note", label: "Delivery Note", labelKey: "deliveryNote", sourceKind: "invoice", sourceRecordType: "INVOICE", options: ["delivered", "issueDate", "notes"], ...financeGates, ...common },
  business_report: { id: "business_report", label: "Business Report", labelKey: "businessReport", sourceKind: "report period", sourceRecordType: "REPORT_PERIOD", options: ["period"], ...orgGates, ...common },
};

for (const [type, def] of Object.entries(DOCUMENT_TYPE_REGISTRY)) {
  def.adapter = ADAPTERS[type];
  def.defaultTemplateId = DEFAULT_TEMPLATE_BY_TYPE[type];
}

export function getDocumentType(type) {
  return DOCUMENT_TYPE_REGISTRY[type] || null;
}

export function listDocumentTypes() {
  return Object.values(DOCUMENT_TYPE_REGISTRY).map(({ adapter, canGenerate, canApprove, canDeliver, canView, ...rest }) => rest);
}

/** Which documents a member may see. Finance documents need finance access
 *  plus department access; other types need department access. A document
 *  with no department (a business report) is visible to org managers and
 *  its own author only. */
export function canViewDocument(membership, doc, email) {
  const def = DOCUMENT_TYPE_REGISTRY[doc.documentType];
  if (!def || !membership) return false;
  // Defense in depth: a membership from a different organization never applies,
  // even if a caller passes mismatched org/membership arguments (routes derive
  // the membership from the org id, so this only guards library misuse).
  if (membership.orgId && String(membership.orgId) !== String(doc.orgId)) return false;
  if (def.finance && !canAccessFinance(membership)) return false;
  if (doc.departmentId) return canAccessDepartment(membership, doc.departmentId);
  return canManageOrg(membership) || (!!email && doc.createdByEmail === email);
}

export { documentVisibilityFilter } from "./visibility.js";
