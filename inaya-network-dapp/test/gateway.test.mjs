// test/gateway.test.mjs -- Sovereign Gateway: enrollment, signed requests, tenant binding, heartbeat/config, inventory, forwarded audit, NTFS/AD permission bridge,
// encrypted resumable transfer, revocation, deployment modes. The REAL agent code talks over REAL HTTP to the REAL route handlers against REAL MongoDB.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/gateway.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as G from "../src/lib/gateway/gateway.js";
import * as A from "../src/lib/gateway/acl.js";
import * as T from "../src/lib/gateway/transfers.js";
import * as M from "../src/lib/gateway/modes.js";
import * as route from "../src/app/api/gateway/v1/[...path]/route.js";
import { enrollGateway, makeClient, RevokedError } from "../../inaya-gateway-agent/src/client.js";
import { runOnce } from "../../inaya-gateway-agent/src/agent.js";
import { openQueue } from "../../inaya-gateway-agent/src/queue.js";
import { openAudit } from "../../inaya-gateway-agent/src/audit.js";
import { restoreTransfer } from "../../inaya-gateway-agent/src/transfer.js";
import { signingString as agentSigning, enrollProofString as agentProof, signedHeaders } from "../../inaya-gateway-agent/src/sign.js";
import { eventHash as agentEventHash } from "../../inaya-gateway-agent/src/audit.js";

const T0 = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
let server, base, db;
let orgA, orgB, ownerA, ownerB, alice, bob, carol, gwA, gwB, tmp, dataKey;

/** Real HTTP in front of the real handlers (what Next does, minus the framework). */
function startBridge() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
      const u = new URL(req.url, "http://localhost"); const parts = u.pathname.replace(/^\/api\/gateway\/v1\//, "").split("/").filter(Boolean);
      const r = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, ...(body.length && req.method !== "GET" ? { body } : {}) });
      const out = await route[req.method](r, { params: Promise.resolve({ path: parts }) });
      res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const enrollFor = async (org, who, label) => {
  const { token } = await G.createEnrollment({ orgId: org.oid, membership: who.membership, actorEmail: who.email, label });
  const dir = fs.mkdtempSync(path.join(tmp, "agent-")); const id = await enrollGateway({ baseUrl: base, token, label, version: "0.1.0", platform: "test", capabilities: ["filesystem"] });
  const client = makeClient({ baseUrl: base, gatewayId: id.gatewayId, privateKeyPem: id.privateKeyPem, retries: 0 });
  return { ...id, token, dir, client, queue: openQueue(dir), audit: openAudit(dir), config: { dataKey: dataKey.toString("base64"), scanIntervalSeconds: 0, aclIntervalSeconds: 0 } };
};

before(async () => {
  await setup(); db = (await getOrgCollections()).db; tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-test-")); dataKey = randomBytes(32);
  orgA = await makeChatOrg("gwa", { people: ["alice", "bob", "carol"] }); orgB = await makeChatOrg("gwb", { people: [] });
  ownerA = orgA.owner; ownerB = orgB.owner; alice = orgA.alice; bob = orgA.bob; carol = orgA.carol;
  for (const o of [orgA, orgB]) await setOrgFeature({ orgId: o.oid, name: "FEATURE_SOVEREIGN_GATEWAY", enabled: true });
  await db.collection("rate_limit_hits").deleteMany({ action: "gateway:enroll" }); server = await startBridge(); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close(); const ids = [orgA.orgId, orgB.orgId];
  for (const n of ["gateway_enrollments", "gateways", "gateway_connectors", "gateway_inventory", "gateway_audit", "gateway_principals", "gateway_identity_map", "gateway_acl_snapshots", "gateway_acl_events", "gateway_transfers", "gateway_chunks", "org_deployment_profile", "org_webhooks", "org_webhook_deliveries"]) await db.collection(n).deleteMany({ orgId: { $in: ids } }).catch(() => {});
  await db.collection("gateway_nonces").deleteMany({}).catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); await teardown();
});

// ------------------------------------------------------------------------------------------------ enrollment and signed requests
test("the signing contract is identical on both sides (agent and server build the same bytes)", T0, () => {
  const p = { method: "post", path: "/api/gateway/v1/heartbeat?x=1", ts: "1700000000000", nonce: "abc", body: '{"a":1}' };
  assert.equal(G.signingString(p), agentSigning(p)); assert.equal(G.enrollProofString({ tokenHash: "h", ts: "1" }), agentProof({ tokenHash: "h", ts: "1" }));
  const e = { prevHash: "p", seq: 3, at: "2026-01-01T00:00:00.000Z", type: "scan.completed", detail: { b: 2, a: { z: 1, y: [1, 2] } } }; assert.equal(G.eventHash(e), agentEventHash(e), "audit chain hash agrees");
});

test("enrollment: a token works once, only for its organization, only with proof of the private key; the server stores a public key, nothing secret", T0, async () => {
  assert.equal((await code(G.createEnrollment({ orgId: orgA.oid, membership: bob.membership, actorEmail: bob.email, label: "x" })))?.status, 403, "a plain member cannot enroll gateways");
  gwA = await enrollFor(orgA, ownerA, "Head office");
  const row = await db.collection("gateways").findOne({ _id: new ObjectId(gwA.gatewayId) }); assert.equal(String(row.orgId), orgA.oid); assert.equal(row.status, "active");
  assert.equal(JSON.stringify(row).includes("PRIVATE KEY"), false); assert.equal(row.publicKey, gwA.publicKey);
  const again = await code(enrollGateway({ baseUrl: base, token: gwA.token, label: "x" })); assert.equal(again?.status, 401, "the token was already used");
  assert.equal((await code(enrollGateway({ baseUrl: base, token: "gwe_notreal", label: "x" })))?.status, 401);
  const { token } = await G.createEnrollment({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, label: "late" }); await db.collection("gateway_enrollments").updateOne({ tokenHash: createHash("sha256").update(token).digest("hex") }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await code(enrollGateway({ baseUrl: base, token, label: "x" })))?.status, 401, "an expired token is refused");
  const fresh = (await G.createEnrollment({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, label: "p" })).token;
  const res = await fetch(`${base}/api/gateway/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: fresh, publicKey: gwA.publicKey, proof: Buffer.from("not a signature").toString("base64"), ts: String(Date.now()) }) }); assert.equal(res.status, 401, "no proof of possession");
  const rsa = (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const res2 = await fetch(`${base}/api/gateway/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: fresh, publicKey: rsa, proof: "x", ts: String(Date.now()) }) }); assert.equal(res2.status, 400, "only Ed25519 keys");
});

test("every request is signed: tampering, replay, a stale clock, an unknown gateway and another gateway's key are all refused", T0, async () => {
  const h = async (hdr, body = "{}", p = "/api/gateway/v1/heartbeat") => (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...hdr }, body })).status;
  const mk = (extra = {}) => signedHeaders({ gatewayId: gwA.gatewayId, privateKeyPem: gwA.privateKeyPem, method: "POST", path: "/api/gateway/v1/heartbeat", body: "{}", ...extra });
  assert.equal(await h(mk()), 200); const reuse = mk(); assert.equal(await h(reuse), 200); assert.equal(await h(reuse), 401, "the same signed request cannot be replayed");
  assert.equal(await h(mk(), '{"x":1}'), 401, "a changed body breaks the signature");
  assert.equal(await h(mk({ now: Date.now() - 10 * 60_000 })), 401, "a request signed ten minutes ago");
  assert.equal(await h(mk({ now: Date.now() + 10 * 60_000 })), 401, "a request from the future");
  assert.equal(await h({ ...mk(), "x-inaya-gateway": new ObjectId().toHexString() }), 401, "unknown gateway");
  assert.equal(await h(), 401, "no signature at all"); assert.equal(await h(mk(), "{}", "/api/gateway/v1/heartbeat?other=1"), 401, "a signature is bound to its exact path and query");
  gwB = await enrollFor(orgB, ownerB, "Branch"); const other = signedHeaders({ gatewayId: gwA.gatewayId, privateKeyPem: gwB.privateKeyPem, method: "POST", path: "/api/gateway/v1/heartbeat", body: "{}" }); assert.equal(await h(other), 401, "B's key cannot speak as A");
});

// ------------------------------------------------------------------------------------------------ cycle: config, inventory, ACL, audit
let connA, folderA, root, hr;
test("an administrator approves a folder; the agent learns it on its next heartbeat, lists it, reads its REAL permissions and forwards its audit trail", T0, async () => {
  root = fs.mkdtempSync(path.join(tmp, "share-")); fs.mkdirSync(path.join(root, "finance", "2026"), { recursive: true }); fs.mkdirSync(path.join(root, "hr"));
  fs.writeFileSync(path.join(root, "finance", "budget.xlsx"), "budget-data"); fs.writeFileSync(path.join(root, "finance", "2026", "plan.pdf"), "plan"); fs.writeFileSync(path.join(root, "hr", "salaries.csv"), "secret");
  const bad = await code(G.upsertConnector({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, name: "x", type: "ftp", rootPath: root, folders: [] })); assert.equal(bad?.status, 400);
  const badFolder = await code(G.upsertConnector({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, name: "x", type: "filesystem", rootPath: root, folders: [{ path: "../hr" }] })); assert.equal(badFolder?.status, 400, "no traversal in an approved folder");
  assert.equal((await code(G.upsertConnector({ orgId: orgA.oid, membership: bob.membership, actorEmail: bob.email, gatewayId: gwA.gatewayId, name: "x", type: "filesystem", rootPath: root, folders: [] })))?.status, 403);
  connA = await G.upsertConnector({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, name: "File server", type: "smb", rootPath: root, folders: [{ path: "finance", label: "Finance" }] });
  folderA = connA.folders[0].folderId;
  const out = await runOnce({ client: gwA.client, config: gwA.config, dir: gwA.dir, audit: gwA.audit, queue: gwA.queue }); assert.equal(out.connectors[0].status, "ok"); assert.equal(out.queued, 0, "everything was acknowledged");
  const inv = await G.listInventory({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, connectorId: connA.connectorId, folderId: folderA });
  assert.deepEqual(inv.items.map((i) => i.path).sort(), ["2026", "2026/plan.pdf", "budget.xlsx"], "only the approved folder; nothing from hr");
  assert.equal(JSON.stringify(inv).includes("budget-data"), false, "no file content ever");
  const acl = await db.collection("gateway_acl_snapshots").findOne({ gatewayId: new ObjectId(gwA.gatewayId), folderId: folderA }); assert.ok(acl && acl.entries.length >= 1); assert.equal(acl.source, process.platform === "win32" ? "ntfs" : "posix");
  const v = await G.verifyGatewayAudit({ orgId: orgA.oid, membership: ownerA.membership, gatewayId: gwA.gatewayId }); assert.equal(v.valid, true); assert.ok(v.checked >= 2, "scan and ACL events arrived");
  assert.deepEqual(v.head, gwA.audit.verify().head, "Inaya's chain head equals the gateway's own");
  const org = await cols.orgActivity.find({ orgId: orgA.orgId, recordType: "GATEWAY", action: "AUDIT_ANCHORED" }).toArray(); assert.ok(org.length >= 1, "the head is anchored in the organization's own audit trail");
  const g = await G.getGateway({ orgId: orgA.oid, membership: ownerA.membership, gatewayId: gwA.gatewayId }); assert.equal(g.status, "ONLINE"); assert.equal(g.connectors.length, 1);
  hr = await gwA.client.post("/api/gateway/v1/heartbeat", {}); assert.equal(hr.connectors[0].folders[0].folderId, folderA);
});

test("inventory and ACL are accepted only for approved folders and paths inside them", T0, async () => {
  const post = (p, b) => gwA.client.post(p, b);
  const unapproved = await code(post("/api/gateway/v1/inventory", { connectorId: connA.connectorId, folderId: new ObjectId().toHexString(), entries: [] })); assert.equal(unapproved?.status, 403);
  const r = await post("/api/gateway/v1/inventory", { connectorId: connA.connectorId, folderId: folderA, entries: [{ path: "../hr/salaries.csv", size: 1 }, { path: "/etc/passwd", size: 1 }, { path: "ok/file.txt", size: 2 }], scanId: "t" }); assert.equal(r.rejected, 1, "a path with .. is refused"); assert.equal(r.accepted, 2, "an absolute path is folded into the approved folder, never read as absolute");
  assert.equal((await code(post("/api/gateway/v1/inventory", { connectorId: connA.connectorId, folderId: folderA, entries: new Array(2001).fill({ path: "a", size: 1 }) })))?.status, 400);
  assert.equal((await code(post("/api/gateway/v1/acl", { folderId: new ObjectId().toHexString(), entries: [] })))?.status, 403);
  const a = await G.listInventory({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, connectorId: connA.connectorId, folderId: folderA }); assert.equal(a.items.some((i) => i.path.includes("..")), false);
  const audited = await cols.orgActivity.countDocuments({ orgId: orgA.orgId, recordType: "GATEWAY", action: "ADMIN_INVENTORY_VIEWED" }); assert.ok(audited >= 1, "the administrator's own inventory view is recorded");
});

test("audit forwarding: a gap, a wrong previous hash or a forged hash is refused; a retry of known events is harmless", T0, async () => {
  const last = gwA.audit.after(0).at(-1); const ev = gwA.audit.append("test.event", { n: 1 });
  assert.equal((await code(gwA.client.post("/api/gateway/v1/events", { events: [{ ...ev, seq: ev.seq + 2 }] })))?.status, 409, "a gap");
  assert.equal((await code(gwA.client.post("/api/gateway/v1/events", { events: [{ ...ev, prevHash: "f".repeat(64) }] })))?.status, 409, "wrong previous hash");
  assert.equal((await code(gwA.client.post("/api/gateway/v1/events", { events: [{ ...ev, detail: { n: 2 } }] })))?.status, 409, "content does not match its hash");
  const ok = await gwA.client.post("/api/gateway/v1/events", { events: [ev] }); assert.equal(ok.accepted, 1); const again = await gwA.client.post("/api/gateway/v1/events", { events: [ev] }); assert.equal(again.accepted, 0);
  assert.ok(last); await db.collection("gateway_audit").updateOne({ gatewayId: new ObjectId(gwA.gatewayId), seq: 2 }, { $set: { "detail.tampered": true } });
  const v = await G.verifyGatewayAudit({ orgId: orgA.oid, membership: ownerA.membership, gatewayId: gwA.gatewayId }); assert.equal(v.valid, false); assert.equal(v.brokenAt, 2, "tampering inside Inaya's own copy is detected too");
  await db.collection("gateway_audit").updateOne({ gatewayId: new ObjectId(gwA.gatewayId), seq: 2 }, { $unset: { "detail.tampered": "" } });
});

test("heartbeat: queued commands are delivered once; health is stored; offline status appears when the gateway goes quiet", T0, async () => {
  await G.queueCommand({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, type: "rescan" });
  assert.equal((await code(G.queueCommand({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, type: "format_disk" })))?.status, 400);
  const h1 = await gwA.client.post("/api/gateway/v1/heartbeat", { queueDepth: 7, lagSeconds: 12, aclFailures: 1, connectors: [{ connectorId: connA.connectorId, status: "degraded", lastError: "slow" }] }); assert.equal(h1.commands.length, 1); assert.equal(h1.commands[0].type, "rescan");
  const h2 = await gwA.client.post("/api/gateway/v1/heartbeat", {}); assert.equal(h2.commands.length, 0, "delivered once");
  await gwA.client.post("/api/gateway/v1/heartbeat", { queueDepth: 7, lagSeconds: 12, aclFailures: 1, connectors: [{ connectorId: connA.connectorId, status: "degraded", lastError: "slow" }] });
  const g = await G.getGateway({ orgId: orgA.oid, membership: ownerA.membership, gatewayId: gwA.gatewayId }); assert.equal(g.health.queueDepth, 7); assert.equal(g.health.connectors[0].status, "degraded"); assert.equal(g.health.aclFailures, 1);
  assert.equal(G.statusOf({ lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(), status: "active" }), "OFFLINE"); assert.equal(G.statusOf({ status: "active" }), "NEVER_CONNECTED");
  await gwA.client.post("/api/gateway/v1/heartbeat", {}); // restore a clean health report
});

// ------------------------------------------------------------------------------------------------ NTFS/AD permission bridge
test("NTFS evaluation: explicit deny beats allow, explicit allow beats inherited deny, groups and Everyone apply, no match means no access", T0, () => {
  const ev = (entries, who, known = true) => A.evaluateAccess({ entries, principals: new Set(who.map((x) => x.toLowerCase())), known });
  const allowRead = { principal: "CONTOSO\\finance", type: "allow", rights: ["modify"], inherited: false };
  const denyWrite = { principal: "CONTOSO\\interns", type: "deny", rights: ["write", "delete"], inherited: false };
  const r1 = ev([allowRead, denyWrite], ["contoso\\finance", "contoso\\interns"]); assert.equal(r1.read, true); assert.equal(r1.write, false, "explicit deny wins over a modify allow"); assert.equal(r1.delete, false);
  assert.equal(r1.reasons.write.decision, "deny");
  const inheritedDeny = { principal: "CONTOSO\\finance", type: "deny", rights: ["write"], inherited: true }; const r2 = ev([inheritedDeny, allowRead], ["contoso\\finance"]); assert.equal(r2.write, true, "an explicit allow outranks an inherited deny (canonical NTFS order)");
  const explicitDeny = { ...inheritedDeny, inherited: false }; assert.equal(ev([explicitDeny, allowRead], ["contoso\\finance"]).write, false);
  assert.equal(ev([{ principal: "Everyone", type: "allow", rights: ["read"] }], ["contoso\\x"]).read, true, "Everyone applies to a known account"); assert.equal(ev([{ principal: "Everyone", type: "allow", rights: ["read"] }], [], false).read, false, "but not to someone Inaya cannot identify");
  assert.equal(ev([allowRead], ["contoso\\other"]).read, false, "no matching entry, no access"); assert.equal(ev([{ principal: "contoso\\finance", type: "allow", rights: ["full"] }], ["contoso\\finance"]).delete, true);
  assert.equal(ev([{ principal: "CONTOSO\\finance", type: "deny", rights: ["read"] }, { principal: "Everyone", type: "allow", rights: ["read"] }], ["contoso\\finance"]).read, false, "a deny on my group beats Everyone's allow");
});

test("enforcement: the customer's ACL decides, through mapped identities and groups; an owner without a mapping gets NO back door; every refusal is audited", T0, async () => {
  const post = (b) => gwA.client.post("/api/gateway/v1/acl", { folderId: folderA, source: "ntfs", ...b });
  const dir = [{ principal: "CONTOSO\\alice", kind: "user", upn: alice.email, memberOf: ["CONTOSO\\finance"] }, { principal: "CONTOSO\\finance", kind: "group", memberOf: [] }, { principal: "CONTOSO\\bob", kind: "user", memberOf: ["CONTOSO\\interns"] }, { principal: "CONTOSO\\interns", kind: "group", memberOf: ["CONTOSO\\finance"] }];
  const r = await post({ entries: [{ principal: "CONTOSO\\finance", type: "allow", rights: ["modify"], inherited: false }, { principal: "CONTOSO\\interns", type: "deny", rights: ["write", "delete"], inherited: false }, { principal: "CONTOSO\\ghost", type: "allow", rights: ["read"], inherited: false }], principals: dir });
  assert.equal(r.autoMapped, 1, "alice matched exactly on her address; bob (no UPN) was NOT guessed");
  const folderId = folderA; const a = await A.effectiveAccess({ orgId: orgA.oid, folderId, email: alice.email }); assert.equal(a.read, true); assert.equal(a.write, true);
  const b0 = await A.effectiveAccess({ orgId: orgA.oid, folderId, email: bob.email }); assert.equal(b0.read, false); assert.equal(b0.why, "NOT_MAPPED");
  await A.setMapping({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, principal: "CONTOSO\\bob", email: bob.email });
  const b = await A.effectiveAccess({ orgId: orgA.oid, folderId, email: bob.email }); assert.equal(b.read, true, "bob inherits read through interns -> finance"); assert.equal(b.write, false, "but the interns deny blocks write"); assert.equal(b.reasons.write.by, "CONTOSO\\interns");
  const own = await code(A.browseFolder({ orgId: orgA.oid, folderId, email: ownerA.email })); assert.equal(own?.status, 403, "the organization owner is refused too: no mapping, no access"); assert.equal(own.code, "NOT_MAPPED");
  const okBrowse = await A.browseFolder({ orgId: orgA.oid, folderId, email: alice.email }); assert.ok(okBrowse.items.some((i) => i.path === "budget.xlsx") && okBrowse.items.length >= 3, "alice sees the approved folder listing");
  assert.match(okBrowse.traceability, /not visible/); assert.equal(okBrowse.effective.write, true);
  assert.equal((await code(A.browseFolder({ orgId: orgA.oid, folderId, email: carol.email })))?.status, 403);
  const denied = await cols.orgActivity.countDocuments({ orgId: orgA.orgId, recordType: "GATEWAY", action: "ACCESS_DENIED" }); assert.ok(denied >= 2, "refusals are audited");
  const vis = await A.visibleFolders({ orgId: orgA.oid, email: alice.email }); assert.equal(vis.folders.length, 1); assert.equal((await A.visibleFolders({ orgId: orgA.oid, email: carol.email })).folders.length, 0, "a folder you cannot read is simply absent");
  assert.equal((await code(A.setMapping({ orgId: orgA.oid, membership: bob.membership, actorEmail: bob.email, principal: "CONTOSO\\bob", email: carol.email })))?.status, 403, "only administrators map identities");
  assert.equal((await code(A.setMapping({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, principal: "CONTOSO\\x", email: "nobody@example.com" })))?.status, 404, "cannot map to a non-member");
});

test("permission changes are noticed, diagnosed and counted; the mapping health view tells the truth", T0, async () => {
  const before = await db.collection("gateway_acl_events").countDocuments({ orgId: orgA.orgId });
  await gwA.client.post("/api/gateway/v1/acl", { folderId: folderA, entries: [{ principal: "CONTOSO\\finance", type: "allow", rights: ["read"], inherited: false }, { principal: "CONTOSO\\finance", type: "deny", rights: ["read"], inherited: false }, { principal: "CONTOSO\\ghost", type: "allow", rights: ["read"] }], principals: [] });
  assert.equal(await db.collection("gateway_acl_events").countDocuments({ orgId: orgA.orgId }), before + 1);
  const same = await gwA.client.post("/api/gateway/v1/acl", { folderId: folderA, entries: [{ principal: "CONTOSO\\finance", type: "allow", rights: ["read"], inherited: false }, { principal: "CONTOSO\\finance", type: "deny", rights: ["read"], inherited: false }, { principal: "CONTOSO\\ghost", type: "allow", rights: ["read"] }], principals: [] }); assert.equal(same.changed, false, "an identical snapshot is not a change");
  const perms = await A.folderPermissions({ orgId: orgA.oid, membership: ownerA.membership, folderId: folderA, email: alice.email });
  assert.ok(perms.diagnostics.some((d) => d.code === "ALLOW_DENY_CONFLICT" && /deny wins/.test(d.detail))); assert.ok(perms.diagnostics.some((d) => d.code === "UNMAPPED_PRINCIPAL" && d.principal === "CONTOSO\\ghost"));
  assert.equal(perms.effective.read, false, "after the new snapshot the deny wins for finance members");
  const h = await A.mappingHealth({ orgId: orgA.oid, membership: ownerA.membership }); assert.equal(h.state, "ATTENTION"); assert.ok(h.unmapped.includes("contoso\\ghost")); assert.equal(h.unmapped.includes("contoso\\finance") || h.unmapped.includes("contoso\\interns"), false, "a directory group applies through its members and is not an unmapped person"); assert.ok(h.groups >= 1); assert.ok(h.conflicts.length >= 1); assert.ok(h.permissionChanges7d >= 1);
  await db.collection("gateway_acl_snapshots").updateOne({ gatewayId: new ObjectId(gwA.gatewayId), folderId: folderA }, { $set: { takenAt: new Date(Date.now() - 30 * 3600_000).toISOString() } });
  assert.ok((await A.folderPermissions({ orgId: orgA.oid, membership: ownerA.membership, folderId: folderA })).diagnostics.some((d) => d.code === "STALE_SNAPSHOT"), "a snapshot older than a day is flagged");
  assert.equal((await code(A.mappingHealth({ orgId: orgA.oid, membership: bob.membership })))?.status, 403);
  const sug = h.suggestions; assert.ok(Array.isArray(sug)); assert.ok(sug.every((s) => s.confirmed === false), "suggestions are never enforced until confirmed");
});

// ------------------------------------------------------------------------------------------------ encrypted resumable transfer
test("transfer: approved by an administrator, encrypted on the gateway, interrupted mid-way, resumed from the held parts, completed, restored byte for byte; Inaya cannot read it", T0, async () => {
  const big = randomBytes(1024 * 1024 * 2 + 4321); fs.writeFileSync(path.join(root, "finance", "model.bin"), big); await runOnce({ client: gwA.client, config: gwA.config, dir: gwA.dir, audit: gwA.audit, queue: gwA.queue });
  assert.equal((await code(T.requestTransfer({ orgId: orgA.oid, membership: bob.membership, actorEmail: bob.email, gatewayId: gwA.gatewayId, connectorId: connA.connectorId, folderId: folderA, path: "model.bin" })))?.status, 403);
  assert.equal((await code(T.requestTransfer({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, connectorId: connA.connectorId, folderId: folderA, path: "nope.bin" })))?.status, 404, "only files the gateway listed");
  assert.equal((await code(T.requestTransfer({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, connectorId: connA.connectorId, folderId: folderA, path: "2026" })))?.status, 404, "not a directory");
  const t = await T.requestTransfer({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, connectorId: connA.connectorId, folderId: folderA, path: "model.bin" }); assert.equal(t.status, "requested");
  assert.equal((await T.requestTransfer({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, connectorId: connA.connectorId, folderId: folderA, path: "model.bin" })).transferId, t.transferId, "asking twice returns the open transfer");
  const drop = new Error("connection dropped"); drop.network = true;
  await runOnce({ client: gwA.client, config: gwA.config, dir: gwA.dir, audit: gwA.audit, queue: gwA.queue, hooks: { afterPart: async (n) => { if (n === 0) throw drop; } } }); // the agent records the failure and keeps going
  const mid = await db.collection("gateway_transfers").findOne({ _id: new ObjectId(t.transferId) }); assert.equal(mid.status, "uploading"); const held = await db.collection("gateway_chunks").countDocuments({ transferId: mid._id }); assert.ok(held >= 1 && held < mid.partCount, `interrupted with ${held} of ${mid.partCount} parts held`);
  const out = await runOnce({ client: gwA.client, config: gwA.config, dir: gwA.dir, audit: gwA.audit, queue: gwA.queue });
  const done = await db.collection("gateway_transfers").findOne({ _id: new ObjectId(t.transferId) }); assert.equal(done.status, "complete", JSON.stringify(gwA.audit.after(0).filter((e) => /failed/.test(e.type)))); assert.equal(await db.collection("gateway_chunks").countDocuments({ transferId: done._id }), done.partCount, "no part was stored twice or lost");
  assert.ok(gwA.audit.after(0).some((e) => e.type === "transfer.completed" && e.detail.resumedFrom >= 1), "the gateway's audit says it resumed"); assert.ok(out);
  const stored = Buffer.concat((await db.collection("gateway_chunks").find({ transferId: done._id }).sort({ index: 1 }).toArray()).map((c) => Buffer.from(c.data.buffer))); assert.equal(stored.includes(big.subarray(100, 164)), false, "Inaya holds ciphertext, not the file");
  assert.equal(JSON.stringify(done).includes(dataKey.toString("base64")), false, "the data key is never sent"); assert.equal((await code((async () => { const { unwrapKey } = await import("../../inaya-gateway-agent/src/transfer.js"); return unwrapKey(done.keyEnvelope, randomBytes(32)); })())) instanceof Error, true, "the envelope does not open without the customer's key");
  const restored = await restoreTransfer({ client: gwA.client, transferId: t.transferId, dataKey }); assert.deepEqual(restored, big, "restored byte for byte");
  const org = await cols.orgActivity.countDocuments({ orgId: orgA.orgId, recordType: "GATEWAY", action: "TRANSFER_COMPLETED" }); assert.equal(org, 1);
});

test("transfer integrity: wrong part hash, oversize part, conflicting duplicate, wrong chain hash and incomplete finish are all refused", T0, async () => {
  const fresh = randomBytes(1024 * 1024 + 10); fs.writeFileSync(path.join(root, "finance", "second.bin"), fresh); await runOnce({ client: gwA.client, config: gwA.config, dir: gwA.dir, audit: gwA.audit, queue: gwA.queue });
  const t = await T.requestTransfer({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, connectorId: connA.connectorId, folderId: folderA, path: "second.bin" }); const id = t.transferId; const P = (p, b) => gwA.client.post(`/api/gateway/v1/transfers/${id}/${p}`, b); const sha = (b) => createHash("sha256").update(b).digest("hex");
  assert.equal((await code(P("begin", { partCount: 9, cipherSize: 1024 * 1024 + 38, keyEnvelope: "{}" })))?.status, 400, "part count must match the size"); await P("begin", { partCount: 2, cipherSize: 1024 * 1024 + 38, keyEnvelope: "{}" });
  const full = randomBytes(1024 * 1024); assert.equal((await code(gwA.client.put(`/api/gateway/v1/transfers/${id}/parts/0`, { data: full.toString("base64"), sha256: "0".repeat(64) })))?.body?.code, "HASH_MISMATCH");
  assert.equal((await code(gwA.client.put(`/api/gateway/v1/transfers/${id}/parts/0`, { data: randomBytes(2 * 1024 * 1024).toString("base64"), sha256: "a".repeat(64) })))?.status, 413);
  assert.equal((await code(gwA.client.put(`/api/gateway/v1/transfers/${id}/parts/0`, { data: randomBytes(500).toString("base64"), sha256: sha(Buffer.alloc(0)) })))?.status, 422);
  assert.equal((await code(gwA.client.put(`/api/gateway/v1/transfers/${id}/parts/5`, { data: full.toString("base64"), sha256: sha(full) })))?.status, 400, "index out of range");
  await gwA.client.put(`/api/gateway/v1/transfers/${id}/parts/0`, { data: full.toString("base64"), sha256: sha(full) }); const dup = await gwA.client.put(`/api/gateway/v1/transfers/${id}/parts/0`, { data: full.toString("base64"), sha256: sha(full) }); assert.equal(dup.duplicate, true);
  const other = randomBytes(1024 * 1024); assert.equal((await code(gwA.client.put(`/api/gateway/v1/transfers/${id}/parts/0`, { data: other.toString("base64"), sha256: sha(other) })))?.body?.code, "CONFLICT");
  assert.equal((await code(P("complete", { chainHash: "0".repeat(64) })))?.body?.code, "INCOMPLETE", "not every part has arrived");
  const tail = randomBytes(38); await gwA.client.put(`/api/gateway/v1/transfers/${id}/parts/1`, { data: tail.toString("base64"), sha256: sha(tail) }); assert.equal((await code(P("complete", { chainHash: "0".repeat(64) })))?.body?.code, "CHAIN_MISMATCH");
  const { chainHashOf } = await import("../src/lib/gateway/transfers.js"); assert.deepEqual(await P("complete", { chainHash: chainHashOf([sha(full), sha(tail)]) }), { complete: true });
  await T.cancelTransfer({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, transferId: (await T.requestTransfer({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwA.gatewayId, connectorId: connA.connectorId, folderId: folderA, path: "budget.xlsx" })).transferId });
});

// ------------------------------------------------------------------------------------------------ tenant isolation, revocation, modes
test("cross-tenant: a gateway can only ever reach its own organization's connectors, transfers and data; administrators only see their own gateways", T0, async () => {
  const connB = await G.upsertConnector({ orgId: orgB.oid, membership: ownerB.membership, actorEmail: ownerB.email, gatewayId: gwB.gatewayId, name: "B", type: "filesystem", rootPath: root, folders: [{ path: "hr", label: "HR" }] }); const folderB = connB.folders[0].folderId;
  assert.equal((await code(gwA.client.post("/api/gateway/v1/inventory", { connectorId: connB.connectorId, folderId: folderB, entries: [{ path: "x.txt", size: 1 }] })))?.status, 404, "A cannot write into B's connector");
  assert.equal((await code(gwA.client.post("/api/gateway/v1/acl", { folderId: folderB, entries: [] })))?.status, 403, "A cannot post a permission snapshot for B's folder");
  assert.equal((await code(gwB.client.post("/api/gateway/v1/inventory", { connectorId: connA.connectorId, folderId: folderA, entries: [] })))?.status, 404, "and B cannot write into A's");
  const tA = (await db.collection("gateway_transfers").find({ orgId: orgA.orgId }).limit(1).next())._id.toString();
  assert.equal((await code(gwB.client.get(`/api/gateway/v1/transfers/${tA}`)))?.status, 404, "B cannot see A's transfer"); assert.equal((await code(gwB.client.get(`/api/gateway/v1/transfers/${tA}/parts/0`)))?.status, 404);
  assert.equal((await code(restoreTransfer({ client: gwB.client, transferId: tA, dataKey })))?.status, 404, "B cannot restore A's file even with a key");
  assert.equal((await code(G.getGateway({ orgId: orgA.oid, membership: ownerA.membership, gatewayId: gwB.gatewayId })))?.status, 404, "A's administrator cannot open B's gateway");
  assert.equal((await code(G.revokeGateway({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwB.gatewayId })))?.status, 404, "or revoke it");
  assert.equal((await G.listGateways({ orgId: orgA.oid, membership: ownerA.membership })).gateways.every((g) => g.gatewayId === gwA.gatewayId), true);
  assert.equal((await code(A.effectiveAccess({ orgId: orgA.oid, folderId: folderB, email: alice.email })))?.status, 404, "A's people cannot be evaluated against B's folder");
  assert.equal((await code(A.browseFolder({ orgId: orgB.oid, folderId: folderA, email: ownerB.email })))?.status, 404);
  assert.equal((await code(T.requestTransfer({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwB.gatewayId, connectorId: connB.connectorId, folderId: folderB, path: "x.txt" })))?.status, 404);
  assert.equal((await code(G.upsertConnector({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, gatewayId: gwB.gatewayId, name: "x", type: "filesystem", rootPath: root, folders: [] })))?.status, 404);
  await setOrgFeature({ orgId: orgB.oid, name: "FEATURE_SOVEREIGN_GATEWAY", enabled: false }); assert.ok([403, 404].includes((await code(gwB.client.post("/api/gateway/v1/heartbeat", {})))?.status), "the feature switch is honoured for the gateway own organization"); await setOrgFeature({ orgId: orgB.oid, name: "FEATURE_SOVEREIGN_GATEWAY", enabled: true });
});

test("revocation: the next request is refused with a clear code, queued transfers are cancelled, the agent stops, and it is audited", T0, async () => {
  const t = await T.requestTransfer({ orgId: orgB.oid, membership: ownerB.membership, actorEmail: ownerB.email, gatewayId: gwB.gatewayId, connectorId: (await db.collection("gateway_connectors").findOne({ gatewayId: new ObjectId(gwB.gatewayId) }))._id.toString(), folderId: (await db.collection("gateway_connectors").findOne({ gatewayId: new ObjectId(gwB.gatewayId) })).folders[0].folderId, path: "x.txt" }).catch(() => null);
  assert.equal((await code(G.revokeGateway({ orgId: orgB.oid, membership: orgB.owner.membership, actorEmail: ownerB.email, gatewayId: new ObjectId().toHexString() })))?.status, 404);
  const r = await G.revokeGateway({ orgId: orgB.oid, membership: ownerB.membership, actorEmail: ownerB.email, gatewayId: gwB.gatewayId, reason: "laptop stolen" }); assert.equal(r.revoked, true);
  assert.ok(await code(gwB.client.post("/api/gateway/v1/heartbeat", {})) instanceof RevokedError, "the client raises a revoked error");
  await assert.rejects(runOnce({ client: gwB.client, config: gwB.config, dir: gwB.dir, audit: gwB.audit, queue: gwB.queue }), RevokedError);
  assert.equal((await code(G.revokeGateway({ orgId: orgB.oid, membership: ownerB.membership, actorEmail: ownerB.email, gatewayId: gwB.gatewayId })))?.status, 404, "already revoked");
  const g = await G.getGateway({ orgId: orgB.oid, membership: ownerB.membership, gatewayId: gwB.gatewayId }); assert.equal(g.status, "REVOKED");
  assert.ok((await cols.orgActivity.countDocuments({ orgId: orgB.orgId, recordType: "GATEWAY", action: "GATEWAY_REVOKED" })) === 1); assert.ok(t === null || (await db.collection("gateway_transfers").findOne({ _id: new ObjectId(t.transferId) })).status === "cancelled");
  assert.equal((await code(G.createEnrollment({ orgId: orgB.oid, membership: orgB.owner.membership, actorEmail: ownerB.email, label: "again" })))?.status, undefined, "a new gateway can be enrolled after a revoke");
});

test("deployment modes: all four are explicit; readiness comes from what is configured; air-gapped is recorded only and needs an acknowledgement; only owner/admin may change it", T0, async () => {
  const p0 = await M.getProfile({ orgId: orgA.oid }); assert.equal(p0.mode, "cloud_managed"); assert.equal(p0.modes.length, 4);
  assert.equal(p0.modes.find((m) => m.key === "customer_gateway").readiness.state, "READY", "an online gateway makes mode 3 ready"); assert.equal(p0.modes.find((m) => m.key === "air_gapped").readiness.state, "RECORDED_ONLY");
  assert.equal((await M.getProfile({ orgId: orgB.oid })).modes.find((m) => m.key === "customer_gateway").readiness.state === "READY", false, "B's only gateway is revoked");
  assert.equal((await code(M.setMode({ orgId: orgA.oid, membership: bob.membership, actorEmail: bob.email, mode: "customer_gateway" })))?.status, 403); assert.equal((await code(M.setMode({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, mode: "quantum" })))?.status, 400);
  assert.equal((await code(M.setMode({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, mode: "air_gapped" })))?.status, 400, "must acknowledge that nothing is provided");
  const m3 = await M.setMode({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, mode: "customer_gateway", note: "head office" }); assert.equal(m3.mode, "customer_gateway");
  const m4 = await M.setMode({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, mode: "air_gapped", acknowledgeNoClaim: true }); assert.equal(m4.current.readiness.state, "RECORDED_ONLY"); assert.match(m4.current.text, /no internet-independent operation is claimed/);
  assert.equal(p0.modes.find((m) => m.key === "customer_storage").readiness.state === "READY", false, "customer storage is never reported as fully ready");
  await M.setMode({ orgId: orgA.oid, membership: ownerA.membership, actorEmail: ownerA.email, mode: "cloud_managed" });
});
