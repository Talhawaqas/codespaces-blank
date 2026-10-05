// test/governance-classification.test.mjs -- metadata fields, classification rules (versioned policies), history, manual override,
// client-side reports and AI suggestions, against the real database.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/governance-classification.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import * as P from "../src/lib/governance/policies.js";
import * as K from "../src/lib/governance/classification.js";
import * as M from "../src/lib/governance/metadata.js";
import { ruleMatches, evaluateClassification, safePattern } from "../src/lib/governance/classifyRules.js";
import { publicShareView } from "../src/lib/sharing/policy.js";

const T = { timeout: 300000 };
let org, db, owner, bob;
const code = (p) => p.then(() => null, (e) => e);
const mkDoc = async (filename, extra = {}) => (await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: new ObjectId(), projectId: new ObjectId(), filename, fileHash: "0xc" + Math.random(), sizeBytes: 5, cidAlpha: "a", cidBeta: "b", uploadedByEmail: owner.email, txHash: "0x", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date().toISOString(), deletedAt: null, ...extra })).insertedId;
const A = (id) => ({ orgId: org.oid, documentId: String(id), membership: owner.membership, email: owner.email });
const getDoc = (id) => cols.orgDocuments.findOne({ _id: id });

before(async () => {
  await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("gcls", { people: ["bob"] }); owner = org.owner; bob = org.bob;
  const pol = await P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type: "classification", name: "Company rules", config: { rules: [
    { id: "r-payroll", name: "Payroll files", level: "CONFIDENTIAL", confidence: 0.8, apply: "suggest", when: { filenameRegex: "^payroll" } },
    { id: "r-keys", name: "Key material", level: "HIGHLY_CONFIDENTIAL", confidence: 0.95, apply: "apply", when: { extensions: ["pem", "key"] } },
    { id: "r-ssn", name: "Social security numbers", level: "RESTRICTED", confidence: 0.9, apply: "apply", when: { pii: { types: ["SSN"], min: 1 } } },
    { id: "r-hipaa", name: "HIPAA class", level: "REGULATED", apply: "suggest", when: { metadata: { compliance_class: "hipaa" } } },
    { id: "r-falcon", name: "Project Falcon", level: "CONFIDENTIAL", apply: "apply", when: { terms: ["project falcon"], contentPatterns: ["falcon\\s+launch"] } },
  ] } });
  await P.publishPolicy({ orgId: org.oid, policyId: pol.policyId, actorEmail: owner.email, membership: owner.membership });
});
after(async () => {
  await cols.orgDocuments.deleteMany({ orgId: org.orgId }).catch(() => {});
  for (const n of ["governance_policies", "classification_history", "metadata_fields", "metadata_sets"]) await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {});
  await teardown();
});

test("the rule evaluator is pure: metadata, content, PII; highest sensitivity wins; empty rules never match", T, async () => {
  assert.equal(ruleMatches({ when: {} }, { filename: "a" }, "x").matched, false);
  assert.equal(ruleMatches({ when: { pii: { types: ["SSN"] } } }, { filename: "a.txt" }, null).contentMissing, true);
  assert.equal(ruleMatches({ when: { pii: { types: ["SSN"] } } }, { filename: "a.txt" }, "ssn 123-45-6789").matched, true);
  assert.equal(ruleMatches({ when: { pii: { types: ["CREDIT_CARD"] } } }, { filename: "a.txt" }, "order 1234 5678 9012 3456").matched, false, "a non-Luhn number is not a card");
  assert.equal(ruleMatches({ when: { pii: { types: ["CREDIT_CARD"] } } }, { filename: "a.txt" }, "card 4111 1111 1111 1111").matched, true);
  const order = { INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 4 };
  const r = evaluateClassification([{ id: "a", level: "CONFIDENTIAL", when: { extensions: ["txt"] }, apply: "apply" }, { id: "b", level: "RESTRICTED", when: { terms: ["secret"] }, apply: "suggest" }], { filename: "n.txt" }, "a SECRET plan", order);
  assert.equal(r.level, "RESTRICTED"); assert.equal(r.matches.length, 2); assert.equal(r.contentEvaluated, true);
  for (const bad of ["(a+)+$", "(.*){3}x", "[", "x".repeat(300)]) assert.equal(safePattern(bad), false, bad);
  assert.equal(safePattern("^payroll[-_ ]\\d{4}"), true);
});

test("policy validation refuses runaway regexes and unknown levels are ignored, not trusted", T, async () => {
  await assert.rejects(P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type: "classification", config: { rules: [{ id: "x", level: "CONFIDENTIAL", when: { contentPatterns: ["(a+)+$"] } }] } }), (e) => e.status === 400 && /not an allowed pattern/.test(e.message));
  await assert.rejects(P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type: "classification", config: { rules: [{ id: "x", level: "CONFIDENTIAL", when: {} }] } }), (e) => e.status === 400);
});

test("suggest vs apply, explanation, history, accept a suggestion, and a person without access cannot classify", T, async () => {
  const id = await mkDoc("payroll-2026.xlsx");
  const r = await K.classifyDocument(A(id)); assert.equal(r.suggested, true); assert.equal(r.applied, false); assert.equal(r.proposed, "CONFIDENTIAL");
  assert.equal((await getDoc(id)).classification, undefined, "a suggestion does not change access or the stored level");
  const h = await K.classificationHistory(A(id)); assert.equal(h.history[0].status, "suggested"); assert.match(h.history[0].explanation, /Payroll files/); assert.deepEqual(h.history[0].ruleVersions.length, 1); assert.equal(h.suggestion.level, "CONFIDENTIAL");
  await K.decideSuggestion({ ...A(id), accept: true, reason: "reviewed" });
  const d = await getDoc(id); assert.equal(d.classification, "CONFIDENTIAL"); assert.equal(d.classificationSuggestion, undefined);
  const key = await mkDoc("server.pem"); const kr = await K.classifyDocument(A(key)); assert.equal(kr.applied, true); assert.equal((await getDoc(key)).classification, "HIGHLY_CONFIDENTIAL");
  assert.equal((await K.classificationHistory(A(key))).history[0].source, "rules");
  const denied = await code(K.classifyDocument({ orgId: org.oid, documentId: String(id), membership: bob.membership, email: bob.email })); assert.equal(denied.status, 403);
  const trail = await cols.orgActivity.find({ orgId: org.orgId, recordType: "CLASSIFICATION" }).toArray(); assert.ok(trail.length >= 3);
});

test("content rules only run when content was supplied, and say so", T, async () => {
  const id = await mkDoc("notes.txt");
  const none = await K.classifyDocument({ ...A(id), dryRun: true }); assert.equal(none.contentEvaluated, false); assert.equal(none.proposed, null);
  const withText = await K.classifyDocument({ ...A(id), text: "employee ssn 078-05-1120 on file", source: "server_text" });
  assert.equal(withText.contentEvaluated, true); assert.equal(withText.applied, true); assert.equal((await getDoc(id)).classification, "RESTRICTED");
  const f = await mkDoc("plan.txt"); const both = await K.classifyDocument({ ...A(f), text: "the project falcon launch is in May" }); assert.equal(both.applied, true); assert.equal((await getDoc(f)).classification, "CONFIDENTIAL");
  const g = await mkDoc("plan2.txt"); assert.equal((await K.classifyDocument({ ...A(g), text: "project falcon only" })).proposed, null, "every condition of a rule must match");
});

test("metadata rules, manual override with a reason, blocking automation, explicit reclassification", T, async () => {
  const id = await mkDoc("contract.docx", { metadata: { compliance_class: "hipaa" } });
  assert.equal((await K.classifyDocument(A(id))).proposed, "REGULATED");
  await assert.rejects(K.overrideClassification({ ...A(id), level: "PUBLIC", reason: "no" }), (e) => e.status === 400);
  await assert.rejects(K.overrideClassification({ ...A(id), level: "NOPE", reason: "valid reason here" }), (e) => e.status === 400);
  await K.overrideClassification({ ...A(id), level: "INTERNAL", reason: "Cleared by legal on 2026-10-01" });
  assert.equal((await getDoc(id)).classificationSource, "manual");
  assert.equal((await K.classifyDocument(A(id))).blockedBy, "manual", "automation never overwrites a person's decision");
  const forced = await K.classifyDocument({ ...A(id), force: true }); assert.equal(forced.suggested, true);
  const hist = await K.classificationHistory(A(id)); assert.ok(hist.history.some((x) => x.source === "manual" && /Cleared by legal/.test(x.reason)));
  await assert.rejects(K.overrideClassification({ orgId: org.oid, documentId: String(id), membership: bob.membership, email: bob.email, level: "PUBLIC", reason: "let me in" }), (e) => e.status === 403);
});

test("client-side classification: the verdict is reported, rule ids are validated, the text never reaches the server", T, async () => {
  const id = await mkDoc("vault-item.bin", { encryptionMode: "client" });
  const rules = await K.rulesForClients({ orgId: org.oid }); assert.ok(rules.find((r) => r.id === "r-ssn"));
  const local = evaluateClassification(rules, { filename: "vault-item.bin" }, "ssn 078-05-1120", { CONFIDENTIAL: 2, RESTRICTED: 4, HIGHLY_CONFIDENTIAL: 3 });
  assert.equal(local.level, "RESTRICTED");
  await assert.rejects(K.reportClientClassification({ ...A(id), level: "RESTRICTED", ruleIds: ["made-up"] }), (e) => e.status === 400);
  await assert.rejects(K.reportClientClassification({ ...A(id), level: "PUBLIC", ruleIds: ["r-ssn"] }), (e) => e.status === 400);
  const rep = await K.reportClientClassification({ ...A(id), level: local.level, ruleIds: local.matches.map((m) => m.ruleId), confidence: 0.99, scanner: "browser" });
  assert.equal(rep.applied, true); const d = await getDoc(id); assert.equal(d.classification, "RESTRICTED"); assert.equal(d.classificationSource, "client"); assert.ok(d.classificationConfidence <= 0.95);
  const h = await K.classificationHistory(A(id)); assert.match(h.history[0].explanation, /content not seen by Inaya/);
});

test("AI-assisted classification only suggests, caps confidence, and goes through the classifier it is given", T, async () => {
  const id = await mkDoc("memo.txt");
  const fake = async ({ labels }) => ({ ok: true, value: { label: "RESTRICTED", confidence: 0.99, seen: labels.length } });
  const r = await K.suggestWithAi({ ...A(id), text: "board memo about an acquisition", ai: fake }); assert.equal(r.suggested, true); assert.ok(r.confidence <= K.AI_CONFIDENCE_CAP);
  assert.equal((await getDoc(id)).classification, undefined, "the AI never applies by itself");
  assert.equal((await K.classificationHistory(A(id))).history[0].source, "ai");
  assert.equal((await K.suggestWithAi({ ...A(id), text: "x", ai: async () => ({ ok: true, value: { label: "MADE_UP", confidence: 1 } }) })).suggested, false);
  assert.equal((await K.suggestWithAi({ ...A(id), text: "x", ai: async () => ({ ok: false, error: "not_configured" }) })).configured, false);
  await K.decideSuggestion({ ...A(id), accept: false, reason: "not sensitive" }); assert.equal((await K.classificationHistory(A(id))).history[0].status, "rejected");
});

test("metadata fields: typed, validated, permission-aware, never exposed to external links", T, async () => {
  const base = { orgId: org.oid, actorEmail: owner.email, membership: owner.membership };
  await M.defineField({ ...base, key: "contract_value", label: "Contract value", type: "number" });
  await M.defineField({ ...base, key: "counterparty", label: "Counterparty", type: "text", required: true });
  await M.defineField({ ...base, key: "stage", label: "Stage", type: "vocabulary", options: ["draft", "review", "signed"] });
  await M.defineField({ ...base, key: "owner_email", label: "Owner", type: "email" });
  await M.defineField({ ...base, key: "legal_notes", label: "Legal notes", type: "text", visibility: "managers" });
  await M.defineField({ ...base, key: "approver_only", label: "Approver", type: "text", editableBy: "manage" });
  await assert.rejects(M.defineField({ ...base, key: "region", label: "x", type: "text" }), (e) => e.status === 409);
  await assert.rejects(M.defineField({ ...base, key: "BadKey", label: "x", type: "text" }), (e) => e.status === 400);
  await assert.rejects(M.defineField({ ...base, membership: bob.membership, key: "mine", label: "x", type: "text" }), (e) => e.status === 403);
  const id = await mkDoc("msa.pdf"); const call = (values, strict) => M.setDocumentMetadata({ ...A(id), values, strict });
  await call({ contract_value: "125000.50", counterparty: "Acme", stage: "review", owner_email: "Legal@Example.com", legal_notes: "do not share", region: "eu", retention_class: "extended", compliance_class: "gdpr" });
  const got = await M.getDocumentMetadata(A(id)); assert.equal(got.values.contract_value, 125000.5); assert.equal(got.values.owner_email, "legal@example.com"); assert.equal(got.values.region, "eu"); assert.equal(got.canManage, true);
  for (const [vals, re] of [[{ contract_value: "abc" }, /number/], [{ stage: "bogus" }, /one of/], [{ owner_email: "nope" }, /email/], [{ nothing: 1 }, /Unknown field/], [{ legal_hold: true }, /managed by the system/], [{ sensitivity: "PUBLIC" }, /classification controls/]]) await assert.rejects(call(vals), (e) => re.test(e.message), JSON.stringify(vals));
  await assert.rejects(call({ stage: "signed" }, true).then(async () => call({ counterparty: null }, true)), (e) => /required/.test(e.message));
  await call({ stage: null }); assert.equal((await M.getDocumentMetadata(A(id))).values.stage, undefined);
  // a member with VIEW but not MANAGE does not see manager-only fields and cannot write at all without EDIT
  await cols.orgDocuments.updateOne({ _id: id }, { $set: { accessLevel: "ORGANIZATION" } });
  const asBob = await code(M.getDocumentMetadata({ orgId: org.oid, documentId: String(id), membership: bob.membership, email: bob.email }));
  if (!asBob) { const v = await M.getDocumentMetadata({ orgId: org.oid, documentId: String(id), membership: bob.membership, email: bob.email }); assert.equal(v.values.legal_notes, undefined, "manager-only fields are hidden"); assert.equal(v.fields.some((f) => f.key === "legal_notes"), false); }
  assert.equal((await code(M.setDocumentMetadata({ orgId: org.oid, documentId: String(id), membership: bob.membership, email: bob.email, values: { stage: "draft" } })))?.status, 403);
  // sets
  await M.defineSet({ ...base, key: "contracts", name: "Contracts", fieldKeys: ["contract_value", "counterparty", "stage"], appliesTo: { extensions: ["pdf"] } });
  assert.equal((await M.getDocumentMetadata(A(id))).sets[0].key, "contracts"); const other = await mkDoc("pic.png"); assert.equal((await M.getDocumentMetadata(A(other))).sets.length, 0);
  await M.archiveField({ ...base, key: "approver_only" }); assert.equal((await M.listFields({ orgId: org.oid, membership: owner.membership })).some((f) => f.key === "approver_only"), false);
  // external viewers: the share view carries no metadata
  const view = publicShareView({ _id: new ObjectId(), documentId: id, kind: "link", permission: "view", createdByEmail: owner.email, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1e6).toISOString(), metadata: { legal_notes: "do not share" } });
  assert.equal(JSON.stringify(view).includes("do not share"), false);
});
