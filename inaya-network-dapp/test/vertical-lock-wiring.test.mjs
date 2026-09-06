// test/vertical-lock-wiring.test.mjs
//
// Healthcare & Legal Expansion follow-on ("lock the door", not just hide
// the nav item) — static-source verification that every Health/Legal API
// route actually calls requireVertical() with the SAME orgId expression
// it already authenticated with via requireMembership(). Reads each
// route.js file's source as text rather than importing it, matching this
// repo's own established convention (see rag-security.test.mjs's header
// comment: plain `node --test` has no JSX transform, so importing a
// route.js that transitively touches a JSX file breaks; reading source
// text is "arguably a more direct check anyway").
//
// This is a REAL regression test for a REAL bug caught during this
// implementation: an automated multi-file edit inserted
// `requireVertical(orgId, "healthcare")` into several POST handlers that
// only ever destructured `body.orgId`, never a bare `orgId` -- a
// ReferenceError at runtime on every single POST call to those routes,
// caught only by manually re-scanning the diff, not by any test at the
// time. This test exists so that class of bug can never silently ship
// again.
//
// Run with: node --env-file=.env.local --test test/vertical-lock-wiring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function findRouteFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findRouteFiles(full));
    else if (entry.name === "route.js") results.push(full);
  }
  return results;
}

const HEALTH_ROUTES = findRouteFiles("src/app/api/orgs/health");
const LEGAL_ROUTES = findRouteFiles("src/app/api/orgs/legal");
// Financial Services & Regulated Enterprise SOW, Phase 4. Note:
// src/app/api/regulatory-examiner/[token]/route.js is DELIBERATELY not
// included here — it's the external examiner's own entry point, has no
// requireMembership() call at all (a different auth model entirely, see
// its own header comment), and is naturally skipped by this test's
// `if (!hasMembershipGate) continue` even if it were scanned.
const REGULATED_ROUTES = findRouteFiles("src/app/api/orgs/regulated");
const ALL_ROUTES = [
  ...HEALTH_ROUTES.map((f) => ({ file: f, vertical: "healthcare" })),
  ...LEGAL_ROUTES.map((f) => ({ file: f, vertical: "legal" })),
  ...REGULATED_ROUTES.map((f) => ({ file: f, vertical: "regulated" })),
];

function splitIntoHandlers(source) {
  const parts = source.split(/^export async function (GET|POST|PATCH|DELETE)\(/m);
  const handlers = [];
  for (let i = 1; i < parts.length; i += 2) {
    handlers.push({ name: parts[i], body: parts[i + 1] });
  }
  return handlers;
}

test("sanity: found every expected health/legal/regulated route file (this test isn't silently checking zero files)", () => {
  assert.ok(HEALTH_ROUTES.length >= 9, `expected at least 9 health routes, found ${HEALTH_ROUTES.length}`);
  assert.ok(LEGAL_ROUTES.length >= 16, `expected at least 16 legal routes, found ${LEGAL_ROUTES.length}`);
  assert.ok(REGULATED_ROUTES.length >= 20, `expected at least 20 regulated routes, found ${REGULATED_ROUTES.length}`);
});

for (const { file, vertical } of ALL_ROUTES) {
  test(`vertical lock wiring: ${file}`, () => {
    const source = fs.readFileSync(file, "utf8");
    const handlers = splitIntoHandlers(source);
    assert.ok(handlers.length > 0, `${file}: no GET/POST/PATCH/DELETE handlers found -- splitIntoHandlers regex may need updating`);

    for (const { name, body } of handlers) {
      const hasMembershipGate = /requireMembership\(/.test(body);
      if (!hasMembershipGate) continue; // a handler with no auth gate at all is a different, unrelated problem

      const membershipMatch = body.match(/requireMembership\(\s*req\s*,\s*([^,)]+)/);
      const verticalMatch = body.match(/requireVertical\(\s*([^,]+?)\s*,\s*["'](\w+)["']\s*\)/);

      assert.ok(verticalMatch, `${file} :: ${name} -- calls requireMembership but has NO requireVertical() call at all. This route is NOT locked to a business type.`);

      const [, verticalOrgIdExpr, checkedVertical] = verticalMatch;
      const membershipOrgIdExpr = membershipMatch[1].trim();

      assert.equal(
        verticalOrgIdExpr.trim(),
        membershipOrgIdExpr,
        `${file} :: ${name} -- requireMembership() authenticated against "${membershipOrgIdExpr}" but requireVertical() checked "${verticalOrgIdExpr.trim()}". These MUST be the exact same expression, or the vertical lock either checks the wrong org or references a variable that doesn't exist in scope (the real bug this test guards against).`
      );

      assert.equal(checkedVertical, vertical, `${file} :: ${name} -- checks vertical "${checkedVertical}" but this route lives under the "${vertical}" tree.`);
    }
  });
}
