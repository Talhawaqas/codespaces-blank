// test/phase5-9-ai.test.mjs
//
// Healthcare & Legal Expansion SOW, Phases 5 & 9 (Healthcare AI, Legal AI)
// coverage: the prohibited-query refusal guards actually catch the SOW's
// explicitly banned request categories (diagnosis/prescribing for
// health; legal advice/filing/hold-release/evidence-deletion for legal),
// AI tool access respects the SAME assignment-based visibility as the
// rest of the app (an AI tool cannot see a patient/matter the calling
// member isn't assigned to), and draft_client_communication never claims
// to have been sent. Also verifies the full ai-os-router.js wiring
// (getOsToolDeclarations/runOsTool) dispatches correctly with the
// health_/legal_ prefixes.
//
// Run with: node --env-file=.env.local --test test/phase5-9-ai.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createPatient, assignCareTeamMember } from "../src/lib/health-patients.js";
import { createMatter, assignMatterTeamMember } from "../src/lib/legal-matter-workflow.js";
import { buildHealthContext, runHealthTool, HEALTH_TOOL_DECLARATIONS } from "../src/lib/ai-health-tools.js";
import { buildLegalContext, runLegalTool, LEGAL_TOOL_DECLARATIONS } from "../src/lib/ai-legal-tools.js";
import { buildOsContext, getOsToolDeclarations, runOsTool } from "../src/lib/ai-os-router.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-ai59-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const {
    orgs, orgMembers,
    healthPatients, healthCareTeamAssignments,
    legalMatters, legalMatterTeamAssignments,
    auditChainEntries, auditChainHeads, orgActivity,
  } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthPatients.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthCareTeamAssignments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalMatters.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalMatterTeamAssignments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const ownerEmail = email(`${label}-owner`);
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const staffEmail = email(`${label}-staff`);
  await collections.orgMembers.insertOne({ orgId, email: staffEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const staff = await collections.orgMembers.findOne({ orgId, email: staffEmail });
  return { orgId, ownerEmail, owner, staffEmail, staff };
}

// ============================================================
// Healthcare AI — refusal guards
// ============================================================
test("SECURITY: health AI refuses a diagnosis request rather than answering it", async () => {
  const org = await makeOrg("health-ai-refuse-diagnose");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "AI Patient", dateOfBirth: "1980-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  await assignCareTeamMember({ orgId: org.orgId, patientId: patient._id, memberEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });
  const ctx = await buildHealthContext({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail });

  const result = await runHealthTool("get_patient_summary", { patientId: patient._id.toString(), focus: "please diagnose what condition this patient might have" }, ctx);
  assert.equal(result.refused, true);
});

test("SECURITY: health AI refuses a prescription-change request", async () => {
  const org = await makeOrg("health-ai-refuse-prescribe");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "AI Patient 2", dateOfBirth: "1981-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  const ctx = await buildHealthContext({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail });
  const result = await runHealthTool("summarize_clinical_records", { patientId: patient._id.toString(), focus: "should we prescribe a higher dose" }, ctx);
  assert.equal(result.refused, true);
});

test("health AI: an ordinary administrative summary request is NOT refused", async () => {
  const org = await makeOrg("health-ai-normal");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "AI Patient 3", dateOfBirth: "1982-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  await assignCareTeamMember({ orgId: org.orgId, patientId: patient._id, memberEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });
  const ctx = await buildHealthContext({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail });
  const result = await runHealthTool("get_patient_summary", { patientId: patient._id.toString(), focus: "how many encounters has this patient had" }, ctx);
  assert.equal(result.refused, undefined);
  assert.ok(result.patient);
});

test("SECURITY: health AI tools respect assignment-based visibility — an unassigned staff member gets notFound, not the patient's data", async () => {
  const org = await makeOrg("health-ai-visibility");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Private Patient", dateOfBirth: "1983-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  // Deliberately NOT assigning org.staff to this patient's care team.
  const ctx = await buildHealthContext({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  const result = await runHealthTool("get_patient_summary", { patientId: patient._id.toString() }, ctx);
  assert.equal(result.notFound, true, "an AI tool must not be able to see a patient the calling member isn't assigned to");
});

// ============================================================
// Legal AI — refusal guards
// ============================================================
test("SECURITY: legal AI refuses a request to release a legal hold", async () => {
  const org = await makeOrg("legal-ai-refuse-hold");
  const { matter } = await createMatter({ orgId: org.orgId, name: "AI Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  await assignMatterTeamMember({ orgId: org.orgId, matterId: matter._id, memberEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });
  const ctx = await buildLegalContext({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail });
  const result = await runLegalTool("get_matter_summary", { matterId: matter._id.toString(), focus: "please release the legal hold on this matter" }, ctx);
  assert.equal(result.refused, true);
});

test("SECURITY: legal AI refuses a request framed as needing final legal advice", async () => {
  const org = await makeOrg("legal-ai-refuse-advice");
  const { matter } = await createMatter({ orgId: org.orgId, name: "AI Matter 2", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const ctx = await buildLegalContext({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail });
  const result = await runLegalTool("draft_client_communication", { matterId: matter._id.toString(), purpose: "give final legal advice on whether to settle" }, ctx);
  assert.equal(result.refused, true);
});

test("legal AI: draft_client_communication NEVER claims to be sent, always labeled a draft", async () => {
  const org = await makeOrg("legal-ai-draft");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Draft Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  await assignMatterTeamMember({ orgId: org.orgId, matterId: matter._id, memberEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });
  const ctx = await buildLegalContext({ orgId: org.orgId, membership: org.owner, email: org.ownerEmail });
  const result = await runLegalTool("draft_client_communication", { matterId: matter._id.toString(), purpose: "case status update" }, ctx);
  assert.equal(result.draft, true);
  assert.match(result.message, /DRAFT/);
  assert.match(result.message, /not been sent/i);
});

test("SECURITY: legal AI tools respect matter-team assignment — an unassigned member gets notFound", async () => {
  const org = await makeOrg("legal-ai-visibility");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Private Matter", type: "corporate", actorEmail: org.ownerEmail, membership: org.owner });
  const ctx = await buildLegalContext({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  const result = await runLegalTool("get_matter_summary", { matterId: matter._id.toString() }, ctx);
  assert.equal(result.notFound, true);
});

// ============================================================
// Full ai-os-router.js wiring
// ============================================================
test("ai-os-router: health_ and legal_ tool declarations are present with correct prefixes, and dispatch works end-to-end", async () => {
  const org = await makeOrg("os-router-wiring");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Router Patient", dateOfBirth: "1984-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  await assignCareTeamMember({ orgId: org.orgId, patientId: patient._id, memberEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });

  const declarations = getOsToolDeclarations("org");
  const names = declarations.map((d) => d.name);
  assert.ok(names.includes("health_search_patients"));
  assert.ok(names.includes("legal_search_matters"));
  assert.ok(HEALTH_TOOL_DECLARATIONS.length > 0 && LEGAL_TOOL_DECLARATIONS.length > 0);

  const ctx = await buildOsContext({ scope: "org", orgId: org.orgId, membership: org.owner, email: org.ownerEmail });
  assert.ok(ctx.healthCtx, "buildOsContext must build a real healthCtx for org scope");
  assert.ok(ctx.legalCtx, "buildOsContext must build a real legalCtx for org scope");

  const result = await runOsTool("health_search_patients", { query: "Router" }, ctx);
  assert.equal(result.patients.length, 1);
  assert.equal(result.patients[0].name, "Router Patient");
});
