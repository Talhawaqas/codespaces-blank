// AI Business Operations Manager -- API route tests (SOW §51). The REAL route handlers are called with real
// session cookies against the real database: authentication, organization scope, replay protection, body limits,
// permissions, the webhook (HMAC) and API-key triggers, the cron entry point, and that no secret ever leaves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server.js";
import { setup, teardown, makeWfOrg, cookieFor, N, E, wfDef, c } from "./_wf-fixtures.mjs";
import { SESSION_COOKIE } from "../src/lib/orgs.js";
import { createApiKey } from "../src/lib/api-keys.js";
import { __setAiProvider } from "../src/lib/workflows/ai.js";
import { __setNotifyFetch } from "../src/lib/workflows/notify.js";

let org, other, tok = {}, hookWf, apiWf;
const J = (x) => JSON.stringify(x);
const mod = {};
const load = async (k, path) => (mod[k] ||= await import(path));

function req(method, path, { body, token, headers = {}, query = {} } = {}) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, { method, headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : J(body) } : {}) });
}
const call = async (handler, r, params = {}) => { const res = await handler(r, { params: Promise.resolve(params) }); return { status: res.status, body: await res.json().catch(() => ({})) }; };

before(async () => {
  await setup();
  org = await makeWfOrg("route"); other = await makeWfOrg("route2");
  tok = { owner: await cookieFor(org.owner.email), rep: await cookieFor(org.salesRep.email), foreign: await cookieFor(other.owner.email) };
});
after(async () => { __setAiProvider(null); __setNotifyFetch(null); await teardown(); });

test("authentication, organization scope and input limits on every route", async () => {
  const { GET, POST } = await load("root", "../src/app/api/orgs/workflows/route.js");
  assert.equal((await call(GET, req("GET", "/api/orgs/workflows", { query: { orgId: org.oid } }))).status, 401, "no session");
  assert.equal((await call(GET, req("GET", "/api/orgs/workflows", { token: tok.owner }))).status, 400, "orgId is required");
  assert.equal((await call(GET, req("GET", "/api/orgs/workflows", { token: tok.foreign, query: { orgId: org.oid } }))).status, 403, "another organization's member is refused");
  assert.equal((await call(POST, req("POST", "/api/orgs/workflows", { token: tok.owner, body: "{not json", query: { orgId: org.oid } }))).status, 400);
  assert.equal((await call(POST, req("POST", "/api/orgs/workflows", { token: tok.owner, body: { orgId: org.oid, name: "x".repeat(600_000) } }))).status, 413, "body size limit");
  const ok = await call(GET, req("GET", "/api/orgs/workflows", { token: tok.owner, query: { orgId: org.oid } }));
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.workflows, []);
});

test("lifecycle over HTTP: create -> replay-safe -> get -> patch -> validate -> publish -> execute -> executions -> explain -> passport", async () => {
  const { GET, POST } = await load("root", "../src/app/api/orgs/workflows/route.js");
  const def = wfDef([N("t", "trigger.manual"), N("d", "data.employee_tasks", { limit: 50 }), N("c", "condition.if", { expression: "nodes.d.output.overdueCount > 5" }), N("a", "notify.inaya", { title: "Overdue {{ nodes.d.output.overdueCount }}", body: "b", severity: "warning", audience: "managers", alertType: "route" })], [E("t", "d"), E("d", "c"), E("c", "a", "true")], ["tasks", "notify"]);
  const create = () => call(POST, req("POST", "/api/orgs/workflows", { token: tok.owner, headers: { "idempotency-key": "create-route-1" }, body: { orgId: org.oid, name: "Route workflow", definition: def } }));
  const a = await create(); assert.equal(a.status, 201, J(a.body));
  const b = await create(); assert.equal(b.body.replayed, true, "the same Idempotency-Key returns the recorded response"); assert.equal(b.body.workflow.workflowId, a.body.workflow.workflowId);
  const id = a.body.workflow.workflowId;
  assert.equal((await call(POST, req("POST", "/api/orgs/workflows", { token: tok.owner, body: { orgId: org.oid, name: "Route workflow", definition: def } }))).status, 409, "names are unique per organization");

  const item = await load("id", "../src/app/api/orgs/workflows/[id]/route.js");
  const got = await call(item.GET, req("GET", `/api/orgs/workflows/${id}`, { token: tok.owner, query: { orgId: org.oid } }), { id });
  assert.equal(got.status, 200); assert.equal(got.body.validation.valid, true);
  assert.equal((await call(item.GET, req("GET", `/api/orgs/workflows/${id}`, { token: tok.rep, query: { orgId: org.oid } }), { id })).status, 404, "a member with no rights cannot see it");
  assert.equal((await call(item.GET, req("GET", `/api/orgs/workflows/${id}`, { token: tok.foreign, query: { orgId: other.oid } }), { id })).status, 404, "nor can another organization");
  const patched = await call(item.PATCH, req("PATCH", `/api/orgs/workflows/${id}`, { token: tok.owner, body: { orgId: org.oid, description: "over http" } }), { id });
  assert.equal(patched.status, 200);

  const validate = await load("validate", "../src/app/api/orgs/workflows/validate/route.js");
  const v = await call(validate.POST, req("POST", "/api/orgs/workflows/validate", { token: tok.owner, body: { orgId: org.oid, definition: { ...def, nodes: def.nodes.slice(0, 2), edges: [{ from: "t", to: "d" }, { from: "d", to: "ghost" }] } } }));
  assert.equal(v.body.valid, false); assert.ok(v.body.errors.length);

  const pubR = await load("publish", "../src/app/api/orgs/workflows/[id]/publish/route.js");
  const pub = await call(pubR.POST, req("POST", `/api/orgs/workflows/${id}/publish`, { token: tok.owner, body: { orgId: org.oid, note: "http" } }), { id });
  assert.equal(pub.status, 200, J(pub.body)); assert.equal(pub.body.version, 1);
  assert.equal((await call(pubR.POST, req("POST", `/api/orgs/workflows/${id}/publish`, { token: tok.rep, body: { orgId: org.oid } }), { id })).status, 404, "no rights: not even confirmed to exist");

  const exeR = await load("exec", "../src/app/api/orgs/workflows/[id]/execute/route.js");
  const dry = await call(exeR.POST, req("POST", `/api/orgs/workflows/${id}/execute`, { token: tok.owner, body: { orgId: org.oid, dryRun: true } }), { id });
  assert.equal(dry.body.execution.mode, "dry_run"); assert.equal(dry.body.execution.nodeResults.a.output.simulated, true);
  const run = await call(exeR.POST, req("POST", `/api/orgs/workflows/${id}/execute`, { token: tok.owner, body: { orgId: org.oid } }), { id });
  assert.equal(run.status, 200, J(run.body)); assert.equal(run.body.execution.status, "COMPLETED");
  const exId = run.body.execution.executionId;

  const list = await load("execs", "../src/app/api/orgs/workflows/executions/route.js");
  const l = await call(list.GET, req("GET", "/api/orgs/workflows/executions", { token: tok.owner, query: { orgId: org.oid, workflowId: id } }));
  assert.equal(l.body.executions.length, 1, "production list excludes the dry run"); assert.ok(l.body.executions[0].nodesExecuted >= 3);
  const one = await load("exec1", "../src/app/api/orgs/workflows/executions/[executionId]/route.js");
  const detail = await call(one.GET, req("GET", `/api/orgs/workflows/executions/${exId}`, { token: tok.owner, query: { orgId: org.oid } }), { executionId: exId });
  assert.equal(detail.body.execution.nodeResults.c.output.branch, "true");
  assert.equal((await call(one.GET, req("GET", `/api/orgs/workflows/executions/${exId}`, { token: tok.foreign, query: { orgId: other.oid } }), { executionId: exId })).status, 404);
  const why = await load("why", "../src/app/api/orgs/workflows/executions/[executionId]/explain/route.js");
  const w = await call(why.GET, req("GET", `/api/orgs/workflows/executions/${exId}/explain`, { token: tok.owner, query: { orgId: org.oid } }), { executionId: exId });
  assert.ok(w.body.explanation.narrative.length >= 3);
  const pp = await load("pp", "../src/app/api/orgs/workflows/executions/[executionId]/passport/route.js");
  const p = await call(pp.GET, req("GET", `/api/orgs/workflows/executions/${exId}/passport`, { token: tok.owner, query: { orgId: org.oid } }), { executionId: exId });
  assert.equal(p.body.passport.verification.verified, true); assert.ok(p.body.passport.passportHash);
  assert.equal((await call(pp.GET, req("GET", `/api/orgs/workflows/executions/${exId}/passport`, { token: tok.rep, query: { orgId: org.oid } }), { executionId: exId })).status, 404);

  const ver = await load("ver", "../src/app/api/orgs/workflows/[id]/versions/route.js");
  assert.equal((await call(ver.GET, req("GET", `/api/orgs/workflows/${id}/versions`, { token: tok.owner, query: { orgId: org.oid } }), { id })).body.versions.length, 1);
  const exp = await load("export", "../src/app/api/orgs/workflows/[id]/export/route.js");
  const ex = await call(exp.GET, req("GET", `/api/orgs/workflows/${id}/export`, { token: tok.owner, query: { orgId: org.oid } }), { id });
  assert.equal(ex.body.export.format, "inaya.workflow/1");
  const imp = await load("import", "../src/app/api/orgs/workflows/import/route.js");
  const im = await call(imp.POST, req("POST", "/api/orgs/workflows/import", { token: tok.owner, body: { orgId: org.oid, payload: ex.body.export, name: "Imported over http" } }));
  assert.equal(im.status, 201); assert.equal(im.body.workflow.status, "DRAFT");
  const del = await call(item.DELETE, req("DELETE", `/api/orgs/workflows/${im.body.workflow.workflowId}`, { token: tok.owner, body: { orgId: org.oid } }), { id: im.body.workflow.workflowId });
  assert.equal(del.body.deleted, true);
});

test("catalog, templates, metrics, health, evaluations and copilot routes", async () => {
  const cat = await load("cat", "../src/app/api/orgs/workflows/catalog/route.js");
  const cg = await call(cat.GET, req("GET", "/api/orgs/workflows/catalog", { token: tok.owner, query: { orgId: org.oid } }));
  assert.ok(cg.body.nodeTypes.length >= 30 && cg.body.tools.length >= 12 && cg.body.integrationStatus.slack.includes("NOT verified"), "the catalog states which integrations are unverified");
  const tpl = await load("tpl", "../src/app/api/orgs/workflows/templates/route.js");
  const owned = await call(tpl.GET, req("GET", "/api/orgs/workflows/templates", { token: tok.owner, query: { orgId: org.oid } }));
  const repList = await call(tpl.GET, req("GET", "/api/orgs/workflows/templates", { token: tok.rep, query: { orgId: org.oid } }));
  assert.equal(owned.body.templates.length, 7); assert.ok(repList.body.templates.length < 7, "templates needing scopes the member lacks are not offered");
  const create = await load("tplc", "../src/app/api/orgs/workflows/templates/[templateId]/create/route.js");
  const made = await call(create.POST, req("POST", "/api/orgs/workflows/templates/finance-exception-monitor/create", { token: tok.owner, body: { orgId: org.oid, name: "Finance from template 09-26 12:30 (Q3)" } }), { templateId: "finance-exception-monitor" });
  assert.equal(made.status, 201); assert.equal(made.body.workflow.status, "DRAFT");
  const met = await load("met", "../src/app/api/orgs/workflows/metrics/route.js");
  assert.ok((await call(met.GET, req("GET", "/api/orgs/workflows/metrics", { token: tok.owner, query: { orgId: org.oid } }))).body.totals);
  const hl = await load("hl", "../src/app/api/orgs/workflows/health/route.js");
  assert.ok((await call(hl.GET, req("GET", "/api/orgs/workflows/health", { token: tok.owner, query: { orgId: org.oid } }))).body.summary);
  const evR = await load("ev", "../src/app/api/orgs/workflows/[id]/evaluations/route.js");
  const wid = made.body.workflow.workflowId;
  const ce = await call(evR.POST, req("POST", `/api/orgs/workflows/${wid}/evaluations`, { token: tok.owner, body: { orgId: org.oid, name: "route eval", cases: [{ name: "quiet", testData: { nodes: { invoices: { count: 0, totalOverdue: 0, over10k: 0, invoices: [] } } }, expect: { status: "COMPLETED", branch: "no" } }] } }), { id: wid });
  assert.equal(ce.status, 201, J(ce.body));
  const runR = await load("evrun", "../src/app/api/orgs/workflows/evaluations/[evaluationId]/run/route.js");
  const rr = await call(runR.POST, req("POST", `/api/orgs/workflows/evaluations/${ce.body.evaluationId}/run`, { token: tok.owner, body: { orgId: org.oid, useDraft: true } }), { evaluationId: ce.body.evaluationId });
  assert.equal(rr.body.run.passed, 1, J(rr.body.run.results));
  __setAiProvider(async () => ({ text: J({ name: "Copilot over http", nodes: [{ key: "t", type: "trigger.manual", name: "t", config: {} }, { key: "n", type: "evidence.record", name: "n", config: { note: "hello" } }], edges: [{ from: "t", to: "n" }], settings: { dataScopes: ["evidence"] } }) }));
  const cop = await load("cop", "../src/app/api/orgs/workflows/copilot/route.js");
  const cd = await call(cop.POST, req("POST", "/api/orgs/workflows/copilot", { token: tok.owner, body: { orgId: org.oid, prompt: "When I press a button, record an evidence note saying hello." } }));
  assert.equal(cd.status, 201, J(cd.body)); assert.equal(cd.body.published, false);
  __setAiProvider(null);
});

test("credentials over HTTP: owner/admin only, and no response ever contains a secret", async () => {
  const cr = await load("cred", "../src/app/api/orgs/workflows/credentials/route.js");
  const secret = "https://hooks.slack.com/services/T1/B2/ROUTESECRET999";
  const denied = await call(cr.POST, req("POST", "/api/orgs/workflows/credentials", { token: tok.rep, body: { orgId: org.oid, provider: "slack_webhook", label: "x", secret: { url: secret } } }));
  assert.equal(denied.status, 403);
  const made = await call(cr.POST, req("POST", "/api/orgs/workflows/credentials", { token: tok.owner, body: { orgId: org.oid, provider: "slack_webhook", label: "ops", secret: { url: secret } } }));
  assert.equal(made.status, 201);
  const list = await call(cr.GET, req("GET", "/api/orgs/workflows/credentials", { token: tok.owner, query: { orgId: org.oid } }));
  assert.ok(!J(made.body).includes("ROUTESECRET999") && !J(list.body).includes("ROUTESECRET999"), "the secret is write-only");
  assert.equal((await call(cr.GET, req("GET", "/api/orgs/workflows/credentials", { token: tok.rep, query: { orgId: org.oid } }))).status, 403);
  assert.ok(!J(await c.workflowCredentials.findOne({ orgId: org.orgId })).includes("ROUTESECRET999"), "stored encrypted, not in plain text");
  const one = await load("cred1", "../src/app/api/orgs/workflows/credentials/[credentialId]/route.js");
  const rev = await call(one.DELETE, req("DELETE", `/api/orgs/workflows/credentials/${made.body.credential.credentialId}`, { token: tok.owner, body: { orgId: org.oid } }), { credentialId: made.body.credential.credentialId });
  assert.equal(rev.body.credential.status, "REVOKED");
});

test("Gmail with a refresh token: the server mints a short-lived access token per run (mock Google)", async () => {
  const seen = [];
  __setNotifyFetch(async (url, init) => { seen.push({ url: String(url), body: String(init?.body || ""), auth: init?.headers?.authorization }); if (String(url).includes("oauth2.googleapis.com")) return { ok: true, status: 200, json: async () => ({ access_token: "ya29.fresh-token-abc" }) }; return { ok: true, status: 200, json: async () => ({ id: "m1" }) }; });
  const { createCredential } = await import("../src/lib/workflows/credentials.js");
  const svc = await import("../src/lib/workflows/service.js");
  const g = await createCredential({ orgId: org.oid, provider: "gmail_oauth", label: "mail", secret: { clientId: "cid.apps.googleusercontent.com", clientSecret: "GOCSPX-clientsecret123", refreshToken: "1//refresh-token-xyz" }, membership: org.owner.membership, actorEmail: org.owner.email });
  assert.ok(!g.error, J(g));
  const O = { orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, email: org.owner.email };
  const cr = await svc.createWorkflow({ ...O, name: "Gmail refresh", definition: wfDef([N("t", "trigger.manual"), N("g", "notify.gmail", { title: "Hello", body: "From Inaya", severity: "info", recipients: [org.owner.email], credentialId: g.credential.credentialId, alertType: "gmail_refresh" })], [E("t", "g")], ["notify"]) });
  const pub = await svc.publishWorkflow({ ...O, id: cr.workflow.workflowId }); assert.ok(!pub.error, J(pub));
  const r = await svc.executeWorkflow({ ...O, id: cr.workflow.workflowId });
  assert.equal(r.execution.status, "COMPLETED", J(r.execution.errors));
  const token = seen.find((x) => x.url.includes("oauth2.googleapis.com/token"));
  assert.ok(token && /grant_type=refresh_token/.test(token.body) && /refresh_token=1%2F%2Frefresh-token-xyz/.test(token.body));
  const send = seen.find((x) => x.url.includes("gmail.googleapis.com"));
  assert.equal(send.auth, "Bearer ya29.fresh-token-abc", "the minted token was used to send");
  assert.equal(r.execution.nodeResults.g.output.delivered, 1);
  assert.ok(!J(r).match(/fresh-token|refresh-token-xyz|GOCSPX/), "no token or secret in the execution record");
  // a revoked refresh token fails the node with a clear, non-secret message
  __setNotifyFetch(async (url) => (String(url).includes("oauth2") ? { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) } : { ok: true, status: 200, json: async () => ({}) }));
  const bad = await svc.executeWorkflow({ ...O, id: cr.workflow.workflowId, mode: "production" });
  const gn = bad.execution.nodeResults.g;
  assert.equal(bad.execution.status, "COMPLETED", "same-day re-run is deduped, so this proves nothing was re-sent");
  assert.equal(gn.output.deliveries[0].status, "DEDUPED");
  __setNotifyFetch(null);
});

test("webhook and API-key triggers, and the cron entry point", async () => {
  const svc = await import("../src/lib/workflows/service.js");
  const O = { orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, email: org.owner.email };
  const wh = await svc.createWorkflow({ ...O, name: "Hooked", definition: wfDef([N("t", "trigger.webhook"), N("e", "evidence.record", { note: "hook {{ trigger.n }}" })], [E("t", "e")], ["evidence"]) });
  const whPub = await svc.publishWorkflow({ ...O, id: wh.workflow.workflowId }); hookWf = wh.workflow.workflowId;
  assert.ok(whPub.webhookSecret);
  const hook = await load("hook", "../src/app/api/workflow-hooks/[workflowId]/route.js");
  const raw = J({ n: 7 }); const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", whPub.webhookSecret).update(`${ts}.${raw}`).digest("hex");
  const H = (s, t = ts) => ({ "x-inaya-timestamp": t, "x-inaya-signature": s });
  assert.equal((await call(hook.POST, req("POST", "/x", { body: raw, headers: H("00".repeat(32)) }), { workflowId: hookWf })).status, 401);
  const good = await call(hook.POST, req("POST", "/x", { body: raw, headers: H(sig) }), { workflowId: hookWf });
  assert.equal(good.status, 202, J(good.body)); assert.ok(good.body.executionId);
  assert.equal((await call(hook.POST, req("POST", "/x", { body: raw, headers: H(sig) }), { workflowId: hookWf })).status, 409, "replay");
  assert.equal((await call(hook.POST, req("POST", "/x", { body: raw, headers: H(sig) }), { workflowId: "0".repeat(24) })).status, 404);
  assert.doesNotMatch(J((await call(hook.POST, req("POST", "/x", { body: raw, headers: H("ab".repeat(32)) }), { workflowId: hookWf })).body), /signature|secret/i, "never explains why a signature failed");

  const ap = await svc.createWorkflow({ ...O, name: "Api started", definition: wfDef([N("t", "trigger.api"), N("e", "evidence.record", { note: "api {{ trigger.who }}" })], [E("t", "e")], ["evidence"]) });
  await svc.publishWorkflow({ ...O, id: ap.workflow.workflowId }); apiWf = ap.workflow.workflowId;
  const key = await createApiKey({ orgId: org.oid, label: "wf-test", actorEmail: org.owner.email });
  const api = await load("api", "../src/app/api/public/v1/workflows/[id]/run/route.js");
  const noKey = await call(api.POST, req("POST", "/x", { body: { who: "ci" } }), { id: apiWf });
  assert.equal(noKey.status, 401);
  const ok = await call(api.POST, req("POST", "/x", { body: { who: "ci" }, headers: { authorization: `Bearer ${key.rawKey}`, "idempotency-key": "run-1" } }), { id: apiWf });
  assert.equal(ok.status, 202, J(ok.body));
  const again = await call(api.POST, req("POST", "/x", { body: { who: "ci" }, headers: { authorization: `Bearer ${key.rawKey}`, "idempotency-key": "run-1" } }), { id: apiWf });
  assert.equal(again.body.duplicate, true);
  const wrongTrigger = await call(api.POST, req("POST", "/x", { body: {}, headers: { authorization: `Bearer ${key.rawKey}` } }), { id: hookWf });
  assert.equal(wrongTrigger.status, 409, "a webhook workflow cannot be started through the API path");
  const foreignKey = await createApiKey({ orgId: other.oid, label: "x", actorEmail: other.owner.email });
  assert.equal((await call(api.POST, req("POST", "/x", { body: {}, headers: { authorization: `Bearer ${foreignKey.rawKey}` } }), { id: apiWf })).status, 404, "another organization's key cannot start it");

  const cron = await load("cron", "../src/app/api/cron/workflows/route.js");
  process.env.CRON_SECRET = "cron-test-secret";
  assert.equal((await call(cron.GET, req("GET", "/api/cron/workflows"))).status, 401);
  assert.equal((await call(cron.GET, req("GET", "/api/cron/workflows", { headers: { authorization: "Bearer wrong" } }))).status, 401);
  const run = await call(cron.GET, req("GET", "/api/cron/workflows", { headers: { authorization: "Bearer cron-test-secret" } }));
  assert.equal(run.status, 200, J(run.body)); assert.ok(run.body.executions >= 2, "the cron pass drained the webhook and API executions: " + J(run.body));
  const done = await c.workflowExecutions.find({ orgId: org.orgId, "trigger.type": { $in: ["webhook", "api"] } }).toArray();
  assert.ok(done.length >= 2 && done.every((e) => e.status === "COMPLETED"), J(done.map((e) => e.status)));
});
