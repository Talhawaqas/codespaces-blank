// src/lib/bookkeeper/policy.js
//
// AI Bookkeeper SOW sections 19 and 48: the auto-processing policy. PURE and fully explainable: it takes the four confidence dimensions and
// the risk facts, and returns AUTO, REVIEW or APPROVAL with a list of reasons.
//
//   AUTO      every applicable dimension >= its threshold, no anomaly, low risk, amount within the auto limit, known counterparty,
//             purchase order present when required. AUTO only ever means INTERNAL bookkeeping state (categorize, link a match, clear a
//             queue item). It never changes an invoice, expense or payment: those go through Controlled Actions (see reconcile.js).
//   REVIEW    a person looks at it (default for anything uncertain, medium risk, or a policy hit).
//   APPROVAL  high risk: a person with authority must approve, and any change to an authoritative record still waits for the standard delay.
// Confidence never overrides risk: a 99.9% match on a 50,000 payment is still APPROVAL.

import { clamp01 } from "./common.js";

/**
 * facts: { amount, currency, extraction?, categorization?, match?, anomalyScore?, anomalies[], category, knownCounterparty, purchaseOrderPresent,
 *          currencyConverted, matchType, ambiguous, duplicate, thirdPartyDocument? }
 */
export function decide({ settings, facts }) {
  const t = settings.thresholds; const a = settings.autoProcess; const reasons = []; let risk = "LOW";
  const bump = (level, why) => { reasons.push(why); if (level === "HIGH" || (level === "MEDIUM" && risk === "LOW")) risk = level; };

  if (facts.amount >= settings.highRiskAmount) bump("HIGH", `Amount ${facts.amount.toFixed(2)} is at or above the high-risk limit ${settings.highRiskAmount}.`);
  if (facts.category && settings.highRiskCategories.includes(facts.category)) bump("HIGH", `Category "${facts.category}" is high-risk by policy.`);
  if (facts.duplicate) bump("HIGH", "A duplicate was detected.");
  for (const an of facts.anomalies || []) bump(an.severity === "high" ? "HIGH" : "MEDIUM", an.detail);
  if (facts.currencyConverted) bump("MEDIUM", "The currencies differ, so the amount was converted with a reference rate.");
  if (facts.ambiguous) bump("MEDIUM", "More than one candidate matches equally well.");
  if (["OVERPAYMENT", "PARTIAL", "AMOUNT_MISMATCH", "FEES", "OVERPAYMENT_CURRENCY", "PARTIAL_CURRENCY"].includes(facts.matchType)) bump("MEDIUM", `The match is a ${String(facts.matchType).toLowerCase().replace(/_/g, " ")}.`);

  const misses = [];
  const check = (name, value, threshold) => { if (value === undefined || value === null) return; if (clamp01(value) + 1e-12 < threshold) misses.push(`${name} confidence ${(clamp01(value) * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(1)}%`); };
  check("Extraction", facts.extraction, t.extraction);
  check("Categorization", facts.categorization, t.categorization);
  check("Match", facts.match, t.match);
  if (facts.anomalyScore !== undefined && facts.anomalyScore !== null && facts.anomalyScore >= t.anomaly) misses.push(`anomaly score ${(facts.anomalyScore * 100).toFixed(0)}% is at or above ${(t.anomaly * 100).toFixed(0)}%`);
  for (const m of misses) reasons.push(m);

  if (!a.enabled) reasons.push("Auto-processing is switched off for this organization.");
  if (a.enabled && facts.amount > a.maxAmount) reasons.push(`Amount ${facts.amount.toFixed(2)} is above the auto-processing limit ${a.maxAmount}.`);
  if (a.enabled && a.requireKnownCounterparty && !facts.knownCounterparty) reasons.push("The counterparty is not a known supplier or contact.");
  if (a.enabled && facts.amount > a.requirePurchaseOrderAbove && facts.purchaseOrderRequired && !facts.purchaseOrderPresent) reasons.push(`A purchase order is required above ${a.requirePurchaseOrderAbove}.`);
  if (facts.extraction === undefined && facts.categorization === undefined && facts.match === undefined) reasons.push("There is nothing to score yet.");

  if (risk === "HIGH") return { decision: "APPROVAL", risk, reasons };
  if (reasons.length) return { decision: "REVIEW", risk, reasons };
  return { decision: "AUTO", risk, reasons: ["Every confidence dimension meets its threshold, no anomaly, low risk, within the auto-processing limit."] };
}
