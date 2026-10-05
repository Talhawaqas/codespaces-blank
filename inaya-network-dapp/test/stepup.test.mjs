// test/stepup.test.mjs -- DLP-002 step-up authentication: a REQUIRE_STRONGER_AUTH rule refuses until the person confirms a fresh authenticator code, then lets the
// action through for a short window; wrong codes are limited, a used code cannot be replayed, and someone without an authenticator is never waved through. Real MongoDB.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/stepup.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TOTP, Secret } from "otpauth";
import { NextRequest } from "next/server";
import { setup, teardown, makeChatOrg, cookieFor } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import * as MFA from "../src/lib/mfa.js";
import * as P from "../src/lib/governance/policies.js";
import * as D from "../src/lib/governance/dlp.js";
import * as S from "../src/lib/stepup.js";
import * as route from "../src/app/api/orgs/step-up/route.js";

const T = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
let org, owner, member, secret, db;
const gen = (at) => new TOTP({ issuer: "Inaya Network", label: member.email, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: at });
before(async () => { await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("stp", { people: ["member", "plain"] }); owner = org.owner; member = org.member; });
after(async () => { await db.collection("member_mfa").deleteMany({ _id: { $in: [member.email, org.plain.email] } }); await db.collection("step_ups").deleteMany({ email: { $in: [member.email, org.plain.email] } }); await db.collection("governance_policies").deleteMany({ orgId: org.orgId }).catch(() => {}); await teardown(); });

test("without an authenticator app the person cannot step up (and is told to set one up); with one, a right code opens a window that closes on its own", T, async () => {
  assert.equal((await code(S.grantStepUp({ email: org.plain.email, code: "123456" }))).code, "MFA_NOT_ENROLLED");
  const en = await MFA.enrollTotp(member.email); secret = en.secret; assert.equal((await code(S.grantStepUp({ email: member.email, code: gen(Date.now()) }))).code, "MFA_NOT_ENROLLED", "an unconfirmed enrollment does not count");
  await MFA.confirmTotp(member.email, gen(Date.now()));
  const t0 = Date.now() + 40_000; const r = await S.grantStepUp({ email: member.email, code: gen(t0), now: t0 }); assert.equal(r.ok, true); assert.equal(await S.hasStepUp(member.email, t0 + 60_000), true);
  assert.equal(await S.hasStepUp(member.email, t0 + (S.STEP_UP_MINUTES + 1) * 60_000), false, "the window expires by itself"); assert.equal(await S.hasStepUp(org.plain.email), false);
});

test("a used code cannot be replayed, wrong codes are counted and lock step-up out, and junk input is just a wrong code", T, async () => {
  const t1 = Date.now() + 5 * 60_000; await S.grantStepUp({ email: member.email, code: gen(t1), now: t1 });
  assert.equal((await code(S.grantStepUp({ email: member.email, code: gen(t1), now: t1 + 1000 }))).code, "CODE_REUSED", "the same code in the same step is refused");
  const t2 = Date.now() + 20 * 60_000; for (let i = 0; i < S.MAX_FAILURES - 1; i++) assert.equal((await code(S.grantStepUp({ email: member.email, code: i ? "abcdef" : "000000", now: t2 + i }))).code, "BAD_CODE");
  assert.equal((await code(S.grantStepUp({ email: member.email, code: "111111", now: t2 + 50 }))).message.includes("Too many"), true, "the fifth wrong code locks it");
  assert.equal((await code(S.grantStepUp({ email: member.email, code: gen(t2 + 100), now: t2 + 100 }))).code, "STEP_UP_LOCKED", "even a right code is refused while locked");
  const t3 = t2 + (S.LOCKOUT_MINUTES + 1) * 60_000; assert.equal((await S.grantStepUp({ email: member.email, code: gen(t3), now: t3 })).ok, true, "the lock ends");
});

test("a REQUIRE_STRONGER_AUTH data-loss rule refuses, then allows (and records it) once the person has stepped up; the HTTP route works and refuses outsiders", T, async () => {
  const p = await P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type: "dlp", name: "t-stepup", config: { rules: [{ id: "r-auth", name: "Admin API needs step-up", action: "REQUIRE_STRONGER_AUTH", when: { actions: ["api_access"], roles: ["member"] } }] }, precedence: 1 });
  await P.publishPolicy({ orgId: org.oid, policyId: p.policyId, actorEmail: owner.email, membership: owner.membership });
  const E = (email) => D.enforceDlp({ orgId: org.oid, ctx: { email, role: "member", action: "api_access" } });
  await db.collection("step_ups").deleteMany({ email: member.email }); const refused = await E(member.email); assert.equal(refused.allowed, false); assert.equal(refused.code, "STRONGER_AUTH_REQUIRED"); assert.match(refused.message, /step-up/);
  const now = Date.now(); await S.grantStepUp({ email: member.email, code: gen(now + 3_600_000), now: now + 3_600_000 }); await db.collection("step_ups").updateOne({ email: member.email }, { $set: { until: Date.now() + 300_000 } });
  const ok = await E(member.email); assert.equal(ok.allowed, true); assert.ok(ok.eventId, "the allowed action is recorded");
  assert.equal((await E(org.plain.email)).allowed, false, "someone who has not stepped up is still refused");
  const cookie = await cookieFor(owner.email); const call = (c, body) => route.POST(new NextRequest("http://localhost:3000/api/orgs/step-up", { method: "POST", headers: { cookie: c ? `inaya_org_session=${c}` : "", "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await call(null, { orgId: org.oid, code: "123456" })).status, 401); assert.equal((await call(cookie, { code: "123456" })).status, 400); const r = await call(cookie, { orgId: org.oid, code: "123456" }); assert.equal(r.status, 409, "the owner has no authenticator, so the route says so rather than allowing"); assert.equal((await r.json()).code, "MFA_NOT_ENROLLED");
});
