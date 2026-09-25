// test/document-automation-e2e.test.mjs
//
// Document Automation SOW §40 -- the mandatory end-to-end acceptance
// scenario: a $25,000 invoice through every stage, against the real
// database and the real encrypted storage pipeline.
//
// Run: RESEND_API_KEY= GEMINI_API_KEY= node --env-file=.env.local --test test/document-automation-e2e.test.mjs
// (the two empty overrides keep the test from sending real email / calling a model)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeOrg, makeInvoice, collections as _c } from "./_docauto-fixtures.mjs";
import * as fx from "./_docauto-fixtures.mjs";
import { createDocument, getDocument, listDocuments, previewDocument } from "../src/lib/documentAutomation/pipeline.js";
import { requestApproval, decideApproval, finalizeDocument, getApprovalPackage } from "../src/lib/documentAutomation/lifecycle.js";
import { createDelivery, resolveDeliveryAccess, revokeDelivery, peekShare, resolveRoomDocument, listRoomGeneratedDocuments } from "../src/lib/documentAutomation/delivery.js";
import { verifyPublic, verifyDocument, buildDocumentPassport, verifyDocumentPassport, renderDocumentPassportPdf } from "../src/lib/documentAutomation/verify.js";
import { verifyEvidenceChain } from "../src/lib/documentAutomation/evidence.js";
import { hashDocumentBytes } from "../src/lib/documentAutomation/manifest.js";
import { exchangeRoomMagicLink, getRoomSession } from "../src/lib/external-data-room.js";
import { getBusinessEventTimeline } from "../src/lib/businessEvents.js";

let ctx;
before(async () => { await setup(); ctx = await makeOrg("e2e"); });
after(async () => { await teardown(); });

test("$25,000 invoice: generate -> approve (exact version) -> finalize -> encrypt+store -> secure link -> recipient view -> auditor verifies -> tamper fails", async () => {
  const { orgId, finDept, owner, managerB, contactId } = ctx;
  const invoiceId = await makeInvoice({ orgId, departmentId: finDept, contactId }); // 10 x $2,500 = $25,000.00

  // 1-4. authorized employee selects the invoice; data is retrieved; calculation is deterministic; template selected
  const preview = await previewDocument({ orgId, documentType: "invoice", sourceId: String(invoiceId), membership: owner.membership, email: owner.email });
  assert.ok(!preview.error, preview.error);
  assert.equal(preview.preview.calculation.grandTotal, 25000);
  assert.equal(preview.preview.approval.required, true, "$25,000 is at/above the default $10,000 approval threshold");
  assert.equal(preview.preview.template.templateId, "system:standard-invoice");
  const pdfHead = Buffer.from(preview.preview.pdfBase64, "base64").subarray(0, 5).toString();
  assert.equal(pdfHead, "%PDF-");
  assert.equal(await fx.collections.generatedDocuments.countDocuments({ orgId }), 0, "a preview stores nothing and allocates no number");

  // 5-7. PDF rendered, hash generated, evidence records source + generation
  const gen = await createDocument({ orgId, documentType: "invoice", sourceId: String(invoiceId), membership: owner.membership, email: owner.email });
  assert.ok(!gen.error, gen.error);
  const doc = gen.document;
  assert.match(doc.documentNumber, /^INV-\d{4}-000001$/);
  assert.equal(doc.status, "GENERATED");
  assert.equal(doc.pipelineState, "COMPLETE");
  assert.equal(doc.grandTotal, 25000);
  assert.match(doc.draftDocumentHash, /^[0-9a-f]{64}$/);
  const raw1 = (await getDocument({ orgId, documentId: doc.id, membership: owner.membership, email: owner.email })).raw;
  const types = raw1.evidenceNodes.map((n) => n.nodeType);
  for (const t of ["SOURCE_SELECTED", "SOURCE_SNAPSHOT", "CALCULATION", "TEMPLATE_VERSION", "DOCUMENT_GENERATED", "VALIDATION_COMPLETED", "STORAGE_COMPLETED"]) assert.ok(types.includes(t), `missing evidence node ${t}`);
  assert.equal(verifyEvidenceChain(raw1.evidenceNodes).valid, true);
  assert.ok(raw1.businessEventId, "linked into the Evidence Graph");

  // finalizing without approval is refused
  const early = await finalizeDocument({ orgId, documentId: doc.id, membership: owner.membership, email: owner.email });
  assert.equal(early.status, 409);

  // 8. approval requested (by owner); approver B is notified
  const reqd = await requestApproval({ orgId, documentId: doc.id, membership: owner.membership, email: owner.email, note: "Please approve" });
  assert.ok(!reqd.error, reqd.error);
  assert.equal(reqd.document.status, "PENDING_APPROVAL");
  assert.ok(reqd.notifiedApprovers >= 1);
  const notif = await fx.collections.db.collection("notifications").findOne({ orgId, targetEmail: managerB.email, type: "document_approval_required" });
  assert.ok(notif, "the other finance manager received an approval notification");

  // approver sees the exact version: calculations, snapshot, drift check
  const pkg = await getApprovalPackage({ orgId, documentId: doc.id, membership: managerB.membership, email: managerB.email });
  assert.ok(!pkg.error, pkg.error);
  assert.equal(pkg.package.calculation.grandTotal, 25000);
  assert.equal(pkg.package.drift.drifted, false);
  assert.ok(pkg.package.sourceSnapshot.customer.billingAddress);

  // 9. the requester cannot approve their own document (segregation of duties); AI/automation can never approve
  const self = await decideApproval({ orgId, documentId: doc.id, decision: "approve", membership: owner.membership, email: owner.email });
  assert.equal(self.status, 403);
  const ai = await decideApproval({ orgId, documentId: doc.id, decision: "approve", membership: managerB.membership, email: managerB.email, actorType: "ai" });
  assert.equal(ai.status, 403);

  // 9-10. an authorized, different approver approves the exact version; approval evidence recorded
  const approved = await decideApproval({ orgId, documentId: doc.id, decision: "approve", membership: managerB.membership, email: managerB.email, note: "Looks right" });
  assert.ok(!approved.error, approved.error);
  assert.equal(approved.document.status, "APPROVED");
  assert.equal(approved.document.approval.boundVersion, 1);

  // 11-12. finalize: re-rendered with the approval stamp, encrypted, stored, storage reference recorded
  const fin = await finalizeDocument({ orgId, documentId: doc.id, membership: managerB.membership, email: managerB.email });
  assert.ok(!fin.error, fin.error);
  const f = fin.document;
  assert.equal(f.status, "FINALIZED");
  assert.match(f.documentHash, /^[0-9a-f]{64}$/);
  assert.notEqual(f.documentHash, f.draftDocumentHash, "the final PDF carries the approval stamp, so it differs from the approved draft");
  assert.ok(f.manifest.evidenceRoot && f.manifest.manifestHash && f.manifest.templateHash && f.manifest.calculationHash && f.manifest.sourceDataHash);
  assert.equal(f.manifest.approvalReference.approvedBy, managerB.email);
  assert.equal(f.manifest.approvalReference.boundDraftHash, f.draftDocumentHash);
  assert.ok(f.storageReference.key.includes("/v1/"));
  assert.equal(fin.retention.locked, true, "retention lock applied to the stored object");

  // 13. secure link, bound to this exact version
  const del = await createDelivery({ orgId, documentId: doc.id, mode: "link", recipientEmail: "cfo@acme.example", expiresPreset: "24h", notify: false, membership: owner.membership, email: owner.email });
  assert.ok(!del.error, del.error);
  assert.match(del.url, /\/shared-document\//);
  const token = del.token;
  const peek = await peekShare(token);
  assert.equal(peek.meta.documentNumber, doc.documentNumber);
  assert.equal(peek.meta.documentHash, f.documentHash);
  assert.equal(JSON.stringify(peek.meta).includes(String(orgId)), false, "the recipient sees no internal ids");

  // 14-17. recipient opens/downloads the EXACT approved document; access recorded
  const view = await resolveDeliveryAccess(token, { download: false });
  assert.ok(!view.error, view.error);
  assert.equal(hashDocumentBytes(view.buffer), f.documentHash);
  assert.equal(view.buffer.subarray(0, 5).toString(), "%PDF-");
  const dl = await resolveDeliveryAccess(token, { download: true });
  assert.equal(hashDocumentBytes(dl.buffer), f.documentHash);
  const after = (await getDocument({ orgId, documentId: doc.id, membership: owner.membership, email: owner.email })).raw;
  assert.equal(after.status, "VIEWED");
  const events = await fx.collections.documentAccessEvents.find({ orgId, documentId: after._id }).toArray();
  assert.ok(events.some((e) => e.type === "VIEW") && events.some((e) => e.type === "DOWNLOAD"));
  const nodeTypes = after.evidenceNodes.map((n) => n.nodeType);
  for (const t of ["APPROVAL_REQUESTED", "APPROVAL_GRANTED", "DOCUMENT_FINALIZED", "SECURE_LINK_CREATED", "DOCUMENT_ACCESSED", "DOCUMENT_DOWNLOADED"]) assert.ok(nodeTypes.includes(t), `missing ${t}`);

  // 18-19. auditor opens the passport and verifies provenance (Data -> Calculation -> Template -> Document -> Approval -> Storage -> Delivery)
  const passportRes = await buildDocumentPassport({ orgId, documentId: doc.id, scope: "internal", membership: owner.membership, email: owner.email });
  assert.ok(!passportRes.error, passportRes.error);
  const passport = passportRes.passport;
  assert.equal(passport.fingerprints.documentHash, f.documentHash);
  assert.equal(passport.approval.status, "APPROVED");
  assert.ok(passport.delivery.length === 1 && passport.accessHistory.length >= 2);
  assert.equal(passport.verification.evidenceChainValid, true);
  const verifiedPassport = await verifyDocumentPassport(passport, { bytes: view.buffer });
  assert.equal(verifiedPassport.state, "VERIFIED", JSON.stringify(verifiedPassport));
  const pdf = await renderDocumentPassportPdf(passport);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

  const ext = (await buildDocumentPassport({ orgId, documentId: doc.id, scope: "external", membership: owner.membership, email: owner.email })).passport;
  const extJson = JSON.stringify(ext);
  assert.equal(extJson.includes("Acme"), false, "external passport reveals no customer");
  assert.equal(extJson.includes("25000"), false, "external passport reveals no amounts");
  assert.equal(extJson.includes("ap@acme"), false);

  const deep = await verifyDocument({ orgId, documentId: doc.id, bytes: view.buffer, deep: true, membership: owner.membership, email: owner.email });
  assert.equal(deep.verification.verified, true, JSON.stringify(deep.verification));
  assert.equal(deep.verification.storage.ok, true, "stored ciphertext decrypts back to the recorded hash");

  // 20. tampering with the finalized PDF causes verification failure
  const tampered = Buffer.from(view.buffer);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  assert.equal(verifyPublicSync(await verifyPublic({ documentId: doc.id, bytes: tampered })), false);
  const okPublic = await verifyPublic({ documentId: doc.id, bytes: view.buffer });
  assert.equal(okPublic.hashMatches, true);
  assert.equal(okPublic.approvalStatus, "APPROVED");
  assert.equal(okPublic.evidenceStatus, "INTACT");
  assert.equal(JSON.stringify(okPublic).includes("Acme"), false);
  const tamperedVerify = await verifyDocument({ orgId, documentId: doc.id, bytes: tampered, deep: false, membership: owner.membership, email: owner.email });
  assert.equal(tamperedVerify.verification.verified, false);
  assert.equal((await verifyDocumentPassport(passport, { bytes: tampered })).state, "INVALID");

  // the whole story is visible in the existing Evidence Graph timeline
  const timeline = await getBusinessEventTimeline({ orgId, eventId: String(after.businessEventId), membership: owner.membership });
  const actions = timeline.timeline.map((t) => t.action);
  for (const a of ["DOCUMENT_GENERATED", "APPROVAL_GRANTED", "DOCUMENT_FINALIZED", "SECURE_LINK_CREATED"]) assert.ok(actions.includes(a), `timeline missing ${a}`);

  // revocation is immediate
  const rev = await revokeDelivery({ orgId, documentId: doc.id, deliveryId: del.delivery.id, membership: owner.membership, email: owner.email });
  assert.equal(rev.revoked, true);
  const denied = await resolveDeliveryAccess(token);
  assert.equal(denied.status, 410);
});

function verifyPublicSync(r) { return r.hashMatches; }

test("Data Room delivery: identity-verified external session reads the exact document; revoked access stops", async () => {
  const { orgId, finDept, owner, contactId } = ctx;
  const invoiceId = await makeInvoice({ orgId, departmentId: finDept, contactId, lineItems: [{ description: "Advisory", quantity: 1, unitPrice: 900 }] }); // below threshold: no approval
  const gen = await createDocument({ orgId, documentType: "invoice", sourceId: String(invoiceId), membership: owner.membership, email: owner.email });
  assert.ok(!gen.error, gen.error);
  assert.equal(gen.document.approval.required, false);
  const fin = await finalizeDocument({ orgId, documentId: gen.document.id, membership: owner.membership, email: owner.email });
  assert.ok(!fin.error, fin.error);
  assert.equal(fin.document.documentHash, fin.document.draftDocumentHash, "no approval stamp => the stored draft IS the final bytes");

  const del = await createDelivery({ orgId, documentId: gen.document.id, mode: "data_room", recipientEmail: "auditor@acme.example", expiresPreset: "24h", notify: false, membership: owner.membership, email: owner.email });
  assert.ok(!del.error, del.error);
  const token = del.url.split("/").pop();
  const exchanged = await exchangeRoomMagicLink(token);
  assert.ok(exchanged.sessionToken, "magic link verified the recipient's email identity");
  const session = await getRoomSession(exchanged.sessionToken);
  const list = await listRoomGeneratedDocuments({ session });
  assert.equal(list.documents.length, 1);
  const got = await resolveRoomDocument({ session, documentObjectId: list.documents[0].objectId, download: true });
  assert.ok(!got.error, got.error);
  assert.equal(hashDocumentBytes(got.buffer), fin.document.documentHash);

  await revokeDelivery({ orgId, documentId: gen.document.id, deliveryId: del.delivery.id, membership: owner.membership, email: owner.email });
  assert.equal(await getRoomSession(exchanged.sessionToken), null, "revoking the delivery ends the external session");
});

test("regenerate -> v2 keeps the number, finalizing v2 supersedes v1, and v1's link never resolves to v2", async () => {
  const { orgId, finDept, owner, contactId } = ctx;
  const invoiceId = await makeInvoice({ orgId, departmentId: finDept, contactId, lineItems: [{ description: "Retainer", quantity: 1, unitPrice: 500 }] });
  const v1 = await createDocument({ orgId, documentType: "invoice", sourceId: String(invoiceId), membership: owner.membership, email: owner.email });
  const fin1 = await finalizeDocument({ orgId, documentId: v1.document.id, membership: owner.membership, email: owner.email });
  assert.ok(!fin1.error, fin1.error);
  const link1 = await createDelivery({ orgId, documentId: v1.document.id, mode: "link", recipientEmail: "x@acme.example", notify: false, membership: owner.membership, email: owner.email });

  // a correction: the invoice changes, so a new version is produced
  await fx.collections.invoices.updateOne({ _id: invoiceId }, { $set: { lineItems: [{ description: "Retainer (corrected)", quantity: 1, unitPrice: 550 }], updatedAt: new Date().toISOString() } });
  const v2 = await createDocument({ orgId, documentType: "invoice", sourceId: String(invoiceId), membership: owner.membership, email: owner.email });
  assert.ok(!v2.error, v2.error);
  assert.equal(v2.document.documentVersion, 2);
  assert.equal(v2.document.documentNumber, v1.document.documentNumber, "same number across versions");
  // v1 stays valid until v2 is finalized
  assert.equal((await resolveDeliveryAccess(link1.token)).error, undefined);
  const fin2 = await finalizeDocument({ orgId, documentId: v2.document.id, membership: owner.membership, email: owner.email });
  assert.ok(!fin2.error, fin2.error);
  const old = (await getDocument({ orgId, documentId: v1.document.id, membership: owner.membership, email: owner.email })).raw;
  assert.equal(old.status, "SUPERSEDED");
  assert.equal(String(old.supersededByDocumentId), v2.document.id);
  const dead = await resolveDeliveryAccess(link1.token);
  assert.equal(dead.status, 410);
  assert.match(dead.error, /superseded|revoked/i);
  assert.equal(dead.buffer, undefined, "never silently serves the newer version");
  assert.ok(old.evidenceNodes.length > 0, "the previous version and its evidence remain available");
});
