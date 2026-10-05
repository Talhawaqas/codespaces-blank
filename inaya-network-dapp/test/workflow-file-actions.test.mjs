// test/workflow-file-actions.test.mjs -- WORKFLOW-001/002: the new file triggers are announced, and the file workflow action can set retention, lock and unlock as the
// workflow owner (permission checked), refuses bad input, and validates its configuration. Real MongoDB.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/workflow-file-actions.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { FILE_EVENTS } from "../src/lib/governance/events.js";
import { runFileGovernanceAction, FILE_OPERATIONS } from "../src/lib/governance/workflowAction.js";
import { NODE_TYPES } from "../src/lib/workflows/nodes.js";
import { getLockInfo } from "../src/lib/filelocks.js";

const T = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
let org, doc, member;
before(async () => {
  await setup(); org = await makeChatOrg("wfa", { people: ["member"] }); member = org.member;
  const now = new Date().toISOString(); const dept = (await cols.departments.insertOne({ orgId: org.orgId, name: "Ops", createdAt: now })).insertedId; const proj = (await cols.projects.insertOne({ orgId: org.orgId, departmentId: dept, name: "P", createdAt: now })).insertedId;
  doc = String((await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: dept, projectId: proj, filename: "plan.pdf", fileHash: `0xwfa-${randomBytes(4).toString("hex")}`, sizeBytes: 9, cidAlpha: "QmA", cidBeta: "QmB", uploadedByEmail: org.owner.email, txHash: "0x1", createdAt: now, isLatest: true, deletedAt: null })).insertedId);
});
after(async () => { await cols.orgDocuments.deleteMany({ orgId: org.orgId }); await cols.projects.deleteMany({ orgId: org.orgId }); await cols.departments.deleteMany({ orgId: org.orgId }); await teardown(); });
const run = (cfg, who = org.owner) => runFileGovernanceAction({ orgId: org.oid, membership: who.membership, email: who.email, cfg: { documentId: doc, ...cfg } });

test("file triggers: expiring share, legal hold change, data room access and backup failure are announced as workflow events", T, () => {
  for (const e of ["file.share_expiring", "file.legal_hold_changed", "file.vdr_accessed", "file.backup_failed"]) assert.ok(FILE_EVENTS.includes(e), e);
  assert.equal(FILE_EVENTS.length, 11);
});

test("set_retention applies a valid retention class and refuses an invalid one; lock and unlock work as the workflow owner and a person without access is refused", T, async () => {
  assert.ok(["set_retention", "lock", "unlock"].every((o) => FILE_OPERATIONS.includes(o)));
  const r = await run({ operation: "set_retention", retentionClass: "extended" }); assert.equal(r.retentionClass, "extended");
  assert.equal((await code(run({ operation: "set_retention", retentionClass: "forever-and-ever" }))).code, "BAD_INPUT");
  const l = await run({ operation: "lock", leaseMinutes: 5 }); assert.equal(l.locked, true); assert.ok(await getLockInfo({ orgId: org.oid, documentId: doc }), "the lock is held");
  const u = await run({ operation: "unlock" }); assert.equal(u.locked, false);
  const info = await getLockInfo({ orgId: org.oid, documentId: doc }); assert.ok(!info || !info.lock && !info.locked, "the lock is released");
  const denied = await code(run({ operation: "lock" }, member)); assert.ok(denied && (denied.code === "FORBIDDEN" || denied.status === 403), "a member without edit access cannot lock");
});

test("node configuration is validated: a retention action needs a valid class", T, () => {
  const v = NODE_TYPES["action.file_governance"].validate; const bad = []; v({ operation: "set_retention", documentId: "x", retentionClass: "nope" }, bad); assert.equal(bad.length, 1);
  const ok = []; v({ operation: "lock", documentId: "x" }, ok); assert.equal(ok.length, 0); const unk = []; v({ operation: "delete", documentId: "x" }, unk); assert.ok(unk.length >= 1, "there is no delete operation");
});
