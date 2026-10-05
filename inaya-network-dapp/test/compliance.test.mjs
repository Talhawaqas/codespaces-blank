// test/compliance.test.mjs -- compliance readiness (COMPLIANCE-001..006): the NIST 800-53 internal catalog extending the framework engine, control status with responsibility, owners, evidence and
// exceptions, live collectors that never invent a pass, the government profile (no certification implied), the OSCAL-shaped evidence package, FIPS-ready crypto policy, enhanced government audit,
// data labels, and the HTTP routes. Real MongoDB.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/compliance.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections, createSession } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { FRAMEWORKS, listFrameworks, getRequirement } from "../src/lib/compliance-frameworks.js";
import * as N from "../src/lib/compliance/nist80053.js";
import * as IMPL from "../src/lib/compliance/implementation.js";
import { collect, collectAll, COLLECTOR_IDS } from "../src/lib/compliance/collectors.js";
import * as GOV from "../src/lib/compliance/governmentProfile.js";
import { buildPackage, checkShape, uuidFrom } from "../src/lib/compliance/oscal.js";
import * as P from "../src/lib/crypto/policy.js";
import * as route from "../src/app/api/orgs/compliance/[[...path]]/route.js";
import { GET as retrieve } from "../src/app/api/orgs/documents/[documentId]/retrieve/route.js";

const T = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
let org, owner, member, auditor, db, doc;
const mine = (who = owner) => ({ orgId: org.oid, membership: who.membership, actorEmail: who.email });
const by = async (id) => (await IMPL.getControl({ orgId: org.oid, membership: owner.membership, controlId: id })).control;

before(async () => {
  await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("cmp", { people: ["member", "auditor"] }); owner = org.owner; member = org.member;
  await cols.orgMembers.updateOne({ orgId: org.orgId, email: org.auditor.email }, { $set: { adminRoles: ["auditor"] } }); auditor = { ...org.auditor, membership: await cols.orgMembers.findOne({ orgId: org.orgId, email: org.auditor.email }) };
  for (const f of ["FEATURE_COMPLIANCE_READINESS", "FEATURE_GOVERNMENT_SECURITY_PROFILE"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
  const dept = (await cols.departments.insertOne({ orgId: org.orgId, name: "Ops", createdAt: new Date().toISOString() })).insertedId; const proj = (await cols.projects.insertOne({ orgId: org.orgId, departmentId: dept, name: "P", createdAt: new Date().toISOString(), createdByEmail: owner.email })).insertedId;
  doc = (await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: dept, projectId: proj, filename: "plan.pdf", fileHash: `0xcmp-${randomBytes(4).toString("hex")}`, sizeBytes: 9, cidAlpha: "QmA", cidBeta: "QmB", uploadedByEmail: owner.email, txHash: "0x", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date().toISOString(), deletedAt: null })).insertedId;
});
after(async () => { for (const n of ["compliance_control_status", "compliance_snapshots", "compliance_evidence", "gov_security_profile", "data_classifications"]) await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {}); await cols.orgDocuments.deleteMany({ orgId: org.orgId }); await cols.projects.deleteMany({ orgId: org.orgId }); await cols.departments.deleteMany({ orgId: org.orgId }); await teardown(); });

test("catalog: a large, well-formed, honest NIST SP 800-53 Rev. 5 internal catalog registered with the existing framework engine", T, () => {
  const ids = N.REQUIREMENTS.map((r) => r.id); assert.equal(new Set(ids).size, ids.length, "no duplicates"); assert.ok(ids.length >= 200, `${ids.length} controls`); assert.ok(ids.every((i) => /^[A-Z]{2}-\d+$/.test(i)));
  for (const fam of Object.keys(N.FAMILIES)) assert.ok(N.REQUIREMENTS.filter((r) => r.family === fam).length >= 3, `${fam} has controls`); assert.equal(Object.keys(N.FAMILIES).length, 19);
  for (const f of ["AC", "AT", "AU", "CA", "CM", "CP", "IA", "IR", "MA", "MP", "PE", "PL", "PM", "PS", "RA", "SA", "SC", "SI", "SR"]) assert.ok(N.FAMILIES[f], f);
  assert.equal(N.BY_ID.get("AC-2").title, "Account Management"); assert.equal(N.BY_ID.get("SC-13").title, "Cryptographic Protection"); assert.equal(N.BY_ID.get("AU-9").title, "Protection of Audit Information"); assert.equal(N.BY_ID.get("CP-9").title, "System Backup");
  assert.ok(FRAMEWORKS.NIST_800_53_R5 && listFrameworks().some((f) => f.id === "NIST_800_53_R5" && f.requirementCount === ids.length), "extends the existing Regulatory Framework Engine"); assert.equal(getRequirement("NIST_800_53_R5", "IA-5").title, "Authenticator Management");
  assert.match(N.BASELINE_NOTE, /Not the authoritative publication; not a certification/); assert.ok(N.REQUIREMENTS.every((r) => /authoritative control text/.test(r.description)), "every description points to the authoritative text");
  assert.ok(Object.keys(IMPL.DEFAULTS).every((id) => N.BY_ID.has(id)), "every curated default names a real control");
});

test("control status: defaults are labelled, responsibility defaults by family, inherited physical controls, no control starts as 'compliant'", T, async () => {
  assert.equal((await code(IMPL.listControls({ orgId: org.oid, membership: member.membership })))?.status, 403, "a plain member cannot read it");
  const { controls, catalog } = await IMPL.listControls({ orgId: org.oid, membership: auditor.membership, limit: 1000 }); assert.equal(controls.length, N.REQUIREMENTS.length); assert.match(catalog.note, /not a certification/i);
  const by = Object.fromEntries(controls.map((c) => [c.controlId, c])); assert.equal(by["AU-9"].implementation, "implemented"); assert.equal(by["AU-9"].responsibility, "provider"); assert.equal(by["AU-9"].source, "default"); assert.equal(by["PE-3"].implementation, "inherited"); assert.equal(by["PE-3"].responsibility, "inherited"); assert.equal(by["AT-2"].implementation, "not_assessed"); assert.equal(by["AT-2"].responsibility, "customer");
  assert.ok(controls.every((c) => IMPL.IMPLEMENTATION.includes(c.implementation) && IMPL.RESPONSIBILITY.includes(c.responsibility))); assert.ok(controls.filter((c) => c.implementation === "not_assessed").length > controls.length / 2, "most controls start unassessed, not green");
  const f = await IMPL.listControls({ orgId: org.oid, membership: auditor.membership, family: "AU" }); assert.ok(f.controls.every((c) => c.family === "AU") && f.controls.length >= 10); const s = await IMPL.listControls({ orgId: org.oid, membership: auditor.membership, q: "least privilege" }); assert.ok(s.controls.some((c) => c.controlId === "AC-6"));
  assert.ok((await IMPL.listControls({ orgId: org.oid, membership: auditor.membership, responsibility: "inherited" })).controls.every((c) => c.responsibility === "inherited"));
});

test("collectors report only what they observe: no data is NO_DATA, never a pass; every result is metadata", T, async () => {
  const facts = await collectAll(org.oid); assert.deepEqual(facts.map((f) => f.id).sort(), [...COLLECTOR_IDS].sort()); const f = Object.fromEntries(facts.map((x) => [x.id, x]));
  assert.equal(f.resilience.ok, null); assert.equal(f.resilience.state, "NO_DATA"); assert.equal(f.backup.ok, null); assert.equal(f.devices.state, "NOT_ENABLED"); assert.equal(f.gateways.state, "NOT_ENABLED"); assert.equal(f.mfa.ok, false, "nobody has a second factor in this test organization: observed, not assumed");
  assert.equal(f.auditChain.ok !== false, true); assert.ok(facts.every((x) => x.collectedAt && typeof x.summary === "string")); assert.equal(JSON.stringify(facts).includes("passphrase"), false);
  assert.equal((await collect(org.oid, "nope")).state, "UNKNOWN");
});

test("changing status: compliance staff only; owner must be a member; evidence state is computed (required, then available), never typed in", T, async () => {
  assert.equal((await code(IMPL.updateControl({ ...mine(auditor), controlId: "AU-9", patch: { implementation: "implemented" } })))?.status, 403, "an auditor reads but does not change");
  for (const bad of [{ implementation: "compliant" }, { responsibility: "someone" }, { ownerEmail: "ghost@example.com" }, {}]) assert.equal((await code(IMPL.updateControl({ ...mine(), controlId: "AU-9", patch: bad })))?.status, 400, JSON.stringify(bad));
  assert.equal((await code(IMPL.updateControl({ ...mine(), controlId: "ZZ-1", patch: { implementation: "implemented" } })))?.status, 404);
  const c1 = await IMPL.updateControl({ ...mine(), controlId: "AT-2", patch: { implementation: "implemented", responsibility: "customer", ownerEmail: member.email, statement: "Annual awareness training run by HR <b>always</b>." } }); assert.equal(c1.control.owner, member.email.toLowerCase()); assert.equal(c1.control.source, "assessed"); assert.equal(c1.control.statement.includes("<"), false);
  assert.equal(c1.control.evidence.state, "required", "implemented but no evidence: evidence is required");
  const L = await IMPL.attachEvidence({ ...mine(), controlId: "AT-2", ref: { kind: "link", url: "https://hr.example.com/training-2026.pdf", sha256: "a".repeat(64), label: "Training record" } }); assert.equal(L.control.evidence.state, "available"); const refId = L.control.evidence.refs[0].refId;
  for (const bad of [{ kind: "link", url: "http://insecure.example/x" }, { kind: "link", url: "https://u:p@x.example/a" }, { kind: "link", url: "not a url" }, { kind: "link", url: "https://x.example/a", sha256: "short" }, { kind: "vault", evidenceId: new ObjectId().toHexString() }, { kind: "snapshot", snapshotId: new ObjectId().toHexString(), collectorId: "auditChain" }, { kind: "file" }]) assert.ok((await code(IMPL.attachEvidence({ ...mine(), controlId: "AT-2", ref: bad }))).status >= 400, JSON.stringify(bad));
  const R = await IMPL.removeEvidence({ ...mine(), controlId: "AT-2", refId }); assert.equal(R.control.evidence.state, "required"); assert.equal((await code(IMPL.removeEvidence({ ...mine(), controlId: "AT-2", refId })))?.status, 404);
  await IMPL.attachEvidence({ ...mine(), controlId: "AT-2", ref: { kind: "link", url: "https://hr.example.com/old.pdf", validUntil: new Date(Date.now() - 86400_000).toISOString() } }); assert.equal((await by("AT-2")).evidence.state, "required", "expired evidence does not count");
});

test("evidence from the Evidence Vault and from live snapshots: only reviewed, unexpired vault items and fresh snapshots count; snapshots are real and fingerprinted", T, async () => {
  const mk = async (o) => (await db.collection("compliance_evidence").insertOne({ orgId: org.orgId, controlId: null, type: "policy", reviewStatus: "pending", validUntil: null, createdAt: new Date().toISOString(), ...o })).insertedId.toHexString();
  await IMPL.updateControl({ ...mine(), controlId: "PL-4", patch: { implementation: "implemented" } }); const pending = await mk({}), approved = await mk({ reviewStatus: "approved" }), expired = await mk({ reviewStatus: "approved", validUntil: new Date(Date.now() - 1000).toISOString() });
  await IMPL.attachEvidence({ ...mine(), controlId: "PL-4", ref: { kind: "vault", evidenceId: pending } }); assert.equal((await by("PL-4")).evidence.state, "required", "a pending vault item does not count");
  await IMPL.attachEvidence({ ...mine(), controlId: "PL-4", ref: { kind: "vault", evidenceId: expired } }); assert.equal((await by("PL-4")).evidence.state, "required", "an expired item does not count");
  await IMPL.attachEvidence({ ...mine(), controlId: "PL-4", ref: { kind: "vault", evidenceId: approved } }); assert.equal((await by("PL-4")).evidence.state, "available");
  assert.equal((await code(IMPL.attachEvidence({ ...mine(), controlId: "PL-4", ref: { kind: "vault", evidenceId: await (async () => { const other = await makeChatOrg("cmp2", { people: [] }); const id = (await db.collection("compliance_evidence").insertOne({ orgId: other.orgId, reviewStatus: "approved" })).insertedId.toHexString(); return id; })() } })))?.status, 404, "another organization's evidence cannot be attached");
  const snap = await IMPL.takeSnapshot(mine()); assert.equal(snap.results.length, COLLECTOR_IDS.length); assert.ok(snap.results.every((r) => r.fingerprint.length === 64)); assert.equal((await code(IMPL.takeSnapshot(mine(auditor))))?.status, 403);
  await IMPL.updateControl({ ...mine(), controlId: "CP-10", patch: { implementation: "partially_implemented" } }); await IMPL.attachEvidence({ ...mine(), controlId: "CP-10", ref: { kind: "snapshot", snapshotId: snap.snapshotId, collectorId: "resilience" } }); const c = await by("CP-10"); assert.equal(c.evidence.state, "available"); assert.equal(c.evidence.refs[0].kind, "snapshot"); assert.equal(c.evidence.refs[0].fingerprint.length, 64);
  await db.collection("compliance_snapshots").updateOne({ _id: new ObjectId(snap.snapshotId) }, { $set: { at: new Date(Date.now() - 120 * 86400_000).toISOString() } }); await db.collection("compliance_control_status").updateOne({ orgId: org.orgId, controlId: "CP-10" }, { $set: { "evidenceRefs.0.at": new Date(Date.now() - 120 * 86400_000).toISOString() } }); assert.equal((await by("CP-10")).evidence.state, "required", "a snapshot older than 90 days is stale");
  await IMPL.updateControl({ ...mine(), controlId: "PE-6", patch: { implementation: "not_applicable" } }); assert.equal((await by("PE-6")).evidence.state, "none", "not applicable needs no evidence");
});

test("exceptions always expire: reason, compensating measure and an expiry within a year are mandatory; an expired one is flagged; closing works", T, async () => {
  const ex = (o) => IMPL.setException({ ...mine(), controlId: "SI-2", reason: "Vendor patch is delayed until the maintenance window next month.", compensating: "Network isolation and monitoring.", expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), ...o });
  assert.equal((await code(ex({ ...mine(auditor) })))?.status, 403); for (const bad of [{ reason: "short" }, { compensating: "x" }, { expiresAt: "2020-01-01" }, { expiresAt: new Date(Date.now() + 400 * 86400_000).toISOString() }, { expiresAt: "never" }]) assert.equal((await code(ex(bad)))?.status, 400, JSON.stringify(bad));
  const ok = await ex({}); assert.equal(ok.control.exception.state, "approved"); assert.equal(ok.control.exception.approvedBy, owner.email);
  await db.collection("compliance_control_status").updateOne({ orgId: org.orgId, controlId: "SI-2" }, { $set: { "exception.expiresAt": new Date(Date.now() - 1000).toISOString() } }); assert.equal((await by("SI-2")).exception.state, "expired", "never silently permanent");
  const s = await IMPL.summary({ orgId: org.oid, membership: auditor.membership }); assert.equal(s.totals.exceptionsExpired, 1); await ex({}); assert.equal((await IMPL.closeException({ ...mine(), controlId: "SI-2" })).control.exception.state, "closed"); assert.equal((await code(IMPL.closeException({ ...mine(), controlId: "SI-2" })))?.status, 404);
});

test("readiness summary adds up, counts evidence gaps and states plainly that it is not a statement of compliance", T, async () => {
  const s = await IMPL.summary({ orgId: org.oid, membership: auditor.membership }); assert.equal(s.totals.controls, N.REQUIREMENTS.length); assert.equal(s.families.reduce((n, f) => n + f.controls, 0), N.REQUIREMENTS.length); assert.equal(Object.values(s.totals.byImplementation).reduce((a, b) => a + b, 0), N.REQUIREMENTS.length);
  assert.equal(s.totals.evidence.available + s.totals.evidence.required + s.totals.evidence.none, N.REQUIREMENTS.length); assert.ok(s.totals.evidence.required >= 1); assert.ok(s.totals.assessed >= 3); assert.match(s.disclaimer, /not a statement of compliance, authorization or certification/); assert.equal(s.families.length, 19);
});

test("government profile: owner/admin only; four states; the label never implies certification; technical checks are live and honest; the customer's authorization is recorded, not verified", T, async () => {
  const g0 = await GOV.getProfile({ orgId: org.oid, membership: auditor.membership }); assert.equal(g0.state, "GENERAL"); assert.match(g0.notice, /not a FedRAMP, FISMA, ATO, FIPS or other certification/); assert.equal(g0.technicalChecks.total, 0);
  assert.equal((await code(GOV.getProfile({ orgId: org.oid, membership: member.membership })))?.status, 403); assert.equal((await code(GOV.setProfile({ ...mine(auditor), state: "GOVERNMENT_READY" })))?.status, 403); assert.equal((await code(GOV.setProfile({ ...mine(), state: "FEDRAMP_HIGH" })))?.status, 400);
  assert.deepEqual(GOV.STATES, ["GENERAL", "GOVERNMENT_READY", "GOVERNMENT_HIGH_READINESS", "CUSTOMER_SPECIFIC_AUTHORIZATION"]); for (const l of Object.values(GOV.STATE_LABELS)) assert.equal(/certified|authorized by|FedRAMP High/i.test(l) && !/customer-specific/i.test(l), false, l);
  const r = await GOV.setProfile({ ...mine(), state: "GOVERNMENT_READY" }); assert.equal(r.state, "GOVERNMENT_READY"); assert.equal(r.enhancedAudit, true); assert.ok(r.technicalChecks.total >= 6); assert.ok(r.technicalChecks.met < r.technicalChecks.total, "a fresh organization does not meet them all"); assert.ok(r.technicalChecks.checks.every((c) => typeof c.detail === "string"));
  const mfa = r.technicalChecks.checks.find((c) => c.id === "mfa"); assert.equal(mfa.met, false); const h = await GOV.setProfile({ ...mine(), state: "GOVERNMENT_HIGH_READINESS" }); assert.ok(h.technicalChecks.total > r.technicalChecks.total); assert.equal(h.technicalChecks.checks.find((c) => c.id === "fips_runtime").met, false, "no validated runtime, so not met"); assert.equal(h.technicalChecks.checks.find((c) => c.id === "customer_keys").met, false);
  assert.equal((await code(GOV.setProfile({ ...mine(), state: "CUSTOMER_SPECIFIC_AUTHORIZATION", authorization: { authority: "Agency X" } })))?.status, 400, "authority, reference and boundary are required");
  const c = await GOV.setProfile({ ...mine(), state: "CUSTOMER_SPECIFIC_AUTHORIZATION", authorization: { authority: "Agency X", reference: "ATO-123 <b>", boundary: "The Inaya workspace and two storage providers", grantedOn: "2026-01-15" } }); assert.equal(c.authorization.verifiedByInaya, false); assert.equal(c.authorization.reference.includes("<"), false); assert.match(c.label, /recorded by the customer/);
  assert.equal((await code(GOV.setProfile({ ...mine(), state: "GOVERNMENT_READY", ipPolicy: "everything" })))?.status, 400);
});

test("enhanced government audit: only with a government profile; carries who, role, department, object, action, device, masked address, result, decision and basis; the address policy is honoured; document reads are logged through the real route", T, async () => {
  await GOV.setProfile({ ...mine(), state: "GENERAL" }); assert.equal(await GOV.recordAccess({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, documentId: String(doc), ip: "198.51.100.77" }), null, "nothing extra under the general profile");
  await GOV.setProfile({ ...mine(), state: "GOVERNMENT_READY" }); const rec = await GOV.recordAccess({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, documentId: String(doc), filename: "plan.pdf", departmentId: new ObjectId(), deviceId: "dev-1", ip: "198.51.100.77", policyDecision: "permission MANAGE" });
  for (const k of ["user", "role", "department", "object", "action", "at", "device", "ip", "result", "policyDecision", "authorizationBasis", "evidenceRef"]) assert.ok(k in rec, k); assert.equal(rec.ip, "198.51.100.0"); assert.equal(rec.object.type, "document"); assert.equal(rec.result, "ALLOWED");
  await GOV.setProfile({ ...mine(), state: "GOVERNMENT_READY", ipPolicy: "none" }); assert.equal((await GOV.recordAccess({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, documentId: String(doc), ip: "198.51.100.77" })).ip, null); await GOV.setProfile({ ...mine(), state: "GOVERNMENT_READY", ipPolicy: "full" }); assert.equal((await GOV.recordAccess({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, documentId: String(doc), ip: "198.51.100.77" })).ip, "198.51.100.77"); await GOV.setProfile({ ...mine(), state: "GOVERNMENT_READY", ipPolicy: "masked" });
  const before = (await GOV.listAccess({ orgId: org.oid, membership: auditor.membership })).events.length; const cookie = (await createSession(owner.email)).sessionToken;
  const res = await retrieve(new NextRequest(`http://localhost:3000/api/orgs/documents/${doc}/retrieve?orgId=${org.oid}`, { headers: { cookie: `inaya_org_session=${cookie}`, "x-forwarded-for": "203.0.113.9" } }), { params: { documentId: String(doc) } }); assert.equal(res.status, 200);
  let after = before; for (let i = 0; i < 20 && after <= before; i++) { await new Promise((r) => setTimeout(r, 400)); after = (await GOV.listAccess({ orgId: org.oid, membership: auditor.membership })).events.length; } assert.ok(after > before, "the real retrieve route wrote an enhanced record");
  const last = (await GOV.listAccess({ orgId: org.oid, membership: auditor.membership })).events.find((e) => e.ip === "203.0.113.0"); assert.ok(last && last.filename === "plan.pdf" && last.profile === "GOVERNMENT_READY"); assert.equal((await code(GOV.listAccess({ orgId: org.oid, membership: member.membership })))?.status, 403);
});

test("government data labels: the preset adds the labels that are missing, never changes existing ones, uses neutral names for the customer-defined classes, and is owner/admin only", T, async () => {
  assert.equal((await code(GOV.applyGovernmentLabels(mine(auditor))))?.status, 403); const { getOrgClassificationLevels } = await import("../src/lib/classification.js"); const before = await getOrgClassificationLevels(org.oid); const r = await GOV.applyGovernmentLabels(mine());
  const after = await getOrgClassificationLevels(org.oid); const keys = new Set(after.map((l) => l.key)); for (const k of ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "SENSITIVE", "CONTROLLED_CLASS_A", "EXPORT_CONTROLLED_CLASS", "RESTRICTED", "LEGAL_HOLD", "MISSION_CRITICAL"]) assert.ok(keys.has(k), k);
  assert.ok(r.added.includes("SENSITIVE") && r.added.includes("MISSION_CRITICAL") && !r.added.includes("PUBLIC")); for (const l of before) assert.deepEqual(after.find((x) => x.key === l.key).label, l.label, "existing labels untouched");
  assert.ok(after.find((l) => l.key === "CONTROLLED_CLASS_A").label.includes("customer-defined") && !/CUI|ITAR/i.test(JSON.stringify(after.filter((l) => l.source === "government-preset")))); assert.deepEqual((await GOV.applyGovernmentLabels(mine())).added, [], "idempotent");
});

test("OSCAL-shaped evidence package: a structurally sound SSP with stable ids, every control, linked evidence resources, the requested sections, a verifiable hash, and no secrets", T, async () => {
  assert.equal((await code(buildPackage({ orgId: org.oid, membership: member.membership })))?.status, 403); const pkg = await buildPackage({ orgId: org.oid, membership: auditor.membership }); assert.deepEqual(pkg.shapeCheck, { ok: true, problems: [] });
  const ssp = pkg.oscal["system-security-plan"]; assert.equal(ssp.metadata["oscal-version"], "1.1.2"); assert.match(ssp.metadata.remarks, /Not validated against the official OSCAL schema/); assert.match(ssp.metadata.remarks, /not a FedRAMP/i); assert.equal(ssp["control-implementation"]["implemented-requirements"].length, N.REQUIREMENTS.length);
  const r = ssp["control-implementation"]["implemented-requirements"].find((x) => x["control-id"] === "au-9"); assert.equal(r.props.find((p) => p.name === "implementation-status").value, "implemented"); assert.equal(r.props.find((p) => p.name === "control-origination").value, "sp-system");
  const at = ssp["control-implementation"]["implemented-requirements"].find((x) => x["control-id"] === "pl-4"); assert.ok(at.statements[0].links?.length >= 1, "attached evidence is linked"); assert.ok(ssp["back-matter"].resources.some((x) => at.statements[0].links.some((l) => l.href === `#${x.uuid}`)));
  assert.equal(uuidFrom("a"), uuidFrom("a")); assert.notEqual(uuidFrom("a"), uuidFrom("b")); const again = await buildPackage({ orgId: org.oid, membership: auditor.membership }); assert.equal(again.oscal["system-security-plan"].uuid, ssp.uuid, "stable identifiers across exports");
  for (const k of ["systemDescription", "componentInventory", "controlStatus", "evidenceReferences", "policyVersions", "auditChainVerification", "configurationSnapshots", "deploymentProfile", "identityIntegrations", "vulnerabilityStatus", "incidentsAndSecurityEvents", "resilienceResults", "dataResidencyPolicy", "encryptionMode", "keyManagementMode", "cryptography", "customerResponsibilityStatement"]) assert.ok(k in pkg, k);
  assert.equal(pkg.vulnerabilityStatus.state, "NOT_COLLECTED"); assert.match(pkg.customerResponsibilityStatement, /not an assessment, an authorization or a certification/); assert.ok(pkg.componentInventory.some((c) => c.responsibility === "inherited")); assert.equal(pkg.keyManagementMode, "platform");
  const { sha256, shapeCheck, ...body } = pkg; assert.equal(sha256, createHash("sha256").update(JSON.stringify(body)).digest("hex")); const text = JSON.stringify(pkg); assert.equal(/PRIVATE KEY|S3_COMPAT_ENCRYPTION_KEY|passphrase/i.test(text), false, "no secrets"); assert.equal(text.includes("plan.pdf"), false, "no file names");
  const bad = JSON.parse(JSON.stringify(pkg.oscal)); bad["system-security-plan"]["control-implementation"]["implemented-requirements"][0]["control-id"] = "NOT AN ID"; bad["system-security-plan"].metadata = {}; delete bad["system-security-plan"]["back-matter"]; assert.ok(checkShape(bad).length >= 3, "the shape check catches broken documents"); assert.deepEqual(checkShape({}), ["missing system-security-plan"]);
});

test("FIPS-ready crypto abstraction: published vectors pass on every available provider, the policy refuses non-approved algorithms in fips_ready mode, nothing is ever called validated, and the inventory is complete", T, async () => {
  const st = P.selfTest(); assert.equal(st.passed, true, JSON.stringify(st.results.filter((r) => !r.pass))); assert.ok(st.results.some((r) => r.id === "aes-256-gcm" && r.kind === "known-answer") && st.results.some((r) => r.kind === "pairwise-consistency")); const nb = await P.selfTestNoble(); assert.equal(nb.passed, true, JSON.stringify(nb.results.filter((r) => !r.pass))); assert.ok(nb.results.length >= 3, "two independent implementations agree with the published values");
  assert.equal(P.algorithmAllowed("chacha20-poly1305", "standard"), true); assert.equal(P.algorithmAllowed("chacha20-poly1305", "fips_ready"), false); assert.equal(P.algorithmAllowed("aes-256-gcm", "fips_ready"), true); assert.throws(() => P.assertAlgorithm("scrypt", "fips_ready"), P.AlgorithmNotApproved); assert.throws(() => P.assertAlgorithm("rot13", "standard"), /Unknown algorithm/); assert.equal(P.currentMode({ INAYA_CRYPTO_MODE: "fips_ready" }), "fips_ready"); assert.equal(P.currentMode({}), "standard");
  const f = P.fipsStatus({ INAYA_FIPS_VALIDATION_REF: "CMVP #0000 (example)" }); assert.ok(["NOT_VALIDATED", "FIPS_RUNTIME_ENABLED", "FIPS_READY"].includes(f.status)); assert.match(f.claim, /does not claim FIPS 140-3 validation/); if (!f.runtimeFipsMode) assert.equal(f.status, "NOT_VALIDATED", "a recorded reference alone never makes it FIPS-ready");
  const inv = await P.inventory(); assert.ok(inv.providers.every((p) => p.validated === false), "no provider is marked validated"); assert.ok(inv.providers.some((p) => p.id === "certified-module" && !p.available)); assert.ok(P.USAGE.every((u) => u.algorithms.every((a) => P.ALGORITHMS[a])), "every algorithm named in the usage inventory exists in the registry"); assert.ok(inv.usage.some((u) => u.notApproved.length), "non-approved uses are listed, not hidden");
  assert.ok(inv.dependencies.modules.some((m) => m.name === "node:crypto") && inv.dependencies.modules.some((m) => m.name === "ethers") && inv.dependencies.modules.every((m) => m.validated === false));
});

test("HTTP routes: summary, controls, evidence, exceptions, snapshot, package download, crypto, government and key status; roles and feature switches are enforced", T, async () => {
  const cookie = (await createSession(owner.email)).sessionToken; const mem = (await createSession(member.email)).sessionToken; const aud = (await createSession(auditor.email)).sessionToken;
  const call = (c, path, method = "GET", body) => route[method](new NextRequest(`http://localhost:3000/api/orgs/compliance/${path}${path.includes("?") ? "&" : "?"}orgId=${org.oid}`, { method, headers: { cookie: `inaya_org_session=${c}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve({ path: path.split("?")[0].split("/") }) });
  assert.equal((await call(cookie, "summary")).status, 200); assert.equal((await call(mem, "summary")).status, 403); assert.equal((await call(aud, "summary")).status, 200); const list = await (await call(aud, "controls?family=AU")).json(); assert.ok(list.controls.length >= 10);
  assert.equal((await call(aud, "controls/AU-9", "PATCH", { implementation: "partially_implemented" })).status, 403); const patched = await call(cookie, "controls/AU-9", "PATCH", { statement: "Hash-chained." }); assert.equal(patched.status, 200); assert.equal((await call(cookie, "controls/NOPE-1")).status, 404);
  assert.equal((await call(cookie, "controls/AC-2/exception", "POST", { reason: "short", compensating: "x", expiresAt: "2020" })).status, 400); assert.equal((await call(cookie, "snapshot", "POST")).status, 201); assert.equal((await call(aud, "facts")).status, 200); assert.equal((await call(mem, "facts")).status, 403);
  const pk = await call(aud, "package"); assert.equal(pk.status, 200); assert.match(pk.headers.get("content-disposition"), /evidence-package-/); assert.equal((await pk.json()).shapeCheck.ok, true); assert.equal((await call(mem, "package")).status, 403);
  const cr = await call(aud, "crypto"); assert.equal(cr.status, 200); const cj = await cr.json(); assert.equal(cj.selfTest.passed, true); assert.ok(cj.usage.length >= 8);
  assert.equal((await call(cookie, "government")).status, 200); assert.equal((await call(cookie, "government", "PUT", { state: "GOVERNMENT_READY" })).status, 200); assert.equal((await call(cookie, "government/labels", "POST")).status, 200); assert.equal((await call(aud, "government/access")).status, 200);
  assert.equal((await call(aud, "keys")).status, 200); assert.equal((await call(mem, "keys")).status, 403); assert.equal((await call(cookie, "keys/configure", "POST", { provider: "local", keyRef: "x", acknowledgeDestruction: true })).status === 200, false, "key changes need their own feature switch");
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_COMPLIANCE_READINESS", enabled: false }); assert.ok([403, 404].includes((await call(cookie, "summary")).status), "readiness switch applies"); await setOrgFeature({ orgId: org.oid, name: "FEATURE_COMPLIANCE_READINESS", enabled: true });
  assert.equal((await route.GET(new NextRequest(`http://localhost:3000/api/orgs/compliance/summary?orgId=${org.oid}`), { params: Promise.resolve({ path: ["summary"] }) })).status, 401);
});

test("public API compliance family: bound to the key's organization, read-only, behind the feature switch", T, async () => {
  const { createApiKey } = await import("../src/lib/api-keys.js"); const sum = await import("../src/app/api/public/v1/compliance/summary/route.js"); const ctl = await import("../src/app/api/public/v1/compliance/controls/route.js");
  const key = await createApiKey({ orgId: org.oid, label: "cmp", actorEmail: owner.email }); const mk = (url, k = key.rawKey) => new Request(`http://localhost:3000${url}`, { headers: { authorization: `Bearer ${k}` } });
  assert.equal((await sum.GET(new Request("http://localhost:3000/api/public/v1/compliance/summary"))).status, 401); const ok = await sum.GET(mk("/api/public/v1/compliance/summary")); assert.equal(ok.status, 200); const j = await ok.json(); assert.equal(j.totals.controls, N.REQUIREMENTS.length); assert.match(j.disclaimer, /not a statement of compliance/);
  const c = await (await ctl.GET(mk("/api/public/v1/compliance/controls?family=PE"))).json(); assert.ok(c.controls.length >= 10 && c.controls.every((x) => x.family === "PE")); assert.equal(sum.POST, undefined);
  const other = await makeChatOrg("cmp3", { people: [] }); const k2 = await createApiKey({ orgId: other.oid, label: "o", actorEmail: other.owner.email }); const off = await sum.GET(mk("/api/public/v1/compliance/summary", k2.rawKey)); assert.ok([403, 404].includes(off.status), "another organization has the feature off");
  await cols.apiKeys.deleteMany({ orgId: { $in: [org.orgId, other.orgId] } });
});
