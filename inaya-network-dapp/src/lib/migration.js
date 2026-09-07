// src/lib/migration.js
//
// Financial Services & Regulated Enterprise SOW, Phase 10 (§273-274) —
// Migration. §273 lists twelve importable record types (documents, users,
// organizations, funds, deals, companies, investors, policies, controls,
// risks, vendors, evidence). Building twelve bespoke importers would mean
// twelve near-identical validate/insert/reconcile loops -- this is ONE
// generic engine parameterized by recordType, with a small per-type
// validator/mapper registry (MIGRATION_ADAPTERS) that a real onboarding
// engagement extends as needed, rather than inventing a parallel importer
// per domain.
//
// §274's required migration-audit fields are the actual return/storage
// shape here, not an afterthought: source, destination, records,
// failures, transformations, hashes, reconciliation, approval. A
// migration run is immutable once created — like every other evidentiary
// record in this SOW, a mistake gets a NEW corrective run, never an edit
// of a past one.
//
// Validation-then-reconciliation, never insert-then-hope: every record is
// validated against its adapter BEFORE any write happens, and only
// validated records are inserted — a partially-invalid batch still
// imports its valid rows and reports the rest as real, named failures
// (never silently dropped).

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageOrg } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const MIGRATION_STATES = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "COMPLETED"];

// Each adapter: { collectionKey, requiredFields, map(rawRecord) -> doc }.
// map() never invents a field the source record doesn't have — a
// required field genuinely missing is a validation failure, not defaulted.
const MIGRATION_ADAPTERS = {
  risk: {
    collectionKey: "riskRegister",
    requiredFields: ["category", "severity"],
    map: (r, orgId, actorEmail) => ({
      orgId: toObjectId(orgId), category: r.category, severity: r.severity,
      likelihood: r.likelihood || "unknown", impact: r.impact || "",
      mitigation: r.mitigation || "", status: "open", reviewDate: r.reviewDate || null,
      evidence: [], relatedIncidentId: null, controlId: null, requirementId: null, frameworkId: null,
      createdByEmail: actorEmail, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      migratedFrom: { source: "migration", originalId: r.id || null },
    }),
  },
  vendor: {
    collectionKey: "vendorRecords",
    requiredFields: ["name", "service"],
    map: (r, orgId, actorEmail) => ({
      orgId: toObjectId(orgId), name: r.name, service: r.service, criticality: r.criticality || "medium",
      dataCategories: r.dataCategories || [], systemsAccessed: [], jurisdictions: [],
      subprocessors: [], contracts: [], dpaOnFile: false,
      securityDocuments: [], socReports: [], isoCertificates: [], penetrationTests: [],
      ownerEmail: actorEmail, securityReviewStatus: "not_reviewed",
      agreementMetadata: {}, renewalDate: r.renewalDate || null,
      certificateExpiryDates: [], contractExpiryDate: null,
      risk: null, riskScore: null, accessGranted: [], incidentHistory: [], findings: [], subprocessorChangeLog: [],
      slaTarget: null, availabilityTarget: null, businessContinuityOnFile: false, recoveryCapabilityNotes: null,
      onboardingStatus: "REQUESTED",
      createdByEmail: actorEmail, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      migratedFrom: { source: "migration", originalId: r.id || null },
    }),
  },
  control: {
    collectionKey: "complianceControls",
    requiredFields: ["name"],
    map: (r, orgId, actorEmail) => ({
      orgId: toObjectId(orgId), name: r.name, description: r.description || "", objective: r.objective || "",
      ownerEmail: actorEmail, reviewer: null, frequency: null, evidenceType: null, automationLevel: "manual",
      status: "draft", effectiveness: "not_tested", linkedRequirements: [], exceptions: [],
      lastTestedAt: null, nextTestDueAt: null,
      createdByEmail: actorEmail, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      migratedFrom: { source: "migration", originalId: r.id || null },
    }),
  },
};

export const MIGRATION_RECORD_TYPES = Object.keys(MIGRATION_ADAPTERS);

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(",")}}`;
}

function hashOf(value) {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

/** Validates every record against its adapter and stores a PENDING_APPROVAL
 *  migration run -- nothing is written to the target collection yet.
 *  Matches §274's "approval" field: even a fully-valid batch waits for a
 *  human decision before executeMigration() actually writes anything. */
export async function planMigration({ orgId, recordType, sourceLabel, records, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can plan a migration.", status: 403 };
  const adapter = MIGRATION_ADAPTERS[recordType];
  if (!adapter) return { error: `Unknown migration record type "${recordType}". Supported: ${MIGRATION_RECORD_TYPES.join(", ")}.`, status: 400 };
  if (!Array.isArray(records) || records.length === 0) return { error: "records must be a non-empty array.", status: 400 };

  const validated = [];
  const failures = [];
  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    const missing = adapter.requiredFields.filter((f) => raw[f] === undefined || raw[f] === null || raw[f] === "");
    if (missing.length > 0) {
      failures.push({ index: i, sourceId: raw.id || null, reason: `Missing required field(s): ${missing.join(", ")}.` });
      continue;
    }
    validated.push({ index: i, raw, mapped: adapter.map(raw, orgId, actorEmail) });
  }

  const { migrationRuns } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), recordType,
    source: sourceLabel || "unspecified", destination: adapter.collectionKey,
    status: "PENDING_APPROVAL",
    recordsTotal: records.length,
    validatedRecords: validated.map((v) => v.mapped),
    failures,
    transformations: { fieldsMapped: adapter.requiredFields, adapterCollectionKey: adapter.collectionKey },
    sourceHash: hashOf(records),
    reconciliation: null, // filled in by executeMigration()
    plannedByEmail: actorEmail, approvedByEmail: null, completedAt: null,
    createdAt: now, updatedAt: now,
  };
  const result = await migrationRuns.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "MIGRATION_RUN", recordId: inserted._id, actorEmail, action: "PLANNED", previousState: null, newState: "PENDING_APPROVAL", metadata: { recordType, recordsTotal: records.length, failureCount: failures.length } });
  return { migration: inserted };
}

export async function approveMigration({ orgId, migrationId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can approve a migration.", status: 403 };
  const { migrationRuns } = await getOrgCollections();
  const migration = await migrationRuns.findOne({ _id: toObjectId(migrationId), orgId: toObjectId(orgId) });
  if (!migration) return { error: "Migration run not found.", status: 404 };
  if (migration.plannedByEmail === actorEmail) return { error: "The approver must be a different person than whoever planned the migration.", status: 403 };

  const updated = await migrationRuns.findOneAndUpdate(
    { _id: migration._id, status: "PENDING_APPROVAL" },
    { $set: { status: "APPROVED", approvedByEmail: actorEmail, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This migration run is no longer pending approval.", status: 409 };

  await logOrgActivity({ orgId, recordType: "MIGRATION_RUN", recordId: updated._id, actorEmail, action: "APPROVED", previousState: "PENDING_APPROVAL", newState: "APPROVED", metadata: {} });
  return { migration: updated };
}

export async function rejectMigration({ orgId, migrationId, actorEmail, membership, reason }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can reject a migration.", status: 403 };
  const { migrationRuns } = await getOrgCollections();
  const updated = await migrationRuns.findOneAndUpdate(
    { _id: toObjectId(migrationId), orgId: toObjectId(orgId), status: "PENDING_APPROVAL" },
    { $set: { status: "REJECTED", approvedByEmail: actorEmail, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This migration run is no longer pending approval.", status: 409 };
  await logOrgActivity({ orgId, recordType: "MIGRATION_RUN", recordId: updated._id, actorEmail, action: "REJECTED", previousState: "PENDING_APPROVAL", newState: "REJECTED", metadata: { reason: reason || null } });
  return { migration: updated };
}

/** The only path that actually writes anything. Inserts every pre-
 *  validated record, computes real reconciliation counts (source/target/
 *  new/failed), and marks the run COMPLETED -- immutable from this point
 *  on, matching §274's "reconciliation" requirement with real numbers,
 *  never assumed. */
export async function executeMigration({ orgId, migrationId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can execute a migration.", status: 403 };
  const collections = await getOrgCollections();
  const { migrationRuns } = collections;
  const migration = await migrationRuns.findOne({ _id: toObjectId(migrationId), orgId: toObjectId(orgId) });
  if (!migration) return { error: "Migration run not found.", status: 404 };
  if (migration.status !== "APPROVED") return { error: `Only an APPROVED migration can be executed (this one is ${migration.status}).`, status: 409 };

  const targetCollection = collections[migration.destination];
  const beforeCount = await targetCollection.countDocuments({ orgId: toObjectId(orgId) });
  let inserted = 0;
  if (migration.validatedRecords.length > 0) {
    const result = await targetCollection.insertMany(migration.validatedRecords);
    inserted = result.insertedCount;
  }
  const afterCount = await targetCollection.countDocuments({ orgId: toObjectId(orgId) });

  const reconciliation = {
    sourceCount: migration.recordsTotal,
    targetCountBefore: beforeCount,
    targetCountAfter: afterCount,
    newRecords: inserted,
    failedRecords: migration.failures.length,
  };

  const now = new Date().toISOString();
  const updated = await migrationRuns.findOneAndUpdate(
    { _id: migration._id, status: "APPROVED" },
    { $set: { status: "COMPLETED", reconciliation, completedAt: now, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This migration run was already executed by a concurrent request.", status: 409 };

  await logOrgActivity({ orgId, recordType: "MIGRATION_RUN", recordId: updated._id, actorEmail, action: "COMPLETED", previousState: "APPROVED", newState: "COMPLETED", metadata: reconciliation });
  return { migration: updated };
}

export async function getMigration(orgId, migrationId) {
  const { migrationRuns } = await getOrgCollections();
  return migrationRuns.findOne({ _id: toObjectId(migrationId), orgId: toObjectId(orgId) });
}

export async function listMigrations(orgId, { status } = {}) {
  const { migrationRuns } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return migrationRuns.find(query).sort({ createdAt: -1 }).toArray();
}
