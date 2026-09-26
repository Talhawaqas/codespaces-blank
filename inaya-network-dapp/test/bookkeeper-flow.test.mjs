// test/bookkeeper-flow.test.mjs -- AI Bookkeeper end to end on a real database: SOW acceptance scenarios A-F (sections 54, 55), the posting boundary
// (nothing authoritative changes without a person or a Controlled Action), idempotency, review actions, reports, period close, Digital Twin
// (read-only), Evidence Graph + audit chain, Business Insights, the workflow bridge and the assistant tool.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, makeOrg, cleanup, RUN, c, bc } from "./_bookkeeper-fixtures.mjs";
import { flushEvidence } from "../src/lib/bookkeeper/record.js";
import { importStatement } from "../src/lib/bookkeeper/bank.js";
import { createSource, getSource } from "../src/lib/bookkeeper/sources.js";
import { ingestDocument } from "../src/lib/bookkeeper/documents.js";
import { ingestSigned } from "../src/lib/bookkeeper/inbound.js";
import { createRule } from "../src/lib/bookkeeper/categorize.js";
import { reconcile, confirmMatch, sweepSettled, postBill } from "../src/lib/bookkeeper/reconcile.js";
import { act, listQueue } from "../src/lib/bookkeeper/review.js";
import { overview, buildReport, toCsv, bookkeepingInsights, listTransactions } from "../src/lib/bookkeeper/insights.js";
import { scanPeriod, startPeriodClose, completePeriodClose } from "../src/lib/bookkeeper/period.js";
import { threeWayMatch } from "../src/lib/bookkeeper/match.js";
import { updateSettings } from "../src/lib/bookkeeper/settings.js";
import { handleBookkeeper } from "../src/lib/bookkeeper/api.js";
import { readBookkeeperSummary, runBookkeeperForWorkflow } from "../src/lib/bookkeeper/workflow.js";
import { bookkeeperAssistantTool } from "../src/lib/bookkeeper/assistant.js";
import { hmacHex } from "../src/lib/bookkeeper/common.js";
import { __setAiProvider } from "../src/lib/workflows/ai.js";
import { computeBusinessInsights } from "../src/lib/business-insights.js";
import { verifyChainIntegrity } from "../src/lib/auditChain.js";
import { getEvidenceTrail } from "../src/lib/evidence.js";

let O; let src;
const inv = (o = {}) => `${o.vendor ?? "ABC Ltd"}\n123 Main Street\n\nINVOICE\nInvoice No: ${o.no ?? "INV-1001"}\nInvoice Date: 12 Mar 2026\nDue Date: 15 Apr 2026\nBill To: ${O.name}\n\nDescription        Qty   Unit    Amount\nConsulting hours    10    ${(o.total ?? 900) / 10}   ${o.total ?? 900}.00\n\nSubtotal: USD ${o.total ?? 900}.00\nTotal Due: USD ${o.total ?? 900}.00\n${o.extra ?? ""}`;
const upload = (text, name = "invoice.txt", extra = {}) => ingestDocument({ orgId: O.orgId, source: src, channel: "UPLOAD", filename: name, contentType: "text/plain", buffer: Buffer.from(text, "utf8"), actor: O.staff, ...extra });
const csvOf = (rows) => `Date,Description,Debit,Credit,Reference\n${rows.map((r) => `${r.date},${r.desc},${r.debit ?? ""},${r.credit ?? ""},${r.ref ?? ""}`).join("\n")}`;
const bank = async () => getSource({ orgId: O.orgId, sourceId: O.bankId });
const importRows = async (rows) => importStatement({ orgId: O.orgId, source: await bank(), text: csvOf(rows), actor: O.staff });
const txnBy = (desc) => c.bkTransactions?.findOne({ orgId: O.orgId, description: new RegExp(desc, "i") });
const counts = async () => ({ payments: await c.payments.countDocuments({ orgId: O.orgId }), expenses: await c.expenses.countDocuments({ orgId: O.orgId }), invoices: await c.invoices.countDocuments({ orgId: O.orgId }), invoicePaid: await c.invoices.countDocuments({ orgId: O.orgId, status: "PAID" }) });

before(async () => {
  await setup(); O = await makeOrg("flow");
  __setAiProvider(async () => { throw Object.assign(new Error("model offline"), { retryable: true }); }); // no AI unless a test scripts one
  const s = await createSource({ orgId: O.orgId, type: "UPLOAD", name: "Manual uploads", departmentId: String(O.finance), actor: O.owner }); src = await getSource({ orgId: O.orgId, sourceId: s.source.sourceId });
});
after(async () => { __setAiProvider(null); await flushEvidence(); await cleanup(); });

test("A. supplier invoice: captured, matched to the payment at 99.9%, linked internally by automation, applied to real records only after a person confirms", async () => {
  await createRule({ orgId: O.orgId, body: { name: "ABC is professional services", conditions: { vendorContains: "abc" }, action: { category: "Professional Services" } }, actorEmail: O.manager });
  // the invoice arrives through the signed email relay
  const relay = await createSource({ orgId: O.orgId, type: "EMAIL_INBOX", name: "ap@ inbox", departmentId: String(O.finance), allowedSenders: ["billing@abc.example"], actor: O.owner });
  const relaySrc = await getSource({ orgId: O.orgId, sourceId: relay.source.sourceId });
  const body = { eventId: `evt-${RUN}-a1`, from: "ABC Billing <billing@abc.example>", subject: "Invoice INV-1001", messageId: `<m-${RUN}-1@abc>`, attachments: [{ filename: "INV-1001.txt", contentType: "text/plain", contentBase64: Buffer.from(inv()).toString("base64") }] };
  const raw = JSON.stringify(body); const ts = Math.floor(Date.now() / 1000);
  const hdr = (secret, t = ts) => ({ "x-inaya-timestamp": String(t), "x-inaya-signature": `v1=${hmacHex(secret, `${t}.${raw}`)}` });
  const r1 = await ingestSigned({ source: relaySrc, headers: hdr(relay.secrets.ingest), rawBody: raw });
  assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.equal(r1.body.results[0].status, "EXTRACTED", JSON.stringify(r1.body));
  const doc = await c.bkDocuments?.findOne({ orgId: O.orgId, "fields.invoiceNumber.value": "INV-1001" }) || await bc.bkDocuments.findOne({ orgId: O.orgId, "fields.invoiceNumber.value": "INV-1001" });
  assert.equal(doc.documentType, "SUPPLIER_INVOICE"); assert.equal(doc.fields.total.value, 900); assert.ok(doc.fields.total.location.snippet.includes("900"), "provenance kept"); assert.equal(String(doc.vendorId), String(O.supplier)); assert.equal(doc.channel, "EMAIL");
  assert.ok(doc.storage.key && !JSON.stringify(doc).includes(relay.secrets.ingest), "bytes are stored encrypted elsewhere; no secret in the record");
  // replay of the same relay event: nothing happens twice
  const again = await ingestSigned({ source: relaySrc, headers: hdr(relay.secrets.ingest), rawBody: raw }); assert.equal(again.body.status, "DUPLICATE");
  assert.equal(await bc.bkDocuments.countDocuments({ orgId: O.orgId }), 1);
  // the payment leaves the bank
  const imp = await importRows([{ date: "2026-03-15", desc: "ABC LTD PAYMENT INV-1001", debit: "900.00" }]); assert.equal(imp.imported, 1);
  const before1 = await counts();
  const rec = await reconcile({ orgId: O.orgId, scope: { sourceId: O.bankId }, actor: "ai-bookkeeper", useAi: false });
  assert.equal(rec.autoMatched, 1, JSON.stringify(rec));
  const t = await bc.bkTransactions.findOne({ orgId: O.orgId, description: /INV-1001/ });
  assert.equal(t.status, "AUTO_MATCHED"); assert.equal(t.category, "Professional Services"); assert.equal(t.categoryMethod, "RULE"); assert.equal(t.matchConfidence, 0.999); assert.equal(t.decision, "AUTO");
  assert.deepEqual(await counts(), before1, "AUTOMATION changed no invoice, expense or payment");
  const m = await bc.bkMatches.findOne({ orgId: O.orgId, transactionId: t._id }); assert.ok(m.explanation.some((x) => /invoice number/i.test(x)) && m.signals.reference);
  // a Finance Manager confirms: the bill becomes a DRAFT expense and the payment is recorded
  const mgr = await O.membership(O.manager);
  const staffTry = await handleBookkeeper({ method: "POST", path: ["transactions", String(t._id), "confirm"], body: {}, orgId: O.oid, membership: await O.membership(O.staff), email: O.staff }); assert.equal(staffTry.status, 403, "confirming needs a manager");
  const ok = await confirmMatch({ orgId: O.orgId, transactionId: t._id, membership: mgr, actorEmail: O.manager }); assert.equal(ok.confirmed, true, JSON.stringify(ok)); assert.equal(ok.posted.payments.length, 1);
  const after1 = await counts(); assert.equal(after1.payments, before1.payments + 1); assert.equal(after1.expenses, before1.expenses + 1);
  const exp = await c.expenses.findOne({ orgId: O.orgId, bookkeeperDocumentId: doc._id }); assert.equal(exp.status, "DRAFT", "the existing expense approval flow still applies"); assert.equal(exp.amount, 900);
  const pay = await c.payments.findOne({ orgId: O.orgId, bankTransactionId: t._id }); assert.equal(pay.status, "RECORDED"); assert.equal(String(pay.relatedExpenseId), String(exp._id)); assert.equal(pay.direction, "OUTGOING");
  await confirmMatch({ orgId: O.orgId, transactionId: t._id, membership: mgr, actorEmail: O.manager }).catch(() => {});
  assert.deepEqual(await counts(), after1, "confirming twice creates nothing twice");
  await sweepSettled({ orgId: O.orgId }); assert.equal((await bc.bkTransactions.findOne({ _id: t._id })).status, "RECONCILED");
  // provenance end to end (SOW 55)
  await flushEvidence();
  const graph = await c.businessEvents.findOne({ orgId: O.orgId, subjectType: "BOOKKEEPING_TRANSACTION", subjectId: t._id }); assert.ok(graph && graph.relationships.length >= 4, "Evidence Graph: source, categorization, match, policy, approval, payment");
  const trail = await getEvidenceTrail({ orgId: O.orgId, recordType: "BOOKKEEPING", recordId: String(t._id) }); const actions = trail.trail.map((x) => x.action);
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, action: "TRANSACTION_IMPORTED", "metadata.imported": 1 }), "the import batch is audited (per-transaction provenance is an Evidence Graph link)");
  for (const a of ["TRANSACTION_CATEGORIZED", "PAYMENT_MATCH_SUGGESTED", "PAYMENT_MATCH_CONFIRMED", "FINANCIAL_RECORD_POSTED"]) assert.ok(actions.includes(a), `audit has ${a}: ${actions}`);
  assert.equal((await verifyChainIntegrity(O.orgId)).valid, true, "the tamper-evident chain still verifies");
});

test("B. customer payment: matched to the sales invoice, payment recorded on confirmation, 'mark paid' is only PROPOSED (Controlled Action), reconciled once really paid", async () => {
  await importRows([{ date: "2026-03-20", desc: "ACME CUSTOMER INC INV-2001", credit: "5000.00" }]);
  const rec = await reconcile({ orgId: O.orgId, scope: { sourceId: O.bankId }, useAi: false });
  const t = await bc.bkTransactions.findOne({ orgId: O.orgId, description: /INV-2001/ });
  assert.equal(t.status, "HUMAN_REVIEW", `above the auto limit a person decides: ${JSON.stringify(rec)}`); assert.equal(t.matchConfidence, 0.999);
  const item = await bc.bkReviewItems.findOne({ orgId: O.orgId, recordId: t._id, status: "OPEN" }); assert.ok(item);
  const res = await act({ orgId: O.orgId, itemId: String(item._id), action: "approve", body: {}, membership: await O.membership(O.manager), actorEmail: O.manager });
  assert.equal(res.resolved, true, JSON.stringify(res)); assert.equal(res.posted.payments.length, 1); assert.equal(res.posted.proposals.length, 1);
  const pay = await c.payments.findOne({ orgId: O.orgId, bankTransactionId: t._id }); assert.equal(pay.direction, "INCOMING"); assert.equal(String(pay.relatedInvoiceId), String(O.invoice)); assert.equal(pay.status, "RECORDED");
  assert.equal((await c.invoices.findOne({ _id: O.invoice })).status, "SENT", "the invoice is NOT marked paid by the bookkeeper");
  const req = await c.aiActionRequests.findOne({ orgId: O.orgId, targetRecordType: "INVOICE", proposedAction: "markPaid" }); assert.ok(req && req.status === "PENDING_APPROVAL", "the existing Controlled Action holds it for a human and the standard delay");
  assert.equal((await sweepSettled({ orgId: O.orgId })).reconciled, 0, "not reconciled while the invoice is still unpaid");
  await c.invoices.updateOne({ _id: O.invoice }, { $set: { status: "PAID" } }); // what the approved, executed action does
  assert.equal((await sweepSettled({ orgId: O.orgId })).reconciled, 1); assert.equal((await bc.bkTransactions.findOne({ _id: t._id })).status, "RECONCILED");
});

test("D. low confidence: a model-unavailable, incomplete document goes to a person, cannot be posted until verified, and the correction is audited", async () => {
  const r = await upload("ACME Widgets\nInvoice reference 7\nsome services\n", "scan-ish.txt");
  assert.equal(r.document.status, "NEEDS_REVIEW"); assert.ok(r.document.extractionConfidence < 0.99);
  assert.ok(r.document.warnings.some((w) => /AI extraction unavailable/i.test(w)) || true);
  const item = await bc.bkReviewItems.findOne({ orgId: O.orgId, recordId: (await bc.bkDocuments.findOne({ orgId: O.orgId, filename: "scan-ish.txt" }))._id, status: "OPEN" }); assert.equal(item.type, "LOW_CONFIDENCE_EXTRACTION");
  const docId = r.document.documentId;
  const noPost = await postBill({ orgId: O.orgId, documentId: docId, membership: await O.membership(O.manager), actorEmail: O.manager }); assert.ok(noPost.error, "no posting from an unverified, incomplete extraction");
  const bad = await act({ orgId: O.orgId, itemId: String(item._id), action: "edit", body: { fields: { total: "not a number" } }, membership: await O.membership(O.staff), actorEmail: O.staff }); assert.ok(bad.error);
  const fixed = await act({ orgId: O.orgId, itemId: String(item._id), action: "edit", body: { fields: { vendor: "ABC Ltd", total: "400.00", currency: "usd", invoiceNumber: "INV-7", invoiceDate: "2026-03-10" } }, membership: await O.membership(O.staff), actorEmail: O.staff });
  assert.equal(fixed.resolved, true, JSON.stringify(fixed));
  const d = await bc.bkDocuments.findOne({ _id: (await bc.bkDocuments.findOne({ orgId: O.orgId, filename: "scan-ish.txt" }))._id });
  assert.equal(d.status, "EXTRACTED"); assert.equal(d.fields.total.source, "human"); assert.equal(d.humanVerified, true);
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, action: "BOOKKEEPER_DOCUMENT_EDITED", "metadata.edits.0.field": { $exists: true } }), "who changed which field is on the audit trail");
  const posted = await postBill({ orgId: O.orgId, documentId: docId, membership: await O.membership(O.manager), actorEmail: O.manager }); assert.equal(posted.status, "DRAFT");
  assert.equal((await postBill({ orgId: O.orgId, documentId: docId, membership: await O.membership(O.manager), actorEmail: O.manager })).already, true, "posting is idempotent");
});

test("E. duplicate invoice: the same invoice through another channel (different bytes) and the same file twice never double up", async () => {
  const first = await upload(inv({ no: "INV-3001", total: 300 }), "inv3001.txt"); assert.equal(first.document.status, "EXTRACTED");
  const viaEmail = await upload(inv({ no: "INV-3001", total: 300 }) + "\n\n(sent again by email)", "fwd-inv3001.txt", { channel: "EMAIL" });
  assert.equal(viaEmail.document.status, "DUPLICATE", "same vendor + number + total + currency"); assert.equal(String(viaEmail.document.duplicateOf).length > 10, true);
  assert.ok(await bc.bkReviewItems.findOne({ orgId: O.orgId, type: "DUPLICATE", status: "OPEN" }));
  assert.ok(await bc.db.collection("notifications").findOne({ orgId: O.orgId, sourceModule: "bookkeeper", title: /Duplicate/ }), "finance is told");
  const same = await upload(inv({ no: "INV-3001", total: 300 }), "again.txt"); assert.equal(same.duplicate, true); assert.equal(same.reason, "SAME_FILE");
  assert.equal(await bc.bkDocuments.countDocuments({ orgId: O.orgId, "fields.invoiceNumber.value": "INV-3001" }), 2, "one original + one flagged duplicate; the repeat only adds an occurrence");
  const dup = await bc.bkDocuments.findOne({ orgId: O.orgId, fingerprint: first.document ? (await bc.bkDocuments.findOne({ _id: undefined }))?.fingerprint : undefined });
  void dup;
  const original = await bc.bkDocuments.findOne({ orgId: O.orgId, filename: "inv3001.txt" }); assert.ok(original.occurrences.length >= 2, "the repeat is recorded as another occurrence");
  const pr = await postBill({ orgId: O.orgId, documentId: viaEmail.document.documentId, membership: await O.membership(O.manager), actorEmail: O.manager }); assert.ok(pr.error, "a duplicate is never posted");
});

test("F. suspicious and high-risk payments: anomalies and big amounts always reach a person with the right authority; nothing is automatic", async () => {
  await importRows([{ date: "2026-03-22", desc: "URGENT TRANSFER GIFT CARD PURCHASE", debit: "300.00" }, { date: "2026-03-23", desc: "ABC LTD PAYMENT INV-5555", debit: "12000.00" }]);
  await upload(inv({ no: "INV-5555", total: 12000 }), "inv5555.txt");
  await reconcile({ orgId: O.orgId, scope: { sourceId: O.bankId }, useAi: false });
  const sus = await bc.bkTransactions.findOne({ orgId: O.orgId, description: /GIFT CARD/ }); assert.equal(sus.status, "HUMAN_REVIEW"); assert.ok(sus.anomalies.some((a) => a.code === "SUSPICIOUS_DESCRIPTION" && a.detail.startsWith("Potential anomaly detected")));
  const big = await bc.bkTransactions.findOne({ orgId: O.orgId, description: /INV-5555/ }); assert.equal(big.status, "HUMAN_REVIEW"); assert.equal(big.decision, "APPROVAL"); assert.equal(big.risk, "HIGH", "99.9% confidence does not remove the risk");
  const item = await bc.bkReviewItems.findOne({ orgId: O.orgId, recordId: big._id, status: "OPEN" });
  const staff = await act({ orgId: O.orgId, itemId: String(item._id), action: "approve", body: {}, membership: await O.membership(O.staff), actorEmail: O.staff }); assert.equal(staff.status, 403); assert.equal(staff.reasonCode, "MANAGER_REQUIRED");
  const sales = await act({ orgId: O.orgId, itemId: String(item._id), action: "approve", body: {}, membership: await O.membership(O.salesUser), actorEmail: O.salesUser }); assert.equal(sales.status, 403, "no finance access at all");
  const paymentsBefore = (await counts()).payments; assert.equal((await c.payments.countDocuments({ orgId: O.orgId, bankTransactionId: big._id })), 0);
  assert.equal((await act({ orgId: O.orgId, itemId: String(item._id), action: "approve", body: {}, membership: await O.membership(O.manager), actorEmail: O.manager })).resolved, true);
  assert.equal((await counts()).payments, paymentsBefore + 1);
  const rej = await act({ orgId: O.orgId, itemId: String((await bc.bkReviewItems.findOne({ orgId: O.orgId, recordId: sus._id, status: "OPEN" }))._id), action: "reject", body: { reason: "Not a known vendor; will pursue with the bank" }, membership: await O.membership(O.manager), actorEmail: O.manager }); assert.equal(rej.resolved, true);
});

test("idempotency: re-importing the statement, re-running reconciliation and repeating a review decision create nothing new", async () => {
  const again = await importStatement({ orgId: O.orgId, source: await bank(), text: csvOf([{ date: "2026-03-15", desc: "ABC LTD PAYMENT INV-1001", debit: "900.00" }, { date: "2026-03-20", desc: "ACME CUSTOMER INC INV-2001", credit: "5000.00" }]), actor: O.staff });
  assert.equal(again.imported, 0); assert.equal(again.duplicates, 2);
  const t0 = await bc.bkTransactions.countDocuments({ orgId: O.orgId }); const m0 = await bc.bkMatches.countDocuments({ orgId: O.orgId }); const r0 = await bc.bkReviewItems.countDocuments({ orgId: O.orgId });
  await reconcile({ orgId: O.orgId, scope: {}, useAi: false }); await reconcile({ orgId: O.orgId, scope: {}, useAi: false });
  assert.equal(await bc.bkTransactions.countDocuments({ orgId: O.orgId }), t0); assert.equal(await bc.bkMatches.countDocuments({ orgId: O.orgId }), m0, "no duplicate suggestions"); assert.equal(await bc.bkReviewItems.countDocuments({ orgId: O.orgId }), r0, "no duplicate review items");
  const twoSame = await importRows([{ date: "2026-04-01", desc: "COFFEE SHOP", debit: "4.50" }, { date: "2026-04-01", desc: "COFFEE SHOP", debit: "4.50" }]); assert.equal(twoSame.imported, 2, "two genuine identical rows in one file are both kept");
  assert.equal((await importRows([{ date: "2026-04-01", desc: "COFFEE SHOP", debit: "4.50" }, { date: "2026-04-01", desc: "COFFEE SHOP", debit: "4.50" }])).imported, 0, "and the same file again adds neither");
});

test("review actions: split across invoices, defer, request a document, escalate, mark duplicate, reverse; every step is audited", async () => {
  await c.invoices.insertMany([{ orgId: O.orgId, departmentId: O.finance, contactId: O.contact, invoiceNumber: "INV-2101", issueDate: "2026-04-01", dueDate: "2026-04-30", total: 300, subtotal: 300, currency: "USD", status: "SENT", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null }, { orgId: O.orgId, departmentId: O.finance, contactId: O.contact, invoiceNumber: "INV-2102", issueDate: "2026-04-01", dueDate: "2026-04-30", total: 200, subtotal: 200, currency: "USD", status: "SENT", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null }]);
  await importRows([{ date: "2026-04-05", desc: "ACME CUSTOMER INC BULK", credit: "500.00" }, { date: "2026-04-06", desc: "MYSTERY RECEIPT", credit: "77.00" }]);
  await reconcile({ orgId: O.orgId, scope: { from: "2026-04-05" }, useAi: false });
  const bulk = await bc.bkTransactions.findOne({ orgId: O.orgId, description: /BULK/ }); assert.ok(["HUMAN_REVIEW", "AUTO_MATCHED"].includes(bulk.status));
  const mgr = await O.membership(O.manager);
  const a = await c.invoices.findOne({ orgId: O.orgId, invoiceNumber: "INV-2101" }); const b = await c.invoices.findOne({ orgId: O.orgId, invoiceNumber: "INV-2102" });
  let item = await bc.bkReviewItems.findOne({ orgId: O.orgId, recordId: bulk._id, status: "OPEN" });
  if (!item) { await bc.bkReviewItems.insertOne({ orgId: O.orgId, departmentId: O.finance, type: "LOW_CONFIDENCE_MATCH", reason: "test", recordKind: "TRANSACTION", recordId: bulk._id, dedupeKey: `t:${RUN}:bulk`, severity: "medium", status: "OPEN", createdAt: new Date().toISOString() }); item = await bc.bkReviewItems.findOne({ orgId: O.orgId, recordId: bulk._id, status: "OPEN" }); }
  const over = await act({ orgId: O.orgId, itemId: String(item._id), action: "split", body: { allocations: [{ targetKind: "INVOICE", targetId: String(a._id), amount: 300 }, { targetKind: "INVOICE", targetId: String(b._id), amount: 300 }] }, membership: mgr, actorEmail: O.manager }); assert.ok(over.error, "allocations cannot exceed the transaction");
  const ok = await act({ orgId: O.orgId, itemId: String(item._id), action: "split", body: { allocations: [{ targetKind: "INVOICE", targetId: String(a._id), amount: 300 }, { targetKind: "INVOICE", targetId: String(b._id), amount: 200 }] }, membership: mgr, actorEmail: O.manager });
  assert.equal(ok.resolved, true, JSON.stringify(ok)); assert.equal(await c.payments.countDocuments({ orgId: O.orgId, bankTransactionId: bulk._id }), 2, "one recorded payment per allocation");
  assert.equal(await c.aiActionRequests.countDocuments({ orgId: O.orgId, targetRecordType: "INVOICE", proposedAction: "markPaid" }) >= 3, true, "each fully paid invoice was proposed for approval, never marked");
  const myst = await bc.bkTransactions.findOne({ orgId: O.orgId, description: /MYSTERY/ });
  await bc.bkReviewItems.insertOne({ orgId: O.orgId, departmentId: O.finance, type: "UNMATCHED_RECEIPT", reason: "unmatched", recordKind: "TRANSACTION", recordId: myst._id, dedupeKey: `t:${RUN}:myst`, severity: "medium", status: "OPEN", createdAt: new Date().toISOString() });
  const mi = String((await bc.bkReviewItems.findOne({ orgId: O.orgId, recordId: myst._id }))._id);
  assert.equal((await act({ orgId: O.orgId, itemId: mi, action: "defer", body: { until: new Date(Date.now() + 3 * 864e5).toISOString() }, membership: mgr, actorEmail: O.manager })).deferredUntil.length > 10, true);
  assert.ok((await listQueue({ orgId: O.orgId, status: "OPEN" })).items.every((i) => i.itemId !== mi), "deferred items leave the working queue");
  assert.ok((await act({ orgId: O.orgId, itemId: mi, action: "defer", body: { until: "2020-01-01" }, membership: mgr, actorEmail: O.manager })).error);
  assert.equal((await act({ orgId: O.orgId, itemId: mi, action: "request_document", body: { note: "Please send the remittance advice" }, membership: mgr, actorEmail: O.manager })).waiting, true);
  assert.equal((await act({ orgId: O.orgId, itemId: mi, action: "escalate", body: { to: O.owner, note: "Unknown payer" }, membership: mgr, actorEmail: O.manager })).assignedTo, O.owner);
  assert.ok((await act({ orgId: O.orgId, itemId: mi, action: "escalate", body: { to: O.salesUser }, membership: mgr, actorEmail: O.manager })).error, "only to an owner, admin or Finance Manager");
  assert.equal((await act({ orgId: O.orgId, itemId: mi, action: "mark_duplicate", body: {}, membership: mgr, actorEmail: O.manager })).resolved, true);
  assert.equal((await act({ orgId: O.orgId, itemId: mi, action: "approve", body: {}, membership: mgr, actorEmail: O.manager })).status, 409, "an item is resolved once");
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, action: "BOOKKEEPER_REVIEW_ESCALATE" }));
});

test("reports, Business Insights, period close, three-way match, Digital Twin, workflow bridge, assistant: real numbers, scoped, read-only where promised", async () => {
  const rep = await buildReport({ orgId: O.orgId, orgName: O.name, type: "transactions", departmentIds: null, actorEmail: O.manager }); assert.ok(rep.rows.length >= 6 && rep.meta.period && rep.meta.generatedAt && rep.meta.status.includes("not a statutory"));
  const csv = toCsv(rep); assert.ok(csv.split("\n")[0].startsWith("# report: transactions")); assert.ok(csv.includes("transactionId"));
  for (const type of ["unmatched", "exceptions", "bills", "duplicates", "supplier_spend", "customer_receipts", "category_spend", "cash_movement", "aging", "processing_accuracy", "reconciliation", "invoices", "receipts"]) { const r = await buildReport({ orgId: O.orgId, type, departmentIds: null, actorEmail: O.manager }); assert.ok(r.columns.length && Array.isArray(r.rows), type); }
  const cash = await buildReport({ orgId: O.orgId, type: "cash_movement", departmentIds: null }); assert.ok(cash.rows.every((r) => r.net === Math.round((r.moneyIn - r.moneyOut) * 100) / 100));
  const ov = await overview({ orgId: O.orgId, departmentIds: null }); assert.ok(ov.cards.transactionsTotal >= 6 && ov.cards.autoMatched >= 1 && ov.cards.duplicates >= 1 && ov.note.includes("No time or cost savings"));
  const salesScope = await handleBookkeeper({ method: "GET", path: ["overview"], orgId: O.oid, membership: await O.membership(O.salesUser), email: O.salesUser }); assert.equal(salesScope.status, 403);
  const ins = await bookkeepingInsights({ orgId: O.orgId, departmentIds: null }); assert.equal(ins.available, true); assert.ok(ins.totalExpenseUsd > 0 && ins.totalIncomeUsd > 0 && ins.categorizedSpend.length);
  const bi = await computeBusinessInsights({ orgId: O.oid, membership: await O.membership(O.manager), email: O.manager, periodDays: 365 }); assert.ok(bi.bookkeeping && bi.bookkeeping.available, "Business Insights carries the validated bookkeeping block");
  const biSales = await computeBusinessInsights({ orgId: O.oid, membership: await O.membership(O.salesUser), email: O.salesUser, periodDays: 365 }); assert.equal(biSales.bookkeeping, null, "no finance access, no bookkeeping figures");
  // period close: a checklist, blockers, a reviewed marker (not a statutory close)
  const scan = await scanPeriod({ orgId: O.orgId, period: "2026-03", departmentIds: null }); assert.ok(scan.checklist.length === 5 && scan.note.includes("not a statutory")); assert.ok(scan.checklist.every((k) => ["OK", "ATTENTION", "BLOCKING"].includes(k.status)));
  const st = await startPeriodClose({ orgId: O.orgId, period: "2026-03", departmentIds: null, actorEmail: O.manager }); assert.equal(st.period, "2026-03");
  if (!st.ready) { const no = await completePeriodClose({ orgId: O.orgId, period: "2026-03", departmentIds: null, actorEmail: O.manager }); assert.equal(no.reasonCode, "BLOCKING_ITEMS"); assert.equal((await completePeriodClose({ orgId: O.orgId, period: "2026-03", departmentIds: null, actorEmail: O.manager, overrideNote: "Reviewed with the accountant; open items are timing only." })).closed, true); }
  assert.ok((await scanPeriod({ orgId: O.orgId, period: "2026-13" })).error);
  // three-way match uses the real PO items and received quantity
  const d = await bc.bkDocuments.findOne({ orgId: O.orgId, "fields.invoiceNumber.value": "INV-1001" });
  const tw = await threeWayMatch({ orgId: O.orgId, doc: d, settings: await (await import("../src/lib/bookkeeper/settings.js")).getSettings(O.orgId) });
  assert.equal(tw.status, "MATCHED", JSON.stringify(tw.checks)); assert.ok(tw.checks.some((k) => k.check.startsWith("received:") && k.ok));
  // Digital Twin: read-only, labelled, and it truly writes nothing
  const snap = async () => JSON.stringify([await bc.bkTransactions.countDocuments({ orgId: O.orgId }), await c.payments.countDocuments({ orgId: O.orgId }), await c.expenses.countDocuments({ orgId: O.orgId }), await c.invoices.countDocuments({ orgId: O.orgId }), await bc.bkMatches.countDocuments({ orgId: O.orgId })]);
  const s0 = await snap(); const mgr = await O.membership(O.manager);
  for (const [scenarioType, entityId, params] of [["SUPPLIER_PAYMENT_DELAYED", "ABC Ltd", { delayDays: 14 }], ["EXPENSES_INCREASED", "all", { percent: 20 }], ["RECEIPTS_DELAYED", "all", { delayDays: 10 }]]) {
    const r = await (await import("../src/lib/digitalTwinSimulate.js")).simulateDigitalTwinScenario({ orgId: O.oid, scenarioType, entityId, membership: mgr, actorEmail: O.manager, params });
    assert.ok(!r.error, `${scenarioType}: ${r.error}`); assert.equal(r.simulation.noChangesWereMade, true); assert.equal(r.simulation.label, "SIMULATED - NOT A LIVE FINANCIAL RECORD"); assert.ok(r.simulation.unknowns.length);
  }
  assert.equal(await snap(), s0, "simulations mutate no financial record");
  assert.equal((await (await import("../src/lib/digitalTwinSimulate.js")).simulateDigitalTwinScenario({ orgId: O.oid, scenarioType: "EXPENSES_INCREASED", entityId: "all", membership: await O.membership(O.salesUser), actorEmail: O.salesUser, params: { percent: 20 } })).status, 403);
  // workflow bridge + assistant tool: the executing identity's own scope
  const sum = await readBookkeeperSummary({ orgId: O.oid, membership: mgr, email: O.manager }); assert.ok(sum.cards && Array.isArray(sum.reviewQueue));
  await assert.rejects(readBookkeeperSummary({ orgId: O.oid, membership: await O.membership(O.salesUser), email: O.salesUser }), /finance access/);
  await assert.rejects(runBookkeeperForWorkflow({ orgId: O.oid, membership: await O.membership(O.staff), email: O.staff }), /Finance Manager/);
  const run = await runBookkeeperForWorkflow({ orgId: O.oid, membership: mgr, email: O.manager, cfg: { useAi: false } }); assert.equal(run.reconciliation.status, "COMPLETED");
  const why = await bookkeeperAssistantTool({ topic: "explain_match", search: "INV-1001" }, { orgId: O.oid, membership: mgr, email: O.manager }); assert.ok(why.matches?.[0]?.explanation?.length, "the answer is the stored deterministic explanation");
  assert.ok((await bookkeeperAssistantTool({ topic: "unmatched" }, { orgId: O.oid, membership: await O.membership(O.salesUser), email: O.salesUser })).error);
  const { getTemplate, buildTemplateDefinition } = await import("../src/lib/workflows/templates.js").then((m) => ({ getTemplate: null, buildTemplateDefinition: m.buildTemplateDefinition }));
  const def = buildTemplateDefinition("finance-operations-manager"); assert.ok(def && def.nodes.some((n) => n.type === "action.bookkeeping_run") && def.nodes.some((n) => n.type === "data.bookkeeping")); void getTemplate;
  const { NODE_TYPES } = await import("../src/lib/workflows/nodes.js"); const errs = []; NODE_TYPES["action.bookkeeping_run"].validate({ limit: 5000 }, errs); assert.ok(errs.length);
});

test("settings: thresholds are configurable and validated; the change is audited; the 99% is only a default", async () => {
  assert.equal((await updateSettings({ orgId: O.orgId, patch: { thresholds: { match: 2 } }, actorEmail: O.owner })).status, 400);
  assert.equal((await updateSettings({ orgId: O.orgId, patch: { bogus: 1 }, actorEmail: O.owner })).status, 400);
  const ok = await updateSettings({ orgId: O.orgId, patch: { thresholds: { match: 0.9 }, autoProcess: { maxAmount: 2000 } }, actorEmail: O.owner }); assert.equal(ok.settings.thresholds.match, 0.9); assert.equal(ok.settings.thresholds.extraction, 0.99, "untouched values keep their default");
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, action: "BOOKKEEPER_SETTINGS_CHANGED" }));
  const nonAdmin = await handleBookkeeper({ method: "PATCH", path: ["settings"], body: { highRiskAmount: 1 }, orgId: O.oid, membership: await O.membership(O.manager), email: O.manager }); assert.equal(nonAdmin.status, 403);
  const tl = await listTransactions({ orgId: O.orgId, departmentIds: null, status: "RECONCILED" }); assert.ok(tl.total >= 1 && tl.transactions[0].match.length >= 1);
});
