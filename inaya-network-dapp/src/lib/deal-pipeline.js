// src/lib/deal-pipeline.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§29-30) — Deal
// CRM + Deal Screening. "private_capital" vertical only. Distinct
// collection/module from deal-workflow.js's sales-pipeline crmDeals — this
// is an investment deal (Sourced -> ... -> Portfolio), a different concept
// entirely, but reuses that file's exact proven transition pattern: linear
// one-stage-at-a-time advance/regress through the open pipeline, a
// terminal close action reachable from ANY open stage (here "pass", not
// "lose"), and reopen returning a closed deal to the start rather than
// reconstructing history.
//
// "Portfolio" is not a plain terminal stage like WON -- reaching it
// creates a real portfolio_companies workspace (§35), never just a status
// label. convertToPortfolio() is therefore its own function, not a generic
// "advance" call.

import { getOrgCollections, canAccessFinancialEntities, canManageFinancialEntities, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createPortfolioCompany } from "./portfolio-company.js";

export const DEAL_STAGES = [
  "SOURCED", "SCREENED", "INITIAL_REVIEW", "PARTNER_REVIEW", "DILIGENCE",
  "IC", "TERM_SHEET", "NEGOTIATION", "CLOSING", "PORTFOLIO", "PASSED",
];
const OPEN_PIPELINE = ["SOURCED", "SCREENED", "INITIAL_REVIEW", "PARTNER_REVIEW", "DILIGENCE", "IC", "TERM_SHEET", "NEGOTIATION", "CLOSING"];

function nextOpenStage(stage) {
  const i = OPEN_PIPELINE.indexOf(stage);
  return i >= 0 && i < OPEN_PIPELINE.length - 1 ? OPEN_PIPELINE[i + 1] : null;
}
function prevOpenStage(stage) {
  const i = OPEN_PIPELINE.indexOf(stage);
  return i > 0 ? OPEN_PIPELINE[i - 1] : null;
}

export async function createDeal({ orgId, fundId, company, founder, sector, geography, dealSource, referralSource, valuation, round, ownershipTarget, checkSize, partnerEmail, leadEmail, coInvestors, probability, timeline, nextAction, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!company?.trim()) return { error: "A company name is required.", status: 400 };
  if (!fundId) return { error: "A fundId is required -- every deal is made through a specific fund/vehicle.", status: 400 };

  const { privateCapitalDeals } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), fundId: toObjectId(fundId), company: company.trim(), founder: founder || null, sector: sector || null,
    geography: geography || null, dealSource: dealSource || null, referralSource: referralSource || null,
    valuation: valuation ?? null, round: round || null, ownershipTarget: ownershipTarget ?? null, checkSize: checkSize ?? null,
    partnerEmail: partnerEmail || null, leadEmail: leadEmail || actorEmail, coInvestors: coInvestors || [],
    probability: probability ?? null, timeline: timeline || null, nextAction: nextAction || null,
    portfolioCompanyId: null,
    stage: "SOURCED",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await privateCapitalDeals.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "PC_DEAL", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "SOURCED", metadata: { company: doc.company } });
  return { deal: inserted };
}

export async function transitionDeal({ orgId, dealId, action, actorEmail, membership, note }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a deal.", status: 403 };
  if (!["advance", "regress", "pass", "reopen"].includes(action)) return { error: `Unknown action "${action}".`, status: 400 };

  const { privateCapitalDeals } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const dealObjectId = toObjectId(dealId);
  const deal = await privateCapitalDeals.findOne({ _id: dealObjectId, orgId: orgObjectId });
  if (!deal) return { error: "Deal not found.", status: 404 };

  let to;
  let activityAction;
  if (action === "advance") {
    to = nextOpenStage(deal.stage);
    if (!to) return { error: `"${deal.stage}" has no next pipeline stage -- use convertToPortfolio() to close a CLOSING deal into a portfolio company, or "pass" to decline it.`, status: 409 };
    activityAction = "DEAL_ADVANCED";
  } else if (action === "regress") {
    to = prevOpenStage(deal.stage);
    if (!to) return { error: `"${deal.stage}" has no previous pipeline stage.`, status: 409 };
    activityAction = "DEAL_REGRESSED";
  } else if (action === "pass") {
    if (!OPEN_PIPELINE.includes(deal.stage)) return { error: `A deal in "${deal.stage}" can't be passed on -- it's already closed.`, status: 409 };
    to = "PASSED";
    activityAction = "DEAL_PASSED";
  } else {
    if (deal.stage !== "PASSED") return { error: `Only a PASSED deal can be reopened (this one is "${deal.stage}").`, status: 409 };
    to = "SOURCED";
    activityAction = "DEAL_REOPENED";
  }

  const now = new Date().toISOString();
  const updated = await privateCapitalDeals.findOneAndUpdate(
    { _id: dealObjectId, orgId: orgObjectId, stage: deal.stage },
    { $set: { stage: to, updatedAt: now }, ...(note ? { $push: { notes: { note, actorEmail, at: now } } } : {}) },
    { returnDocument: "after" }
  );
  if (!updated) return { error: `This deal's stage changed since it was loaded (was "${deal.stage}") -- reload and try again.`, status: 409 };

  await logOrgActivity({ orgId, recordType: "PC_DEAL", recordId: dealObjectId, actorEmail, action: activityAction, previousState: deal.stage, newState: to, metadata: note ? { note } : {} });
  return { deal: updated };
}

/** The only path from CLOSING to PORTFOLIO -- creates a real
 *  portfolio_companies workspace (§35) and links it back on the deal.
 *  Reaching "Portfolio" is never just a status label. */
export async function convertToPortfolio({ orgId, dealId, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can convert a deal to portfolio.", status: 403 };
  const { privateCapitalDeals } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const dealObjectId = toObjectId(dealId);
  const deal = await privateCapitalDeals.findOne({ _id: dealObjectId, orgId: orgObjectId });
  if (!deal) return { error: "Deal not found.", status: 404 };
  if (deal.stage !== "CLOSING") return { error: `A deal can only convert to portfolio from CLOSING (this one is "${deal.stage}").`, status: 409 };

  const { portfolioCompany } = await createPortfolioCompany({ orgId, fundId: deal.fundId, name: deal.company, dealId: deal._id, actorEmail, membership });

  const now = new Date().toISOString();
  const updated = await privateCapitalDeals.findOneAndUpdate(
    { _id: dealObjectId, orgId: orgObjectId, stage: "CLOSING" },
    { $set: { stage: "PORTFOLIO", portfolioCompanyId: portfolioCompany._id, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This deal's stage changed since it was loaded -- reload and try again.", status: 409 };

  await logOrgActivity({ orgId, recordType: "PC_DEAL", recordId: dealObjectId, actorEmail, action: "CONVERTED_TO_PORTFOLIO", previousState: "CLOSING", newState: "PORTFOLIO", metadata: { portfolioCompanyId: portfolioCompany._id } });
  return { deal: updated, portfolioCompany };
}

export async function listDeals(orgId, { fundId, stage } = {}) {
  const { privateCapitalDeals } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (fundId) query.fundId = toObjectId(fundId);
  if (stage) query.stage = stage;
  return privateCapitalDeals.find(query).sort({ createdAt: -1 }).toArray();
}

// ============================================================
// DEAL SCREENING (§30) -- configurable weighted scorecards, versioned
// per evaluator (never overwritten -- a re-score is a NEW version).
// ============================================================
export const SCORECARD_CRITERIA = [
  "market", "team", "product", "traction", "financials", "moat", "competition",
  "regulatory_risk", "technical_risk", "cybersecurity", "customer_concentration",
  "capital_efficiency", "valuation", "exit_potential", "strategic_fit",
];

/** scores: { [criterion]: { score, weight } }. Every submission is a new,
 *  immutable version -- scores must retain evaluator/timestamp/version/
 *  rationale (§30), so a scorecard is never edited in place. */
export async function submitScorecard({ orgId, dealId, scores, rationale, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!scores || typeof scores !== "object" || Object.keys(scores).length === 0) return { error: "At least one criterion score is required.", status: 400 };
  for (const criterion of Object.keys(scores)) {
    if (!SCORECARD_CRITERIA.includes(criterion)) return { error: `Unknown scorecard criterion "${criterion}".`, status: 400 };
  }

  const { dealScorecards } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const dealObjectId = toObjectId(dealId);
  const priorVersions = await dealScorecards.find({ orgId: orgObjectId, dealId: dealObjectId, evaluatorEmail: actorEmail }).sort({ version: -1 }).limit(1).toArray();
  const version = (priorVersions[0]?.version || 0) + 1;

  const weightedTotal = Object.values(scores).reduce((sum, s) => sum + (s.score || 0) * (s.weight ?? 1), 0);
  const totalWeight = Object.values(scores).reduce((sum, s) => sum + (s.weight ?? 1), 0);

  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId, dealId: dealObjectId, version, scores, rationale: rationale || null,
    weightedScore: totalWeight > 0 ? weightedTotal / totalWeight : null,
    evaluatorEmail: actorEmail, evaluatedAt: now,
  };
  const result = await dealScorecards.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "PC_DEAL", recordId: dealObjectId, actorEmail, action: "SCORECARD_SUBMITTED", previousState: null, newState: null, metadata: { version, weightedScore: doc.weightedScore } });
  return { scorecard: inserted };
}

export async function listScorecards(orgId, dealId) {
  const { dealScorecards } = await getOrgCollections();
  return dealScorecards.find({ orgId: toObjectId(orgId), dealId: toObjectId(dealId) }).sort({ evaluatedAt: -1 }).toArray();
}
