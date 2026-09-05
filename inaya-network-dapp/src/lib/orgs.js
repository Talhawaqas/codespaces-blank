// src/lib/orgs.js
//
// Data model and auth primitives for Company/Department/Project/Document
// business records management (Phase 1 of the ERP-style scope — Phase 2
// layers document workflow states on top of this).
//
// DELIBERATELY SEPARATE from the wallet-based personal file system
// (src/lib/metadata-auth.js, the `metadata_files` collection): that
// system's `owner` field is always a wallet address, cross-checked
// against on-chain data via verifyOnChainFileOwner(). Org members
// authenticate by email + session, not a wallet signature — mixing the
// two ownership semantics into one collection risked silently breaking
// that system's on-chain-ownership invariant. Org documents live in their
// own `org_documents` collection instead (see the "wire document upload"
// task), reusing the same encrypt/shard/pin/on-chain-registration
// pipeline, just recorded differently afterward — same pattern the
// Corporate Reserve/PAYG card-customer flow already uses (treasury
// wallet registers on-chain on the customer's behalf, see
// app/api/stripe-webhook/route.js's settlePaygUpload()).
//
// AUTH: magic links are generated here and emailed via Resend (see
// src/lib/email.js's sendMagicLinkEmail(), called from orgs/create,
// orgs/invite, and orgs/login/request) whenever RESEND_API_KEY is
// configured. Only falls back to returning the raw link directly to the
// caller when delivery isn't configured or a send fails — see each
// route's own comment for why that fallback is safe there specifically.
// Session tokens are opaque random values, stored SHA-256-hashed
// (not in plaintext) so a database leak doesn't directly yield usable
// sessions — there's no reason to store them recoverable, hashing costs
// nothing extra here.

import { randomBytes, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "./mongodb.js";
// Enterprise OS SOW, Phase 1: the pure permission-gate functions live in
// orgGates.js (client-safe — no node:crypto/mongodb) so OrgContext can
// import them directly. Imported here too so this file's own internal
// callers (requireMembership, etc.) keep working, and re-exported below
// so every existing `import { canManageOrg } from "./orgs.js"` call site
// is unaffected.
import {
  canManageOrg,
  canAccessDepartment,
  canManageFinance,
  canAccessFinance,
  canManageHR,
  canAccessHR,
  isDepartmentManager,
  canManageHealth,
  canAccessHealthRecords,
  canManageLegal,
  canAccessLegalMatters,
  isCareTeamMember,
  isMatterTeamMember,
} from "./orgGates.js";

export {
  canManageOrg, canAccessDepartment, canManageFinance, canAccessFinance, canManageHR, canAccessHR, isDepartmentManager,
  canManageHealth, canAccessHealthRecords, canManageLegal, canAccessLegalMatters, isCareTeamMember, isMatterTeamMember,
};

export const ROLES = ["owner", "admin", "member"];
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAGIC_LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes — short-lived, single-use
export const SESSION_COOKIE = "inaya_org_session";

export function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

export async function getOrgCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    orgs: db.collection("orgs"),
    orgMembers: db.collection("org_members"),
    departments: db.collection("departments"),
    projects: db.collection("projects"),
    magicLinks: db.collection("magic_links"),
    sessions: db.collection("sessions"),
    orgDocuments: db.collection("org_documents"),
    documentActivity: db.collection("document_activity"),
    projectMembers: db.collection("project_members"),
    documentPermissions: db.collection("document_permissions"),
    documentShares: db.collection("document_shares"),
    // Business Operations, Phase 1 (Projects & Tasks) — tasks are a child
    // of the existing `projects` collection, not a new top-level entity.
    // orgActivity is the new additive audit-log foundation every future
    // Business Operations module (CRM, Procurement, Inventory) writes to;
    // documentActivity above is untouched, kept document-scoped exactly
    // as it already is, zero regression risk to it or its existing tests.
    tasks: db.collection("tasks"),
    orgActivity: db.collection("org_activity"),
    // Business Operations, Phase 2 (CRM) — a contact evolves in place
    // (type flips LEAD -> CUSTOMER on conversion rather than becoming a
    // new record), deals FK to both a contact and, optionally, the
    // existing `projects` collection — that single field is what
    // completes Customer -> Deal -> Project -> Task -> Document per the
    // SOW's unified-workspace requirement, no new join table needed.
    crmContacts: db.collection("crm_contacts"),
    crmDeals: db.collection("crm_deals"),
    // Business Operations, Phase 3 (Procurement) — a purchase_request can
    // optionally graduate into a purchase_order (sourceRequestId), but a
    // PO can also be created standalone; both share the org/department
    // scoping every other module here uses.
    suppliers: db.collection("suppliers"),
    purchaseRequests: db.collection("purchase_requests"),
    purchaseOrders: db.collection("purchase_orders"),
    // Business Operations, Phase 4 (Inventory) — stockLevels is a
    // materialized view (one doc per product+warehouse) updated ONLY via
    // $inc from stockMovements (append-only, the real audit trail) —
    // never set directly, same "never overwrite the ledger" discipline
    // sessions/magicLinks already follow for their own append-only data.
    warehouses: db.collection("warehouses"),
    products: db.collection("products"),
    stockLevels: db.collection("stock_levels"),
    stockMovements: db.collection("stock_movements"),
    // Business Operations, Phase 5 (Finance & HR) — a testnet demonstration/
    // validation layer per the SOW, not regulated banking/payroll. invoices
    // link to the existing crmContacts (Customer -> Invoice -> Payment, no
    // duplicate customer concept); attachments is new rather than reusing
    // org_documents, since that collection mandates projectId and its whole
    // permission model is department/project-based — wrong shape for "who
    // can see this employee's contract" (self + HR roles + org managers,
    // never department-based) and too risky to bend on the most
    // foundational, heaviest-depended-on collection in the app.
    invoices: db.collection("invoices"),
    expenses: db.collection("expenses"),
    payments: db.collection("payments"),
    employees: db.collection("employees"),
    leaveRequests: db.collection("leave_requests"),
    attachments: db.collection("attachments"),
    // Phase 2 — cryptographic audit trail. A hash-chained overlay on top
    // of org_activity/document_activity (see src/lib/auditChain.js), not a
    // replacement — those collections keep recording the same
    // human-readable events they always have. auditChainHeads holds one
    // doc per org (the tip of that org's chain); auditChainEntries is the
    // append-only chain itself.
    auditChainEntries: db.collection("audit_chain_entries"),
    auditChainHeads: db.collection("audit_chain_heads"),
    // Phase 3/4 — Guarded Execution. An AI-proposed action request never
    // executes the real transitionX() itself — it's a row here that a
    // human with the same authority the real action would require must
    // approve, after which a 36h unlockAt (mirroring InayaNodeRegistry.sol's
    // SETTLEMENT_DELAY) must pass before a cron executor calls the real
    // workflow function. See src/lib/ai-action-requests.js.
    aiActionRequests: db.collection("ai_action_requests"),
    // Healthcare & Legal Expansion SOW, Phase 1 (Shared Industry Framework).
    // Generic, vertical-agnostic org-governance records — not health/legal
    // specific themselves, just the foundation both verticals (and any
    // future one) build compliance-adjacent tooling on top of. See
    // src/lib/classification.js, policy-engine.js, incidents.js,
    // retention.js, export-center.js, risk-register.js,
    // vendor-management.js, training.js for the logic layered on these.
    industryPolicies: db.collection("industry_policies"),
    dataClassifications: db.collection("data_classifications"),
    incidents: db.collection("incidents"),
    retentionPolicies: db.collection("retention_policies"),
    riskRegister: db.collection("risk_register"),
    vendorRecords: db.collection("vendor_records"),
    trainingRecords: db.collection("training_records"),
    exportRequests: db.collection("export_requests"),
    // Healthcare & Legal Expansion SOW, Phase 2 (Healthcare Core). Clinical
    // files themselves are NOT a new storage table — health_clinical_records
    // holds only domain metadata + a documentId pointer into the existing
    // org_documents (same encrypt/shard/pin pipeline every other document
    // already uses). health_care_team_assignments is the join table that
    // makes patient visibility assignment-based rather than purely
    // department-based (mirrors project_members' shape).
    healthPatients: db.collection("health_patients"),
    healthEncounters: db.collection("health_encounters"),
    healthProviders: db.collection("health_providers"),
    healthCareTeams: db.collection("health_care_teams"),
    healthCareTeamAssignments: db.collection("health_care_team_assignments"),
    healthAppointments: db.collection("health_appointments"),
    healthReferrals: db.collection("health_referrals"),
    healthCarePlans: db.collection("health_care_plans"),
    healthClinicalRecords: db.collection("health_clinical_records"),
    healthConsents: db.collection("health_consents"),
    healthRoiRequests: db.collection("health_roi_requests"),
    healthAccessEvents: db.collection("health_access_events"),
    // Healthcare & Legal Expansion SOW, Phase 6 (Legal Core). Same storage
    // indirection: legal_evidence (Phase 7) holds metadata + a documentId
    // pointer, never a parallel storage system.
    legalClients: db.collection("legal_clients"),
    legalProspects: db.collection("legal_prospects"),
    legalMatters: db.collection("legal_matters"),
    legalParties: db.collection("legal_parties"),
    legalConflictChecks: db.collection("legal_conflict_checks"),
    legalEngagements: db.collection("legal_engagements"),
    legalMatterTeamAssignments: db.collection("legal_matter_team_assignments"),
    // Phase 7 (Legal Evidence & Litigation)
    legalEvidence: db.collection("legal_evidence"),
    legalChainEvents: db.collection("legal_chain_events"),
    legalHolds: db.collection("legal_holds"),
    legalDiscovery: db.collection("legal_discovery"),
    legalDeadlines: db.collection("legal_deadlines"),
    // Phase 8 (Legal Operations)
    legalContracts: db.collection("legal_contracts"),
    legalTimeEntries: db.collection("legal_time_entries"),
    legalBilling: db.collection("legal_billing"),
    legalEntities: db.collection("legal_entities"),
    legalTrustLedger: db.collection("legal_trust_ledger"),
  };
}

let indexesEnsured = false;

export async function ensureOrgIndexes() {
  if (indexesEnsured) return;
  const {
    orgMembers, departments, projects, magicLinks, sessions, orgDocuments, documentActivity,
    projectMembers, documentPermissions, documentShares, tasks, orgActivity,
    crmContacts, crmDeals, suppliers, purchaseRequests, purchaseOrders,
    warehouses, products, stockLevels, stockMovements,
    invoices, expenses, payments, employees, leaveRequests, attachments,
    auditChainEntries, auditChainHeads, aiActionRequests,
    industryPolicies, dataClassifications, incidents, retentionPolicies,
    riskRegister, vendorRecords, trainingRecords, exportRequests,
    healthPatients, healthEncounters, healthProviders, healthCareTeams, healthCareTeamAssignments,
    healthAppointments, healthReferrals, healthCarePlans, healthClinicalRecords,
    healthConsents, healthRoiRequests, healthAccessEvents,
    legalClients, legalProspects, legalMatters, legalParties, legalConflictChecks,
    legalEngagements, legalMatterTeamAssignments, legalEvidence, legalChainEvents,
    legalHolds, legalDiscovery, legalDeadlines, legalContracts, legalTimeEntries,
    legalBilling, legalEntities, legalTrustLedger,
  } = await getOrgCollections();

  await Promise.all([
    orgMembers.createIndex({ orgId: 1, email: 1 }, { unique: true }),
    orgMembers.createIndex({ email: 1 }),
    departments.createIndex({ orgId: 1 }),
    projects.createIndex({ orgId: 1, departmentId: 1 }),
    magicLinks.createIndex({ tokenHash: 1 }, { unique: true }),
    magicLinks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    orgDocuments.createIndex({ orgId: 1, departmentId: 1, projectId: 1 }),
    orgDocuments.createIndex({ fileHash: 1 }, { unique: true }),
    documentActivity.createIndex({ documentId: 1, timestamp: 1 }),
    documentActivity.createIndex({ eventId: 1 }, { unique: true }),
    // Phase 3 — permissions & secure sharing
    projectMembers.createIndex({ orgId: 1, projectId: 1, email: 1 }, { unique: true }),
    projectMembers.createIndex({ orgId: 1, email: 1 }),
    documentPermissions.createIndex({ orgId: 1, documentId: 1, email: 1 }, { unique: true }),
    documentPermissions.createIndex({ orgId: 1, email: 1 }),
    documentShares.createIndex({ tokenHash: 1 }, { unique: true }),
    documentShares.createIndex({ documentId: 1 }),
    documentShares.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Business Operations, Phase 1 (Projects & Tasks)
    tasks.createIndex({ orgId: 1, projectId: 1 }),
    tasks.createIndex({ orgId: 1, departmentId: 1 }),
    tasks.createIndex({ orgId: 1, assigneeEmail: 1, status: 1 }),
    tasks.createIndex({ orgId: 1, dueDate: 1 }),
    orgActivity.createIndex({ eventId: 1 }, { unique: true }),
    orgActivity.createIndex({ orgId: 1, recordType: 1, recordId: 1, timestamp: 1 }),
    orgActivity.createIndex({ orgId: 1, timestamp: 1 }),
    // Business Operations, Phase 2 (CRM)
    crmContacts.createIndex({ orgId: 1, departmentId: 1 }),
    crmContacts.createIndex({ orgId: 1, type: 1 }),
    crmDeals.createIndex({ orgId: 1, departmentId: 1 }),
    crmDeals.createIndex({ orgId: 1, contactId: 1 }),
    crmDeals.createIndex({ orgId: 1, projectId: 1 }),
    crmDeals.createIndex({ orgId: 1, stage: 1 }),
    // Business Operations, Phase 3 (Procurement)
    suppliers.createIndex({ orgId: 1, departmentId: 1 }),
    purchaseRequests.createIndex({ orgId: 1, departmentId: 1 }),
    purchaseRequests.createIndex({ orgId: 1, status: 1 }),
    purchaseOrders.createIndex({ orgId: 1, departmentId: 1 }),
    purchaseOrders.createIndex({ orgId: 1, supplierId: 1 }),
    purchaseOrders.createIndex({ orgId: 1, status: 1 }),
    // Business Operations, Phase 4 (Inventory)
    warehouses.createIndex({ orgId: 1, departmentId: 1 }),
    products.createIndex({ orgId: 1, sku: 1 }, { unique: true }),
    products.createIndex({ orgId: 1, departmentId: 1 }),
    stockLevels.createIndex({ orgId: 1, productId: 1, warehouseId: 1 }, { unique: true }),
    stockMovements.createIndex({ orgId: 1, productId: 1, createdAt: 1 }),
    stockMovements.createIndex({ orgId: 1, relatedPurchaseOrderId: 1 }),
    // Business Operations, Phase 5 (Finance & HR)
    invoices.createIndex({ orgId: 1, departmentId: 1 }),
    invoices.createIndex({ orgId: 1, contactId: 1 }),
    invoices.createIndex({ orgId: 1, status: 1, dueDate: 1 }),
    expenses.createIndex({ orgId: 1, departmentId: 1 }),
    expenses.createIndex({ orgId: 1, status: 1 }),
    payments.createIndex({ orgId: 1, departmentId: 1 }),
    payments.createIndex({ orgId: 1, relatedInvoiceId: 1 }),
    payments.createIndex({ orgId: 1, relatedExpenseId: 1 }),
    employees.createIndex({ orgId: 1, departmentId: 1 }),
    employees.createIndex({ orgId: 1, memberEmail: 1 }),
    leaveRequests.createIndex({ orgId: 1, employeeId: 1 }),
    leaveRequests.createIndex({ orgId: 1, status: 1 }),
    attachments.createIndex({ orgId: 1, relatedRecordType: 1, relatedRecordId: 1 }),
    // Phase 2 — cryptographic audit trail
    auditChainEntries.createIndex({ orgId: 1, seq: 1 }, { unique: true }),
    auditChainEntries.createIndex({ orgId: 1, timestamp: 1 }),
    auditChainHeads.createIndex({ orgId: 1 }, { unique: true }),
    // Phase 3/4 — Guarded Execution
    aiActionRequests.createIndex({ orgId: 1, status: 1 }),
    aiActionRequests.createIndex({ orgId: 1, unlockAt: 1 }),
    aiActionRequests.createIndex({ idempotencyKey: 1 }, { unique: true }),
    // Healthcare & Legal Expansion SOW, Phase 1 (Shared Industry Framework)
    industryPolicies.createIndex({ orgId: 1, key: 1 }, { unique: true }),
    dataClassifications.createIndex({ orgId: 1, key: 1 }, { unique: true }),
    incidents.createIndex({ orgId: 1, status: 1 }),
    incidents.createIndex({ orgId: 1, severity: 1, createdAt: 1 }),
    retentionPolicies.createIndex({ orgId: 1, recordType: 1 }, { unique: true }),
    riskRegister.createIndex({ orgId: 1, status: 1 }),
    riskRegister.createIndex({ orgId: 1, reviewDate: 1 }),
    vendorRecords.createIndex({ orgId: 1, name: 1 }),
    trainingRecords.createIndex({ orgId: 1, memberEmail: 1 }),
    trainingRecords.createIndex({ orgId: 1, policyKey: 1 }),
    exportRequests.createIndex({ orgId: 1, status: 1 }),
    exportRequests.createIndex({ orgId: 1, requestedByEmail: 1, createdAt: 1 }),
    // Healthcare & Legal Expansion SOW, Phase 2 (Healthcare Core)
    healthPatients.createIndex({ orgId: 1, status: 1 }),
    healthEncounters.createIndex({ orgId: 1, patientId: 1, createdAt: 1 }),
    healthProviders.createIndex({ orgId: 1, departmentId: 1 }),
    healthCareTeams.createIndex({ orgId: 1, patientId: 1 }),
    healthCareTeamAssignments.createIndex({ orgId: 1, patientId: 1, email: 1 }, { unique: true }),
    healthCareTeamAssignments.createIndex({ orgId: 1, email: 1 }),
    healthAppointments.createIndex({ orgId: 1, patientId: 1, startAt: 1 }),
    healthAppointments.createIndex({ orgId: 1, providerId: 1, startAt: 1 }),
    healthReferrals.createIndex({ orgId: 1, patientId: 1 }),
    healthCarePlans.createIndex({ orgId: 1, patientId: 1 }),
    healthClinicalRecords.createIndex({ orgId: 1, patientId: 1, createdAt: 1 }),
    healthClinicalRecords.createIndex({ orgId: 1, documentId: 1 }),
    healthConsents.createIndex({ orgId: 1, patientId: 1, status: 1 }),
    healthRoiRequests.createIndex({ orgId: 1, patientId: 1, status: 1 }),
    healthAccessEvents.createIndex({ orgId: 1, patientId: 1, timestamp: 1 }),
    // Phase 6 (Legal Core)
    legalClients.createIndex({ orgId: 1, status: 1 }),
    legalProspects.createIndex({ orgId: 1, status: 1 }),
    legalMatters.createIndex({ orgId: 1, clientId: 1 }),
    legalMatters.createIndex({ orgId: 1, status: 1 }),
    legalParties.createIndex({ orgId: 1, matterId: 1 }),
    legalConflictChecks.createIndex({ orgId: 1, createdAt: 1 }),
    legalEngagements.createIndex({ orgId: 1, matterId: 1 }),
    legalMatterTeamAssignments.createIndex({ orgId: 1, matterId: 1, email: 1 }, { unique: true }),
    legalMatterTeamAssignments.createIndex({ orgId: 1, email: 1 }),
    // Phase 7 (Legal Evidence & Litigation)
    legalEvidence.createIndex({ orgId: 1, matterId: 1 }),
    legalEvidence.createIndex({ orgId: 1, documentId: 1 }),
    legalChainEvents.createIndex({ orgId: 1, evidenceId: 1, timestamp: 1 }),
    legalHolds.createIndex({ orgId: 1, status: 1 }),
    legalHolds.createIndex({ orgId: 1, matterId: 1 }),
    legalDiscovery.createIndex({ orgId: 1, matterId: 1 }),
    legalDeadlines.createIndex({ orgId: 1, matterId: 1, dueAt: 1 }),
    // Phase 8 (Legal Operations)
    legalContracts.createIndex({ orgId: 1, status: 1 }),
    legalTimeEntries.createIndex({ orgId: 1, matterId: 1, lawyerEmail: 1 }),
    legalTimeEntries.createIndex({ orgId: 1, billed: 1 }),
    legalBilling.createIndex({ orgId: 1, clientId: 1, status: 1 }),
    legalEntities.createIndex({ orgId: 1 }),
    legalTrustLedger.createIndex({ orgId: 1, matterId: 1, createdAt: 1 }),
  ]);

  indexesEnsured = true;
}

/** Extracts the raw session token from a request. Web clients send it as the
 *  inaya_org_session cookie (set by GET /api/orgs/login/consume). Mobile has no
 *  cookie jar shared with the app's own fetch calls (a magic link opened from an
 *  email opens the device's system browser, not the app, so any cookie it gets
 *  set stays trapped there) — so the mobile client instead consumes its login
 *  token via POST /api/orgs/login/consume-token, gets the raw session token back
 *  in the JSON body, and sends it back as `Authorization: Bearer <token>` on
 *  every subsequent request. Both paths resolve to the same sessions collection,
 *  so nothing else about session validation differs between web and mobile. */
export function getRawSessionToken(req) {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return req.cookies.get(SESSION_COOKIE)?.value || null;
}

/** Looks up the active session for a request's session cookie value (the raw token,
 *  not the hash). Returns null for missing/expired/unknown tokens rather than throwing —
 *  callers decide whether that's a 401 or an anonymous view. */
export async function getSession(rawToken) {
  if (!rawToken) return null;
  const { sessions } = await getOrgCollections();
  const session = await sessions.findOne({ tokenHash: hashToken(rawToken) });
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

/** Fetches the caller's membership + role for a specific org, or null if they aren't a
 *  member. Every org-scoped route should call this rather than trusting a client-supplied
 *  role — role is only ever read from the stored org_members doc. */
export async function getMembership(orgId, email) {
  const { orgMembers } = await getOrgCollections();
  return orgMembers.findOne({ orgId: toObjectId(orgId), email: normalizeEmail(email), status: "active" });
}

export function toObjectId(id) {
  return id instanceof ObjectId ? id : new ObjectId(id);
}

/** The session-cookie -> membership resolution every org-scoped route needs. Returns
 *  { session, membership } or a { error, status } pair to return directly — callers do:
 *    const auth = await requireMembership(req, orgId);
 *    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
 *  Pass requireManage:true for owner/admin-only actions (inviting members, creating
 *  departments/projects); omit it for anything any active member can do. */
export async function requireMembership(req, orgId, { requireManage = false } = {}) {
  const rawToken = getRawSessionToken(req);
  const session = await getSession(rawToken);
  if (!session) return { error: "Not signed in.", status: 401 };

  let membership;
  try {
    membership = await getMembership(orgId, session.email);
  } catch {
    return { error: "Invalid company ID.", status: 400 };
  }
  if (!membership) return { error: "You're not a member of this company.", status: 403 };
  if (requireManage && !canManageOrg(membership)) {
    return { error: "Only the owner or an admin can do that.", status: 403 };
  }

  return { session, membership };
}

/** Issues a fresh session for an email whose identity has already been verified by the
 *  caller — a consumed magic-link token, or a verified Google ID token. Returns
 *  { email, sessionToken }. Does NOT set a cookie — callers decide how to hand it back. */
export async function createSession(email) {
  const { sessions } = await getOrgCollections();
  const sessionToken = generateToken();
  await sessions.insertOne({
    tokenHash: hashToken(sessionToken),
    email,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return { email, sessionToken };
}

/** Validates and consumes a magic-link token (shared by the web GET redirect route and
 *  the mobile POST JSON route) — marks it used, flips an invite's membership to active,
 *  and issues a fresh session via createSession(). Returns { error, status } or
 *  { email, sessionToken }. Does NOT set a cookie or build a response — callers decide
 *  how to hand the token back. */
export async function consumeLoginToken(token) {
  if (!token) return { error: "missing_token", status: 400 };

  await ensureOrgIndexes();
  const { magicLinks, orgMembers } = await getOrgCollections();

  const link = await magicLinks.findOne({ tokenHash: hashToken(token) });
  if (!link || link.usedAt || new Date(link.expiresAt).getTime() < Date.now()) {
    return { error: "invalid_or_expired", status: 400 };
  }

  const now = new Date().toISOString();
  await magicLinks.updateOne({ _id: link._id }, { $set: { usedAt: now } });

  if (link.purpose === "invite" && link.orgId) {
    await orgMembers.updateOne(
      { orgId: link.orgId, email: link.email },
      { $set: { status: "active", joinedAt: now } }
    );
  }

  return createSession(link.email);
}

/** "Employee" (the SOW's 7th role, "personal HR information and permitted
 *  documents") is deliberately NOT a role string — it's a data-scoping
 *  rule: any active member can always read (never edit) the employees
 *  record whose memberEmail matches their own session email, regardless
 *  of hrRole. Callers check this alongside canAccessHR, not instead of it. */
export function isSelfEmployeeRecord(employee, email) {
  return !!employee?.memberEmail && !!email && employee.memberEmail === email;
}
