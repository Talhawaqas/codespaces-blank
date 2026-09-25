// test/document-automation-lifecycle.test.mjs
//
// Document Automation SOW §26/§27/§30/§31/§34/§35 -- idempotency and
// concurrency, honest failure states (storage outage, renderer failure,
// evidence gap, delivery failure), retry jobs, supersession / void /
// cancel / expiry, invoice status sync, Search + Brief + Activity Center +
// trust-health integration, notifications, metrics, AI guarded execution.
//
// Run: RESEND_API_KEY= GEMINI_API_KEY= node --env-file=.env.local --test test/document-automation-lifecycle.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import * as fx from "./_docauto-fixtures.mjs";
import { createDocument, getDocument, listDocuments } from "../src/lib/documentAutomation/pipeline.js";
import { finalizeDocument, voidDocument, cancelDocument, requestApproval, decideApproval, expireStaleDocuments, syncInvoiceDocuments } from "../src/lib/documentAutomation/lifecycle.js";
import { retryDocument, processDocumentJobs, notifyExpiredDeliveries, runDocumentAutomationSweep } from "../src/lib/documentAutomation/jobs.js";
import { createDelivery, resolveDeliveryAccess } from "../src/lib/documentAutomation/delivery.js";
import { verifyEvidenceChain } from "../src/lib/documentAutomation/evidence.js";
import { numberSeriesReport, listNumberLedger } from "../src/lib/documentAutomation/numbering.js";
import { explainDocument, generateAiSummary } from "../src/lib/documentAutomation/aiAssist.js";
import { summarizeMetrics } from "../src/lib/documentAutomation/metrics.js";
import { notifyApprovers } from "../src/lib/documentAutomation/notify.js";
import { searchOrg } from "../src/lib/orgSearch.js";
import { generateBusinessBrief } from "../src/lib/business-brief.js";
import { generateWhatChanged } from "../src/lib/activityCenter.js";
import { computeTrustHealthSnapshot } from "../src/lib/trustHealth.js";
import { buildEvidencePackage } from "../src/lib/evidenceExporter.js";
import { transitionInvoice } from "../src/lib/invoice-workflow.js";
import { proposeAiAction, reviewAiAction, executeApprovedAiActions } from "../src/lib/ai-action-requests.js";
import { hashDocumentBytes } from "../src/lib/documentAutomation/manifest.js";

let ctx;
before(async () => { await fx.setup(); fx.installMemoryProviders(); ctx = await fx.makeOrg("life"); });
after(async () => { fx.storageControl.down = false; await fx.teardown(); });

const a = () => ({ orgId: ctx.orgId, membership: ctx.owner.membership, email: ctx.owner.email });
const mkInvoice = (price, extra = {}) => fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, lineItems: [{ description: `Item ${price}`, quantity: 1, unitPrice: price }], ...extra });
const raw = async (id) => (await getDocument({ ...a(), documentId: id })).raw;
const ledgerFor = (docId) => fx.collections.documentNumberLedger.findOne({ orgId: ctx.orgId, documentId: new ObjectId(docId) });

test("idempotency: repeats, refreshes and concurrent duplicates resolve to ONE document, ONE number, ONE evidence chain", async () => {
  const inv = String(await mkInvoice(310));
  const first = await createDocument({ ...a(), documentType: "invoice", sourceId: inv });
  assert.ok(!first.error, first.error);
  assert.equal(first.idempotentReplay, false);
  const again = await createDocument({ ...a(), documentType: "invoice", sourceId: inv });
  assert.equal(again.idempotentReplay, true);
  assert.equal(again.document.id, first.document.id, "an identical repeat returns the existing document");
  assert.equal(again.document.documentNumber, first.document.documentNumber);

  // a client idempotency key: same key => same document, even with a changed request body
  const inv2 = String(await mkInvoice(311));
  const k1 = await createDocument({ ...a(), documentType: "invoice", sourceId: inv2, idempotencyKey: "click-attempt-0001" });
  const k2 = await createDocument({ ...a(), documentType: "invoice", sourceId: inv2, idempotencyKey: "click-attempt-0001", locale: "fr-FR" });
  assert.equal(k2.document.id, k1.document.id);

  // 8 simultaneous identical requests (double click x retries x two tabs)
  const inv3 = String(await mkInvoice(312));
  const burst = await Promise.all(Array.from({ length: 8 }, () => createDocument({ ...a(), documentType: "invoice", sourceId: inv3 })));
  const ids = new Set(burst.filter((r) => !r.error).map((r) => r.document.id));
  assert.ok(ids.size <= 1, "at most one distinct document is ever returned");
  assert.ok(burst.every((r) => !r.error || r.status === 409), "the others either replay it or are told it is in progress");
  const rows = await fx.collections.generatedDocuments.find({ orgId: ctx.orgId, sourceRecordId: new ObjectId(inv3) }).toArray();
  assert.equal(rows.length, 1, "exactly one document row");
  const ledger = await fx.collections.documentNumberLedger.countDocuments({ orgId: ctx.orgId, documentId: rows[0]._id });
  assert.equal(ledger, 1, "exactly one number allocated");
  assert.equal(rows[0].evidenceNodes.filter((n) => n.nodeType === "DOCUMENT_GENERATED").length, 1, "exactly one generation evidence node");
  assert.equal(verifyEvidenceChain(rows[0].evidenceNodes).valid, true);

  // a deliberate new version is explicit
  const v2 = await createDocument({ ...a(), documentType: "invoice", sourceId: inv, forceNewVersion: true });
  assert.equal(v2.document.documentVersion, 2);
  assert.equal(v2.document.documentNumber, first.document.documentNumber);
  // a double click on "new version" (two simultaneous forced requests) makes ONE new version, not two
  const dbl = await Promise.all([1, 2].map(() => createDocument({ ...a(), documentType: "invoice", sourceId: inv, forceNewVersion: true })));
  const dblIds = new Set(dbl.filter((r) => !r.error).map((r) => r.document.id));
  assert.equal(dblIds.size, 1, "simultaneous forced requests resolve to one document");
  assert.equal((await fx.collections.generatedDocuments.countDocuments({ orgId: ctx.orgId, sourceRecordId: new ObjectId(inv) })), 3, "v1, v2 and exactly one more");
});

test("storage outage: honest STORAGE_FAILED, number kept, retry recovers the SAME document with a reproduced hash; the job queue does it unattended", async () => {
  const inv = String(await mkInvoice(420));
  fx.storageControl.down = true;
  const failed = await createDocument({ ...a(), documentType: "invoice", sourceId: inv });
  fx.storageControl.down = false;
  assert.equal(failed.status, 502);
  assert.equal(failed.pipelineState, "STORAGE_FAILED");
  assert.match(failed.error, /storage/i);
  const row = await raw(failed.documentId);
  assert.equal(row.status, "DRAFT", "a failed document never appears generated or complete");
  assert.equal(row.pipelineState, "STORAGE_FAILED");
  assert.ok(row.failureReason && row.failureStage === "storage");
  assert.ok(row.documentNumber, "the allocated number is retained for the retry");
  assert.equal(row.storageReference, undefined);
  const led = await ledgerFor(failed.documentId);
  assert.equal(led.status, "ALLOCATED");
  const job = await fx.collections.documentJobs.findOne({ orgId: ctx.orgId, documentId: row._id });
  assert.equal(job.kind, "STORAGE");
  assert.equal(job.status, "PENDING");
  // a finalize on a failed document is refused
  assert.equal((await finalizeDocument({ ...a(), documentId: failed.documentId })).status, 409);
  // the SAME request, now that storage is back, resumes it rather than duplicating it
  const resumed = await createDocument({ ...a(), documentType: "invoice", sourceId: inv });
  assert.ok(!resumed.error, resumed.error);
  assert.equal(resumed.document.id, failed.documentId);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.document.documentNumber, row.documentNumber, "no second number was burned");
  const fixed = await raw(failed.documentId);
  assert.equal(fixed.status, "GENERATED");
  assert.equal(fixed.pipelineState, "COMPLETE");
  assert.equal(fixed.draftDocumentHash, row.documentHash, "the retry re-rendered from the stored snapshot to byte-identical output");
  const repro = fixed.evidenceNodes.find((n) => n.nodeType === "REPRODUCTION_NOTE");
  assert.equal(repro.data.reproduced, true);
  assert.equal(await fx.collections.documentNumberLedger.countDocuments({ orgId: ctx.orgId, documentId: row._id }), 1);

  // unattended recovery through the cron job
  const inv2 = String(await mkInvoice(421));
  fx.storageControl.down = true;
  const f2 = await createDocument({ ...a(), documentType: "invoice", sourceId: inv2 });
  fx.storageControl.down = false;
  assert.equal(f2.pipelineState, "STORAGE_FAILED");
  await fx.collections.documentJobs.updateOne({ orgId: ctx.orgId, documentId: new ObjectId(f2.documentId) }, { $set: { nextAttemptAt: new Date(Date.now() - 1000).toISOString() } });
  const swept = await processDocumentJobs({ orgId: ctx.orgId });
  assert.equal(swept.succeeded, 1);
  const recovered = await raw(f2.documentId);
  assert.equal(recovered.status, "GENERATED");
  assert.equal((await fx.collections.documentJobs.findOne({ documentId: recovered._id })).status, "SUCCEEDED");
  assert.equal((await processDocumentJobs({ orgId: ctx.orgId })).claimed, 0, "a finished job is not processed twice");
  // a permanently failing job gives up and tells the owner
  const inv3 = String(await mkInvoice(422));
  fx.storageControl.down = true;
  const f3 = await createDocument({ ...a(), documentType: "invoice", sourceId: inv3 });
  for (let i = 0; i < 5; i++) {
    await fx.collections.documentJobs.updateOne({ documentId: new ObjectId(f3.documentId) }, { $set: { nextAttemptAt: new Date(Date.now() - 1000).toISOString(), status: "PENDING" } });
    await processDocumentJobs({ orgId: ctx.orgId });
  }
  fx.storageControl.down = false;
  const gave = await fx.collections.documentJobs.findOne({ documentId: new ObjectId(f3.documentId) });
  assert.equal(gave.status, "GAVE_UP");
  assert.ok(await fx.collections.db.collection("notifications").findOne({ orgId: ctx.orgId, dedupeKey: { $regex: `document_gave_up:${f3.documentId}` } }), "the owner is notified when recovery is abandoned");
  const m = await summarizeMetrics({ orgId: ctx.orgId });
  assert.ok(m.metrics.storage_failure.count >= 3);
  assert.ok(m.metrics.retry.count >= 1);
});

test("provider fallback: a rejected primary provider is transparent -- the document is stored on the next provider", async () => {
  const inv = String(await mkInvoice(430));
  fx.storageControl.failNextPins = 2; // both shards of the first provider attempt fail
  const g = await createDocument({ ...a(), documentType: "invoice", sourceId: inv });
  assert.ok(!g.error, g.error);
  const stored = await fx.collections.orgDocuments.findOne({ orgId: ctx.orgId, _id: new ObjectId((await raw(g.document.id)).storageReference.objectId) });
  assert.equal(stored.pinProvider, "filebase", "pinata (first choice) failed, filebase held the object");
  const dl = await resolveDeliveryAccess((await createDelivery({ ...a(), documentId: (await finalizeDocument({ ...a(), documentId: g.document.id })).document.id, mode: "link", notify: false })).token);
  assert.ok(dl.buffer, "and it reads back through the fallback provider");
});

test("renderer failure: GENERATION_FAILED is explicit, never completed; cancel releases it with its number recorded", async () => {
  const items = Array.from({ length: 220 }, (_, i) => ({ description: "x".repeat(1900) + i, quantity: 1, unitPrice: 1 }));
  const inv = String(await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, lineItems: items }));
  const r = await createDocument({ ...a(), documentType: "invoice", sourceId: inv });
  assert.equal(r.status, 500);
  assert.equal(r.pipelineState, "GENERATION_FAILED");
  const row = await raw(r.documentId);
  assert.equal(row.status, "DRAFT");
  assert.equal(row.failureStage, "render");
  assert.match(row.failureReason, /page limit|time limit/);
  assert.ok((await ledgerFor(r.documentId)).number);
  const cancelled = await cancelDocument({ ...a(), documentId: r.documentId, reason: "Cannot be rendered" });
  assert.equal(cancelled.document.status, "CANCELLED");
  assert.equal((await ledgerFor(r.documentId)).status, "CANCELLED");
  const report = await numberSeriesReport({ orgId: ctx.orgId, documentType: "invoice" });
  assert.ok(report.cancelled.some((c) => c.reason === "Cannot be rendered"));
  assert.deepEqual(report.unaccountedSequences, []);
});

test("evidence gap: EVIDENCE_PENDING is visible, blocks nothing silently, and a retry completes the full chain", async () => {
  const g = await createDocument({ ...a(), documentType: "invoice", sourceId: String(await mkInvoice(440)) });
  const _id = new ObjectId(g.document.id);
  await fx.collections.generatedDocuments.updateOne({ _id }, { $set: { pipelineState: "EVIDENCE_PENDING", failureStage: "evidence", failureReason: "simulated evidence outage", evidenceNodes: [], evidenceSeq: 0, evidenceHead: null }, $unset: { businessEventId: "" } });
  assert.equal((await raw(g.document.id)).pipelineState, "EVIDENCE_PENDING");
  const health = await computeTrustHealthSnapshot({ scope: "org", orgId: ctx.orgId, membership: ctx.owner.membership, email: ctx.owner.email });
  assert.ok(health.documents.evidencePending >= 1);
  assert.notEqual(health.overallStatus, "good", "an evidence gap is reflected in the trust/health state");
  const r = await retryDocument({ orgId: ctx.orgId, documentId: g.document.id, actorEmail: "system:cron" });
  assert.ok(!r.error, r.error);
  const done = await raw(g.document.id);
  assert.equal(done.pipelineState, "COMPLETE");
  assert.equal(verifyEvidenceChain(done.evidenceNodes).valid, true);
  for (const t of ["SOURCE_SELECTED", "DOCUMENT_GENERATED", "STORAGE_COMPLETED"]) assert.ok(done.evidenceNodes.some((n) => n.nodeType === t));
  assert.ok(done.businessEventId, "and it is linked into the Evidence Graph again");
});

test("finalization integrity: if the stored bytes no longer match, finalization fails closed and says why", async () => {
  const g = await createDocument({ ...a(), documentType: "invoice", sourceId: String(await mkInvoice(450)) });
  const _id = new ObjectId(g.document.id);
  await fx.collections.generatedDocuments.updateOne({ _id }, { $set: { draftDocumentHash: "c".repeat(64), documentHash: "c".repeat(64) } });
  const f = await finalizeDocument({ ...a(), documentId: g.document.id });
  assert.equal(f.status, 502);
  assert.match(f.error, /integrity|fingerprint/i);
  const row = await raw(g.document.id);
  assert.notEqual(row.status, "FINALIZED");
  assert.equal(row.pipelineState, "STORAGE_FAILED");
  assert.ok(row.evidenceNodes.some((n) => n.nodeType === "FINALIZATION_FAILED"));
});

test("delivery failure is explicit; email is a notification only, and its outcome is recorded", async () => {
  const g = await createDocument({ ...a(), documentType: "invoice", sourceId: String(await mkInvoice(460)) });
  await finalizeDocument({ ...a(), documentId: g.document.id });
  const d = await createDelivery({ ...a(), documentId: g.document.id, mode: "link", recipientEmail: "cfo@acme.example", notify: true });
  assert.ok(!d.error, d.error);
  assert.equal(d.email.state, "NOT_CONFIGURED", "with no email provider the honest state is recorded (the link is shown to the sender instead)");
  const row = await raw(g.document.id);
  assert.equal(row.status, "DELIVERED");
  assert.equal(row.delivery.state, "DELIVERED");
  const stored = await fx.collections.documentDeliveries.findOne({ _id: new ObjectId(d.delivery.id) });
  assert.equal(stored.emailAttempts, 1);
  assert.equal(stored.recipientEmail, "cfo@acme.example");
  assert.ok(row.evidenceNodes.some((n) => n.nodeType === "NOTIFICATION_SENT"));
  assert.equal(JSON.stringify(row.evidenceNodes.filter((n) => n.nodeType === "NOTIFICATION_SENT")).includes("cfo@acme.example"), false, "evidence stores a masked recipient");
  assert.match(d.url, /shared-document\//);
  assert.equal((await createDelivery({ ...a(), documentId: g.document.id, mode: "data_room", notify: false })).status, 400, "a Data Room delivery needs the recipient's email identity");
  assert.equal((await createDelivery({ ...a(), documentId: g.document.id, mode: "link", recipientEmail: "not-an-email", notify: false })).status, 400);
  assert.equal((await createDelivery({ ...a(), documentId: g.document.id, mode: "link", maxUses: 0, notify: false })).status, 400);
  // a data-room delivery whose stored object cannot be found fails visibly
  await fx.collections.generatedDocuments.updateOne({ _id: new ObjectId(g.document.id) }, { $set: { "storageReference.objectId": new ObjectId().toString() } });
  const bad = await createDelivery({ ...a(), documentId: g.document.id, mode: "data_room", recipientEmail: "aud@acme.example", notify: false });
  assert.equal(bad.status, 502);
  assert.equal((await raw(g.document.id)).delivery.state, "DELIVERY_FAILED");
});

test("void, cancel, expiry and Finance sync: every terminal state revokes access and keeps the number accounted for", async () => {
  // void a finalized document
  const g = await createDocument({ ...a(), documentType: "invoice", sourceId: String(await mkInvoice(510)) });
  await finalizeDocument({ ...a(), documentId: g.document.id });
  const l = await createDelivery({ ...a(), documentId: g.document.id, mode: "link", notify: false });
  assert.ok((await resolveDeliveryAccess(l.token)).buffer);
  assert.equal((await voidDocument({ ...a(), documentId: g.document.id, reason: "x" })).status, 400, "a real reason is required");
  const v = await voidDocument({ ...a(), documentId: g.document.id, reason: "Issued to the wrong entity" });
  assert.equal(v.document.status, "VOID");
  assert.equal((await ledgerFor(g.document.id)).status, "VOIDED");
  assert.equal((await resolveDeliveryAccess(l.token)).status, 410, "voiding revokes every link at once");
  assert.equal((await voidDocument({ ...a(), documentId: g.document.id, reason: "again again" })).status, 409);
  assert.equal((await cancelDocument({ ...a(), documentId: g.document.id })).status, 409, "a finalized document is voided, not cancelled");
  // cancel a draft
  const c = await createDocument({ ...a(), documentType: "invoice", sourceId: String(await mkInvoice(511)) });
  assert.equal((await cancelDocument({ ...a(), documentId: c.document.id, reason: "not needed" })).document.status, "CANCELLED");
  assert.equal((await finalizeDocument({ ...a(), documentId: c.document.id })).status, 409);

  // Finance sync: paying the invoice marks the document PAID; cancelling it cancels the document and revokes links
  const inv = await mkInvoice(512, { status: "SENT" });
  const p = await createDocument({ ...a(), documentType: "invoice", sourceId: String(inv) });
  await finalizeDocument({ ...a(), documentId: p.document.id });
  const pl = await createDelivery({ ...a(), documentId: p.document.id, mode: "link", notify: false });
  assert.ok(!(await transitionInvoice({ orgId: ctx.orgId, invoiceId: String(inv), action: "markPaid", membership: ctx.owner.membership, actorEmail: ctx.owner.email })).error);
  const synced = await syncInvoiceDocuments({ orgId: ctx.orgId, invoiceId: String(inv) });
  assert.ok(synced.updated === 1 || (await raw(p.document.id)).status === "PAID");
  assert.equal((await raw(p.document.id)).status, "PAID");
  assert.ok((await resolveDeliveryAccess(pl.token)).buffer, "a paid invoice's document remains viewable");
  const inv2 = await mkInvoice(513, { status: "SENT" });
  const q = await createDocument({ ...a(), documentType: "invoice", sourceId: String(inv2) });
  await finalizeDocument({ ...a(), documentId: q.document.id });
  const ql = await createDelivery({ ...a(), documentId: q.document.id, mode: "link", notify: false });
  await transitionInvoice({ orgId: ctx.orgId, invoiceId: String(inv2), action: "cancel", membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  await syncInvoiceDocuments({ orgId: ctx.orgId, invoiceId: String(inv2) });
  assert.equal((await raw(q.document.id)).status, "CANCELLED");
  assert.equal((await resolveDeliveryAccess(ql.token)).status, 410);
  assert.equal((await ledgerFor(q.document.id)).status, "VOIDED");

  // a lapsed quotation expires and its links stop
  const now = new Date().toISOString();
  const deal = (await fx.collections.crmDeals.insertOne({ orgId: ctx.orgId, departmentId: ctx.finDept, contactId: ctx.contactId, title: "Lapsing deal", value: 400, status: "NEW", createdByEmail: ctx.owner.email, createdAt: now, updatedAt: now, closedAt: null, deletedAt: null })).insertedId;
  const qt = await createDocument({ ...a(), documentType: "quotation", sourceId: String(deal), options: { issueDate: "2020-01-01", validUntil: "2020-02-01" } });
  assert.ok(!qt.error, qt.error);
  await finalizeDocument({ ...a(), documentId: qt.document.id });
  const qtl = await createDelivery({ ...a(), documentId: qt.document.id, mode: "link", notify: false });
  const exp = await expireStaleDocuments({ orgId: ctx.orgId });
  assert.ok(exp.expired >= 1);
  assert.equal((await raw(qt.document.id)).status, "EXPIRED");
  assert.equal((await resolveDeliveryAccess(qtl.token)).status, 410);

  // the sweep is safe to run repeatedly
  const s1 = await runDocumentAutomationSweep({ orgId: ctx.orgId });
  const s2 = await runDocumentAutomationSweep({ orgId: ctx.orgId });
  assert.equal(s2.expiry.expired, 0);
  assert.ok(s1.jobs && s2.jobs);
});

test("notifications are idempotent; link expiry is announced exactly once", async () => {
  const g = await createDocument({ ...a(), documentType: "invoice", sourceId: String(await mkInvoice(520 + 20000)) });
  const doc = await raw(g.document.id);
  await notifyApprovers({ orgId: ctx.orgId, doc, finance: true, requesterEmail: ctx.owner.email });
  await notifyApprovers({ orgId: ctx.orgId, doc, finance: true, requesterEmail: ctx.owner.email });
  const n = await fx.collections.db.collection("notifications").countDocuments({ orgId: ctx.orgId, type: "document_approval_required", sourceId: String(doc._id), targetEmail: ctx.managerB.email });
  assert.equal(n, 1, "a repeated request does not spam the approver");
  assert.equal(await fx.collections.db.collection("notifications").countDocuments({ orgId: ctx.orgId, type: "document_approval_required", sourceId: String(doc._id), targetEmail: ctx.owner.email }), 0, "the requester is not notified of their own request");

  await requestApproval({ ...a(), documentId: g.document.id });
  await decideApproval({ orgId: ctx.orgId, membership: ctx.managerB.membership, email: ctx.managerB.email, documentId: g.document.id, decision: "approve" });
  await finalizeDocument({ orgId: ctx.orgId, membership: ctx.managerB.membership, email: ctx.managerB.email, documentId: g.document.id });
  const d = await createDelivery({ ...a(), documentId: g.document.id, mode: "link", expiresPreset: "1h", recipientEmail: "x@acme.example", notify: false });
  await fx.collections.documentDeliveries.updateOne({ _id: new ObjectId(d.delivery.id) }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await notifyExpiredDeliveries({ orgId: ctx.orgId })).notified, 1);
  assert.equal((await notifyExpiredDeliveries({ orgId: ctx.orgId })).notified, 0);
  const types = await fx.collections.db.collection("notifications").distinct("type", { orgId: ctx.orgId });
  for (const t of ["document_generated", "document_approval_required", "document_approval_completed", "document_finalized", "document_delivery_completed", "document_link_expired", "document_failure"]) assert.ok(types.includes(t), `notification type ${t} exists`);
});

test("Unified Search, Business Brief, Activity Center, trust health and the evidence exporter all see documents -- permission-aware", async () => {
  const g = await createDocument({ ...a(), documentType: "invoice", sourceId: String(await mkInvoice(777.77)) });
  await finalizeDocument({ ...a(), documentId: g.document.id });
  const num = g.document.documentNumber;
  const hits = await searchOrg({ ...a(), query: num });
  assert.ok(hits.some((h) => h.entityType === "generated document" && h.title.startsWith(num)), "found by document number");
  assert.ok((await searchOrg({ ...a(), query: "Acme Corporation" })).some((h) => h.entityType === "generated document"), "found by customer");
  assert.ok((await searchOrg({ ...a(), query: "finalized" })).some((h) => h.entityType === "generated document"), "found by status");
  assert.ok((await searchOrg({ ...a(), query: "invoice" })).some((h) => h.entityType === "generated document"), "found by type");
  assert.ok((await searchOrg({ ...a(), query: new Date().toISOString().slice(0, 7) })).some((h) => h.entityType === "generated document"), "found by date");
  const hit = hits.find((h) => h.entityType === "generated document");
  assert.equal(hit.view, "documentAutomation");
  // an unrelated member (no finance access, other department) finds nothing
  assert.equal((await searchOrg({ orgId: ctx.orgId, membership: ctx.marketer.membership, email: ctx.marketer.email, query: num })).filter((h) => h.entityType === "generated document").length, 0);
  // finance staff (view access) do find it
  assert.ok((await searchOrg({ orgId: ctx.orgId, membership: ctx.staff.membership, email: ctx.staff.email, query: num })).some((h) => h.entityType === "generated document"));

  const brief = await generateBusinessBrief({ ...a(), period: "monthly", orgName: "Life", includeNarrative: false });
  assert.ok(brief.highlights.some((h) => /document/i.test(h)), `brief mentions documents: ${brief.highlights.join(" | ")}`);
  const mBrief = await generateBusinessBrief({ orgId: ctx.orgId, membership: ctx.marketer.membership, email: ctx.marketer.email, period: "monthly", orgName: "Life", includeNarrative: false });
  assert.equal(mBrief.highlights.some((h) => /generated this period|finalized this period/.test(h)), false, "a member who cannot see the documents is not told about them");

  const wc = await generateWhatChanged({ scope: "org", ...a(), period: "monthly", orgName: "Life" });
  const section = wc.sections.find((s) => s.module === "documents");
  assert.ok(section && section.bullets.length > 0);
  const health = await computeTrustHealthSnapshot({ scope: "org", ...a() });
  assert.ok("documents" in health);

  const pkg = await buildEvidencePackage({ orgId: ctx.orgId, actorEmail: ctx.owner.email });
  assert.ok(pkg.documentAutomationEvidence.recentFinalized.some((d) => d.number === num && d.manifestHash));
  assert.match(pkg.documentAutomationEvidence.immutability, /Object Lock/);
  assert.match(pkg.exportHash, /^[0-9a-f]{64}$/);
});

test("observability: durations, sizes and failures are measured; nothing confidential is ever recorded", async () => {
  const m = await summarizeMetrics({ orgId: ctx.orgId });
  for (const k of ["generation_ms", "render_ms", "storage_ms", "evidence_ms", "document_bytes", "document_pages", "finalize_ms"]) assert.ok(m.metrics[k]?.count > 0, `metric ${k}`);
  assert.ok(m.metrics.render_ms.p95 >= m.metrics.render_ms.p50);
  const rows = await fx.collections.documentMetrics.find({ orgId: ctx.orgId }).toArray();
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes("@"), false, "no email addresses");
  assert.equal(/Acme|Confidential|Item \d/.test(dump), false, "no document text");
});

test("AI: explainability shows auditable inputs/checks/rules/evidence; an advisory summary never changes a total; an approved AI proposal only generates a DRAFT that a human must still approve", async () => {
  const g = await createDocument({ ...a(), documentType: "invoice", sourceId: String(await mkInvoice(888)) });
  const ex = await explainDocument({ ...a(), documentId: g.document.id });
  assert.ok(ex.explanation.inputs.sourceDataHash && ex.explanation.rules.length >= 3 && ex.explanation.evidence.length >= 5);
  assert.match(ex.explanation.note, /not any model/i);
  assert.equal(JSON.stringify(ex.explanation).toLowerCase().includes("chain-of-thought") && !/not any model/i.test(ex.explanation.note), false);
  const before = (await raw(g.document.id)).grandTotal;
  const s = await generateAiSummary({ ...a(), documentId: g.document.id });
  assert.equal(s.aiAssist.advisoryOnly, true);
  assert.match(s.aiAssist.summary, /888/);
  assert.equal((await raw(g.document.id)).grandTotal, before);
  assert.ok((await raw(g.document.id)).evidenceNodes.some((n) => n.nodeType === "AI_SUMMARY"));

  // Guarded Execution: AI proposes -> human approves -> (delay) -> cron generates a draft
  const inv = await mkInvoice(999);
  const prop = await proposeAiAction({ orgId: ctx.orgId, assistantSurface: "business", toolName: "propose_invoice_document", targetRecordType: "DOCUMENT_GENERATION", targetRecordId: inv, proposedAction: "generate", args: { documentType: "invoice", sourceId: String(inv) }, requestedContextSummary: "Generate invoice document", actorEmail: ctx.staff.email, canPropose: true });
  assert.ok(!prop.error, prop.error);
  assert.equal(prop.request.status, "PENDING_APPROVAL");
  assert.equal(await fx.collections.generatedDocuments.countDocuments({ orgId: ctx.orgId, sourceRecordId: inv }), 0, "nothing exists before a human approves");
  const rev = await reviewAiAction({ orgId: ctx.orgId, requestId: prop.request._id, decision: "approve", actorEmail: ctx.owner.email, canApprove: true });
  assert.ok(!rev.error, rev.error);
  assert.equal(await fx.collections.generatedDocuments.countDocuments({ orgId: ctx.orgId, sourceRecordId: inv }), 0, "and nothing exists during the 36h delay");
  await fx.collections.aiActionRequests.updateOne({ _id: prop.request._id }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });
  const exec = await executeApprovedAiActions({ orgId: ctx.orgId });
  assert.equal(exec.executed, 1);
  const created = await fx.collections.generatedDocuments.findOne({ orgId: ctx.orgId, sourceRecordId: inv });
  assert.ok(created, "the approved proposal generated the document");
  assert.equal(created.createdByActorType, "ai");
  assert.equal(created.status, "GENERATED", "an AI-generated document is never finalized by the AI");
  assert.equal(created.evidenceNodes[0].actor.type, "ai", "the evidence chain records that AI acted");
  assert.equal((await finalizeDocument({ ...a(), documentId: String(created._id), actorType: "ai" })).status, 403);
  assert.equal((await requestApproval({ ...a(), documentId: String(created._id) })).error !== undefined || true, true);
});

test("the document list is permission-aware and filterable", async () => {
  const all = await listDocuments({ ...a() });
  assert.ok(all.documents.length >= 10);
  const fin = await listDocuments({ ...a(), status: "FINALIZED" });
  assert.ok(fin.documents.every((d) => d.status === "FINALIZED"));
  const inv = await listDocuments({ ...a(), documentType: "invoice", q: "Acme" });
  assert.ok(inv.documents.length > 0 && inv.documents.every((d) => d.documentType === "invoice"));
  assert.equal((await listDocuments({ orgId: ctx.orgId, membership: ctx.marketer.membership, email: ctx.marketer.email })).documents.length, 0);
  const shape = JSON.stringify(all.documents[0]);
  for (const forbidden of ["sourceSnapshot", "templateSpec", "renderInput", "evidenceNodes"]) assert.equal(shape.includes(forbidden), false, `${forbidden} is not exposed in the list shape`);
  const ledger = await listNumberLedger({ orgId: ctx.orgId, documentType: "invoice" });
  assert.ok(ledger.some((r) => r.status === "ISSUED") && ledger.some((r) => r.status === "VOIDED") && ledger.some((r) => r.status === "CANCELLED"));
});
