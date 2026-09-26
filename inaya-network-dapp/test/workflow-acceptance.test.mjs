// AI Business Operations Manager -- SOW §61 acceptance test: the reference workflow, created from the
// "Daily Business Health" template and executed end to end against REAL MongoDB data, the REAL
// permission scope, the REAL controlled-notification system, the REAL audit chain and Evidence Graph.
// External systems are stand-ins ONLY where the SOW names them: a local helpdesk HTTP server, a capturing
// Slack/Gmail fetch, and a scripted model provider (so OUR enforcement -- data minimisation, tool
// allow-listing, branch logic -- is tested deterministically; a separate test calls the real Gemini).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { setup, teardown, makeWfOrg, startHelpdesk, allowLocalHttp, c } from "./_wf-fixtures.mjs";
import * as svc from "../src/lib/workflows/service.js";
import { createCredential } from "../src/lib/workflows/credentials.js";
import { __setAiProvider } from "../src/lib/workflows/ai.js";
import { __setNotifyFetch } from "../src/lib/workflows/notify.js";
import { buildEvidencePassport, verifyWorkflowEvidence } from "../src/lib/workflows/evidence.js";
import { explainExecution } from "../src/lib/workflows/explain.js";
import { processQueue, processSchedules } from "../src/lib/workflows/queue.js";

let org, other, helpdesk, wfId, cred = {};
const SECRETS = { bearer: "hd_secret_bearer_9f8e7d6c5b4a", slack: "https://hooks.slack.com/services/T000/B000/SLACKSECRET123", gmail: "ya29.gmail_secret_token_abcdef123456" };
const seenPrompts = []; const httpCalls = [];
let modelUrgent = null; // null = decide from the data in the prompt

before(async () => {
  allowLocalHttp();
  await setup();
  org = await makeWfOrg("acc"); other = await makeWfOrg("other");
  helpdesk = await startHelpdesk({ requireToken: SECRETS.bearer });
  __setNotifyFetch(async (url, init) => { httpCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.authorization }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; });
  __setAiProvider(async ({ contents, config }) => {
    const text = contents.map((m) => (m.parts || []).map((p) => p.text || "").join("")).join("\n");
    if (config.tools) {
      const called = contents.some((m) => (m.parts || []).some((p) => p.functionResponse));
      if (called) return { text: "Checked overdue invoices.", functionCalls: [] };
      return { text: "", functionCalls: [{ name: "read_invoices", args: { minAmount: 10000 } }, { name: "delete_all_company_data", args: {} }], modelContent: { role: "model", parts: [{ functionCall: { name: "read_invoices", args: { minAmount: 10000 } } }] } };
    }
    seenPrompts.push(text);
    const total = Number((text.match(/"overdueInvoices":\{[^}]*"total":(\d+)/) || [])[1] || 0);
    const urgent = modelUrgent ?? total >= 10000;
    return { text: JSON.stringify({ urgent, classification: urgent ? "urgent" : "normal", confidence: 0.91, summary: urgent ? `Overdue invoices total ${total}; escalate collections today.` : "Operations are within normal ranges.", findings: [{ title: urgent ? "Large overdue invoice" : "No issues", severity: urgent ? "high" : "low", evidence: `total=${total}` }], recommendations: [{ action: "Call the customer about the overdue invoice", rationale: "Largest exposure", risk: "low" }] }), functionCalls: [] };
  });
});
after(async () => { __setAiProvider(null); __setNotifyFetch(null); await helpdesk.close(); await teardown(); });

const O = () => ({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, email: org.owner.email });
const asJson = (x) => JSON.stringify(x);

test("setup: template -> draft with credentials by reference -> validation -> publish (credentials never appear in the definition)", async () => {
  const bearer = await createCredential({ orgId: org.oid, provider: "http_bearer", label: "helpdesk", secret: { token: SECRETS.bearer }, allowedHosts: ["127.0.0.1"], membership: org.owner.membership, actorEmail: org.owner.email });
  const slack = await createCredential({ orgId: org.oid, provider: "slack_webhook", label: "ops-alerts", secret: { url: SECRETS.slack }, membership: org.owner.membership, actorEmail: org.owner.email });
  const gmail = await createCredential({ orgId: org.oid, provider: "gmail_oauth", label: "gmail", secret: { accessToken: SECRETS.gmail }, membership: org.owner.membership, actorEmail: org.owner.email });
  for (const r of [bearer, slack, gmail]) assert.ok(!r.error, r.error);
  cred = { bearer: bearer.credential.credentialId, slack: slack.credential.credentialId, gmail: gmail.credential.credentialId };
  assert.doesNotMatch(asJson(bearer), /hd_secret/, "the API never echoes a secret");

  const made = await svc.createFromTemplate({ ...O(), templateId: "daily-business-health", name: "Daily Business Health" });
  assert.ok(!made.error, made.error);
  wfId = made.workflow.workflowId;
  const got = await svc.getWorkflow({ ...O(), id: wfId });
  const draft = JSON.parse(JSON.stringify(got.draft));
  const node = (k) => draft.nodes.find((n) => n.key === k);
  Object.assign(node("support"), { disabled: false }); node("support").config = { ...node("support").config, url: `${helpdesk.url}/tickets`, allowedHosts: ["127.0.0.1"], credentialId: cred.bearer };
  Object.assign(node("urgentSlack"), { disabled: false }); node("urgentSlack").config.credentialId = cred.slack;
  node("urgentEmail").disabled = true; // Inaya email needs a mail provider; the Gmail-API adapter below stands in for "Urgent Gmail"
  draft.nodes.push({ key: "urgentGmail", type: "notify.gmail", name: "Urgent Gmail", position: { x: 1560, y: 400 }, config: { title: "Urgent business alert", body: "{{ nodes.agent.output.result.summary }}", severity: "critical", recipients: [org.owner.email], credentialId: cred.gmail, alertType: "urgent_gmail" } });
  draft.edges.push({ from: "urgent", to: "urgentGmail", fromPort: "true" });
  node("agent").config.inputFrom = ["kpi", "support"]; // tickets go through the same minimisation + injection screen
  draft.settings.dataScopes = [...new Set([...draft.settings.dataScopes, "external_http"])];
  const upd = await svc.updateWorkflow({ ...O(), id: wfId, definition: draft });
  assert.ok(!upd.error, upd.error);
  assert.equal(upd.validation.valid, true, asJson(upd.validation.errors));

  const pub = await svc.publishWorkflow({ ...O(), id: wfId, note: "acceptance" });
  assert.ok(!pub.error, asJson(pub));
  assert.equal(pub.version, 1);
  const stored = asJson(await c.workflows.findOne({ _id: (await c.workflows.findOne({ orgId: org.orgId, name: "Daily Business Health" }))._id })) + asJson(await c.workflowVersions.find({ orgId: org.orgId }).toArray());
  for (const s of Object.values(SECRETS)) assert.ok(!stored.includes(s), "no raw secret is stored inside a workflow or its versions");
  assert.ok(stored.includes(cred.slack), "credentials are referenced by id");
  const w = await c.workflows.findOne({ orgId: org.orgId, name: "Daily Business Health" });
  assert.equal(w.schedule.enabled, true);
  assert.ok(w.schedule.nextRunAt > new Date().toISOString(), "next run is computed server-side");
});

let exec1;
test("§61 reference workflow: executes end to end on the urgent path with every step inspectable", async () => {
  const run = await svc.executeWorkflow({ ...O(), id: wfId });
  assert.ok(!run.error, asJson(run));
  exec1 = run.execution;
  assert.equal(exec1.status, "COMPLETED", asJson(exec1.errors) + asJson(Object.entries(exec1.nodeResults).filter(([, r]) => r.status === "FAILED")));
  const nr = exec1.nodeResults;
  // 2 + 3: four data branches executed under the run identity's permissions and merged
  for (const k of ["crm", "support", "invoices", "tasks"]) assert.equal(nr[k].status, "COMPLETED", k);
  assert.equal(nr.invoices.output.count, 2, "only OVERDUE / past-due SENT invoices");
  assert.equal(nr.invoices.output.over10k, 1);
  assert.equal(nr.tasks.output.overdueCount, 13);
  assert.equal(nr.support.output.openCount, 2);
  assert.equal(nr.support.dataSource, `http:127.0.0.1`);
  assert.equal(nr.merge.status, "COMPLETED");
  assert.deepEqual(new Set(nr.merge.output._sources), new Set(["crm", "support", "invoices", "tasks"]));
  // 4: KPI snapshot with provenance
  const snap = nr.kpi.output.snapshot;
  for (const f of ["generatedAt", "period", "sourceSystems", "organizationId", "permissionScope", "calculation"]) assert.ok(snap[f] !== undefined, `snapshot.${f}`);
  assert.equal(snap.organizationId, org.oid);
  assert.equal(snap.overdueInvoices.total, 17000);
  // 5 + 6 + 7: AI received only permitted, minimised data; produced structured output; tools allow-listed
  const prompt = seenPrompts.at(-1);
  assert.ok(prompt.includes("untrusted_data") || /UNTRUSTED/i.test(prompt), "retrieved data is wrapped as untrusted");
  assert.ok(!prompt.includes(org.owner.email) && !prompt.includes(org.salesRep.email), "people are pseudonymised before the model sees them");
  assert.doesNotMatch(prompt, /attacker@evil\.example/, "the injected helpdesk instruction never reaches the model");
  assert.equal(nr.agent.output.result.urgent, true);
  assert.equal(nr.agent.output.result.classification, "urgent");
  assert.ok(nr.agent.output.deterministic.anyExceeded, "threshold facts are computed by the engine, not the model");
  const toolCalls = nr.agent.output.explainability.toolCalls;
  assert.ok(toolCalls.some((t) => t.tool === "read_invoices" && t.decision === "ALLOWED"));
  assert.ok(toolCalls.some((t) => t.tool === "delete_all_company_data" && t.decision === "DENIED_UNKNOWN_TOOL"), "a tool the model invented is refused");
  assert.equal(nr.agent.output.explainability.securityFindings.promptInjectionRemoved, 1, "prompt injection in a ticket was detected and removed");
  // 8 + 9: branch + urgent notifications through the approved paths
  assert.equal(nr.urgent.output.branch, "true");
  assert.equal(nr.urgentAlert.output.delivered, 1);
  assert.equal(nr.urgentSlack.output.channel, "slack");
  assert.equal(nr.urgentGmail.output.channel, "gmail");
  assert.equal(httpCalls.filter((x) => x.url.startsWith("https://hooks.slack.com/")).length, 1);
  assert.equal(httpCalls.filter((x) => x.url.includes("gmail.googleapis.com")).length, 1);
  // 10: the normal path did NOT run
  assert.equal(nr.report.status, "SKIPPED");
  assert.equal(nr.dailyInaya.status, "SKIPPED");
  // 12: node-level inspection
  for (const k of ["invoices", "agent", "urgent"]) { const r = nr[k]; assert.ok(r.permissionContext.executingIdentity && r.startedAt && r.completedAt && r.outputSummary && r.actionClass, `${k} inspectable`); }
  assert.equal(nr.invoices.permissionContext.scope, "finance");
  // 16: no credentials in execution records
  const blob = asJson(await c.workflowExecutions.find({ orgId: org.orgId }).toArray()) + asJson(await c.workflowEvidence.find({ orgId: org.orgId }).toArray());
  for (const s of Object.values(SECRETS)) assert.ok(!blob.includes(s), "no credential appears in executions or evidence");
  // 11: auditable + verified
  const v = await verifyWorkflowEvidence({ orgId: org.oid, executionId: exec1.executionId });
  assert.equal(v.verified, true, asJson(v.problems));
  const kinds = new Set((await c.workflowEvidence.find({ orgId: org.orgId, executionId: new ObjectId(exec1.executionId) }).toArray()).map((r) => r.action));
  for (const k of ["EXECUTION_STARTED", "DATA_READ", "KPI_SNAPSHOT", "AI_ANALYSIS", "AI_TOOL_CALLED", "DECISION_MADE", "NOTIFICATION_SENT", "EXECUTION_COMPLETED"]) assert.ok(kinds.has(k), `evidence kind ${k}`);
  // Evidence Graph: the execution is a subject with typed relationships
  const ev = await c.businessEvents.findOne({ orgId: org.orgId, subjectType: "WORKFLOW_EXECUTION" });
  assert.ok(ev, "execution is an Evidence Graph subject");
  const relTypes = new Set(ev.relationships.map((r) => r.type));
  for (const t of ["SOURCED_FROM", "DERIVED_FROM", "ANALYZED_BY", "CHECKED_BY", "PROVEN_BY"]) assert.ok(relTypes.has(t), `graph relationship ${t}`);
});

test("§47 evidence passport and §68 'why did this happen' answer the SOW's questions without hidden reasoning", async () => {
  const p = await buildEvidencePassport({ orgId: org.oid, executionId: exec1.executionId });
  assert.ok(!p.error);
  const pp = p.passport;
  assert.equal(pp.workflow.workflowVersion, 1);
  assert.equal(pp.verification.verified, true);
  assert.equal(pp.aiStructuredOutput.urgent, true);
  assert.ok(pp.kpiSnapshot && pp.rulesEvaluated.length === 1 && pp.branchSelected === "yes" && pp.notifications.length >= 3);
  assert.ok(pp.passportHash && pp.cryptographicAuditReferences.length > 5);
  const why = await explainExecution({ orgId: org.oid, executionId: exec1.executionId, membership: org.owner.membership, email: org.owner.email });
  assert.ok(why.explanation.narrative.some((l) => /TRUE/.test(l)));
  assert.ok(why.explanation.toolCalls.length >= 2 && why.explanation.aiConclusion.classification === "urgent");
  assert.ok(!/chain[- ]of[- ]thought|reasoning trace/i.test(asJson(why).replace(/hidden model reasoning[^"]*/gi, "")), "no hidden reasoning is recorded");
});

test("§61.14 re-running the same day creates NO duplicate notifications or external sends", async () => {
  const before = httpCalls.length;
  const run = await svc.executeWorkflow({ ...O(), id: wfId });
  assert.equal(run.execution.status, "COMPLETED", asJson(run.execution.errors));
  assert.equal(httpCalls.length, before, "Slack/Gmail were not called again");
  assert.equal(run.execution.nodeResults.urgentAlert.output.deliveries[0].status, "DEDUPED");
  assert.equal(run.execution.nodeResults.urgentSlack.output.deliveries[0].status, "DEDUPED");
  const n = await c.db.collection("notifications").countDocuments({ orgId: org.orgId, sourceModule: "workflows", "metadata.alertType": "urgent" });
  assert.equal(n, 1);
});

test("§61.15 / §31 cross-org and privilege-escalation attempts fail closed", async () => {
  const foreign = await svc.getWorkflow({ orgId: other.oid, id: wfId, membership: other.owner.membership, email: other.owner.email });
  assert.equal(foreign.status, 404, "another organization cannot see the workflow");
  const foreignRun = await svc.executeWorkflow({ orgId: other.oid, id: wfId, membership: other.owner.membership, actorEmail: other.owner.email });
  assert.ok(foreignRun.error && foreignRun.status === 404);
  const nobodyView = await svc.getWorkflow({ ...O(), id: wfId, membership: org.nobody.membership, email: org.nobody.email });
  assert.equal(nobodyView.status, 404, "a member with no rights cannot even see it");
  // share execute with a sales rep: they can run it only if THEY hold the finance scope the workflow reads
  const shared = await svc.setWorkflowAcl({ ...O(), id: wfId, acl: [{ email: org.salesRep.email, rights: ["view", "execute", "viewExecutions"] }] });
  assert.ok(!shared.error, asJson(shared));
  const rep = await svc.executeWorkflow({ orgId: org.oid, id: wfId, membership: org.salesRep.membership, actorEmail: org.salesRep.email });
  assert.equal(rep.status, 403, "sharing a workflow does not lend its owner's data scopes");
  assert.equal(rep.reasonCode, "PERMISSION_DENIED");
  const escalate = await svc.setWorkflowAcl({ orgId: org.oid, id: wfId, membership: org.salesRep.membership, actorEmail: org.salesRep.email, acl: [{ email: org.salesRep.email, rights: ["publish"] }] });
  assert.equal(escalate.status, 403, "a non-owner cannot grant themselves publish");
  const tried = await svc.publishWorkflow({ orgId: org.oid, id: wfId, membership: org.salesRep.membership, actorEmail: org.salesRep.email });
  assert.equal(tried.status, 403);
});

test("§61.1 schedule fires server-side exactly once per slot (claimed, idempotent, no backlog flood)", async () => {
  const w = await c.workflows.findOne({ orgId: org.orgId, name: "Daily Business Health" });
  const past = new Date(Date.now() - 3 * 86400000).toISOString();
  await c.workflows.updateOne({ _id: w._id }, { $set: { "schedule.nextRunAt": past } });
  const [a, b] = await Promise.all([processSchedules(), processSchedules()]);
  const fired = [...a.fired, ...b.fired].filter((f) => f.workflowId === String(w._id));
  assert.equal(fired.length, 1, "two workers, one slot: only one wins the claim");
  const after = await c.workflows.findOne({ _id: w._id });
  assert.ok(after.schedule.nextRunAt > new Date().toISOString(), "missed days are skipped, not replayed");
  const ex = await c.workflowExecutions.findOne({ _id: (await c.workflowExecutions.findOne({ orgId: org.orgId, "trigger.type": "schedule" }))._id });
  assert.equal(ex.trigger.type, "schedule");
  assert.equal(ex.initiatingIdentity.kind, "schedule");
  assert.equal(ex.runAs, org.owner.email);
  const q = await processQueue({ workerId: "t-worker" });
  assert.ok(q.ran.some((r) => r.executionId === String(ex._id) && r.status === "COMPLETED"), asJson(q));
});

test("§61.10 normal path: when nothing is urgent the daily report is produced instead", async () => {
  await c.invoices.updateMany({ orgId: org.orgId }, { $set: { status: "PAID" } });
  await c.tasks.updateMany({ orgId: org.orgId }, { $set: { status: "DONE" } });
  await helpdesk.close(); helpdesk = await startHelpdesk({ requireToken: SECRETS.bearer, tickets: [{ id: 9, subject: "Thanks", status: "solved", priority: "low" }] });
  const w = await svc.getWorkflow({ ...O(), id: wfId });
  const draft = JSON.parse(JSON.stringify(w.draft));
  draft.nodes.find((n) => n.key === "support").config.url = `${helpdesk.url}/tickets`;
  await svc.updateWorkflow({ ...O(), id: wfId, definition: draft });
  const pub = await svc.publishWorkflow({ ...O(), id: wfId });
  assert.equal(pub.version, 2, "editing creates a NEW version; v1 is untouched");
  const v1 = await svc.getVersion({ ...O(), id: wfId, version: 1 });
  assert.equal(v1.integrityOk, true);
  assert.notEqual(v1.definition.nodes.find((n) => n.key === "support").config.url, draft.nodes.find((n) => n.key === "support").config.url);
  const run = await svc.executeWorkflow({ ...O(), id: wfId });
  const nr = run.execution.nodeResults;
  assert.equal(run.execution.status, "COMPLETED", asJson(run.execution.errors));
  assert.equal(nr.urgent.output.branch, "false");
  assert.equal(nr.report.status, "COMPLETED");
  assert.equal(nr.report.output.report.reportType, "daily_operations");
  assert.ok(nr.report.output.markdown.includes("Daily Operations Report"));
  assert.equal(nr.dailyInaya.status, "COMPLETED");
  assert.equal(nr.urgentAlert.status, "SKIPPED");
  assert.equal(run.execution.workflowVersion, 2, "the execution is tied to the version it used");
  const old = await c.workflowExecutions.findOne({ orgId: org.orgId, workflowVersion: 1 });
  assert.ok(old, "existing executions stay tied to their version");
  // rollback re-activates v1 without deleting anything
  const rb = await svc.rollbackWorkflow({ ...O(), id: wfId, version: 1 });
  assert.equal(rb.activeVersion, 1);
  assert.equal((await svc.listVersions({ ...O(), id: wfId })).versions.length, 2);
});
