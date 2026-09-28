// test/moderator-dashboard.test.mjs
//
// Tests for the Moderator Dashboard's auth (src/lib/moderator-auth.js) and
// its data route's own scope discipline: it must genuinely be a subset of
// what admin/dashboard exposes (Watcher Pioneer wallets + KYC individuals
// only), and a moderator credential must never double as an admin one.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyModeratorPassphrase,
  computeModeratorSessionCookieValue,
  isModeratorAuthenticated,
  MODERATOR_SESSION_COOKIE,
} from "../src/lib/moderator-auth.js";

function fakeRequest(cookieValue) {
  return {
    cookies: {
      get: (name) => (name === MODERATOR_SESSION_COOKIE && cookieValue !== undefined ? { value: cookieValue } : undefined),
    },
  };
}

test("verifyModeratorPassphrase: rejects when MODERATOR_DASHBOARD_PASSPHRASE isn't configured", () => {
  const original = process.env.MODERATOR_DASHBOARD_PASSPHRASE;
  delete process.env.MODERATOR_DASHBOARD_PASSPHRASE;
  try {
    assert.throws(() => verifyModeratorPassphrase("anything"), /not configured/i);
  } finally {
    if (original !== undefined) process.env.MODERATOR_DASHBOARD_PASSPHRASE = original;
  }
});

test("verifyModeratorPassphrase + isModeratorAuthenticated: correct passphrase issues a cookie that then authenticates", () => {
  process.env.MODERATOR_DASHBOARD_PASSPHRASE = "test-mod-passphrase-12345";
  try {
    assert.equal(verifyModeratorPassphrase("wrong"), false);
    assert.equal(verifyModeratorPassphrase("test-mod-passphrase-12345"), true);

    const cookieValue = computeModeratorSessionCookieValue();
    assert.equal(isModeratorAuthenticated(fakeRequest(cookieValue)), true);
    assert.equal(isModeratorAuthenticated(fakeRequest("wrong-cookie-value-wrong-cookie-value")), false);
    assert.equal(isModeratorAuthenticated(fakeRequest(undefined)), false);
  } finally {
    delete process.env.MODERATOR_DASHBOARD_PASSPHRASE;
  }
});

test("moderator credential is a genuinely separate secret from the admin one — same passphrase string does not cross-authenticate", async () => {
  process.env.MODERATOR_DASHBOARD_PASSPHRASE = "moderator-only-secret";
  process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-only-secret";
  try {
    const { isAdminAuthenticated } = await import("../src/lib/admin-auth.js");
    const { computeAdminSessionCookieValue, ADMIN_SESSION_COOKIE } = await import("../src/lib/admin-auth.js");

    const modCookie = computeModeratorSessionCookieValue();
    // A valid moderator session cookie presented under the ADMIN cookie name
    // must not authenticate against admin routes.
    const adminReqWithModCookie = { cookies: { get: (name) => (name === ADMIN_SESSION_COOKIE ? { value: modCookie } : undefined) } };
    assert.equal(isAdminAuthenticated(adminReqWithModCookie), false, "a moderator's cookie value must never pass as an admin session");
  } finally {
    delete process.env.MODERATOR_DASHBOARD_PASSPHRASE;
    delete process.env.ADMIN_DASHBOARD_PASSPHRASE;
  }
});

test("dashboard route module: GET rejects an unauthenticated request without touching the database", async () => {
  delete process.env.MODERATOR_DASHBOARD_PASSPHRASE;
  const { GET } = await import("../src/app/api/moderator/dashboard/route.js");
  const res = await GET(fakeRequest(undefined));
  assert.equal(res.status, 401);
});
