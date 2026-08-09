// test/orgs-auth.test.mjs
//
// Automated coverage for the org auth/permission layer (src/lib/orgs.js).
// Complements the live end-to-end pass already run by hand against the
// real dev server (org creation -> login-link consume -> department/
// project CRUD -> invite -> cross-department isolation -> 401/403
// boundaries), all of which passed. These tests focus on the pieces worth
// pinning down permanently: session/token lifecycle and the
// canAccessDepartment permission logic itself.
//
// Deliberately NOT covered here: the on-chain document-registration path
// (POST /api/orgs/documents) — that requires a real testnet transaction
// per run, same reasoning as the referral system's webhook tests not
// exercising a real Didit "Approved" decision. Its permission-check paths
// (401/403/404, all of which return before touching ethers) are covered;
// the on-chain success path is verified live once the upload UI exists.
//
// Run with: node --test test/orgs-auth.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getOrgCollections,
  ensureOrgIndexes,
  generateToken,
  hashToken,
  getSession,
  getMembership,
  canManageOrg,
  canAccessDepartment,
  SESSION_TTL_MS,
} from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-org-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [], emails: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, projects, sessions, magicLinks } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await sessions.deleteMany({ email: { $in: cleanup.emails } });
  await magicLinks.deleteMany({ email: { $in: cleanup.emails } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithOwner(label) {
  const ownerEmail = email(`${label}-owner`);
  cleanup.emails.push(ownerEmail);
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  await collections.orgMembers.insertOne({
    orgId: orgResult.insertedId,
    email: ownerEmail,
    role: "owner",
    departmentIds: [],
    status: "active",
    invitedAt: now,
    joinedAt: now,
  });
  return { orgId: orgResult.insertedId, ownerEmail };
}

async function createSession(userEmail) {
  const token = generateToken();
  await collections.sessions.insertOne({
    tokenHash: hashToken(token),
    email: userEmail,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return token;
}

// ============================================================
test("getSession: valid token resolves, unknown token does not", async () => {
  const userEmail = email("session-basic");
  cleanup.emails.push(userEmail);
  const token = await createSession(userEmail);

  const session = await getSession(token);
  assert.equal(session.email, userEmail);

  const unknown = await getSession("not-a-real-token");
  assert.equal(unknown, null);
});

test("getSession: expired token resolves to null", async () => {
  const userEmail = email("session-expired");
  cleanup.emails.push(userEmail);
  const token = generateToken();
  await collections.sessions.insertOne({
    tokenHash: hashToken(token),
    email: userEmail,
    expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    createdAt: new Date().toISOString(),
  });

  const session = await getSession(token);
  assert.equal(session, null);
});

test("getSession: missing/empty token resolves to null without querying", async () => {
  assert.equal(await getSession(null), null);
  assert.equal(await getSession(undefined), null);
  assert.equal(await getSession(""), null);
});

// ============================================================
test("getMembership: only returns ACTIVE membership, not invited/pending", async () => {
  const { orgId } = await makeOrgWithOwner("membership-status");
  const invitedEmail = email("membership-invited");
  cleanup.emails.push(invitedEmail);
  await collections.orgMembers.insertOne({
    orgId,
    email: invitedEmail,
    role: "member",
    departmentIds: [],
    status: "invited",
    invitedAt: new Date().toISOString(),
  });

  const membership = await getMembership(orgId, invitedEmail);
  assert.equal(membership, null, "an invited-but-not-yet-accepted member must not count as active");
});

test("getMembership: accepts either an ObjectId or a string orgId", async () => {
  const { orgId, ownerEmail } = await makeOrgWithOwner("membership-idtype");
  const byObjectId = await getMembership(orgId, ownerEmail);
  const byString = await getMembership(orgId.toString(), ownerEmail);
  assert.equal(byObjectId.email, ownerEmail);
  assert.equal(byString.email, ownerEmail);
});

// ============================================================
test("canManageOrg: true for owner and admin, false for member", () => {
  assert.equal(canManageOrg({ role: "owner" }), true);
  assert.equal(canManageOrg({ role: "admin" }), true);
  assert.equal(canManageOrg({ role: "member" }), false);
  assert.equal(canManageOrg(null), false);
});

// ============================================================
test("canAccessDepartment: owner/admin can access any department regardless of assignment", () => {
  const deptId = randomUUID();
  assert.equal(canAccessDepartment({ role: "owner", departmentIds: [] }, deptId), true);
  assert.equal(canAccessDepartment({ role: "admin", departmentIds: [] }, deptId), true);
});

test("canAccessDepartment: member can access only departments they're assigned to", () => {
  const financeId = { toString: () => "finance-id" };
  const hrId = { toString: () => "hr-id" };
  const member = { role: "member", departmentIds: [financeId] };

  assert.equal(canAccessDepartment(member, "finance-id"), true);
  assert.equal(canAccessDepartment(member, "hr-id"), false);
  assert.equal(canAccessDepartment(member, financeId), true, "should also accept a non-string id via toString()");
});

test("canAccessDepartment: no membership at all is always denied", () => {
  assert.equal(canAccessDepartment(null, "any-dept"), false);
  assert.equal(canAccessDepartment(undefined, "any-dept"), false);
});
