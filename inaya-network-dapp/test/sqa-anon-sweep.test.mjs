// SQA anonymous sweep (SOW sections 8, 23, 19): every API route OUTSIDE /api/orgs is called with no credentials, for every exported method,
// with an empty JSON body. State-changing methods must never succeed anonymously, and cron/relay routes must refuse a wrong secret.
// Anonymous GETs that succeed are written to the report (SQA_REPORT) so each one can be reviewed by hand.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import clientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

process.env.CRON_SECRET = "sqa-cron-secret"; process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_sqa"; process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_sqa";
const API = path.resolve("src/app/api"); const REPORT = process.env.SQA_REPORT || null;
const norm = (p) => p.replace(/\\/g, "/");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(API).filter((f) => /route\.js$/.test(f) && !norm(path.relative(API, f)).startsWith("orgs/")).sort();
after(async () => { try { const { db } = await connectToDatabase(); await db.collection("rate_limit_hits").deleteMany({ key: "sqa-anon" }); } catch { /* best effort */ } try { await (await clientPromise).close(); } catch { /* ignore */ } });

const routeUrl = (f) => {
  let rel = norm(path.relative(API, f)).replace(/\/route\.js$/, ""); const params = {};
  rel = rel.split("/").filter((s) => !/^\[\[?\.\.\..+\]\]?$/.test(s)).map((s) => { const m = s.match(/^\[(.+)\]$/); if (!m) return s; params[m[1]] = new ObjectId().toString(); return params[m[1]]; }).join("/");
  return { url: `/api/${rel}`, params };
};
async function call(handler, method, url, params, headers = {}) {
  const init = { method, headers: { "content-type": "application/json", "x-forwarded-for": "sqa-anon", ...headers } };
  if (method !== "GET" && method !== "HEAD") init.body = "{}";
  try { const res = await handler(new NextRequest(new URL(`http://localhost${url}`), init), { params: Object.assign(Promise.resolve(params), params) }); return res?.status ?? 0; } catch { return 599; }
}

test("no route outside /api/orgs lets an anonymous caller change state; cron routes refuse a wrong secret", { timeout: 1_500_000 }, async () => {
  const mutating = []; const anonGets = []; const cronOpen = []; const unimportable = []; const serverErrors = []; let routes = 0;
  const queue = [...files];
  async function worker() {
    for (let f = queue.shift(); f; f = queue.shift()) {
      let mod; try { mod = await import(pathToFileURL(f).href); } catch (e) { unimportable.push(`${norm(path.relative(API, f))}: ${String(e.message).split("\n")[0].slice(0, 90)}`); continue; }
      routes++; const { url, params } = routeUrl(f); const rel = url.replace("/api/", "").replace(/\/[0-9a-f]{24}/g, "/:id");
      const isCron = /cron|relay|release|settlements/i.test(rel);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[method] !== "function") continue;
        const st = await call(mod[method], method, url, params);
        if (st >= 500) serverErrors.push(`${rel} (${method}): ${st}`);
        if (st >= 200 && st < 300) { if (method === "GET") anonGets.push(rel); else if (!/\/logout$/.test(rel)) mutating.push(`${rel} (${method}): ${st}`); }
        if (isCron) { const bad = await call(mod[method], method, url, params, { authorization: "Bearer wrong-secret" }); if (bad >= 200 && bad < 300) cronOpen.push(`${rel} (${method}) accepted a wrong secret: ${bad}`); }
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const summary = { routesTested: routes, unimportable: unimportable.length, serverErrors: serverErrors.length, anonymousMutations: mutating.length, anonymousGetsAnswered: anonGets.length, cronOpen: cronOpen.length };
  console.log("SWEEP", JSON.stringify(summary));
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ summary, mutating, anonGets: anonGets.sort(), unimportable, serverErrors, cronOpen }, null, 1));
  assert.deepEqual(mutating, [], "state-changing methods that succeeded anonymously");
  assert.deepEqual(cronOpen, [], "cron/relay routes that accepted a wrong secret");
});
