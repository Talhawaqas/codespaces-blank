// test/digital-twin-snapshots.test.mjs -- saved simulation results: a past run re-opens exactly as it was returned, its integrity is
// re-verified against the audit chain, tampering with the stored copy is detected, and only the runner or an owner/admin can open it.
// Run: node --env-file=.env.local --test --test-force-exit test/digital-twin-snapshots.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { simulateDigitalTwinScenario, getDigitalTwinSimulation, hashSimulationResult } from "../src/lib/digitalTwinSimulate.js";

const RUN = randomUUID().slice(0, 8);
const orgIds = []; let c;
before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); });
after(async () => {
  await Promise.all([c.orgs.deleteMany({ _id: { $in: orgIds } }), c.departments.deleteMany({ orgId: { $in: orgIds } }), c.orgMembers.deleteMany({ orgId: { $in: orgIds } }), c.orgActivity.deleteMany({ orgId: { $in: orgIds } }), c.digitalTwinSnapshots.deleteMany({ orgId: { $in: orgIds } })]);
  await (await mongoClientPromise).close();
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const ownerEmail = `${label}-owner-${RUN}@example.com`; const staffEmail = `${label}-staff-${RUN}@example.com`; const adminEmail = `${label}-admin-${RUN}@example.com`;
  const orgId = (await c.orgs.insertOne({ name: `${label} ${RUN} Co`, ownerEmail, createdAt: now })).insertedId; orgIds.push(orgId);
  const departmentId = (await c.departments.insertOne({ orgId, name: "Ops", createdAt: now })).insertedId;
  await c.orgMembers.insertMany([
    { orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
    { orgId, email: adminEmail, role: "admin", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
    { orgId, email: staffEmail, role: "member", departmentIds: [departmentId], status: "active", invitedAt: now, joinedAt: now },
  ]);
  const m = (email) => c.orgMembers.findOne({ orgId, email });
  return { orgId: String(orgId), ownerEmail, staffEmail, adminEmail, owner: await m(ownerEmail), staff: await m(staffEmail), admin: await m(adminEmail) };
}

test("a run is saved, re-opens identically, and verifies against the audit chain", async () => {
  const org = await makeOrg("snap");
  const { simulation } = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "EMPLOYEE_ACCESS_REMOVED", entityId: org.staffEmail, membership: org.owner, actorEmail: org.ownerEmail });
  const again = await getDigitalTwinSimulation({ orgId: org.orgId, simulationId: simulation.simulationId, membership: org.owner, email: org.ownerEmail });
  assert.ok(!again.error, JSON.stringify(again));
  assert.equal(again.verification.verified, true);
  assert.deepEqual(again.verification, { verified: true, storedMatchesResult: true, auditEntryFound: true, auditMatches: true });
  assert.equal(again.simulation.integrityHash, simulation.integrityHash);
  assert.deepEqual(again.simulation.directImpact, simulation.directImpact);
  assert.deepEqual(again.simulation.unknowns, simulation.unknowns);
  assert.equal(hashSimulationResult(again.simulation, { modelVersion: simulation.modelVersion, rulesVersion: simulation.rulesVersion }), simulation.integrityHash, "the hash is recomputable from the saved result alone");
});

test("editing the stored copy is detected; so is a missing audit entry", async () => {
  const org = await makeOrg("tamper");
  const { simulation } = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "EMPLOYEE_ACCESS_REMOVED", entityId: org.staffEmail, membership: org.owner, actorEmail: org.ownerEmail });
  const open = () => getDigitalTwinSimulation({ orgId: org.orgId, simulationId: simulation.simulationId, membership: org.owner, email: org.ownerEmail });
  await c.digitalTwinSnapshots.updateOne({ simulationId: simulation.simulationId }, { $set: { "result.unknowns": ["nothing to see here"] } });
  const edited = await open();
  assert.equal(edited.verification.verified, false); assert.equal(edited.verification.storedMatchesResult, false);
  await c.digitalTwinSnapshots.updateOne({ simulationId: simulation.simulationId }, { $set: { "result.unknowns": simulation.unknowns } });
  assert.equal((await open()).verification.verified, true, "restoring the original makes it verify again");
  await c.orgActivity.deleteMany({ orgId: new ObjectId(org.orgId), recordType: "DIGITAL_TWIN_SIMULATION" });
  const noAudit = await open();
  assert.equal(noAudit.verification.verified, false); assert.equal(noAudit.verification.auditEntryFound, false);
});

test("only the runner or an owner/admin can open a saved run; other orgs and unknown ids get nothing", async () => {
  const org = await makeOrg("perm"); const other = await makeOrg("perm-other");
  // the staff member runs a scenario about themselves (their own, department-scoped view)
  const { simulation, error } = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "EMPLOYEE_ACCESS_REMOVED", entityId: org.staffEmail, membership: org.owner, actorEmail: org.staffEmail });
  assert.ok(!error, error);
  const id = simulation.simulationId;
  assert.ok(!(await getDigitalTwinSimulation({ orgId: org.orgId, simulationId: id, membership: org.staff, email: org.staffEmail })).error, "the runner can re-open it");
  assert.ok(!(await getDigitalTwinSimulation({ orgId: org.orgId, simulationId: id, membership: org.admin, email: org.adminEmail })).error, "an admin can");
  const nosy = { ...org.staff, email: `nosy-${RUN}@example.com` };
  assert.equal((await getDigitalTwinSimulation({ orgId: org.orgId, simulationId: id, membership: nosy, email: nosy.email })).status, 403, "another plain member cannot");
  assert.equal((await getDigitalTwinSimulation({ orgId: other.orgId, simulationId: id, membership: other.owner, email: other.ownerEmail })).status, 404, "another organization's owner gets nothing");
  assert.equal((await getDigitalTwinSimulation({ orgId: org.orgId, simulationId: "does-not-exist", membership: org.owner, email: org.ownerEmail })).status, 404);
});
