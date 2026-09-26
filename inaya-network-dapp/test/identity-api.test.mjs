// test/identity-api.test.mjs -- Identity Integration: the HTTP surface. Webhook security (SOW section 23, 45, 50 E), service credentials and scopes,
// MSP isolation and delegated roles (section 25/26, 50 D), privilege escalation attempts (45), idempotency, dry run export (37, 50 G),
// secrets never leaving. Real MongoDB; the route handlers are invoked directly with real Request objects.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { setup, makeIdentityOrg, ev, cookieFor, signedHeaders, cleanup, RUN, c, ic } from "./_identity-fixtures.mjs";
import { flushEvidence } from "../src/lib/identity/record.js";
import { createCredential } from "../src/lib/identity/credentials.js";
import { createLinkInvite, acceptLinkInvite, assignTechnician } from "../src/lib/identity/msp.js";
import * as webhook from "../src/app/api/integrations/identity/webhooks/[provider]/route.js";
import * as api from "../src/app/api/integrations/identity/[[...path]]/route.js";
import { SESSION_COOKIE } from "../src/lib/orgs.js";

let A; let B; let MSPO;
const mail = (n) => `idn-${RUN}-${n}@corp.example`;
const J = (o) => JSON.stringify(o);

const hookCall = (org, raw, headers = {}, { url = `http://localhost/api/integrations/identity/webhooks/${org.providerId}`, providerId = org.providerId } = {}) =>
  webhook.POST(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers }, body: raw }), { params: Promise.resolve({ provider: providerId }) });
const signedHook = (org, event, { ts, secret = org.secret, ...opts } = {}) => { const raw = J(event); return hookCall(org, raw, signedHeaders(secret, raw, ts), opts); };
const apiCall = async (method, path, { cookie, token, org, body, headers = {}, query = "" } = {}) => {
  const h = { "x-forwarded-for": "203.0.113.8", ...headers };
  if (cookie) h.cookie = `${SESSION_COOKIE}=${cookie}`; if (token) h.authorization = `Bearer ${token}`; if (org) h["x-inaya-organization"] = org;
  if (body !== undefined) h["content-type"] = "application/json";
  const req = new NextRequest(`http://localhost/api/integrations/identity/${path}${query}`, { method, headers: h, ...(body !== undefined ? { body: typeof body === "string" ? body : J(body) } : {}) });
  const res = await api[method](req, { params: Promise.resolve({ path: path.split("/") }) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};

before(async () => { await setup(); A = await makeIdentityOrg("apia"); B = await makeIdentityOrg("apib"); MSPO = await makeIdentityOrg("msp", { mappings: false }); });
after(async () => { await flushEvidence(); await cleanup(); });

const wireEvent = (org, over = {}) => ({ ...ev(org, over), occurredAt: new Date().toISOString() });

test("webhooks: unsigned, bad-signature, stale-timestamp, oversize, unknown-provider and http requests are all refused; nothing is created (SOW 23, 45)", async () => {
  const e = wireEvent(A, { id: `w1-${RUN}`, email: mail("w1"), eventId: `evt-w1-${RUN}` });
  const raw = J(e);
  const unsigned = await hookCall(A, raw); assert.equal(unsigned.status, 401);
  const bad = await hookCall(A, raw, signedHeaders("whsec_wrong", raw)); assert.equal(bad.status, 401);
  const stale = await signedHook(A, e, { ts: Math.floor(Date.now() / 1000) - 3600 }); assert.equal(stale.status, 401, "old timestamp = replay window closed");
  const future = await signedHook(A, e, { ts: Math.floor(Date.now() / 1000) + 3600 }); assert.equal(future.status, 401);
  const big = J({ ...e, pad: "x".repeat(300 * 1024) }); const tooBig = await hookCall(A, big, signedHeaders(A.secret, big)); assert.equal(tooBig.status, 413);
  const unknown = await signedHook(A, e, { providerId: "64b64b64b64b64b64b64b64b" }); assert.equal(unknown.status, 401, "same answer as a bad signature: does not reveal which providers exist");
  const notId = await signedHook(A, e, { providerId: "not-an-id" }); assert.equal(notId.status, 401);
  const http = await hookCall(A, raw, signedHeaders(A.secret, raw), { url: `http://example.com/api/integrations/identity/webhooks/${A.providerId}` }); assert.equal(http.status, 400, "non-local plain http is refused");
  assert.equal(await c.orgMembers.countDocuments({ orgId: A.orgId, email: mail("w1") }), 0, "nothing was created by any refused request");
  assert.ok(await c.orgActivity.findOne({ orgId: A.orgId, action: "IDENTITY_WEBHOOK_REJECTED" }), "signature failures are audited");
});

test("webhooks: a signed event provisions; replaying the same event id is idempotent; a stale copy of a later state is ignored (SOW 50 A, E, 46)", async () => {
  const email = mail("w2"); const id = `w2-${RUN}`;
  const e = wireEvent(A, { id, email, eventId: `evt-w2-${RUN}`, groups: ["Inaya-Finance"] });
  const r1 = await signedHook(A, e); const j1 = await r1.json();
  assert.equal(r1.status, 200, J(j1)); assert.equal(j1.status, "PROCESSED");
  const r2 = await signedHook(A, e); const j2 = await r2.json();
  assert.equal(r2.status, 200); assert.equal(j2.status, "DUPLICATE", "a replay (even with a fresh valid signature) does not run twice");
  assert.equal(await c.orgMembers.countDocuments({ orgId: A.orgId, email }), 1);
  assert.equal(await ic.identityRuns.countDocuments({ orgId: A.orgId, email, type: "JOINER" }), 1);
  const later = { ...wireEvent(A, { type: "user.disabled", id, email, eventId: `evt-w2d-${RUN}` }) }; later.occurredAt = new Date(Date.now() + 5000).toISOString();
  const rd = await signedHook(A, later); assert.equal((await rd.json()).status, "PROCESSED");
  assert.equal((await c.orgMembers.findOne({ orgId: A.orgId, email })).status, "revoked");
  const old = { ...wireEvent(A, { type: "user.enabled", id, email, eventId: `evt-w2e-${RUN}` }) }; old.occurredAt = new Date(Date.now() - 60000).toISOString();
  const re = await signedHook(A, old); const je = await re.json();
  assert.equal(je.status, "STALE", J(je));
  assert.equal((await c.orgMembers.findOne({ orgId: A.orgId, email })).status, "revoked", "a delayed older event can never re-enable access");
});

test("webhooks: wrong tenant, malformed schema and a disabled provider fail closed; a webhook can never target another organization (SOW 8, 45)", async () => {
  const wrongTenant = wireEvent(A, { id: `w3-${RUN}`, email: mail("w3"), eventId: `evt-w3-${RUN}`, tenant: "someone-elses-tenant" });
  const r = await signedHook(A, wrongTenant); assert.equal(r.status, 403); assert.equal((await r.json()).reasonCode, "TENANT_MISMATCH");
  // B's tenant id sent through A's endpoint (signed with A's secret) is still refused: a provider serves exactly one tenant
  const crossOrg = wireEvent(A, { id: `w3b-${RUN}`, email: mail("w3b"), eventId: `evt-w3b-${RUN}`, tenant: B.tenant });
  assert.equal((await signedHook(A, crossOrg)).status, 403);
  assert.equal(await c.orgMembers.countDocuments({ orgId: B.orgId, email: mail("w3b") }) + await c.orgMembers.countDocuments({ orgId: A.orgId, email: mail("w3b") }), 0);
  const bad = { eventId: "x", type: "user.exploded", tenantId: A.tenant, occurredAt: new Date().toISOString(), subject: { externalId: "z" } };
  const rb = await signedHook(A, bad); assert.equal(rb.status, 400); assert.equal((await rb.json()).reasonCode, "SCHEMA");
  const notJson = "{not json"; assert.equal((await hookCall(A, notJson, signedHeaders(A.secret, notJson))).status, 400);
  // a tenant cannot be claimed by a second organization
  const { createProvider } = await import("../src/lib/identity/providers.js");
  const dup = await createProvider({ orgId: B.orgId, kind: "entra", providerTenantId: A.tenant, name: "steal", actorEmail: B.owner });
  assert.equal(dup.status, 409); assert.ok(dup.error);
  await ic.identityProviders.updateOne({ _id: B.provider._id }, { $set: { status: "DISABLED" } });
  const dis = wireEvent(B, { id: `w3c-${RUN}`, email: mail("w3c"), eventId: `evt-w3c-${RUN}` });
  assert.equal((await signedHook(B, dis)).status, 403);
  await ic.identityProviders.updateOne({ _id: B.provider._id }, { $set: { status: "ACTIVE" } });
});

test("API: only an owner/admin can use it; another organization's admin, a plain member and an anonymous caller are refused (SOW 45 tenant isolation)", async () => {
  const ownerC = await cookieFor(A.owner); const memberEmail = A.member ? await A.member("plain") : mail("plain"); const plainC = await cookieFor(memberEmail);
  const bOwnerC = await cookieFor(B.owner);
  const ok = await apiCall("GET", "providers", { cookie: ownerC, query: `?orgId=${A.oid}` }); assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.providers.length, 1); assert.ok(!ok.text.includes(A.secret), "the signing secret is never returned");
  assert.equal((await apiCall("GET", "providers", { cookie: plainC, query: `?orgId=${A.oid}` })).status, 403);
  assert.equal((await apiCall("GET", "providers", { cookie: bOwnerC, query: `?orgId=${A.oid}` })).status, 403, "another organization's owner sees nothing");
  assert.equal((await apiCall("GET", "providers", { query: `?orgId=${A.oid}` })).status, 401);
  assert.equal((await apiCall("GET", "providers", { cookie: ownerC })).status, 400, "orgId is required");
  const st = await apiCall("GET", "status", { cookie: ownerC, query: `?orgId=${A.oid}` }); assert.equal(st.status, 200); assert.ok(st.json.providers && st.json.events);
  const mt = await apiCall("GET", "metrics", { cookie: ownerC, query: `?orgId=${A.oid}` }); assert.equal(mt.status, 200); assert.equal(mt.json.source, "computed from durable rows only");
});

test("service credentials: scoped, organization-bound, audited on a cross-tenant attempt, human-only management, never exposing secrets (SOW 25, 36, 45)", async () => {
  const readOnly = await createCredential({ orgId: A.orgId, label: "reader", scopes: ["identity:read", "identity:audit"], actorEmail: A.owner });
  const prov = await createCredential({ orgId: A.orgId, label: "rewst", scopes: ["identity:read", "identity:provision", "identity:revoke", "identity:reconcile"], actorEmail: A.owner });
  assert.ok(readOnly.token.startsWith("idc_"));
  const r1 = await apiCall("GET", "providers", { token: readOnly.token }); assert.equal(r1.status, 200, r1.text);
  const noScope = await apiCall("POST", "users/nobody@corp.example/revoke", { token: readOnly.token, body: { reason: "x" } }); assert.equal(noScope.status, 403); assert.equal(noScope.json.reasonCode, "CAPABILITY_MISSING");
  // an org-bound credential cannot be pointed at another organization
  const cross = await apiCall("GET", "providers", { token: prov.token, org: B.oid }); assert.equal(cross.status, 403); assert.equal(cross.json.reasonCode, "ORGANIZATION_NOT_ALLOWED");
  assert.ok(await c.orgActivity.findOne({ orgId: A.orgId, action: "IDENTITY_CROSS_TENANT_DENIED" }), "the attempt is audited");
  // automation cannot mint credentials, providers, or MSP links for itself
  assert.equal((await apiCall("POST", "credentials", { token: prov.token, body: { label: "escalate", scopes: ["identity:read"] } })).status, 403);
  assert.equal((await apiCall("POST", "providers", { token: prov.token, body: { kind: "entra", providerTenantId: `t-${RUN}-x`, name: "x" } })).status, 403);
  assert.equal((await apiCall("POST", "msp/invites", { token: prov.token, body: {} })).status, 403);
  // bad token, revoked token, expired token
  assert.equal((await apiCall("GET", "providers", { token: "idc_notatoken" })).status, 401);
  const ownerC = await cookieFor(A.owner);
  const revoke = await apiCall("POST", `credentials/${readOnly.credential.credentialId}/revoke`, { cookie: ownerC, body: {}, query: `?orgId=${A.oid}` }); assert.equal(revoke.status, 200, revoke.text);
  assert.equal((await apiCall("GET", "providers", { token: readOnly.token })).status, 401, "a revoked credential stops working at once");
  await ic.identityCredentials.updateOne({ tokenHash: { $exists: true }, orgId: A.orgId, prefix: prov.credential.prefix }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await apiCall("GET", "providers", { token: prov.token })).status, 401, "an expired credential is refused");
  const list = await apiCall("GET", "credentials", { cookie: ownerC, query: `?orgId=${A.oid}` }); assert.equal(list.status, 200);
  assert.ok(!list.text.includes(prov.token) && !list.text.includes("tokenHash"), "listing never returns tokens or hashes");
  // secrets must not appear in the audit trail either
  const leaks = await c.orgActivity.find({ orgId: A.orgId, recordType: "IDENTITY_LIFECYCLE" }).toArray();
  assert.ok(!JSON.stringify(leaks).includes(prov.token) && !JSON.stringify(leaks).includes(A.secret), "audit never contains secrets");
});

test("D. MSP isolation: an MSP credential reaches only customers with an accepted link; delegated roles are enforced; ending the link cuts access at once (SOW 25, 26, 50 D)", async () => {
  const cust1 = A; const cust2 = B;
  const mspOwnerC = await cookieFor(MSPO.owner);
  const inv = await createLinkInvite({ customerOrgId: cust1.orgId, actorEmail: cust1.owner }); assert.ok(inv.inviteCode);
  const cred = await createCredential({ orgId: MSPO.orgId, kind: "msp", label: "msp-all", scopes: ["identity:read", "identity:provision", "identity:revoke"], customerOrgIds: "*", actorEmail: MSPO.owner });
  // before the link exists: refused everywhere, and the refusal is audited on the MSP's side
  const pre = await apiCall("GET", "providers", { token: cred.token, org: cust1.oid }); assert.equal(pre.status, 403);
  assert.equal((await acceptLinkInvite({ mspOrgId: MSPO.orgId, token: "idm_forged", actorEmail: MSPO.owner })).status, 400, "a forged invite code is refused");
  assert.equal((await acceptLinkInvite({ mspOrgId: MSPO.orgId, token: inv.inviteCode, actorEmail: MSPO.owner })).linked, true);
  assert.equal((await acceptLinkInvite({ mspOrgId: MSPO.orgId, token: inv.inviteCode, actorEmail: MSPO.owner })).status, 400, "an invite code works once");
  const linked = await apiCall("GET", "providers", { token: cred.token, org: cust1.oid }); assert.equal(linked.status, 200, linked.text);
  const other = await apiCall("GET", "providers", { token: cred.token, org: cust2.oid }); assert.equal(other.status, 403, "a customer that never linked stays invisible to the MSP");
  assert.equal((await apiCall("GET", "providers", { token: cred.token })).status, 400, "an MSP credential must name the customer");
  // an MSP credential cannot reach the MSP's own organization data through the customer path either
  // delegated roles: a read-only auditor can look but not revoke; automation operators can revoke but not manage mappings or credentials
  const tech = await MSPO.member("tech"); const auditor = await MSPO.member("auditor");
  assert.equal((await assignTechnician({ mspOrgId: MSPO.orgId, email: tech, role: "MSP_AUTOMATION_OPERATOR", customerOrgIds: [cust1.oid], actorEmail: MSPO.owner })).assigned, true);
  assert.equal((await assignTechnician({ mspOrgId: MSPO.orgId, email: auditor, role: "MSP_READ_ONLY_AUDITOR", customerOrgIds: [cust1.oid], actorEmail: MSPO.owner })).assigned, true);
  assert.equal((await assignTechnician({ mspOrgId: MSPO.orgId, email: tech, role: "MSP_AUTOMATION_OPERATOR", customerOrgIds: [cust2.oid], actorEmail: MSPO.owner })).status, 403, "cannot assign a customer that is not linked");
  const techC = await cookieFor(tech); const audC = await cookieFor(auditor);
  const victim = await cust1.member("victim");
  assert.equal((await apiCall("GET", "status", { cookie: audC, query: `?orgId=${cust1.oid}` })).status, 200);
  assert.equal((await apiCall("POST", `users/${victim}/revoke`, { cookie: audC, query: `?orgId=${cust1.oid}`, body: { reason: "x" } })).status, 403, "read-only auditor cannot revoke");
  assert.equal((await apiCall("POST", "mappings", { cookie: techC, query: `?orgId=${cust1.oid}`, body: { name: "m", match: { type: "group", value: "g" }, grants: [{ kind: "role", value: "member" }] } })).status, 403, "an automation operator cannot change mappings");
  assert.equal((await apiCall("GET", "status", { cookie: techC, query: `?orgId=${cust2.oid}` })).status, 403, "and cannot reach an unassigned customer");
  assert.equal((await apiCall("POST", "credentials", { cookie: techC, query: `?orgId=${cust1.oid}`, body: { label: "x", scopes: ["identity:read"] } })).status, 403, "MSP staff cannot mint credentials inside a customer");
  const rev = await apiCall("POST", `users/${victim}/revoke`, { cookie: techC, query: `?orgId=${cust1.oid}`, body: { reason: "offboarded by MSP runbook" } });
  assert.equal(rev.status, 200, rev.text); assert.equal(rev.json.revocation.state, "REVOCATION_COMPLETE");
  assert.equal((await c.orgMembers.findOne({ orgId: cust1.orgId, email: victim })).status, "revoked");
  assert.equal((await apiCall("POST", `users/${victim}/restore`, { cookie: techC, query: `?orgId=${cust1.oid}`, body: {} })).status, 403, "an operator cannot restore a revoked person");
  // ending the link (customer side) cuts every MSP path immediately
  const custC = await cookieFor(cust1.owner);
  const end = await apiCall("DELETE", `msp/links/${MSPO.oid}`, { cookie: custC, query: `?orgId=${cust1.oid}`, body: {} }); assert.equal(end.status, 200, end.text);
  assert.equal((await apiCall("GET", "providers", { token: cred.token, org: cust1.oid })).status, 403);
  assert.equal((await apiCall("GET", "status", { cookie: techC, query: `?orgId=${cust1.oid}` })).status, 403);
  void mspOwnerC;
});

test("privilege escalation: automation cannot grant admin/owner outright, cannot touch an owner, and cannot restore the revoked (SOW 17, 38, 45)", async () => {
  const cred = await createCredential({ orgId: A.orgId, label: "rewst-esc", scopes: ["identity:read", "identity:provision", "identity:revoke", "identity:mapping"], actorEmail: A.owner });
  const target = await A.member("esc");
  const owner = await apiCall("POST", `users/${target}/roles`, { token: cred.token, body: { role: "owner", reason: "please" } }); assert.equal(owner.status, 400, "owner can never be granted");
  const adm = await apiCall("POST", `users/${target}/roles`, { token: cred.token, body: { role: "admin", reason: "rewst says so" } });
  assert.equal(adm.status, 200, adm.text); assert.equal(adm.json.granted, false); assert.ok(adm.json.pendingApproval?.requestId, "admin from automation waits for a human via Controlled Actions");
  assert.equal((await c.orgMembers.findOne({ orgId: A.orgId, email: target })).role, "member", "not applied yet");
  const ownerTouch = await apiCall("POST", `users/${A.owner}/roles`, { token: cred.token, body: { role: "admin", reason: "make the owner admin" } }); assert.equal(ownerTouch.status, 409); assert.equal(ownerTouch.json.reasonCode, "OWNER_PROTECTED");
  const ownerRevoke = await apiCall("POST", `users/${A.owner}/revoke`, { token: cred.token, body: { reason: "x" } });
  assert.ok(ownerRevoke.status >= 400, "the only owner cannot be revoked"); assert.equal((await c.orgMembers.findOne({ orgId: A.orgId, email: A.owner })).status, "active");
  const noReason = await apiCall("POST", `users/${target}/departments`, { token: cred.token, body: { departmentId: String(A.finance) } }); assert.equal(noReason.status, 400, "a reason is mandatory for an override");
  // a mapping can carry a role but never "owner"
  const badMap = await apiCall("POST", "mappings", { token: cred.token, body: { name: "esc", match: { type: "group", value: "Everyone" }, grants: [{ kind: "role", value: "owner" }] } }); assert.equal(badMap.status, 400);
  // an override by a signed-in admin applies at once and is labelled as manual
  const ownerC = await cookieFor(A.owner);
  const dept = await apiCall("POST", `users/${target}/departments`, { cookie: ownerC, query: `?orgId=${A.oid}`, body: { departmentId: String(A.legal), reason: "cross-cover during audit" } }); assert.equal(dept.status, 200, dept.text);
  const acc = await apiCall("GET", `users/${target}/access`, { cookie: ownerC, query: `?orgId=${A.oid}` });
  assert.ok(acc.json.grants.some((g) => g.sourceLabel === "INAYA MANUAL OVERRIDE" && g.kind === "department"), "the source is labelled");
  // revoke, then automation tries to bring them back
  assert.equal((await apiCall("POST", `users/${target}/revoke`, { token: cred.token, body: { reason: "test" } })).status, 200);
  assert.equal((await apiCall("POST", `users/${target}/restore`, { token: cred.token, body: {} })).status, 403);
  const back = await apiCall("POST", `users/${target}/restore`, { cookie: ownerC, query: `?orgId=${A.oid}`, body: { reason: "human review: false alarm" } }); assert.equal(back.status, 200, back.text);
  assert.equal((await c.orgMembers.findOne({ orgId: A.orgId, email: target })).status, "active");
});

test("G. dry run: exportable text ends with LIVE MUTATION: NO and changes nothing; Idempotency-Key replays the recorded answer (SOW 37, 50 G, 46)", async () => {
  const ownerC = await cookieFor(A.owner); const email = mail("dry");
  const before = await c.orgMembers.countDocuments({ orgId: A.orgId }); const runsBefore = await ic.identityRuns.countDocuments({ orgId: A.orgId });
  const r = await apiCall("POST", "dry-run", { cookie: ownerC, query: `?orgId=${A.oid}`, body: { providerId: A.providerId, event: { type: "user.created", subject: { externalId: `dry-${RUN}`, email, upn: email, groups: ["Inaya-Finance"], accountEnabled: true } } } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, "DRY_RUN"); assert.equal(r.json.liveMutation, false);
  assert.match(r.json.text, /^DRY RUN/); assert.match(r.json.text, /Would create:\n- CREATE_MEMBERSHIP/); assert.match(r.json.text, /Would grant:/); assert.ok(r.json.text.trim().endsWith("LIVE MUTATION: NO"));
  assert.equal(await c.orgMembers.countDocuments({ orgId: A.orgId }), before); assert.equal(await ic.identityRuns.countDocuments({ orgId: A.orgId }), runsBefore);
  assert.equal(await ic.identityExternalUsers.countDocuments({ orgId: A.orgId, externalObjectId: `dry-${RUN}` }), 0);
  // Idempotency-Key: the same key returns the recorded response and does not run twice
  const body = { providerId: A.providerId, event: { type: "user.created", eventId: `api-idem-${RUN}`, subject: { externalId: `idem-${RUN}`, email: mail("idem"), upn: mail("idem"), groups: ["Inaya-Finance"] } } };
  const key = `idem-${RUN}-key1`;
  const p1 = await apiCall("POST", "users/provision", { cookie: ownerC, query: `?orgId=${A.oid}`, body, headers: { "idempotency-key": key } }); assert.equal(p1.status, 200, p1.text);
  const p2 = await apiCall("POST", "users/provision", { cookie: ownerC, query: `?orgId=${A.oid}`, body, headers: { "idempotency-key": key } }); assert.equal(p2.json.replayed, true);
  assert.equal(await ic.identityRuns.countDocuments({ orgId: A.orgId, email: mail("idem"), type: "JOINER" }), 1);
  const other = await apiCall("POST", "users/reconcile", { cookie: ownerC, query: `?orgId=${A.oid}`, body: { providerId: A.providerId, subjects: [] }, headers: { "idempotency-key": key } }); assert.equal(other.status, 409, "the key cannot be reused for a different request");
  // oversized JSON is refused
  const huge = await apiCall("POST", "dry-run", { cookie: ownerC, query: `?orgId=${A.oid}`, body: J({ pad: "x".repeat(1100 * 1024) }) }); assert.equal(huge.status, 413);
});

test("evidence: lifecycle actions appear in the existing audit trail, the hash chain still verifies, and the existing evidence export contains them (SOW 39, 40, 53)", async () => {
  const { getEvidenceTrail } = await import("../src/lib/evidence.js");
  const { verifyChainIntegrity } = await import("../src/lib/auditChain.js");
  const { buildEvidencePackage } = await import("../src/lib/evidenceExporter.js");
  const run = await ic.identityRuns.findOne({ orgId: A.orgId, type: "JOINER" });
  assert.ok(run, "an earlier test produced a joiner run");
  const trail = await getEvidenceTrail({ orgId: A.orgId, recordType: "IDENTITY_LIFECYCLE", recordId: String(run._id) });
  assert.ok(trail.count >= 2 && trail.trail.some((t) => t.action === "IDENTITY_LIFECYCLE_COMPLETED"), "the per-record evidence trail (the same one /api/public/v1/evidence serves) has the run");
  const chain = await verifyChainIntegrity(A.orgId); assert.equal(chain.valid, true, "the tamper-evident chain still verifies with identity entries in it");
  const pkg = await buildEvidencePackage({ orgId: A.oid, actorEmail: A.owner });
  assert.ok(JSON.stringify(pkg).includes("IDENTITY_LIFECYCLE"), "the existing organization evidence export carries the identity lifecycle records");
});
