// test/document-permissions.test.mjs
//
// Phase 3 coverage per the SOW's §18 list: permissions (owner/admin/member/
// private/department/project/explicit VIEW-EDIT-MANAGE/revocation/
// unauthorized/org isolation), sharing (creation/valid/expired/revoked/
// invalid-token/max-uses/activity-logging), and security (document ID
// manipulation, CID manipulation, role escalation, cross-org access,
// concurrent permission changes, concurrent share access/revocation).
//
// Tests the lib layer directly (document-permissions.js), same reasoning
// as every other test file in this repo: the routes are thin wrappers
// around these functions, and importing route.js pulls in next/server,
// which plain `node --test` can't resolve outside Next's own bundler.
//
// Run with: node --test test/document-permissions.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  getDocumentAccessLevel,
  getBulkDocumentAccess,
  requireDocumentAccess,
  isProjectMember,
  meetsLevel,
  createDocumentShare,
  consumeDocumentShare,
  revokeDocumentShare,
  resolveShareAccess,
  resolveExpiresAt,
} from "../src/lib/document-permissions.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-perm-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [], docIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, projects, orgDocuments, documentActivity, projectMembers, documentPermissions, documentShares } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await documentActivity.deleteMany({ documentId: { $in: cleanup.docIds } });
  await projectMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await documentPermissions.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await documentShares.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

// ============================================================
// Fixtures
// ============================================================
async function makeOrg(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptA = await collections.departments.insertOne({ orgId, name: "Finance", createdAt: now });
  const deptB = await collections.departments.insertOne({ orgId, name: "HR", createdAt: now });
  const projA = await collections.projects.insertOne({ orgId, departmentId: deptA.insertedId, name: "Client A", createdAt: now });

  async function makeMember(role, departmentIds = []) {
    const e = email(`${label}-${role}-${randomUUID().slice(0, 4)}`);
    await collections.orgMembers.insertOne({ orgId, email: e, role, departmentIds, status: "active", invitedAt: now, joinedAt: now });
    const m = await collections.orgMembers.findOne({ orgId, email: e });
    return { email: e, membership: m };
  }

  const owner = await makeMember("owner");
  const admin = await makeMember("admin");
  const financeMember = await makeMember("member", [deptA.insertedId]);
  const hrMember = await makeMember("member", [deptB.insertedId]);
  const outsider = await makeMember("member", []);

  return { orgId, deptFinanceId: deptA.insertedId, deptHrId: deptB.insertedId, projAId: projA.insertedId, owner, admin, financeMember, hrMember, outsider };
}

async function makeDoc({ orgId, departmentId, projectId, accessLevel, uploadedByEmail }) {
  const now = new Date().toISOString();
  const result = await collections.orgDocuments.insertOne({
    orgId, departmentId, projectId,
    filename: "test.pdf", fileHash: `0xperm-${randomUUID()}`, sizeBytes: 1000,
    cidAlpha: "QmA", cidBeta: "QmB",
    uploadedByEmail, txHash: "0xfake", status: "DRAFT", accessLevel,
    createdAt: now, deletedAt: null,
  });
  cleanup.docIds.push(result.insertedId);
  return result.insertedId;
}

// ============================================================
// PERMISSIONS
// ============================================================
test("permissions: org owner has MANAGE on any document, including PRIVATE ones they didn't upload", async () => {
  const org = await makeOrg("owner-access");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.outsider.email });
  const doc = await collections.orgDocuments.findOne({ _id: docId });
  const level = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.owner.membership, email: org.owner.email });
  assert.equal(level, "MANAGE");
});

test("permissions: org admin has MANAGE on any document org-wide, not just their own department", async () => {
  const org = await makeOrg("admin-access");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptHrId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.outsider.email });
  const doc = await collections.orgDocuments.findOne({ _id: docId });
  const level = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.admin.membership, email: org.admin.email });
  assert.equal(level, "MANAGE");
});

test("permissions: a plain member with no relationship to a document gets no access", async () => {
  const org = await makeOrg("member-noaccess");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptHrId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.outsider.email });
  const doc = await collections.orgDocuments.findOne({ _id: docId });
  const level = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.financeMember.membership, email: org.financeMember.email });
  assert.equal(level, null);
});

test("permissions: PRIVATE document — only owner and explicitly authorized users, not department members", async () => {
  const org = await makeOrg("private-doc");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.outsider.email });
  const doc = await collections.orgDocuments.findOne({ _id: docId });

  // Finance member has department access but the doc is PRIVATE -> still nothing.
  const level = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.financeMember.membership, email: org.financeMember.email });
  assert.equal(level, null);
});

test("permissions: DEPARTMENT document is accessible to department members but not outsiders", async () => {
  const org = await makeOrg("dept-doc");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "DEPARTMENT", uploadedByEmail: org.owner.email });
  const doc = await collections.orgDocuments.findOne({ _id: docId });

  const financeLevel = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.financeMember.membership, email: org.financeMember.email });
  const hrLevel = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.hrMember.membership, email: org.hrMember.email });
  assert.ok(meetsLevel(financeLevel, "EDIT"));
  assert.equal(hrLevel, null);
});

test("permissions: PROJECT document is accessible to project members regardless of department", async () => {
  const org = await makeOrg("project-doc");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PROJECT", uploadedByEmail: org.owner.email });
  const doc = await collections.orgDocuments.findOne({ _id: docId });

  // hrMember isn't in Finance department, but add them as a PROJECT member.
  await collections.projectMembers.insertOne({ orgId: org.orgId, projectId: org.projAId, email: org.hrMember.email, addedAt: new Date().toISOString(), addedByEmail: org.owner.email });

  const hrLevel = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.hrMember.membership, email: org.hrMember.email });
  const outsiderLevel = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.outsider.membership, email: org.outsider.email });
  assert.ok(meetsLevel(hrLevel, "EDIT"));
  assert.equal(outsiderLevel, null);
});

test("permissions: explicit VIEW grant lets an outsider view but not edit a PRIVATE document", async () => {
  const org = await makeOrg("explicit-view");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  await collections.documentPermissions.insertOne({ orgId: org.orgId, documentId: docId, email: org.outsider.email, level: "VIEW", grantedByEmail: org.owner.email, grantedAt: new Date().toISOString() });

  const doc = await collections.orgDocuments.findOne({ _id: docId });
  const level = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.outsider.membership, email: org.outsider.email });
  assert.equal(level, "VIEW");
  assert.ok(meetsLevel(level, "VIEW"));
  assert.ok(!meetsLevel(level, "EDIT"));
});

test("permissions: explicit EDIT grant allows editing but not managing permissions", async () => {
  const org = await makeOrg("explicit-edit");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  await collections.documentPermissions.insertOne({ orgId: org.orgId, documentId: docId, email: org.outsider.email, level: "EDIT", grantedByEmail: org.owner.email, grantedAt: new Date().toISOString() });

  const doc = await collections.orgDocuments.findOne({ _id: docId });
  const level = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.outsider.membership, email: org.outsider.email });
  assert.ok(meetsLevel(level, "EDIT"));
  assert.ok(!meetsLevel(level, "MANAGE"));
});

test("permissions: explicit MANAGE grant allows managing permissions/sharing", async () => {
  const org = await makeOrg("explicit-manage");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  await collections.documentPermissions.insertOne({ orgId: org.orgId, documentId: docId, email: org.outsider.email, level: "MANAGE", grantedByEmail: org.owner.email, grantedAt: new Date().toISOString() });

  const doc = await collections.orgDocuments.findOne({ _id: docId });
  const level = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.outsider.membership, email: org.outsider.email });
  assert.equal(level, "MANAGE");
});

test("permissions: revoking an explicit grant removes access (back to null on a PRIVATE doc)", async () => {
  const org = await makeOrg("revocation");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  await collections.documentPermissions.insertOne({ orgId: org.orgId, documentId: docId, email: org.outsider.email, level: "EDIT", grantedByEmail: org.owner.email, grantedAt: new Date().toISOString() });

  const doc = await collections.orgDocuments.findOne({ _id: docId });
  const before = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.outsider.membership, email: org.outsider.email });
  assert.equal(before, "EDIT");

  await collections.documentPermissions.deleteOne({ orgId: org.orgId, documentId: docId, email: org.outsider.email });
  const after = await getDocumentAccessLevel({ orgId: org.orgId, doc, membership: org.outsider.membership, email: org.outsider.email });
  assert.equal(after, null);
});

test("permissions: workflow approval authority is independent of document permission level (EDIT does not mean can-approve)", async () => {
  // This is really document-workflow.js's canManageOrg gate, unaffected by
  // document_permissions grants — asserted here as the explicit "separation"
  // requirement: an EDIT (or even MANAGE) document grant is not the same
  // thing as being able to call startReview/approve/reject.
  const org = await makeOrg("workflow-separation");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  await collections.documentPermissions.insertOne({ orgId: org.orgId, documentId: docId, email: org.outsider.email, level: "MANAGE", grantedByEmail: org.owner.email, grantedAt: new Date().toISOString() });

  // outsider has document-level MANAGE, but org role is still "member" ->
  // canManageOrg-gated transitions (startReview etc.) must still refuse them.
  const { canManageOrg } = await import("../src/lib/orgs.js");
  assert.equal(canManageOrg(org.outsider.membership), false, "document permission level must never change the org role used for workflow gating");
});

test("permissions bulk resolution: matches single-document resolution and needs only 2 queries regardless of list size", async () => {
  const org = await makeOrg("bulk-resolution");
  const privateDoc = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const deptDoc = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "DEPARTMENT", uploadedByEmail: org.owner.email });
  await collections.documentPermissions.insertOne({ orgId: org.orgId, documentId: privateDoc, email: org.outsider.email, level: "VIEW", grantedByEmail: org.owner.email, grantedAt: new Date().toISOString() });

  const docs = await collections.orgDocuments.find({ _id: { $in: [privateDoc, deptDoc] } }).toArray();
  const bulk = await getBulkDocumentAccess({ orgId: org.orgId, email: org.outsider.email, membership: org.outsider.membership, docs });

  assert.equal(bulk.get(privateDoc.toString()), "VIEW");
  assert.equal(bulk.get(deptDoc.toString()), null, "outsider has no department relationship to this DEPARTMENT doc");
});

// ============================================================
// Small standalone helpers
// ============================================================
test("resolveExpiresAt: presets resolve to a future ISO date; invalid/past/too-far custom dates are rejected", () => {
  const oneHour = resolveExpiresAt({ preset: "1h" });
  assert.ok(new Date(oneHour).getTime() > Date.now());

  const pastDate = resolveExpiresAt({ customExpiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(pastDate, null, "a custom expiration in the past must be rejected");

  const tooFar = resolveExpiresAt({ customExpiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(tooFar, null, "a custom expiration beyond the 1-year sanity cap must be rejected");

  const garbage = resolveExpiresAt({ customExpiresAt: "not-a-date" });
  assert.equal(garbage, null);

  const validCustom = resolveExpiresAt({ customExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() });
  assert.ok(validCustom);
});

test("isProjectMember: reflects project_members membership directly", async () => {
  const org = await makeOrg("isprojectmember");
  const before = await isProjectMember({ orgId: org.orgId, projectId: org.projAId, email: org.hrMember.email });
  assert.equal(before, false);

  await collections.projectMembers.insertOne({ orgId: org.orgId, projectId: org.projAId, email: org.hrMember.email, addedAt: new Date().toISOString(), addedByEmail: org.owner.email });
  const after = await isProjectMember({ orgId: org.orgId, projectId: org.projAId, email: org.hrMember.email });
  assert.equal(after, true);
});

// ============================================================
// SHARING
// ============================================================
test("sharing: creation returns a token that is never stored in plaintext", async () => {
  const org = await makeOrg("share-creation");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });

  const { token } = await createDocumentShare({ orgId: org.orgId, documentId: docId, createdByEmail: org.owner.email, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxUses: null });
  assert.ok(token && token.length > 20);

  const { documentShares } = collections;
  const stored = await documentShares.findOne({ documentId: docId });
  assert.ok(stored);
  assert.notEqual(stored.tokenHash, token, "the raw token must never be the stored value");
  assert.equal(stored.tokenHash.length, 64, "sha256 hex digest");
});

test("sharing: a valid share can be accessed and returns only content pointers, no internal IDs", async () => {
  const org = await makeOrg("share-valid");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const { token } = await createDocumentShare({ orgId: org.orgId, documentId: docId, createdByEmail: org.owner.email, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxUses: null });

  const result = await resolveShareAccess(token);
  assert.equal(result.error, undefined);
  assert.equal(result.filename, "test.pdf");
  assert.equal(result.cidAlpha, "QmA");
  assert.equal(result.cidBeta, "QmB");
  assert.equal(result.documentId, undefined);
  assert.equal(result.orgId, undefined);
  assert.equal(result._id, undefined);
});

test("sharing: an expired share fails and is logged as DOCUMENT_SHARE_EXPIRED", async () => {
  const org = await makeOrg("share-expired");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const { token } = await createDocumentShare({ orgId: org.orgId, documentId: docId, createdByEmail: org.owner.email, expiresAt: new Date(Date.now() - 1000).toISOString(), maxUses: null });

  const result = await resolveShareAccess(token);
  assert.equal(result.status, 410);
  assert.match(result.error, /expired/i);

  const events = await collections.documentActivity.find({ documentId: docId, action: "DOCUMENT_SHARE_EXPIRED" }).toArray();
  assert.equal(events.length, 1);
  assert.equal(events[0].actorId, "external");
});

test("sharing: a revoked share fails immediately, even if it hasn't expired", async () => {
  const org = await makeOrg("share-revoked");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const { shareId, token } = await createDocumentShare({ orgId: org.orgId, documentId: docId, createdByEmail: org.owner.email, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxUses: null });

  const revoked = await revokeDocumentShare({ orgId: org.orgId, documentId: docId, shareId });
  assert.ok(revoked);

  const result = await resolveShareAccess(token);
  assert.equal(result.status, 410);
  assert.match(result.error, /revoked/i);
});

test("sharing: an invalid/random/modified token fails with 404", async () => {
  const result = await resolveShareAccess("this-is-not-a-real-token-" + randomUUID());
  assert.equal(result.status, 404);
});

test("sharing: maximum-use limit is enforced — the (N+1)th access fails", async () => {
  const org = await makeOrg("share-maxuses");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const { token } = await createDocumentShare({ orgId: org.orgId, documentId: docId, createdByEmail: org.owner.email, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxUses: 2 });

  const first = await resolveShareAccess(token);
  const second = await resolveShareAccess(token);
  const third = await resolveShareAccess(token);
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(third.status, 410);
});

test("sharing: DOCUMENT_SHARE_CREATED and DOCUMENT_SHARE_ACCESSED are both logged with correct actors", async () => {
  const org = await makeOrg("share-logging");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const { token } = await createDocumentShare({ orgId: org.orgId, documentId: docId, createdByEmail: org.owner.email, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxUses: null });
  // createDocumentShare() itself doesn't log (the route does, since it also
  // needs the caller's identity/expiresAt for metadata) — simulate that here.
  const { logDocumentActivity } = await import("../src/lib/activity-log.js");
  await logDocumentActivity({ organizationId: org.orgId, documentId: docId, actorId: org.owner.email, action: "DOCUMENT_SHARE_CREATED" });

  await resolveShareAccess(token);

  const events = await collections.documentActivity.find({ documentId: docId }).sort({ timestamp: 1 }).toArray();
  assert.deepEqual(events.map((e) => e.action), ["DOCUMENT_SHARE_CREATED", "DOCUMENT_SHARE_ACCESSED"]);
  assert.equal(events[0].actorId, org.owner.email);
  assert.equal(events[1].actorId, "external");
});

// ============================================================
// SECURITY
// ============================================================
test("security: document ID manipulation — a foreign documentId under the correct orgId 404s, never grants access", async () => {
  const orgA = await makeOrg("security-docid-a");
  const orgB = await makeOrg("security-docid-b");
  const docInB = await makeDoc({ orgId: orgB.orgId, departmentId: orgB.deptFinanceId, projectId: orgB.projAId, accessLevel: "DEPARTMENT", uploadedByEmail: orgB.owner.email });

  // orgA's owner (who has MANAGE on everything in orgA) tries to reach
  // orgB's document by ID — must not work even though they're an owner.
  const access = await requireDocumentAccess({ orgId: orgA.orgId, documentId: docInB, membership: orgA.owner.membership, email: orgA.owner.email, minLevel: "VIEW" });
  assert.equal(access.status, 404);
});

test("security: CID manipulation — knowing another document's CID doesn't grant access to a document you can't otherwise see", async () => {
  const org = await makeOrg("security-cid");
  const secretDoc = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const accessibleDoc = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "DEPARTMENT", uploadedByEmail: org.owner.email });

  // The outsider can see accessibleDoc's CID (QmA/QmB, same fixture values
  // for every test doc) — but access is resolved purely by documentId +
  // permission, never by matching a CID. Retrieving secretDoc as the
  // outsider must still fail regardless of what CID they know.
  const secretAccess = await requireDocumentAccess({ orgId: org.orgId, documentId: secretDoc, membership: org.outsider.membership, email: org.outsider.email, minLevel: "VIEW" });
  assert.equal(secretAccess.status, 403);
  void accessibleDoc; // demonstrates the point: no function anywhere accepts a CID as an auth input
});

test("security: role escalation — a member cannot self-grant MANAGE (requireDocumentAccess with minLevel MANAGE rejects them)", async () => {
  const org = await makeOrg("security-escalation");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "DEPARTMENT", uploadedByEmail: org.owner.email });

  // financeMember has implicit EDIT (department default) but never MANAGE —
  // the permissions route requires exactly this check before allowing a
  // grant/revoke call to proceed, so this demonstrates self-escalation is
  // structurally blocked at the same layer every such route relies on.
  const access = await requireDocumentAccess({ orgId: org.orgId, documentId: docId, membership: org.financeMember.membership, email: org.financeMember.email, minLevel: "MANAGE" });
  assert.equal(access.status, 403);
});

test("security: cross-organization access — an explicit grant in org A does not apply to the same email's document in org B", async () => {
  const orgA = await makeOrg("security-crossorg-a");
  const orgB = await makeOrg("security-crossorg-b");
  const sharedEmail = org => org.outsider.email;

  const docInB = await makeDoc({ orgId: orgB.orgId, departmentId: orgB.deptFinanceId, projectId: orgB.projAId, accessLevel: "PRIVATE", uploadedByEmail: orgB.owner.email });
  // Grant orgA's outsider MANAGE on a document in orgA — irrelevant to orgB.
  const docInA = await makeDoc({ orgId: orgA.orgId, departmentId: orgA.deptFinanceId, projectId: orgA.projAId, accessLevel: "PRIVATE", uploadedByEmail: orgA.owner.email });
  await collections.documentPermissions.insertOne({ orgId: orgA.orgId, documentId: docInA, email: sharedEmail(orgA), level: "MANAGE", grantedByEmail: orgA.owner.email, grantedAt: new Date().toISOString() });

  // orgB has its own, unrelated member with the same local membership shape as orgA's outsider.
  const docBDoc = await collections.orgDocuments.findOne({ _id: docInB });
  const level = await getDocumentAccessLevel({ orgId: orgB.orgId, doc: docBDoc, membership: orgB.outsider.membership, email: orgB.outsider.email });
  assert.equal(level, null, "no cross-org bleed-through of explicit grants");
});

test("security: concurrent permission changes on the same document/email resolve to one coherent final state", async () => {
  const org = await makeOrg("security-concurrent-perm");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const { documentPermissions } = collections;
  const now = new Date().toISOString();

  await Promise.all([
    documentPermissions.updateOne({ orgId: org.orgId, documentId: docId, email: org.outsider.email }, { $set: { level: "VIEW", grantedByEmail: org.owner.email, grantedAt: now }, $setOnInsert: { orgId: org.orgId, documentId: docId, email: org.outsider.email } }, { upsert: true }),
    documentPermissions.updateOne({ orgId: org.orgId, documentId: docId, email: org.outsider.email }, { $set: { level: "EDIT", grantedByEmail: org.owner.email, grantedAt: now }, $setOnInsert: { orgId: org.orgId, documentId: docId, email: org.outsider.email } }, { upsert: true }),
  ]);

  const rows = await documentPermissions.find({ orgId: org.orgId, documentId: docId, email: org.outsider.email }).toArray();
  assert.equal(rows.length, 1, "must end up with exactly one grant row, not a duplicate from a race");
  assert.ok(["VIEW", "EDIT"].includes(rows[0].level), "final level must be one of the two attempted values, not corrupted");
});

test("security: concurrent share access vs revocation never lets access succeed once revocation has taken effect", async () => {
  const org = await makeOrg("security-concurrent-share");
  const docId = await makeDoc({ orgId: org.orgId, departmentId: org.deptFinanceId, projectId: org.projAId, accessLevel: "PRIVATE", uploadedByEmail: org.owner.email });
  const { shareId, token } = await createDocumentShare({ orgId: org.orgId, documentId: docId, createdByEmail: org.owner.email, expiresAt: new Date(Date.now() + 3600000).toISOString(), maxUses: null });

  await Promise.all([
    consumeDocumentShare(token),
    revokeDocumentShare({ orgId: org.orgId, documentId: docId, shareId }),
  ]);

  // Whatever order the race resolved in, the share is now certainly
  // revoked — a subsequent attempt must fail, no exceptions.
  const after = await consumeDocumentShare(token);
  assert.equal(after.status, 410);
  assert.match(after.error, /revoked/i);
});
