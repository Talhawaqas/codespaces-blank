// test/tenant-isolation-scan.test.mjs -- automated tenant-isolation scanner for every route group added by the Competitive Expansion SOW (TENANT-001).
// It reads the route sources and fails when a route could act on an organization without establishing who the caller is and which organization that caller may act in:
//   1. every route in a new group authenticates (directly, or through its group's wrapper), unless it is on the explicit public-by-design list, which must authenticate by token, slug or signature instead;
//   2. no API-key or gateway route takes an organization id from the request (the organization comes from the key or the gateway record);
//   3. cron routes require the cron secret;
//   4. session routes that accept an orgId authenticate it through requireMembership before any other use.
// A static scan cannot prove isolation by itself; the per-feature tests (cross-tenant cases in gateway, portal-requests, office, keys, compliance, sharing and others) do that against a real database.
// Run: node --test test/tenant-isolation-scan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const API = path.resolve(new URL("../src/app/api/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name === "route.js" ? [path.join(dir, d.name)] : []));
const rel = (f) => path.relative(API, f).replace(/\\/g, "/");
const read = (f) => fs.readFileSync(f, "utf8");

// groups added by the SOW
const SESSION_GROUPS = ["orgs/chat", "orgs/notes", "orgs/shares", "orgs/file-requests", "orgs/file-locks", "orgs/file-prefs", "orgs/governance", "orgs/devices", "orgs/security", "orgs/endpoint-backup", "orgs/webhooks", "orgs/admin-dashboard", "orgs/admin-roles", "orgs/branding", "orgs/notify", "orgs/gateway", "orgs/replication", "orgs/office", "orgs/portal-requests", "orgs/compliance", "orgs/features", "orgs/search"];
const PUBLIC_V1 = ["public/v1/shares", "public/v1/file-requests", "public/v1/governance", "public/v1/classification", "public/v1/devices", "public/v1/endpoint-backup", "public/v1/compliance"];
const CRONS = ["cron/org-webhooks", "cron/share-expiry", "cron/ha-gateway", "cron/notes-purge"];
// public by design: the credential is a token in the path, a portal slug with its own session, or a signature. Each is checked for its own marker below.
const TOKEN_ROUTES = [
  { prefix: "orgs/share/", markers: [/peekShare|openShare|readShareContent|recordShareSignal|requestShareCode|shareRoute|publicShareRoute/] },
  { prefix: "public/file-requests/", markers: [/publicInfo|beginUpload|uploadPart|completeUpload|publicRoute|requestRoute/] },
  { prefix: "data-room-access/", markers: [/token|session|magic/i] },
  { prefix: "orgs/data-rooms/", markers: [/requireMembership|requireDataRoom|roomRoute|canManage/] },
  { prefix: "portal/", markers: [/orgBySlug|resolvePortal/] },
  { prefix: "gateway/v1/", markers: [/authenticateGateway|G\.enroll/] },
  { prefix: "office/sessions/", markers: [/Bearer|authorization/i] },
];
const AUTH = /requireMembership|requireApiKey|authenticateGateway|publicRoute|shareRoute|deviceRoute|govRoute|chatRoute|notesRoute|requesterRoute|getSession\(|requireSession|getPortalUser|isAuthorizedCron|identityRoute|withOrg|requireOrgAuth/;
const FROM_REQUEST = /searchParams\.get\(["']orgId["']\)|body\??\.orgId|query\.orgId|\{\s*orgId[^}]*\}\s*=\s*(await\s+)?(req|request)\.json/;

const all = walk(API);
const inGroup = (f, groups) => groups.some((g) => rel(f).startsWith(g + "/") || rel(f) === g + "/route.js");
const wrapperOf = (f) => { let d = path.dirname(f); while (d.startsWith(API) && d !== API) { const w = path.join(d, "_lib.js"); if (fs.existsSync(w)) return read(w); d = path.dirname(d); } return ""; };

test("the scan actually sees the new route groups (it cannot pass by finding nothing)", () => {
  for (const g of [...SESSION_GROUPS, ...PUBLIC_V1, "gateway/v1", ...CRONS]) assert.ok(all.some((f) => rel(f).startsWith(g)), `no routes found for ${g}`);
  assert.ok(all.filter((f) => inGroup(f, SESSION_GROUPS)).length >= 60, "a meaningful number of session routes is scanned");
});

test("every session route in a new group authenticates through requireMembership, a session check or its group's wrapper", () => {
  const bad = []; for (const f of all.filter((f) => inGroup(f, SESSION_GROUPS))) { const src = read(f), lib = wrapperOf(f); if (!AUTH.test(src) && !(AUTH.test(lib) && /import[^;]*\/_lib\.js/.test(src))) bad.push(rel(f)); }
  assert.deepEqual(bad, [], `routes with no authentication: ${bad.join(", ")}`);
});

test("session routes that take an organization id from the request authenticate it before use", () => {
  const bad = []; for (const f of all.filter((f) => inGroup(f, SESSION_GROUPS))) { const src = read(f); if (!FROM_REQUEST.test(src)) continue; const lib = wrapperOf(f); const ok = /requireMembership|requireApiKey/.test(src) || (/requireMembership/.test(lib) && /import[^;]*\/_lib\.js/.test(src)); if (!ok) bad.push(rel(f)); else { const src2 = /requireMembership/.test(src) ? src : lib; const iReq = src2.search(/requireMembership/); const iUse = src2.search(/orgId/); if (iReq < 0 || iUse < 0) bad.push(rel(f) + " (order)"); } }
  assert.deepEqual(bad, [], `routes using a client-supplied orgId without membership: ${bad.join(", ")}`);
});

test("API-key routes never take the organization from the request: it comes from the key", () => {
  const bad = []; for (const f of all.filter((f) => inGroup(f, PUBLIC_V1))) { const src = read(f); if (!/publicRoute/.test(src)) bad.push(rel(f) + " (no publicRoute)"); if (FROM_REQUEST.test(src)) bad.push(rel(f) + " (reads orgId from the request)"); }
  assert.deepEqual(bad, []); const lib = read(path.join(API, "public/v1/_lib.js")); assert.match(lib, /requireApiKey/); assert.equal(FROM_REQUEST.test(lib), false, "the shared wrapper never reads an organization id from the request");
  assert.match(lib, /auth\.orgId/, "the organization used is the one the key resolves to");
});

test("gateway routes: the organization is the gateway's own; only enrollment (a one-time token with proof of the key) is unsigned", () => {
  const f = path.join(API, "gateway/v1/[...path]/route.js"); const src = read(f); assert.equal(FROM_REQUEST.test(src), false, "no organization id from the request");
  const iEnroll = src.indexOf("G.enroll("), iAuth = src.indexOf("G.authenticateGateway("); assert.ok(iEnroll > 0 && iAuth > iEnroll, "enroll comes first and everything after it is authenticated"); const after = src.slice(iAuth); for (const m of ["G.heartbeat", "G.recordInventory", "A.recordAcl", "G.recordAuditEvents", "T.beginTransfer", "T.putPart", "T.completeTransfer", "T.getPart", "T.transferState"]) assert.ok(src.indexOf(m) > iAuth, `${m} runs only after authentication`);
  assert.match(after, /gateway\b/); assert.equal(/body\.(orgId|gatewayId)/.test(src), false, "a gateway cannot name another gateway or organization");
});

test("cron routes require the cron secret", () => {
  for (const g of CRONS) for (const f of all.filter((f) => rel(f).startsWith(g))) assert.match(read(f), /isAuthorizedCron/, rel(f));
});

test("routes that are public by design authenticate by their own credential and are explicitly listed", () => {
  const checked = []; for (const spec of TOKEN_ROUTES) for (const f of all.filter((f) => rel(f).startsWith(spec.prefix))) { const src = read(f), lib = wrapperOf(f); if (!spec.markers.some((m) => m.test(src) || m.test(lib)) && !AUTH.test(src) && !AUTH.test(lib)) assert.fail(`${rel(f)} is public by design but shows no token, slug, session or signature check`); checked.push(rel(f)); }
  assert.ok(checked.length >= 10, `${checked.length} public routes were checked`);
});

test("route sources never log request bodies or tokens", () => {
  const bad = []; for (const f of all.filter((f) => inGroup(f, [...SESSION_GROUPS, ...PUBLIC_V1, "gateway/v1", "office/sessions"]))) { const src = read(f); if (/console\.(log|error|warn)\([^)]*(body|token|password|secret|authorization)/i.test(src.replace(/err\?\.name|err\.message/g, ""))) bad.push(rel(f)); }
  assert.deepEqual(bad, []);
});
