// src/lib/fraudRisk.js
//
// Inaya Fraud & Abuse Protection Layer -- Phase 1 (detection + risk engine
// + decision logic + audit log). Ecosystem enforcement (actually gating
// referrals/airdrop/Watcher enrollment/Business Workspace/API rate limits
// on the assessments this produces) is Phase 2, deliberately not wired up
// yet -- see the plan this shipped under. This file only ever COMPUTES and
// RECORDS a risk assessment; nothing in this pass blocks or restricts
// anything on its own.
//
// CORE PRINCIPLE (directly from the SOW): VPN detection is a risk signal,
// not a verdict. recommendAction() below enforces this in code, not just
// prose -- VPN/proxy/datacenter alone with a clean reputation can never
// resolve to RESTRICT or TEMPORARILY_BLOCK, only a combination with real
// reputation/abuse signal can. See scripts/test-fraud-risk.mjs for this
// asserted directly against all 10 of the SOW's named test scenarios.
//
// PRIVACY (SOW section 7): this file never touches metadata_files,
// org_documents, encryption keys, or passkeys -- it only ever sees an IP
// address and an identityId (a wallet address or email, whichever surface
// called it). fraud_risk_assessments stores exactly the fields listed
// below and nothing else.
//
// FAILS OPEN: every external dependency (Tor list, IPQualityScore) already
// degrades to a neutral/unknown result on its own failure (see each
// module's own comment) -- assessRisk() itself also never throws, so no
// Phase 2 call site can ever be broken by this layer being unavailable.

import { connectToDatabase } from "./mongodb.js";
import { isTorExitNode } from "./torExitNodes.js";
import { lookupIp } from "./ipQualityScore.js";
import { getClientIp } from "./ipAddress.js";

export const CLASSIFICATIONS = ["VPN_DETECTED", "PROXY_DETECTED", "TOR_DETECTED", "DATACENTER_IP", "RESIDENTIAL_IP", "UNKNOWN"];
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"];
export const ACTIONS = ["ALLOW", "MONITOR", "VERIFY", "RESTRICT", "TEMPORARILY_BLOCK"];

// Every number below is a single, easy-to-retune constant -- "configurable
// thresholds" per the SOW. Nothing here is hardcoded inline in the scoring
// logic itself.
const SCORE_WEIGHTS = {
  VPN_DETECTED: 25,
  PROXY_DETECTED: 25,
  DATACENTER_IP: 20,
  TOR_DETECTED: 35,
  RESIDENTIAL_IP: 0,
  UNKNOWN: 0,
};
const KNOWN_ABUSER_ADD = 40;
const RISK_LEVEL_THRESHOLDS = { MEDIUM: 30, HIGH: 70 };
// Two reputation tiers, matching the SOW's own three-step example exactly
// ("VPN alone -> MONITOR", "VPN + suspicious IP reputation -> VERIFY",
// "confirmed malicious infrastructure -> RESTRICT/BLOCK"). ELEVATED is
// "worth a closer look"; CONFIRMED is "acted on" -- connection-type
// classification alone can never reach CONFIRMED, only a real reputation
// signal (isKnownAbuser, or a fraud score at/above this) can.
const ELEVATED_REPUTATION_THRESHOLD = 75;
const CONFIRMED_MALICIOUS_THRESHOLD = 90;

export async function getFraudCollections() {
  const { db } = await connectToDatabase();
  return { db, assessments: db.collection("fraud_risk_assessments") };
}

let indexesEnsured = false;
export async function ensureFraudIndexes() {
  if (indexesEnsured) return;
  const { assessments } = await getFraudCollections();
  await Promise.all([
    assessments.createIndex({ createdAt: -1 }),
    assessments.createIndex({ identityId: 1, createdAt: -1 }),
    assessments.createIndex({ riskLevel: 1 }),
  ]);
  indexesEnsured = true;
}

/** Tor list first (free, authoritative for that one classification), then
 *  IPQualityScore for everything else. Returns { classification, reputation }
 *  where reputation is null only when IPQS isn't configured/failed AND the
 *  IP wasn't a Tor exit node either -- genuinely no signal available. */
export async function classifyIp(ip) {
  const isTor = await isTorExitNode(ip);
  if (isTor) {
    // Still worth a reputation lookup if configured -- a Tor exit node with
    // additional confirmed abuse history is a stronger signal than Tor alone.
    const { reputation } = await lookupIp(ip);
    return { classification: "TOR_DETECTED", reputation };
  }
  const { classification, reputation } = await lookupIp(ip);
  return { classification, reputation };
}

export function computeRiskScore({ classification, reputation }) {
  let score = SCORE_WEIGHTS[classification] ?? 0;
  if (reputation) {
    score += Math.round((reputation.fraudScore || 0) * 0.5);
    if (reputation.isKnownAbuser) score += KNOWN_ABUSER_ADD;
  }
  return Math.max(0, Math.min(100, score));
}

export function classifyRiskLevel(score) {
  if (score >= RISK_LEVEL_THRESHOLDS.HIGH) return "HIGH";
  if (score >= RISK_LEVEL_THRESHOLDS.MEDIUM) return "MEDIUM";
  return "LOW";
}

/** The false-positive guarantee lives here: connection-type classification
 *  alone -- VPN, proxy, datacenter, even Tor -- can only ever reach MONITOR
 *  or VERIFY. RESTRICT/TEMPORARILY_BLOCK requires a CONFIRMED reputation
 *  signal (isKnownAbuser, or a fraud score at/above CONFIRMED_MALICIOUS_
 *  THRESHOLD) -- real evidence, never an inference from connection type
 *  alone. Mirrors the SOW's own worked example exactly: VPN alone ->
 *  MONITOR, VPN + suspicious (elevated) reputation -> VERIFY, confirmed
 *  malicious infrastructure -> RESTRICT/BLOCK. */
export function recommendAction({ classification, reputation }) {
  const fraudScore = reputation?.fraudScore || 0;
  const confirmedMalicious = !!reputation?.isKnownAbuser || fraudScore >= CONFIRMED_MALICIOUS_THRESHOLD;
  const elevatedReputation = fraudScore >= ELEVATED_REPUTATION_THRESHOLD;
  const isFlaggedConnection = classification !== "RESIDENTIAL_IP" && classification !== "UNKNOWN";

  if (confirmedMalicious) {
    return reputation.isKnownAbuser ? "TEMPORARILY_BLOCK" : "RESTRICT";
  }
  if (elevatedReputation) {
    // Worth a closer look regardless of connection type -- a residential
    // IP with an elevated (but not yet confirmed) reputation score is
    // still a real signal on its own, not just a VPN/proxy amplifier.
    return "VERIFY";
  }
  return isFlaggedConnection ? "MONITOR" : "ALLOW";
}

/** The one entrypoint everything else calls. Never throws -- any failure
 *  anywhere in the chain still returns a usable ALLOW/LOW assessment rather
 *  than blocking whatever called it (see module header). */
export async function assessRisk({ req, identityId, surface }) {
  const ip = req ? getClientIp(req) : "unknown";
  try {
    await ensureFraudIndexes();
    const { classification, reputation } = await classifyIp(ip);
    const riskScore = computeRiskScore({ classification, reputation });
    const riskLevel = classifyRiskLevel(riskScore);
    const recommendedAction = recommendAction({ classification, reputation });

    const assessment = {
      identityId: identityId || null,
      surface: surface || "unknown",
      ipAddress: ip,
      classification,
      reputation,
      riskScore,
      riskLevel,
      recommendedAction,
      createdAt: new Date().toISOString(),
    };

    const { assessments } = await getFraudCollections();
    const result = await assessments.insertOne(assessment);
    return { ...assessment, id: result.insertedId.toString() };
  } catch (err) {
    console.error("assessRisk failed (failing open to ALLOW/LOW):", err.message);
    return {
      identityId: identityId || null,
      surface: surface || "unknown",
      ipAddress: ip,
      classification: "UNKNOWN",
      reputation: null,
      riskScore: 0,
      riskLevel: "LOW",
      recommendedAction: "ALLOW",
      createdAt: new Date().toISOString(),
      id: null,
    };
  }
}

export async function listRecentAssessments(limit = 100) {
  const { assessments } = await getFraudCollections();
  const list = await assessments.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return list.map((a) => ({ ...a, id: a._id.toString(), _id: undefined }));
}

export async function getFraudStats() {
  const { assessments } = await getFraudCollections();
  const [byLevel, byClassification, total] = await Promise.all([
    assessments.aggregate([{ $group: { _id: "$riskLevel", count: { $sum: 1 } } }]).toArray(),
    assessments.aggregate([{ $group: { _id: "$classification", count: { $sum: 1 } } }]).toArray(),
    assessments.countDocuments({}),
  ]);
  return {
    total,
    byLevel: Object.fromEntries(byLevel.map((r) => [r._id, r.count])),
    byClassification: Object.fromEntries(byClassification.map((r) => [r._id, r.count])),
  };
}
