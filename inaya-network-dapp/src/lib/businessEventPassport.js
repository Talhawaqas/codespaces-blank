// src/lib/businessEventPassport.js
//
// Evidence Graph SOW §17 — Business Event Passport. Deliberately NOT a
// new exporter architecture: reuses evidenceExporter.js's exact
// canonicalize/hash technique (canonicalizeForExport, re-exported from
// there) so a passport and a compliance evidence export always serialize
// identically for identical underlying data — one hashing convention,
// not two. Read-only: building a passport never mutates the event, its
// subject, or anything it references; the only write is the self-audit
// log entry recording that a passport was generated.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { getBusinessEvent, getBusinessEventTimeline } from "./businessEvents.js";
import { explainBusinessEvent } from "./businessEventExplain.js";
import { logOrgActivity } from "./org-activity-log.js";
import { canonicalizeForExport } from "./evidenceExporter.js";
import { verifyChainIntegrity } from "./auditChain.js";
import PDFDocument from "pdfkit";

function sha256Hex(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

/** Builds the JSON passport body (everything except manifestHash), so the
 *  same object can be canonicalized to compute the hash and then re-
 *  canonicalized later, minus the hash field, to verify it. */
async function buildPassportBody({ orgId, eventId, membership, actorEmail }) {
  const got = await getBusinessEvent({ orgId, eventId, membership });
  if (got.error) return got;
  const [timelineResult, explainResult, org] = await Promise.all([
    getBusinessEventTimeline({ orgId, eventId, membership }),
    explainBusinessEvent({ orgId, eventId, membership }),
    (async () => (await getOrgCollections()).orgs.findOne({ _id: toObjectId(orgId) }))(),
  ]);
  if (timelineResult.error) return timelineResult;
  if (explainResult.error) return explainResult;

  const event = got.event;
  const generatedAt = new Date().toISOString();

  const body = {
    schemaVersion: "1.0",
    passportType: "BUSINESS_EVENT_PASSPORT",
    eventSummary: {
      eventId: String(event._id),
      organization: org?.name || null,
      orgId: String(event.orgId),
      eventType: event.eventType,
      subjectType: event.subjectType,
      subjectId: String(event.subjectId),
      subjectSummary: event.subjectSummary,
      status: event.status,
      riskLevel: event.riskLevel,
      createdByEmail: event.createdByEmail,
      createdAt: event.createdAt,
      completedAt: event.completedAt,
      generatedAt,
      generatedByEmail: actorEmail,
    },
    relationships: (event.relationships || []).map((r) => ({ type: r.type, targetType: r.targetType, targetId: String(r.targetId), note: r.note || null })),
    timeline: timelineResult.timeline.map((t) => ({ recordType: t.recordType, recordId: String(t.recordId), action: t.action, actorEmail: t.actorEmail, timestamp: t.timestamp, previousState: t.previousState, newState: t.newState })),
    evidence: explainResult.explanation.sourceEvidence,
    decision: explainResult.explanation.decision,
    rules: explainResult.explanation.rules,
    proof: explainResult.explanation.proof,
    disclosure: "This passport documents evidence that already exists in Inaya's own records for this business event. It is not a certification of compliance with any specific law, regulation, or standard.",
  };
  return { body };
}

/** Generates and self-audits a passport. Returns the full JSON (body +
 *  manifestHash) plus a PDF rendering of the same content. */
export async function buildBusinessEventPassport({ orgId, eventId, membership, actorEmail }) {
  const built = await buildPassportBody({ orgId, eventId, membership, actorEmail });
  if (built.error) return built;

  const manifestHash = sha256Hex(canonicalizeForExport(built.body));
  const passport = { ...built.body, manifestHash };

  await logOrgActivity({
    orgId, recordType: "BUSINESS_EVENT", recordId: toObjectId(eventId), actorEmail,
    action: "PASSPORT_GENERATED", previousState: null, newState: null,
    metadata: { manifestHash },
  });

  return { passport };
}

/** Independent verification (SOW §17.4): recomputes the hash over the
 *  passport body (everything except manifestHash) and compares. Also
 *  live-reverifies the org's audit chain, since a passport whose chain
 *  has since been tampered with must not read as VERIFIED just because
 *  its own manifest hash still matches. Returns exactly one of
 *  VERIFIED | INVALID | INCOMPLETE. */
export async function verifyBusinessEventPassport(passport) {
  if (!passport || typeof passport !== "object") return { state: "INVALID", reason: "Not a valid passport object." };
  const { manifestHash, ...body } = passport;
  if (!manifestHash) return { state: "INCOMPLETE", reason: "Passport has no manifestHash to verify." };

  const recomputed = sha256Hex(canonicalizeForExport(body));
  if (recomputed !== manifestHash) return { state: "INVALID", reason: "Manifest hash does not match passport content — this passport was altered after generation." };

  const orgId = body?.eventSummary?.orgId;
  if (!orgId) return { state: "INCOMPLETE", reason: "Passport is missing its organization reference." };
  const chainCheck = await verifyChainIntegrity(orgId).catch(() => null);
  if (!chainCheck) return { state: "UNKNOWN", reason: "Could not reverify the organization's audit chain." };
  if (!chainCheck.valid) return { state: "INVALID", reason: `Organization audit chain integrity check failed: ${chainCheck.reason}` };

  return { state: "VERIFIED", manifestHash, chainEntriesVerified: chainCheck.count };
}

function heading(doc, text) {
  doc.moveDown(0.5).fontSize(14).fillColor("#0a5f6e").text(text);
  doc.fillColor("#000000").fontSize(10);
}

function kv(doc, label, value) {
  doc.fontSize(9).fillColor("#555555").text(label, { continued: true }).fillColor("#000000").text(` ${value ?? "—"}`);
}

export function renderBusinessEventPassportPdf(passport) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).fillColor("#12161f").text("Inaya Business Event Passport");
    doc.moveDown(0.3).fontSize(9).fillColor("#777777").text("Portable evidence package, not a compliance certification.");
    doc.fillColor("#000000");

    heading(doc, "Event Summary");
    kv(doc, "Organization:", passport.eventSummary.organization);
    kv(doc, "Event ID:", passport.eventSummary.eventId);
    kv(doc, "Type:", passport.eventSummary.eventType);
    kv(doc, "Subject:", `${passport.eventSummary.subjectType} ${passport.eventSummary.subjectSummary?.label || ""}`);
    kv(doc, "Status:", passport.eventSummary.status);
    kv(doc, "Risk level:", passport.eventSummary.riskLevel);
    kv(doc, "Generated:", passport.eventSummary.generatedAt);
    kv(doc, "Generated by:", passport.eventSummary.generatedByEmail);

    heading(doc, "Timeline");
    if (passport.timeline.length === 0) doc.fontSize(9).text("No recorded activity.");
    for (const t of passport.timeline) {
      doc.fontSize(8).fillColor("#000000").text(`${t.timestamp}  ${t.recordType}  ${t.action}  (${t.actorEmail || "system"})`);
    }
    doc.fillColor("#000000");

    heading(doc, "Evidence");
    if (passport.evidence.length === 0) doc.fontSize(9).text("No linked evidence.");
    for (const e of passport.evidence) {
      doc.fontSize(9).text(`• ${e.relationship} → ${e.targetType} [${e.state}]${e.label ? `: ${e.label}` : ""}`);
    }

    heading(doc, "Rules Evaluated");
    for (const r of passport.rules) {
      doc.fontSize(9).text(`• ${r.ruleId}: ${r.result} — ${r.reason}`);
    }

    heading(doc, "Proof");
    kv(doc, "Audit chain intact:", passport.proof.auditChainIntact === null ? "UNKNOWN" : passport.proof.auditChainIntact ? "YES" : "NO");
    kv(doc, "Audit chain entries checked:", passport.proof.entriesChecked);

    heading(doc, "Manifest Integrity");
    doc.fontSize(8).font("Courier").text(`SHA-256: ${passport.manifestHash}`);
    doc.font("Helvetica");

    doc.moveDown(1).fontSize(8).fillColor("#777777").text(passport.disclosure);

    doc.end();
  });
}
