// test/sharing-policy.test.mjs -- the pure rules of Secure Sharing 2.0 (no database): CIDR matching, option validation, password
// hashing, access decisions and their order. Run: node --test --test-force-exit test/sharing-policy.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIp, parseIp, parseCidr, ipInCidr, ipMatchesAny, isValidCidr } from "../src/lib/net/cidr.js";
import { validateLinkOptions, hashPassword, verifyPassword, shareStatus, evaluateShareAccess, watermarkText, publicShareView } from "../src/lib/sharing/policy.js";

test("CIDR: IPv4 ranges, host routes, boundaries", () => {
  assert.equal(ipInCidr("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(ipInCidr("11.0.0.1", "10.0.0.0/8"), false);
  assert.equal(ipInCidr("192.168.1.255", "192.168.1.0/24"), true);
  assert.equal(ipInCidr("192.168.2.0", "192.168.1.0/24"), false);
  assert.equal(ipInCidr("203.0.113.7", "203.0.113.7"), true, "a bare address is a host route");
  assert.equal(ipInCidr("203.0.113.8", "203.0.113.7"), false);
  assert.equal(ipInCidr("1.2.3.4", "0.0.0.0/0"), true);
  assert.equal(ipInCidr("1.2.3.4", "1.2.3.4/32"), true);
});

test("CIDR: IPv6, mapped IPv4, zones and brackets", () => {
  assert.equal(ipInCidr("2001:db8::1", "2001:db8::/32"), true);
  assert.equal(ipInCidr("2001:db9::1", "2001:db8::/32"), false);
  assert.equal(ipInCidr("::1", "::1/128"), true);
  assert.equal(ipInCidr("fe80::1%eth0", "fe80::/10"), true);
  assert.equal(normalizeIp("::ffff:10.0.0.5"), "10.0.0.5");
  assert.equal(ipInCidr("::ffff:10.0.0.5", "10.0.0.0/8"), true, "an IPv4-mapped address matches the IPv4 range");
  assert.equal(ipInCidr("[2001:db8::1]", "2001:db8::/32"), true);
  assert.equal(ipInCidr("2001:db8::1", "10.0.0.0/8"), false, "families never cross-match");
  assert.deepEqual(parseIp("::ffff:1.2.3.4"), parseIp("1.2.3.4"));
});

test("CIDR: malformed input fails closed", () => {
  for (const bad of ["", "abc", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.4/33", "1.2.3.4/-1", "1.2.3.4/8/8", "2001:db8::/129", ":::", "1:2:3:4:5:6:7:8:9"]) {
    assert.equal(parseCidr(bad), null, `"${bad}" must not parse`);
    assert.equal(ipInCidr("1.2.3.4", bad), false);
  }
  assert.equal(ipInCidr("not an ip", "10.0.0.0/8"), false);
  assert.equal(ipInCidr(undefined, "10.0.0.0/8"), false);
  assert.equal(isValidCidr("10.0.0.0/8"), true);
  assert.equal(ipMatchesAny("10.0.0.9", ["192.168.0.0/16", "10.0.0.0/24"]), true);
  assert.equal(ipMatchesAny("10.0.1.9", ["192.168.0.0/16", "10.0.0.0/24"]), false);
  assert.equal(ipMatchesAny("10.0.0.9", []), false);
});

test("options: defaults, oneTime, limits and every rejection", () => {
  const ok = validateLinkOptions({}); assert.equal(ok.value.permission, "download"); assert.deepEqual(ok.value.ipAllow, []);
  const one = validateLinkOptions({ oneTime: true }).value; assert.equal(one.maxUses, 1); assert.equal(one.maxDownloads, 1);
  const oneView = validateLinkOptions({ oneTime: true, permission: "view" }).value; assert.equal(oneView.maxUses, 1); assert.equal(oneView.maxDownloads, null);
  assert.ok(validateLinkOptions({ permission: "edit" }).errors, "edit is not a link permission");
  assert.ok(validateLinkOptions({ permission: "view", maxDownloads: 3 }).errors, "view-only has no downloads");
  assert.ok(validateLinkOptions({ maxUses: 0 }).errors); assert.ok(validateLinkOptions({ maxUses: 1.5 }).errors); assert.ok(validateLinkOptions({ maxUses: 10 ** 9 }).errors);
  assert.ok(validateLinkOptions({ password: "short" }).errors); assert.ok(validateLinkOptions({ password: "x".repeat(200) }).errors);
  assert.ok(validateLinkOptions({ ipAllow: ["nope"] }).errors); assert.ok(validateLinkOptions({ ipAllow: Array(21).fill("10.0.0.0/8") }).errors);
  assert.ok(validateLinkOptions({ domainAllow: ["not a domain"] }).errors);
  assert.deepEqual(validateLinkOptions({ domainAllow: ["@Example.COM", "example.com"] }).value.domainAllow, ["example.com"]);
  assert.ok(validateLinkOptions({ deviceBinding: "always" }).errors);
  assert.ok(validateLinkOptions({ managerEmails: ["bad"] }).errors);
  assert.equal(validateLinkOptions({ label: "a<b>c\u0000d" }).value.label, "abcd", "control characters and angle brackets are stripped");
});

test("passwords: scrypt with a fresh salt each time, constant-time verify, wrong and malformed", async () => {
  const a = await hashPassword("correct horse battery"); const b = await hashPassword("correct horse battery");
  assert.notEqual(a, b, "a new salt every time"); assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("", a), false);
  for (const junk of ["", "scrypt$x", "md5$a$b", null, undefined, "scrypt$16384$8$1$AAAA$BBBB"]) assert.equal(await verifyPassword("x", junk), false);
  assert.equal(a.includes("correct"), false);
});

const base = (o = {}) => ({ _id: "s1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), useCount: 0, maxUses: null, downloadCount: 0, maxDownloads: null, revokedAt: null, ...o });

test("status: active, revoked, expired, exhausted by uses and by downloads", () => {
  const now = Date.now();
  assert.equal(shareStatus(base(), now), "active");
  assert.equal(shareStatus(base({ revokedAt: new Date().toISOString() }), now), "revoked");
  assert.equal(shareStatus(base({ expiresAt: new Date(now - 1).toISOString() }), now), "expired");
  assert.equal(shareStatus(base({ expiresAt: new Date(now).toISOString() }), now), "expired", "the expiry instant itself is expired");
  assert.equal(shareStatus(base({ maxUses: 2, useCount: 2 }), now), "exhausted");
  assert.equal(shareStatus(base({ maxDownloads: 1, downloadCount: 1 }), now), "exhausted");
  assert.equal(shareStatus(base({ maxUses: 2, useCount: 1 }), now), "active");
});

test("access order: dead links first, then lockout, then one generic 403, then what the visitor must provide", async () => {
  const ctx = { ip: "10.0.0.5" };
  assert.equal(evaluateShareAccess(base({ revokedAt: "x", passwordHash: "h", ipAllow: ["1.1.1.1"] }), ctx).status, 410, "revoked beats everything");
  assert.equal(evaluateShareAccess(base({ lockedUntil: new Date(Date.now() + 60000).toISOString(), passwordHash: "h" }), ctx).status, 429);
  // location/device failures all look the same and do not say which rule failed
  const ipFail = evaluateShareAccess(base({ ipAllow: ["192.168.0.0/16"] }), ctx);
  const devFail = evaluateShareAccess(base({ deviceBinding: "first-use", boundDeviceId: "A" }), { ...ctx, deviceId: "B" });
  assert.equal(ipFail.status, 403); assert.equal(devFail.status, 403); assert.equal(ipFail.error, devFail.error);
  assert.equal(evaluateShareAccess(base({ ipAllow: ["10.0.0.0/8"] }), ctx).allow, true);
  assert.equal(evaluateShareAccess(base({ deviceBinding: "first-use" }), ctx).allow, true, "the first device binds");
  assert.equal(evaluateShareAccess(base({ deviceBinding: "first-use", boundDeviceId: "A" }), { ...ctx, deviceId: "A" }).allow, true);
  // a wrong location is reported before the password prompt, so the prompt never leaks that the location was fine
  assert.equal(evaluateShareAccess(base({ ipAllow: ["192.168.0.0/16"], passwordHash: "h" }), ctx).status, 403);
  const needPw = evaluateShareAccess(base({ passwordHash: "h" }), ctx); assert.equal(needPw.status, 401); assert.equal(needPw.needs, "password");
  const wrong = evaluateShareAccess(base({ passwordHash: "h" }), { ...ctx, passwordChecked: false }); assert.equal(wrong.wrongPassword, true);
  assert.equal(evaluateShareAccess(base({ passwordHash: "h" }), { ...ctx, passwordChecked: true }).allow, true);
});

test("domain rule: email required, wrong domain refused, code required", () => {
  const s = base({ domainAllow: ["acme.com"] });
  assert.equal(evaluateShareAccess(s, {}).needs, "email");
  assert.equal(evaluateShareAccess(s, { email: "x@evil.com", emailVerified: true }).status, 403);
  assert.equal(evaluateShareAccess(s, { email: "x@acme.com.evil.com", emailVerified: true }).status, 403, "suffix tricks do not match");
  assert.equal(evaluateShareAccess(s, { email: "x@acme.com" }).needs, "code");
  assert.equal(evaluateShareAccess(s, { email: "X@ACME.com", emailVerified: true }).allow, true, "case does not matter");
  assert.equal(evaluateShareAccess(s, { email: "nodomain", emailVerified: true }).status, 403);
});

test("watermark text and the public view never carry secrets", async () => {
  const w = watermarkText({ email: "a@b.com", ip: "1.2.3.4", now: Date.UTC(2026, 9, 5, 8, 30), label: "Q3 deck" });
  assert.equal(w, "Q3 deck | a@b.com | 1.2.3.4 | 2026-10-05 08:30 UTC");
  assert.ok(watermarkText({ email: "x".repeat(500) }).length <= 160);
  const v = publicShareView({ _id: "s1", createdByEmail: "o@x.com", createdAt: "t", expiresAt: new Date(Date.now() + 1000).toISOString(), tokenHash: "SECRET", passwordHash: "SECRETPW", ipAllow: ["10.0.0.0/8"] });
  assert.equal(JSON.stringify(v).includes("SECRET"), false, "token hash and password hash never leave the server");
  assert.equal(v.passwordProtected, true); assert.equal(v.ipRestricted, true); assert.equal(v.status, "active");
});
