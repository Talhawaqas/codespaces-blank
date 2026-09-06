// src/lib/private-capital-reporting.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§43) — Private
// Capital Investor Reporting. "private_capital" vertical only.
//
// A thin aggregator, not a new storage system: capital account/
// commitment/contribution/distribution/ownership all come straight from
// financial-investors.js's existing getCapitalAccountSummary() (Phase 1),
// and portfolio exposure comes from portfolio-company.js +
// cap-table.js's latest snapshots (Phase 3). NAV and fund-level
// performance are deliberately NOT computed here: unlike Phase 2's
// hedge-fund positions (which have a live valuation-management.js
// pipeline), a PE/VC portfolio company's fair value is whatever its
// latest cap-table snapshot implies at best, and this module reports
// exactly that (or null if no snapshot exists) rather than inventing a
// NAV figure this system has no real basis for.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities } from "./orgGates.js";
import { getCapitalAccountSummary } from "./financial-investors.js";
import { listPortfolioCompanies } from "./portfolio-company.js";
import { getLatestCapTableSnapshot } from "./cap-table.js";

/** One LP's full report for one fund: capital account (real, from Phase
 *  1's ledger) + the fund's portfolio composition (real, from Phase 3's
 *  own records) + each holding's latest approved valuation basis, if
 *  any exists -- never fabricated when it doesn't. */
export async function getInvestorReport({ orgId, investorId, fundId, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };

  const capitalAccount = await getCapitalAccountSummary(orgId, investorId, fundId);
  const portfolioCompanies = await listPortfolioCompanies(orgId, { fundId });

  const portfolioExposure = await Promise.all(portfolioCompanies.map(async (company) => {
    const snapshot = await getLatestCapTableSnapshot(orgId, company._id);
    return {
      portfolioCompanyId: company._id, name: company.name, status: company.status,
      capTableAsOf: snapshot?.asOfDate || null,
      capTableApproved: !!snapshot?.approvedAt,
      totalFullyDilutedShares: snapshot?.totalFullyDilutedShares ?? null,
    };
  }));

  return {
    capitalAccount,
    portfolioExposure,
    // Explicitly not computed -- see file header for why.
    nav: null,
    performance: null,
  };
}

/** Fund-level roll-up across every portfolio company the fund holds --
 *  same "real data or null" discipline as getInvestorReport(). */
export async function getFundLevelMetrics({ orgId, fundId, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };

  const { financialInvestors } = await getOrgCollections();
  const investors = await financialInvestors.find({ orgId: toObjectId(orgId), fundId: toObjectId(fundId) }).toArray();
  const portfolioCompanies = await listPortfolioCompanies(orgId, { fundId });

  let totalContribution = 0;
  let totalDistribution = 0;
  for (const investor of investors) {
    const summary = await getCapitalAccountSummary(orgId, investor._id, fundId);
    totalContribution += summary.totals.contribution || 0;
    totalDistribution += summary.totals.distribution || 0;
  }

  return {
    investorCount: investors.length,
    portfolioCompanyCount: portfolioCompanies.length,
    activePortfolioCompanyCount: portfolioCompanies.filter((c) => c.status === "active").length,
    exitedPortfolioCompanyCount: portfolioCompanies.filter((c) => c.status === "exited").length,
    totalContribution, totalDistribution,
    nav: null, // see file header
  };
}
