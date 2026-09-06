// src/lib/portfolio-company.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§35) — Portfolio
// Company Management. "private_capital" vertical only. This module is
// deliberately just the workspace shell (company profile + status): board
// materials (board-management.js), KPIs (portfolio-kpis.js), strategic
// initiatives (value-creation.js), fundraising (fundraising.js), and
// investor reporting (private-capital-reporting.js) are all separate
// modules that attach to a company via portfolioCompanyId, not fields
// duplicated onto this document -- financials/legal/compliance/
// cybersecurity already have their own systems elsewhere in the platform
// (finance.js, legal-*, compliance-*) that a real deployment would link to
// rather than re-implementing here.

import { getOrgCollections, canManageFinancialEntities, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const PORTFOLIO_COMPANY_STATUSES = ["active", "exited", "written_off"];

/** Normally reached only via deal-pipeline.js's convertToPortfolio() --
 *  exported directly too for the rare case of onboarding an existing
 *  portfolio company with no deal record in this system (e.g. a fund
 *  migrating from a prior tool, per §273's migration-import requirement). */
export async function createPortfolioCompany({ orgId, fundId, name, dealId, sector, geography, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can create a portfolio company.", status: 403 };
  if (!name?.trim()) return { error: "A company name is required.", status: 400 };
  if (!fundId) return { error: "A fundId is required -- every portfolio company belongs to the fund/vehicle that invested in it.", status: 400 };

  const { portfolioCompanies } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), fundId: toObjectId(fundId), name: name.trim(), dealId: dealId ? toObjectId(dealId) : null,
    sector: sector || null, geography: geography || null,
    status: "active",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await portfolioCompanies.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "PORTFOLIO_COMPANY", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "active", metadata: { name: doc.name } });
  return { portfolioCompany: inserted };
}

export async function updatePortfolioCompanyStatus({ orgId, portfolioCompanyId, status, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a portfolio company.", status: 403 };
  if (!PORTFOLIO_COMPANY_STATUSES.includes(status)) return { error: `Unknown status "${status}".`, status: 400 };
  const { portfolioCompanies } = await getOrgCollections();
  const current = await portfolioCompanies.findOne({ _id: toObjectId(portfolioCompanyId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Portfolio company not found.", status: 404 };

  const updated = await portfolioCompanies.findOneAndUpdate(
    { _id: current._id },
    { $set: { status, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "PORTFOLIO_COMPANY", recordId: current._id, actorEmail, action: "STATUS_CHANGED", previousState: current.status, newState: status, metadata: {} });
  return { portfolioCompany: updated };
}

export async function getPortfolioCompany(orgId, portfolioCompanyId) {
  const { portfolioCompanies } = await getOrgCollections();
  return portfolioCompanies.findOne({ _id: toObjectId(portfolioCompanyId), orgId: toObjectId(orgId) });
}

export async function listPortfolioCompanies(orgId, { fundId, status } = {}) {
  const { portfolioCompanies } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (fundId) query.fundId = toObjectId(fundId);
  if (status) query.status = status;
  return portfolioCompanies.find(query).sort({ createdAt: -1 }).toArray();
}
