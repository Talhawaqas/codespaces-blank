// SQA tenant-isolation sweep (SOW sections 8, 9, 23). For EVERY route under src/app/api/orgs, every exported method is called
//   1. anonymously                                  -> must never succeed
//   2. as a member of org B, aimed at org A's id    -> must never succeed (client-controlled orgId cannot bypass authorization)
// A route that answers 2xx to either is a broken access control finding unless it is in PUBLIC_BY_DESIGN with a written reason.
// The sweep also reports routes it could not import (so they are not silently untested) and routes that answer 5xx to junk input.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../src/lib/orgs.js";
import clientPromise from "../src/lib/mongodb.js";

const API = path.resolve("src/app/api");
const REPORT = process.env.SQA_REPORT || null;
// routes that legitimately answer an authenticated caller with no org context (or are public entry points). Each needs a reason.
const PUBLIC_BY_DESIGN = new Map([
  ["orgs (GET)", "lists the caller's OWN organizations"],
  ["orgs (POST)", "creates an organization for the caller"],
  ["orgs/billing/plans (GET)", "public, static plan catalog for the marketing pricing page (no organization data)"],
  ["orgs/logout (POST)", "deletes only the caller's own session; anonymous callers have nothing to delete"],
]);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(path.join(API, "orgs")).filter((f) => /route\.js$/.test(f)).sort();

const RUN = randomBytes(3).toString("hex");
let A, B, tokB; const orgIds = [];
async function setup() {
  await ensureOrgIndexes(); const c = await getOrgCollections(); const now = new Date().toISOString();
  const mk = async (label) => {
    const orgId = (await c.orgs.insertOne({ name: `iso-${RUN}-${label}`, createdAt: now })).insertedId; orgIds.push(orgId);
    const email = `iso-${RUN}-${label}-owner@example.com`;
    await c.orgMembers.insertOne({ orgId, email, role: "owner", departmentIds: [], status: "active", createdAt: now });
    return { orgId, email };
  };
  A = await mk("a"); B = await mk("b");
  tokB = (await createSession(B.email)).sessionToken;
}

after(async () => {
  try {
    const { db } = await (await import("../src/lib/mongodb.js")).connectToDatabase();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name);
    for (const n of names) { try { await db.collection(n).deleteMany({ orgId: { $in: orgIds } }); } catch { /* ignore */ } }
    await db.collection("orgs").deleteMany({ _id: { $in: orgIds } });
    await db.collection("sessions").deleteMany({ email: new RegExp(`^iso-${RUN}-`) });
    await db.collection("org_members").deleteMany({ email: new RegExp(`^iso-${RUN}-`) });
  } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

const routeUrl = (f) => {
  let rel = path.relative(API, f).replace(/\\/g, "/").replace(/\/route\.js$/, "");
  const params = {};
  rel = rel.split("/").filter((seg) => !/^\[\[\.\.\..+\]\]$/.test(seg) && !/^\[\.\.\..+\]$/.test(seg)).map((seg) => { const m = seg.match(/^\[(.+)\]$/); if (!m) return seg; params[m[1]] = new ObjectId().toString(); return params[m[1]]; }).join("/");
  return { url: `/api/${rel}`, params };
};

async function call(handler, method, url, params, orgId, token) {
  const u = new URL(`http://localhost${url}`); u.searchParams.set("orgId", String(orgId));
  const init = { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } };
  if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify({ orgId: String(orgId) });
  const req = new NextRequest(u, init);
  const ctx = { params: Object.assign(Promise.resolve(params), params) };
  try { const res = await handler(req, ctx); return res?.status ?? 0; } catch { return 599; }
}

test("no organization route answers a request from outside the organization", { timeout: 1_500_000 }, async () => {
  await setup();
  const violations = []; const unimportable = []; const serverErrors = []; let calls = 0; let routes = 0;
  const CONCURRENCY = 6;
  const queue = [...files];
  async function worker() {
    for (let f = queue.shift(); f; f = queue.shift()) {
      let mod;
      try { mod = await import(pathToFileURL(f).href); } catch (err) { unimportable.push(`${path.relative(API, f)}: ${String(err.message).split("\n")[0].slice(0, 100)}`); continue; }
      const { url, params } = routeUrl(f); routes++;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[method] !== "function") continue;
        const label = `${url.replace(/\/[0-9a-f]{24}/g, "/:id").replace("/api/", "")} (${method})`;
        const anon = await call(mod[method], method, url, params, A.orgId, null); calls++;
        const cross = await call(mod[method], method, url, params, A.orgId, tokB); calls++;
        if (PUBLIC_BY_DESIGN.has(label)) continue;
        if (anon >= 200 && anon < 300) violations.push(`${label}: ANONYMOUS got ${anon}`);
        if (cross >= 200 && cross < 300) violations.push(`${label}: outsider (org B) aimed at org A got ${cross}`);
        if (anon >= 500 || cross >= 500) serverErrors.push(`${label}: anon=${anon} cross=${cross}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const summary = { routesTested: routes, calls, unimportable: unimportable.length, serverErrors: serverErrors.length, violations: violations.length };
  console.log("SWEEP", JSON.stringify(summary));
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ summary, violations, unimportable, serverErrors }, null, 1));
  assert.deepEqual(violations, [], "routes that answered a request from outside the organization");
});
