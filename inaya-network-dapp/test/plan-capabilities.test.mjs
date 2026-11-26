// test/plan-capabilities.test.mjs
//
// Pricing-card capabilities (26 Nov 2026): package gates (planGates.js) incl. grandfathering and beta switches, passkey sign-in
// (passkeys.js, WebAuthn verification injected), Enterprise staff SSO (workforceSso.js, provider exchange injected), custom-domain
// hosting + lookup (branding.js, Vercel API injected), and priority-support tiers (support/packageTier.js). Real test Atlas,
// RUN_ID fixtures, cleaned up afterwards.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "../src/lib/mongodb.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { planAllows, requirePlanFeature, planFeatureMap } from "../src/lib/planGates.js";
import { resolveFeature, setOrgFeature } from "../src/lib/featureFlags.js";
import * as PK from "../src/lib/passkeys.js";
import * as W from "../src/lib/workforceSso.js";
import { attachDomainToHosting, setCustomDomain, verifyCustomDomain, workspaceForHost } from "../src/lib/branding/branding.js";
import { tierForOrgs, packageTier } from "../src/lib/support/packageTier.js";
import { computePriority } from "../src/lib/support/tickets.js";
import { requestEnterpriseOnboarding } from "../src/lib/help.js";

const RUN = randomUUID().slice(0, 8);
const orgIds = []; const emails = [];
const owner = { role: "owner" };
async function db() { return (await connectToDatabase()).db; }
async function mkOrg(plan, extra = {}) {
  const d = await db(); const _id = new ObjectId(); orgIds.push(_id);
  await d.collection("orgs").insertOne({ _id, name: `PlanCap ${RUN} ${plan}`, plan, ownerEmail: `owner-${RUN}@plancap.test`, createdAt: new Date().toISOString(), ...extra });
  return String(_id);
}
async function mkMember(orgId, email, status = "active") { emails.push(email); await (await db()).collection("org_members").insertOne({ orgId: new ObjectId(orgId), email, role: "member", status, createdAt: new Date().toISOString() }); }

after(async () => {
  const d = await db();
  await d.collection("orgs").deleteMany({ _id: { $in: orgIds } });
  await d.collection("org_members").deleteMany({ orgId: { $in: orgIds } });
  await d.collection("org_branding").deleteMany({ orgId: { $in: orgIds } });
  await d.collection("member_mfa").deleteMany({ _id: { $in: emails } });
  await d.collection("mfa_pending").deleteMany({ email: { $in: emails } });
  await d.collection("org_activity").deleteMany({ orgId: { $in: orgIds } }).catch(() => {});
  await (await mongoClientPromise).close();
});

// ------------------------------------------------------------------------------------------------ package gates
test("planAllows: package order, legacy unrestricted, grandfathered", () => {
  assert.equal(planAllows({ plan: "starter" }, "advancedSharing"), false);
  assert.equal(planAllows({ plan: "professional" }, "advancedSharing"), true);
  assert.equal(planAllows({ plan: "professional" }, "apiAccess"), false);
  assert.equal(planAllows({ plan: "business" }, "apiAccess"), true);
  assert.equal(planAllows({ plan: "business" }, "sso"), false);
  assert.equal(planAllows({ plan: "enterprise" }, "sso"), true);
  assert.equal(planAllows({ plan: "business" }, "retentionPolicies"), false);
  assert.equal(planAllows({}, "sso"), true, "no package = legacy, unrestricted");
  assert.equal(planAllows({ noPlanConfirmedAt: "x" }, "documentAi"), false, "no-billing Starter is limited");
  assert.equal(planAllows({ plan: "starter", planGrandfatheredAt: "2026-11-26" }, "customDomain"), true);
  assert.equal(planAllows({ plan: "starter", planGrandfatheredAt: "2026-11-26" }, "sso"), false, "SSO is new: nothing to keep");
  assert.equal(planAllows({ plan: "business" }, "advancedCompliance"), false);
  assert.equal(planFeatureMap({ plan: "business" }).customDomain.allowed, true);
});

test("requirePlanFeature: 403 with the package to upgrade to", async () => {
  const pro = await mkOrg("professional");
  const g = await requirePlanFeature(pro, "adminDashboard");
  assert.equal(g.status, 403); assert.equal(g.requiredPlan, "business"); assert.match(g.error, /Business and Enterprise/);
  assert.equal(await requirePlanFeature(await mkOrg("business"), "adminDashboard"), null);
});

test("beta switches that are package features: locked below, on by default from Business", async () => {
  assert.equal(resolveFeature("FEATURE_DEVICE_CONTROL", { FEATURE_DEVICE_CONTROL: true }, {}, "professional", { plan: "professional" }), false);
  assert.equal(resolveFeature("FEATURE_DEVICE_CONTROL", {}, {}, "business", { plan: "business" }), true);
  assert.equal(resolveFeature("FEATURE_DEVICE_CONTROL", { FEATURE_DEVICE_CONTROL: false }, {}, "business", { plan: "business" }), false, "a company can still switch it off");
  assert.equal(resolveFeature("FEATURE_DEVICE_CONTROL", {}, { FEATURE_DEVICE_CONTROL: "on" }, "starter", { plan: "starter" }), false, "platform-on does not bypass the package");
  assert.equal(resolveFeature("FEATURE_ADVANCED_SHARING", { FEATURE_ADVANCED_SHARING: true }, {}, "professional", { plan: "professional" }), true);
  const starter = await mkOrg("starter");
  const r = await setOrgFeature({ orgId: starter, name: "FEATURE_ADVANCED_SHARING", enabled: true });
  assert.equal(r.status, 403);
});

// ------------------------------------------------------------------------------------------------ passkeys
const RP = { rpID: "inayanetwork.com", origin: "https://www.inayanetwork.com" };
test("relyingPartyFor: own hosts, custom domains, everything else refused", async () => {
  assert.deepEqual(await PK.relyingPartyFor("https://www.inayanetwork.com"), RP);
  assert.equal((await PK.relyingPartyFor("https://inayanetwork.com")).rpID, "inayanetwork.com");
  assert.equal((await PK.relyingPartyFor("https://files.acme.test", { isWorkspaceHost: async () => true })).rpID, "files.acme.test");
  await assert.rejects(PK.relyingPartyFor("https://evil.test", { isWorkspaceHost: async () => false }), /not available/);
  await assert.rejects(PK.relyingPartyFor("http://www.inayanetwork.com"), /HTTPS/);
});

test("passkey: register while signed in, then sign in with it; counter stored; single-use challenges", async () => {
  const email = `pk-${RUN}@plancap.test`; emails.push(email);
  const reg = await PK.startRegistration({ email, rpOverride: RP });
  assert.equal(reg.options.authenticatorSelection.userVerification, "required");
  const credId = `cred-${RUN}`;
  const verifyReg = async (o) => { assert.equal(o.expectedRPID, "inayanetwork.com"); assert.equal(o.requireUserVerification, true); return { verified: true, registrationInfo: { credential: { id: credId, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] }, credentialDeviceType: "multiDevice", credentialBackedUp: true } }; };
  const pk = await PK.finishRegistration({ email, requestToken: reg.requestToken, response: { id: credId, response: {} }, name: "Laptop", verify: verifyReg });
  assert.equal(pk.name, "Laptop");
  await assert.rejects(PK.finishRegistration({ email, requestToken: reg.requestToken, response: {}, verify: verifyReg }), /no longer valid/);
  assert.equal((await PK.listPasskeys(email)).length, 1);

  const login = await PK.startLogin({ rpOverride: RP });
  const verifyAuth = async (o) => { assert.equal(o.credential.id, credId); assert.deepEqual([...o.credential.publicKey], [1, 2, 3]); return { verified: true, authenticationInfo: { newCounter: 7 } }; };
  const out = await PK.finishLogin({ requestToken: login.requestToken, response: { id: credId }, verify: verifyAuth });
  assert.equal(out.email, email);
  const doc = await (await db()).collection("member_mfa").findOne({ _id: email });
  assert.equal(doc.passkeys[0].counter, 7); assert.ok(doc.passkeys[0].lastUsedAt);

  const bad = await PK.startLogin({ rpOverride: RP });
  await assert.rejects(PK.finishLogin({ requestToken: bad.requestToken, response: { id: credId }, verify: async () => { throw new Error("counter went backwards"); } }), /could not be verified/);
  const other = await PK.startLogin({ rpOverride: { rpID: "files.acme.test", origin: "https://files.acme.test" } });
  await assert.rejects(PK.finishLogin({ requestToken: other.requestToken, response: { id: credId }, verify: verifyAuth }), /not registered/);
  await PK.removePasskey({ email, id: credId }); assert.equal((await PK.listPasskeys(email)).length, 0);
});

// ------------------------------------------------------------------------------------------------ staff SSO
test("validateSsoInput", () => {
  assert.match(W.validateSsoInput({ enabled: true }).errors.join(" "), /issuer, the client ID and at least one email domain/);
  assert.match(W.validateSsoInput({ issuer: "http://x.test" }).errors.join(" "), /https/);
  assert.match(W.validateSsoInput({ domains: ["gmail.com"] }).errors.join(" "), /Public email domains/);
  assert.match(W.validateSsoInput({ enforce: true }).errors.join(" "), /must be on/);
  assert.deepEqual(W.validateSsoInput({ domains: ["@Acme.test", "acme.test"] }).value.domains, ["acme.test"]);
});

test("SSO: Enterprise only; enforce blocks email links; sign-in needs membership and activates invitations", async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY ??= "a".repeat(64);
  const domain = `sso-${RUN}.test`;
  const biz = await mkOrg("business");
  await assert.rejects(W.setWorkforceSso({ orgId: biz, membership: owner, actorEmail: "o@x.test", input: {} }), /Enterprise/);
  const ent = await mkOrg("enterprise", { name: `SSO Co ${RUN}` });
  const probe = async () => ({ issuer: "https://idp.test" });
  const cfg = await W.setWorkforceSso({ orgId: ent, membership: owner, actorEmail: "o@x.test", probe, input: { issuer: "https://idp.test", clientId: "cid", clientSecret: "s3cret", domains: [domain], enabled: true, enforce: true } });
  assert.equal(cfg.enabled, true); assert.equal(cfg.clientSecretSet, true); assert.equal(cfg.clientSecret, undefined);
  const other = await mkOrg("enterprise");
  await assert.rejects(W.setWorkforceSso({ orgId: other, membership: owner, actorEmail: "o@x.test", probe, input: { issuer: "https://idp.test", clientId: "c", clientSecret: "s", domains: [domain], enabled: true } }), /another company/);

  const staff = `amna@${domain}`; const invited = `bilal@${domain}`; const stranger = `zara@${domain}`;
  await mkMember(ent, staff); await mkMember(ent, invited, "invited"); emails.push(stranger);
  assert.match(await W.ssoRequiredFor(staff), /requires single sign-on/);
  assert.equal(await W.ssoRequiredFor(`x@not-${RUN}.test`), null);

  async function state(email) { // what startWorkforceSso stores, without calling a real provider
    const { generateToken, hashToken } = await import("../src/lib/orgs.js"); const s = generateToken();
    await (await db()).collection("mfa_pending").insertOne({ tokenHash: hashToken(s), purpose: "workforce-sso", orgId: new ObjectId(ent), email, nonce: "n", verifier: "v", returnTo: "/business", usedAt: null, expiresAt: new Date(Date.now() + 60000).toISOString() });
    return s;
  }
  const ok = await W.finishWorkforceSso({ code: "c", state: await state(staff), exchange: async () => ({ email: staff, email_verified: true }) });
  assert.equal(ok.email, staff);
  const st = await state(invited);
  await W.finishWorkforceSso({ code: "c", state: st, exchange: async () => ({ email: invited, email_verified: true }) });
  assert.equal((await (await db()).collection("org_members").findOne({ email: invited })).status, "active");
  await assert.rejects(W.finishWorkforceSso({ code: "c", state: st, exchange: async () => ({ email: invited }) }), /expired or was already used/);
  await assert.rejects(W.finishWorkforceSso({ code: "c", state: await state(stranger), exchange: async () => ({ email: stranger, email_verified: true }) }), /not a member/);
  await assert.rejects(W.finishWorkforceSso({ code: "c", state: await state(staff), exchange: async () => ({ email: `amna@elsewhere-${RUN}.test`, email_verified: true }) }), /not covered/);
  await assert.rejects(W.finishWorkforceSso({ code: "c", state: await state(staff), exchange: async () => ({ email: staff, email_verified: false }) }), /not verified/);
  await assert.rejects(W.finishWorkforceSso({ code: "c", state: await state(staff), exchange: async () => { throw new Error("bad signature"); } }), /could not verify/);
  // downgraded below Enterprise: SSO stops covering the domain
  await (await db()).collection("orgs").updateOne({ _id: new ObjectId(ent) }, { $set: { plan: "business" } });
  assert.equal(await W.ssoRequiredFor(staff), null);
});

// ------------------------------------------------------------------------------------------------ custom domain
test("custom domain: package gate, hosting attach states, public lookup", async () => {
  const pro = await mkOrg("professional");
  await assert.rejects(setCustomDomain({ orgId: pro, membership: owner, actorEmail: "o@x.test", domain: `files.pro-${RUN}.test` }), /Business and Enterprise/);
  assert.equal((await attachDomainToHosting("a.test", () => null)).routing, "NOT_CONFIGURED");
  const fake = (verified, addOk = true) => (path) => Promise.resolve(path.startsWith("/v10") ? { ok: addOk, json: async () => (addOk ? {} : { error: { code: "forbidden", message: "nope" } }) } : { ok: true, json: async () => ({ verified }) });
  assert.equal((await attachDomainToHosting("a.test", fake(false))).routing, "ATTACHED");
  assert.equal((await attachDomainToHosting("a.test", fake(true))).routing, "LIVE");
  assert.equal((await attachDomainToHosting("a.test", fake(false, false))).routing, "ATTACH_FAILED");

  const biz = await mkOrg("business"); const host = `files.biz-${RUN}.test`;
  const cd = await setCustomDomain({ orgId: biz, membership: owner, actorEmail: "o@x.test", domain: host });
  assert.equal(cd.cnameTarget, "cname.vercel-dns.com");
  assert.equal(await workspaceForHost(host), null, "not before ownership is proven");
  const next = await verifyCustomDomain({ orgId: biz, membership: owner, actorEmail: "o@x.test", resolver: async () => [[cd.txtValue]], attach: async () => ({ routing: "LIVE", note: "Live." }) });
  assert.equal(next.status, "VERIFIED_DNS"); assert.equal(next.routing, "LIVE"); assert.ok(next.liveAt);
  const w = await workspaceForHost(host.toUpperCase() + ":443");
  assert.equal(w.orgId, biz);
  await (await db()).collection("orgs").updateOne({ _id: new ObjectId(biz) }, { $set: { plan: "professional" } });
  assert.equal(await workspaceForHost(host), null, "off again below Business");
});

// ------------------------------------------------------------------------------------------------ priority support
test("support tiers from the package, only on Inaya's own desk; Enterprise priority raised", async () => {
  assert.equal(tierForOrgs([{ plan: "starter" }, { plan: "business" }]), "PRIORITY");
  assert.equal(tierForOrgs([{ plan: "enterprise" }]), "ENTERPRISE");
  assert.equal(tierForOrgs([{ noPlanConfirmedAt: "x" }]), "STANDARD");
  assert.equal(tierForOrgs([{}]), null);
  assert.equal(computePriority({ type: "Other", tier: "ENTERPRISE" }).priority, "HIGH");
  const ent = await mkOrg("enterprise"); const email = `tier-${RUN}@plancap.test`; await mkMember(ent, email);
  const desk = new ObjectId().toString();
  assert.equal(await packageTier(desk, email, { INAYA_SUPPORT_ORG_ID: desk }), "ENTERPRISE");
  assert.equal(await packageTier(new ObjectId().toString(), email, { INAYA_SUPPORT_ORG_ID: desk }), null, "other companies' desks are untouched");
  assert.deepEqual(await requestEnterpriseOnboarding({ orgId: ent, planId: "business" }), { skipped: true });
});

// ------------------------------------------------------------------------------------------------ Professional add-ons
test("add-ons: catalogue, validation, prices, upgrade hint", async () => {
  const { cleanAddOns, addOnsPrice, describeAddOns, upgradeHint, ADD_ONS } = await import("../src/lib/addOns.js");
  assert.equal(ADD_ONS.storageTB.usd, 30); assert.equal(ADD_ONS.connect.usd, 35); assert.equal(ADD_ONS.storageTB.pkr, 7500); assert.equal(ADD_ONS.connect.pkr, 6000);
  assert.deepEqual(cleanAddOns({ connect: true, storageTB: 2, junk: true }, "professional").addOns, { connect: true, storageTB: 2 });
  assert.match(cleanAddOns({ connect: true }, "business").error, /already includes/);
  assert.match(cleanAddOns({ connect: true }, "starter").error, /choose Professional/);
  assert.deepEqual(cleanAddOns({}, "starter").addOns, {});
  assert.match(cleanAddOns({ storageTB: 5 }, "professional").error, /0 to 4 TB/);
  assert.equal(addOnsPrice({ connect: true, storageTB: 2 }), 95);
  assert.equal(addOnsPrice({ connect: true, storageTB: 2 }, { interval: "year" }), 950);
  assert.equal(addOnsPrice({ appointments: true, customDomain: true }, { currency: "PKR" }), 5000);
  assert.equal(describeAddOns({ connect: true, storageTB: 1 }), "Inaya Connect (WhatsApp Business & AI), 1 TB extra storage");
  assert.equal(upgradeHint({ customDomain: true }), null);
  assert.match(upgradeHint({ storageTB: 2 }), /Business is \$99 and includes all of them/);
  assert.match(upgradeHint({ connect: true, appointments: true }), /For \$10 more/);
});

test("add-ons: they unlock features and storage only on Professional", async () => {
  const { getOrgPlan } = await import("../src/lib/orgPlans.js");
  const { entitledFromOrg } = await import("../src/lib/connect/core.js");
  const { engagementAccess } = await import("../src/lib/engagement/store.js");
  const pro = { plan: "professional", addOns: { customDomain: true, apiAccess: true, storageTB: 2 } };
  assert.equal(planAllows(pro, "customDomain"), true); assert.equal(planAllows(pro, "apiAccess"), true);
  assert.equal(planAllows(pro, "clientPortal"), false); assert.equal(planAllows(pro, "adminDashboard"), false, "Business-defining features are never add-ons");
  assert.equal(planAllows({ plan: "starter", addOns: { customDomain: true } }, "customDomain"), false);
  assert.equal(getOrgPlan(pro).maxStorageGB, 3000);
  assert.equal(getOrgPlan({ plan: "business", addOns: { storageTB: 4 } }).maxStorageGB, 5000);
  assert.equal(entitledFromOrg({ plan: "professional", addOns: { connect: true } }, { FEATURE_INAYA_CONNECT: "on" }), true);
  assert.equal(entitledFromOrg({ plan: "professional" }, { FEATURE_INAYA_CONNECT: "on" }), false);
  const withAppt = await mkOrg("professional", { addOns: { appointments: true } });
  assert.equal(await engagementAccess(withAppt, "appointments"), null);
  assert.equal((await engagementAccess(withAppt, "campaigns")).status, 402);
});

test("add-ons: requested with the package, charged, and applied on activation", async () => {
  const { requestUsdPlan, requestPkPlan, activatePkRequest } = await import("../src/lib/billingRequests.js");
  const usdOrg = await mkOrg(null, { plan: null });
  const r = await requestUsdPlan({ orgId: usdOrg, planId: "professional", addOns: { connect: true, storageTB: 1 }, actorEmail: `a-${RUN}@plancap.test`, membership: owner, contact: { name: "A", phone: "+92 300 0000000" } });
  assert.equal(r.request.amountUsd, 39 + 35 + 30);
  const bad = await requestUsdPlan({ orgId: usdOrg, planId: "business", addOns: { connect: true }, actorEmail: "a@x.test", membership: owner });
  assert.equal(bad.status, 400);
  const pkOrg = await mkOrg(null, { plan: null });
  const p = await requestPkPlan({ orgId: pkOrg, planId: "professional", addOns: { appointments: true }, actorEmail: `b-${RUN}@plancap.test`, membership: owner });
  assert.equal(p.request.amountPkr, 20000 + 3000);
  const d = await db();
  const reqDoc = await d.collection("billing_requests").findOne({ orgId: new ObjectId(usdOrg), status: "pending" });
  const act = await activatePkRequest({ requestId: String(reqDoc._id), months: 1, paymentReference: `t-${RUN}`, adminLabel: "test" });
  assert.equal(act.activated, true, JSON.stringify(act));
  const org = await d.collection("orgs").findOne({ _id: new ObjectId(usdOrg) });
  assert.deepEqual(org.addOns, { connect: true, storageTB: 1 });
  assert.equal(org.plan, "professional");
  await d.collection("billing_requests").deleteMany({ orgId: { $in: [new ObjectId(usdOrg), new ObjectId(pkOrg)] } });
  await d.collection("org_subscriptions").deleteMany({ orgId: { $in: [new ObjectId(usdOrg), new ObjectId(pkOrg)] } });
});

// ------------------------------------------------------------------------------------------------ SAML, return address, app handoff
test("SSO comes back to the address it started from; SAML config is validated and its sign-in admits only members", async () => {
  const { allowedOrigin, validateSsoInput, setWorkforceSso, startWorkforceSso, finishWorkforceSaml, pemOf } = await import("../src/lib/workforceSso.js");
  assert.equal(await allowedOrigin("https://www.inayanetwork.com"), "https://www.inayanetwork.com");
  assert.equal(await allowedOrigin("https://inayanetwork.com"), "https://inayanetwork.com");
  assert.equal(await allowedOrigin("https://files.acme.test", { isWorkspaceHost: async () => true }), "https://files.acme.test");
  assert.notEqual(await allowedOrigin("https://evil.test", { isWorkspaceHost: async () => false }), "https://evil.test");
  assert.match(validateSsoInput({ protocol: "saml", enabled: true, domains: ["x.test"] }).errors.join(" "), /SAML sign-in URL/);
  assert.match(validateSsoInput({ protocol: "saml", samlIdpCert: "not a cert" }).errors.join(" "), /could not be read/);

  // a real self-signed certificate, generated for the test
  const { execFileSync } = await import("node:child_process"); const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saml-")); let certPem;
  try { execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", "/CN=idp.test"], { stdio: "ignore" }); certPem = fs.readFileSync(path.join(dir, "c.pem"), "utf8"); }
  catch { certPem = null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  if (!certPem) return; // openssl not available on this machine: the pure checks above still ran
  const bare = certPem.replace(/-----[A-Z ]+-----|\s/g, "");
  assert.equal(pemOf(bare).trim(), pemOf(certPem).trim(), "a bare Base64 certificate is accepted");

  const domain = `saml-${RUN}.test`; const ent = await mkOrg("enterprise", { name: `SAML Co ${RUN}` });
  const cfg = await setWorkforceSso({ orgId: ent, membership: owner, actorEmail: "o@x.test", input: { protocol: "saml", samlEntryPoint: "https://idp.test/saml2", samlIdpCert: bare, domains: [domain], enabled: true } });
  assert.equal(cfg.protocol, "saml"); assert.ok(cfg.samlCert?.fingerprint256); assert.ok(cfg.saml.acsUrls.some((u) => u.startsWith("https://inayanetwork.com")));
  const staff = `amna@${domain}`; await mkMember(ent, staff);
  const { url } = await startWorkforceSso({ email: staff, origin: "https://inayanetwork.com" });
  assert.match(url, /^https:\/\/idp\.test\/saml2\?SAMLRequest=/); const relay = new URL(url).searchParams.get("RelayState"); assert.ok(relay);
  const out = await finishWorkforceSaml({ samlResponse: "x", relayState: relay, validate: async () => ({ nameID: staff }) });
  assert.equal(out.email, staff); assert.equal(out.base, "https://inayanetwork.com", "back to where it started");
  await assert.rejects(finishWorkforceSaml({ samlResponse: "x", relayState: relay, validate: async () => ({ nameID: staff }) }), /expired or was already used/);
  const r2 = new URL((await startWorkforceSso({ email: staff })).url).searchParams.get("RelayState");
  await assert.rejects(finishWorkforceSaml({ samlResponse: "x", relayState: r2, validate: async () => { throw new Error("Invalid signature"); } }), /could not verify/);
  const r3 = new URL((await startWorkforceSso({ email: staff })).url).searchParams.get("RelayState");
  await assert.rejects(finishWorkforceSaml({ samlResponse: "x", relayState: r3, validate: async () => ({ nameID: `zara@${domain}` }) }), /not a member/);
  await (await db()).collection("mfa_pending").deleteMany({ purpose: { $in: ["workforce-sso", "saml-request"] }, orgId: new ObjectId(ent) });
});

test("app handoff: fresh sign-in only, single use, needs the app's verifier", async () => {
  const { createHandoff, exchangeHandoff, challengeFor } = await import("../src/lib/appHandoff.js");
  const email = `app-${RUN}@plancap.test`; emails.push(email);
  const verifier = "v".repeat(20) + RUN + "w".repeat(20); const challenge = challengeFor(verifier);
  await assert.rejects(createHandoff({ email, challenge, sessionCreatedAt: new Date(Date.now() - 11 * 60000).toISOString() }), /sign in again/);
  await assert.rejects(createHandoff({ email, challenge: "short", sessionCreatedAt: new Date().toISOString() }), /not valid/);
  const { code } = await createHandoff({ email, challenge, sessionCreatedAt: new Date().toISOString() });
  await assert.rejects(exchangeHandoff({ code, verifier: "x".repeat(43) }), /different request/);
  const { code: code2 } = await createHandoff({ email, challenge, sessionCreatedAt: new Date().toISOString() });
  const ok = await exchangeHandoff({ code: code2, verifier });
  assert.equal(ok.email, email); assert.equal(ok.sessionToken.length, 64);
  await assert.rejects(exchangeHandoff({ code: code2, verifier }), /already used/);
  const d = await db(); await d.collection("sessions").deleteMany({ email }); await d.collection("mfa_pending").deleteMany({ email, purpose: "app-handoff" });
});
