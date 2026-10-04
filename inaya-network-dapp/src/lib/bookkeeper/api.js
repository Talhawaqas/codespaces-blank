// src/lib/bookkeeper/api.js
//
// AI Bookkeeper SOW section 50: ONE dispatcher for /api/orgs/finance/bookkeeper/*. The route authenticates the caller (session + membership)
// and passes { orgId, membership, email }; everything else, including permissions, is decided here:
//   * every endpoint needs finance access (canAccessFinance);
//   * data is scoped to the departments the caller may see (owners/admins: all);
//   * confirming, posting, reversing and period close need a Finance Manager (or owner/admin); sources, secrets and settings need an owner/admin;
//   * responses never contain a secret.

import { toObjectId, getOrgCollections, canAccessFinance, canManageFinance, canManageOrg, canAccessDepartment } from "../orgs.js";
import { toXlsx, toPdf } from "./exportFormats.js";
import { getBookkeeperCollections } from "./db.js";
import { fail, DOCUMENT_TYPES } from "./common.js";
import * as S from "./settings.js";
import * as SRC from "./sources.js";
import * as BANK from "./bank.js";
import * as DOC from "./documents.js";
import * as REC from "./reconcile.js";
import * as REV from "./review.js";
import * as CAT from "./categorize.js";
import * as INS from "./insights.js";
import * as PER from "./period.js";
import { ALLOWED_TYPES } from "./extract.js";
import { audit } from "./record.js";

const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };
const asInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
export const MAX_UPLOAD_JSON = 6 * 1024 * 1024;

/** Department ids the caller may see, or null for "all" (owner/admin). */
export async function departmentScope({ orgId, membership }) {
  if (canManageOrg(membership)) return null;
  const { departments } = await getBookkeeperCollections();
  return (await departments.find({ orgId: toObjectId(orgId) }).project({ _id: 1 }).toArray()).filter((d) => canAccessDepartment(membership, d._id)).map((d) => d._id);
}

const inScope = (deptIds, departmentId) => deptIds === null || deptIds.some((d) => String(d) === String(departmentId));

export async function handleBookkeeper({ method, path, query = {}, body = {}, orgId, membership, email }) {
  if (!canAccessFinance(membership)) return fail("You don't have finance access.", 403);
  const [a, b, c] = path; const m = method.toUpperCase(); const manager = canManageFinance(membership); const admin = canManageOrg(membership);
  const deptIds = await departmentScope({ orgId, membership });
  const needManager = () => (manager ? null : fail("This needs a Finance Manager or an owner/admin.", 403, { reasonCode: "MANAGER_REQUIRED" }));
  const needAdmin = () => (admin ? null : fail("Only an owner or admin can do that.", 403, { reasonCode: "ADMIN_REQUIRED" }));
  const { bkTransactions, bkMatches } = await getBookkeeperCollections();

  if (a === "overview" && m === "GET") return INS.overview({ orgId, departmentIds: deptIds });
  if (a === "metrics" && m === "GET") return INS.observability({ orgId });
  if (a === "insights" && m === "GET") return INS.bookkeepingInsights({ orgId, departmentIds: deptIds, from: query.from || null, to: query.to || null });
  if (a === "settings") {
    if (m === "GET") return { settings: await S.getSettings(orgId) };
    if (m === "PATCH") return needAdmin() || S.updateSettings({ orgId, patch: body, actorEmail: email });
  }

  // -------------------------------------------------------------------------------------------------------------- sources
  if (a === "sources") {
    if (!b && m === "GET") return SRC.listSources({ orgId });
    if (!b && m === "POST") return needAdmin() || SRC.createSource({ orgId, ...body, actor: email });
    if (b && !c && m === "DELETE") return needAdmin() || SRC.disableSource({ orgId, sourceId: b, actor: email });
    if (b && c === "rotate-secret" && m === "POST") return needAdmin() || SRC.rotateIngestSecret({ orgId, sourceId: b, actor: email });
    if (b && c === "import" && m === "POST") {
      const e = needManager(); if (e) return e;
      const src = await SRC.getSource({ orgId, sourceId: b }); if (!src || src.status !== "ACTIVE") return fail("Source not found.", 404);
      if (!inScope(deptIds, src.departmentId)) return fail("You don't have access to this source's department.", 403);
      const r = await BANK.importStatement({ orgId, source: src, text: body.text, format: body.format || null, mapping: body.mapping || null, dayFirst: body.dayFirst !== false, actor: email });
      if (r.error) return r;
      if (body.reconcile !== false && r.imported) r.reconciliation = await REC.reconcile({ orgId, scope: { sourceId: b, departmentIds: deptIds }, actor: email });
      return r;
    }
    if (b && c === "sync" && m === "POST") { const e = needManager(); if (e) return e; const src = await SRC.getSource({ orgId, sourceId: b }); if (!src) return fail("Source not found.", 404); return BANK.syncSource({ orgId, source: src, actor: email }); }
  }

  // -------------------------------------------------------------------------------------------------------------- documents
  if (a === "documents") {
    if (!b && m === "GET") return DOC.listDocuments({ orgId, departmentIds: deptIds, status: query.status || null, type: DOCUMENT_TYPES.includes(query.type) ? query.type : null, channel: query.channel || null, limit: asInt(query.limit, 50), skip: asInt(query.skip, 0) });
    if (!b && m === "POST") {
      const src = await SRC.getSource({ orgId, sourceId: body.sourceId }); if (!src || src.status !== "ACTIVE") return fail("Choose an active source.", 404);
      if (!inScope(deptIds, src.departmentId)) return fail("You don't have access to this source's department.", 403);
      if (typeof body.contentBase64 !== "string") return fail("contentBase64 is required.");
      const type = String(body.contentType || "").toLowerCase().split(";")[0]; if (!ALLOWED_TYPES[type]) return fail("This file type is not accepted. Send a PDF, JPEG, PNG, plain text or CSV.", 415);
      return DOC.ingestDocument({ orgId, source: src, channel: "UPLOAD", filename: body.filename, contentType: type, buffer: Buffer.from(body.contentBase64, "base64"), externalId: body.externalId || null, actor: email, aiEnabled: body.ai !== false });
    }
    const doc = b && b.length === 24 ? await DOC.getDocument({ orgId, documentId: b }) : null;
    if (b && !doc) return fail("Document not found.", 404);
    if (doc && !inScope(deptIds, doc.departmentId)) return fail("Document not found.", 404);
    if (doc && !c && m === "GET") return { document: DOC.documentView(doc, { full: true }) };
    if (doc && c === "download" && m === "GET") { const d = await DOC.downloadDocument({ orgId, documentId: b }); if (!d) return fail("The stored file could not be read.", 502); await audit({ orgId, recordId: doc._id, action: "BOOKKEEPER_DOCUMENT_DOWNLOADED", actorEmail: email, metadata: { documentId: b } }); return { raw: { contentType: d.contentType, body: d.buffer, filename: d.filename } }; }
    if (doc && c === "reprocess" && m === "POST") return needManager() || DOC.reprocessDocument({ orgId, documentId: b, actor: email });
    if (doc && c === "post" && m === "POST") return needManager() || REC.postBill({ orgId, documentId: b, membership, actorEmail: email });
    if (doc && c === "three-way" && m === "GET") { const { threeWayMatch } = await import("./match.js"); return threeWayMatch({ orgId, doc, settings: await S.getSettings(orgId) }); }
  }

  // -------------------------------------------------------------------------------------------------------------- transactions and reconciliation
  if (a === "transactions") {
    if (!b && m === "GET") return INS.listTransactions({ orgId, departmentIds: deptIds, from: query.from || null, to: query.to || null, sourceId: query.sourceId || null, category: query.category || null, status: query.status || null, direction: query.direction || null, counterparty: query.counterparty || null, minConfidence: query.minConfidence !== undefined ? Number(query.minConfidence) : null, exception: query.exception === "true", limit: asInt(query.limit, 50), skip: asInt(query.skip, 0) });
    const id = b && b.length === 24 ? oidOf(b) : null;
    const txn = id ? await bkTransactions.findOne({ _id: id, orgId: toObjectId(orgId) }) : null;
    if (b && (!txn || !inScope(deptIds, txn.departmentId))) return fail("Transaction not found.", 404);
    if (txn && !c && m === "GET") { const matches = await bkMatches.find({ orgId: toObjectId(orgId), transactionId: txn._id }).sort({ createdAt: -1 }).toArray(); return { transaction: REV.txnView(txn), matches: matches.map((x) => ({ matchId: String(x._id), targetKind: x.targetKind, targetId: x.targetId, number: x.targetNumber, party: x.targetParty, type: x.matchType, confidence: x.confidence, allocation: x.allocation, status: x.status, explanation: x.explanation, discrepancy: x.discrepancy, signals: x.signals, paymentId: x.paymentId ? String(x.paymentId) : null })) }; }
    if (txn && c === "process" && m === "POST") return needManager() || REC.processTransaction({ orgId, txn, actor: email });
    if (txn && c === "confirm" && m === "POST") return needManager() || REC.confirmMatch({ orgId, transactionId: b, membership, actorEmail: email, post: body.post !== false, note: body.note || null });
    if (txn && c === "reverse" && m === "POST") return needManager() || REC.reverseMatch({ orgId, transactionId: b, actorEmail: email, reason: body.reason });
    if (txn && c === "category" && m === "POST") return REV.act({ orgId, itemId: body.itemId, action: "edit", body: { category: body.category }, membership, actorEmail: email });
  }
  if (a === "reconcile" && m === "POST") { const e = needManager(); if (e) return e; return REC.reconcile({ orgId, scope: { from: body.from || null, to: body.to || null, sourceId: body.sourceId || null, departmentIds: deptIds, limit: body.limit }, actor: email, useAi: body.ai !== false }); }
  if (a === "reconciliation" && m === "GET") { const { bkReconciliations } = await getBookkeeperCollections(); const rows = await bkReconciliations.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).limit(50).toArray(); return { reconciliations: rows.map((r) => ({ reconciliationId: String(r._id), status: r.status, startedAt: r.startedAt, completedAt: r.completedAt || null, processed: r.processed, autoMatched: r.autoMatched, humanReview: r.humanReview, unmatched: r.unmatched, exceptions: r.exceptions, reconciled: r.reconciled || 0, scope: r.scope })) }; }
  if (a === "process" && m === "POST") { const e = needManager(); if (e) return e; return REC.reconcile({ orgId, scope: { departmentIds: deptIds }, actor: email }); }

  // -------------------------------------------------------------------------------------------------------------- review queue
  if (a === "review") {
    if (!b && m === "GET") return REV.listQueue({ orgId, departmentIds: deptIds, status: query.status === "all" ? null : query.status || "OPEN", type: query.type || null, severity: query.severity || null, limit: asInt(query.limit, 50), skip: asInt(query.skip, 0) });
    if (b && !c && m === "GET") { const r = await REV.getItem({ orgId, itemId: b }); if (!r || !inScope(deptIds, r.item.departmentId)) return fail("Review item not found.", 404); return { item: r.view }; }
    if (b && c && m === "POST") return REV.act({ orgId, itemId: b, action: c, body, membership, actorEmail: email });
  }

  // -------------------------------------------------------------------------------------------------------------- rules
  if (a === "rules") {
    if (!b && m === "GET") return CAT.listRules({ orgId });
    if (!b && m === "POST") return needManager() || CAT.createRule({ orgId, body, actorEmail: email, proposedByAi: body.proposedByAi === true });
    if (b && !c && m === "PATCH") return needManager() || CAT.updateRule({ orgId, ruleId: b, patch: body, actorEmail: email });
    if (b && c === "history" && m === "GET") return CAT.ruleHistory({ orgId, ruleId: b });
  }

  // -------------------------------------------------------------------------------------------------------------- reports, periods, evidence, simulation
  if (a === "reports") {
    if (m === "GET" && !b) {
      const { orgs } = await getOrgCollections(); const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1 } });
      const r = await INS.buildReport({ orgId, orgName: org?.name, type: query.type || "transactions", departmentIds: deptIds, from: query.from || null, to: query.to || null, filters: { type: query.type }, actorEmail: email });
      if (r.error) return r;
      await audit({ orgId, action: "BOOKKEEPER_REPORT_GENERATED", actorEmail: email, metadata: { type: query.type || "transactions", rows: r.rows.length, format: query.format || "json" } });
      const stamp = `bookkeeper-${query.type || "transactions"}-${new Date().toISOString().slice(0, 10)}`;
      if (query.format === "xlsx") return { raw: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: toXlsx(r), filename: `${stamp}.xlsx` } };
      if (query.format === "pdf") return { raw: { contentType: "application/pdf", body: await toPdf(r), filename: `${stamp}.pdf` } };
      if (query.format === "csv") return { raw: { contentType: "text/csv; charset=utf-8", body: Buffer.from(INS.toCsv(r), "utf8"), filename: `bookkeeper-${query.type || "transactions"}-${new Date().toISOString().slice(0, 10)}.csv` } };
      return r;
    }
  }
  if (a === "periods") {
    if (!b && m === "GET") return PER.listPeriods({ orgId });
    if (b && c === "scan" && m === "GET") return PER.scanPeriod({ orgId, period: b, departmentIds: deptIds });
    if (b && c === "start" && m === "POST") return needManager() || PER.startPeriodClose({ orgId, period: b, departmentIds: deptIds, actorEmail: email });
    if (b && c === "close" && m === "POST") return needManager() || PER.completePeriodClose({ orgId, period: b, departmentIds: deptIds, actorEmail: email, overrideNote: body.overrideNote || null });
  }
  if (a === "evidence" && m === "GET") {
    const kind = query.documentId ? "BOOKKEEPING_DOCUMENT" : query.transactionId ? "BOOKKEEPING_TRANSACTION" : null; const rid = oidOf(query.documentId || query.transactionId);
    if (!kind || !rid) return fail("transactionId or documentId is required.");
    const rec = kind === "BOOKKEEPING_DOCUMENT" ? await DOC.getDocument({ orgId, documentId: rid }) : await bkTransactions.findOne({ _id: rid, orgId: toObjectId(orgId) });
    if (!rec || !inScope(deptIds, rec.departmentId)) return fail("Record not found.", 404);
    const { businessEvents } = await getOrgCollections();
    const ev = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: kind, subjectId: rid, deletedAt: null });
    const { getEvidenceTrail } = await import("../evidence.js");
    const trail = await getEvidenceTrail({ orgId, recordType: "BOOKKEEPING", recordId: String(rid) });
    if (!ev) return { evidence: null, trail, note: "No Evidence Graph record exists for this item yet." };
    const { buildBusinessEventPassport } = await import("../businessEventPassport.js");
    const passport = await buildBusinessEventPassport({ orgId, eventId: String(ev._id), membership, actorEmail: email });
    return { trail, evidence: passport.error ? { error: passport.error } : passport };
  }
  if (a === "twin" && m === "POST") {
    const { simulateDigitalTwinScenario } = await import("../digitalTwinSimulate.js");
    const { BOOKKEEPER_SCENARIOS } = await import("./twin.js");
    if (!BOOKKEEPER_SCENARIOS.includes(body.scenarioType)) return fail(`scenarioType must be one of ${BOOKKEEPER_SCENARIOS.join(", ")}.`);
    return simulateDigitalTwinScenario({ orgId, scenarioType: body.scenarioType, entityId: body.entityId || "all", membership, actorEmail: email, params: { delayDays: body.delayDays, percent: body.percent } });
  }
  return fail("Unknown bookkeeper endpoint.", 404);
}
