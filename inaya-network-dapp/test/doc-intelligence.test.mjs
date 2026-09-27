// Document Intelligence Studio (RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream C).
// Real database. The AI model call is scripted via workflows/ai.js's own test seam (__setAiProvider) --
// no real Gemini call, no network call to a real AI provider -- so this is deterministic and free to run.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../src/lib/orgs.js";
import { getDocIntelligenceCollections } from "../src/lib/docIntelligence/db.js";
import { __setAiProvider } from "../src/lib/workflows/ai.js";
import { POST as analyzersPost, GET as analyzersGet } from "../src/app/api/orgs/doc-intelligence/analyzers/route.js";
import { PATCH as analyzerPatch } from "../src/app/api/orgs/doc-intelligence/analyzers/[analyzerId]/route.js";
import { POST as analyzePost } from "../src/app/api/orgs/doc-intelligence/analyze/route.js";
import { GET as resultsGet } from "../src/app/api/orgs/doc-intelligence/results/route.js";
import { GET as resultGet } from "../src/app/api/orgs/doc-intelligence/results/[resultId]/route.js";
import { GET as reviewGet } from "../src/app/api/orgs/doc-intelligence/review/route.js";
import { POST as reviewAct } from "../src/app/api/orgs/doc-intelligence/review/[itemId]/route.js";
import { POST as evaluatePost } from "../src/app/api/orgs/doc-intelligence/evaluate/route.js";
import { listBusinessEvents } from "../src/lib/businessEvents.js";
import { flushEvidence } from "../src/lib/docIntelligence/record.js";
import clientPromise from "../src/lib/mongodb.js";

const RUN = randomBytes(3).toString("hex"); const created = [];
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";

after(async () => {
  __setAiProvider(null);
  await flushEvidence().catch(() => {});
  try {
    const c = await getOrgCollections();
    for (const n of (await c.db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name)) { try { await c.db.collection(n).deleteMany({ orgId: { $in: created } }); } catch { /* ignore */ } }
    await c.orgs.deleteMany({ _id: { $in: created } });
    await c.db.collection("sessions").deleteMany({ email: new RegExp(`^di-${RUN}`) });
    const di = await getDocIntelligenceCollections();
    for (const coll of [di.diAnalyzers, di.diResults, di.diReviewItems, di.diEvaluations]) await coll.deleteMany({ orgId: { $in: created } });
  } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

const jreq = (method, url, { token, body } = {}) => new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const freq = (url, { token, form } = {}) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: form });
const j = async (res) => ({ status: res.status, body: await res.json() });
const params = (obj) => Promise.resolve(obj);

let orgId, ownerToken, memberToken, otherOrgId, otherOwnerToken;
let analyzerId;

test("setup: an organization with an owner and a plain member, plus an unrelated organization", async () => {
  await ensureOrgIndexes(); const c = await getOrgCollections(); const now = new Date().toISOString();
  orgId = (await c.orgs.insertOne({ name: `di-${RUN}-co`, createdAt: now })).insertedId; created.push(orgId);
  const ownerEmail = `di-${RUN}-owner@example.com`; const memberEmail = `di-${RUN}-member@example.com`;
  await c.orgMembers.insertMany([
    { orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", createdAt: now },
    { orgId, email: memberEmail, role: "member", departmentIds: [], status: "active", createdAt: now },
  ]);
  ownerToken = (await createSession(ownerEmail)).sessionToken; memberToken = (await createSession(memberEmail)).sessionToken;

  otherOrgId = (await c.orgs.insertOne({ name: `di-${RUN}-other-co`, createdAt: now })).insertedId; created.push(otherOrgId);
  const otherOwnerEmail = `di-${RUN}-other-owner@example.com`;
  await c.orgMembers.insertOne({ orgId: otherOrgId, email: otherOwnerEmail, role: "owner", departmentIds: [], status: "active", createdAt: now });
  otherOwnerToken = (await createSession(otherOwnerEmail)).sessionToken;
});

test("built-in analyzers are listed and are ACTIVE without being created", async () => {
  const r = await j(await analyzersGet(jreq("GET", `/api/orgs/doc-intelligence/analyzers?orgId=${orgId}`, { token: ownerToken })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.analyzers.some((a) => a.analyzerKey === "prebuilt-invoice" && a.status === "ACTIVE" && a.builtin));
});

test("a plain member cannot create a custom analyzer; an owner can", async () => {
  const body = { orgId: String(orgId), name: "Delivery Note", method: "EXTRACT", fieldSchema: [{ name: "poNumber", type: "string", required: true }, { name: "deliveryDate", type: "date", required: false }, { name: "carrier", type: "string", required: false }] };
  const denied = await j(await analyzersPost(jreq("POST", "/api/orgs/doc-intelligence/analyzers", { token: memberToken, body })));
  assert.equal(denied.status, 403);
  const ok = await j(await analyzersPost(jreq("POST", "/api/orgs/doc-intelligence/analyzers", { token: ownerToken, body })));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.analyzer.status, "DRAFT");
  analyzerId = ok.body.analyzer.analyzerId;
});

test("analyzer lifecycle: only legal transitions are allowed, built-ins can't be touched", async () => {
  const skip = await j(await analyzerPatch(jreq("PATCH", `/api/orgs/doc-intelligence/analyzers/${analyzerId}`, { token: ownerToken, body: { orgId: String(orgId), status: "ACTIVE" } }), { params: params({ analyzerId }) }));
  assert.equal(skip.status, 409, "DRAFT -> ACTIVE directly must be rejected");
  for (const status of ["TESTING", "READY", "ACTIVE"]) {
    const r = await j(await analyzerPatch(jreq("PATCH", `/api/orgs/doc-intelligence/analyzers/${analyzerId}`, { token: ownerToken, body: { orgId: String(orgId), status } }), { params: params({ analyzerId }) }));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.analyzer.status, status);
  }
  const bi = await j(await analyzerPatch(jreq("PATCH", "/api/orgs/doc-intelligence/analyzers/prebuilt-invoice", { token: ownerToken, body: { orgId: String(orgId), status: "DISABLED" } }), { params: params({ analyzerId: "prebuilt-invoice" }) }));
  assert.equal(bi.status, 403);
});

test("analyze: deterministic + AI-corroborated extraction, grounded fields, Evidence Graph link recorded", async () => {
  __setAiProvider(async () => ({ text: JSON.stringify({ poNumber: "PO-9931", deliveryDate: "2026-08-01", carrier: "Fast Freight", confidence: 0.92 }) }));
  const text = "Delivery Note\nPO Number: PO-9931\nDelivery Date: 2026-08-01\nCarrier: Fast Freight Co\nItems: 4 pallets";
  const fd = new FormData(); fd.append("file", new Blob([text], { type: "text/plain" }), "delivery.txt");
  const r = await j(await analyzePost(freq(`/api/orgs/doc-intelligence/analyze?orgId=${orgId}&analyzerId=${analyzerId}`, { token: ownerToken, form: fd })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.status, "PROCESSED", JSON.stringify(r.body));
  assert.equal(r.body.result.fields.poNumber.value, "PO-9931");
  assert.equal(r.body.result.fields.poNumber.source, "deterministic", "PO number is in the text, deterministic pass should have found it");
  assert.equal(r.body.result.extractionConfidence > 0.8, true);
  global.__diResultId = r.body.result.resultId;

  const one = await j(await resultGet(jreq("GET", `/api/orgs/doc-intelligence/results/${r.body.result.resultId}?orgId=${orgId}`, { token: ownerToken }), { params: params({ resultId: r.body.result.resultId }) }));
  assert.equal(one.status, 200); assert.equal(one.body.result.resultId, r.body.result.resultId);

  // Evidence Graph: this analysis result became a real subject with a real ANALYZED_BY relationship, not a
  // second, disconnected record of what happened.
  await flushEvidence();
  const events = await listBusinessEvents({ orgId: String(orgId), membership: { role: "owner" }, subjectType: "DOC_INTELLIGENCE_RESULT" });
  const ev = events.find((e) => String(e.subjectId) === r.body.result.resultId);
  assert.ok(ev, "an Evidence Graph subject should exist for this result");
  assert.ok(ev.relationships.some((rel) => rel.type === "ANALYZED_BY"), "the analyzer run should be linked");
});

test("analyze: the same file against the same analyzer is reported as a duplicate, not reprocessed", async () => {
  __setAiProvider(async () => ({ text: JSON.stringify({ poNumber: "PO-9931", confidence: 0.9 }) }));
  const text = "Delivery Note\nPO Number: PO-9931\nDelivery Date: 2026-08-01\nCarrier: Fast Freight Co\nItems: 4 pallets";
  const fd = new FormData(); fd.append("file", new Blob([text], { type: "text/plain" }), "delivery.txt");
  const r = await j(await analyzePost(freq(`/api/orgs/doc-intelligence/analyze?orgId=${orgId}&analyzerId=${analyzerId}`, { token: ownerToken, form: fd })));
  assert.equal(r.status, 200); assert.equal(r.body.duplicate, true);
});

test("analyze: a document missing a required field is routed to human review, not silently accepted", async () => {
  __setAiProvider(async () => ({ text: JSON.stringify({ carrier: "Slow Freight", confidence: 0.6 }) }));
  const text = "Delivery slip, no PO number printed. Carrier: Slow Freight.";
  const fd = new FormData(); fd.append("file", new Blob([text], { type: "text/plain" }), "delivery2.txt");
  const r = await j(await analyzePost(freq(`/api/orgs/doc-intelligence/analyze?orgId=${orgId}&analyzerId=${analyzerId}`, { token: ownerToken, form: fd })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.status, "NEEDS_REVIEW");
  assert.ok(r.body.result.missing.includes("poNumber"));
  global.__diReviewResultId = r.body.result.resultId;

  const q = await j(await reviewGet(jreq("GET", `/api/orgs/doc-intelligence/review?orgId=${orgId}`, { token: ownerToken })));
  assert.equal(q.status, 200);
  const item = q.body.items.find((i) => i.resultId === global.__diReviewResultId);
  assert.ok(item, "a review item should exist for the low-confidence result");
  global.__diReviewItemId = item.itemId;
});

test("review: a plain member cannot resolve a review item; an owner can apply a versioned correction", async () => {
  const denied = await j(await reviewAct(jreq("POST", `/api/orgs/doc-intelligence/review/${global.__diReviewItemId}`, { token: memberToken, body: { orgId: String(orgId), action: "edit", corrections: [{ field: "poNumber", value: "PO-8800" }] } }), { params: params({ itemId: global.__diReviewItemId }) }));
  assert.equal(denied.status, 403);
  const ok = await j(await reviewAct(jreq("POST", `/api/orgs/doc-intelligence/review/${global.__diReviewItemId}`, { token: ownerToken, body: { orgId: String(orgId), action: "edit", corrections: [{ field: "poNumber", value: "PO-8800", note: "read off the paper original" }] } }), { params: params({ itemId: global.__diReviewItemId }) }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.corrections, 1);

  const after1 = await j(await resultGet(jreq("GET", `/api/orgs/doc-intelligence/results/${global.__diReviewResultId}?orgId=${orgId}`, { token: ownerToken }), { params: params({ resultId: global.__diReviewResultId }) }));
  assert.equal(after1.body.result.status, "PROCESSED");
  assert.equal(after1.body.result.corrections.length, 1);
  assert.equal(after1.body.result.corrections[0].value, "PO-8800");
  assert.equal(after1.body.result.fields.poNumber, undefined, "the ORIGINAL extraction is untouched -- the correction is layered, not overwritten");

  const resolved = await j(await reviewGet(jreq("GET", `/api/orgs/doc-intelligence/review?orgId=${orgId}&status=OPEN`, { token: ownerToken })));
  assert.ok(!resolved.body.items.some((i) => i.itemId === global.__diReviewItemId), "the item is no longer open");
});

test("evaluation: precision/recall/field accuracy/grounding/correction rate are reported separately, never as one score", async () => {
  const fieldSchema = [{ name: "poNumber", type: "string", required: true }, { name: "deliveryDate", type: "date", required: false }, { name: "carrier", type: "string", required: false }];
  const samples = [
    { resultId: global.__diResultId, expectedFields: { poNumber: "PO-9931", carrier: "Fast Freight" } },
    { resultId: global.__diReviewResultId, expectedFields: { poNumber: "PO-8800", carrier: "Slow Freight Logistics Ltd" } },
  ];
  // analyzerKey must match exactly what was stored; fetch the real key from the result instead of guessing it.
  const one = await j(await resultGet(jreq("GET", `/api/orgs/doc-intelligence/results/${global.__diResultId}?orgId=${orgId}`, { token: ownerToken }), { params: params({ resultId: global.__diResultId }) }));
  const analyzerKey = one.body.result.analyzerKey;
  const real = await j(await evaluatePost(jreq("POST", "/api/orgs/doc-intelligence/evaluate", { token: ownerToken, body: { orgId: String(orgId), analyzerKey, fieldSchema, samples } })));
  assert.equal(real.status, 200, JSON.stringify(real.body));
  assert.ok(real.body.metrics.fieldAccuracy > 0 && real.body.metrics.fieldAccuracy < 1, "one correct field, one corrected/mismatched field -- accuracy should be partial, not 0 or 1");
  assert.equal(real.body.metrics.correctionRate, 0.5, "1 of 2 evaluated results had a human correction applied");
  assert.ok(real.body.metrics.groundingRate > 0);
});

test("cross-org isolation: another organization cannot see this org's analyzer or results", async () => {
  const listA = await j(await analyzersGet(jreq("GET", `/api/orgs/doc-intelligence/analyzers?orgId=${otherOrgId}`, { token: otherOwnerToken })));
  assert.ok(!listA.body.analyzers.some((a) => a.analyzerId === analyzerId), "the other org must not see this org's custom analyzer");
  const leak = await j(await resultGet(jreq("GET", `/api/orgs/doc-intelligence/results/${global.__diResultId}?orgId=${otherOrgId}`, { token: otherOwnerToken }), { params: params({ resultId: global.__diResultId }) }));
  assert.equal(leak.status, 404);
});
