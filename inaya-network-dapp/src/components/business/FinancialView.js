"use client";

// src/components/business/FinancialView.js
//
// Financial Services & Regulated Enterprise SOW, Phase 1 (Financial
// Entity Core) — Funds (with a Fund Workspace: team + investors +
// capital accounts), Entities, and Counterparties. Shared by both the
// "financial" (hedge funds/asset managers) and "private_capital" (PE/VC)
// verticals — Phase 2 (Investment Management) and Phase 3 (Private
// Capital) will each add their own vertical-specific tabs here later.
// Same self-contained-view pattern as HealthView.js/RegulatedView.js.
//
// Business Workspace gap closure, Batch 3: the tabs now live in
// ./financial/*.js (moved verbatim); this file is the tab switcher.

import { useState } from "react";
import { CounterpartiesTab } from "./financial/counterparties.js";
import { EntitiesTab } from "./financial/entities.js";
import { FundsTab } from "./financial/funds.js";
import { CommitteeTab } from "./financial/committee.js";
import { ThesesTab } from "./financial/theses.js";
import { PortfolioTab } from "./financial/portfolio.js";
import { DealsTab } from "./financial/pcDeals.js";
import { ExitsTab } from "./financial/pcExits.js";
import { FundraisingTab } from "./financial/pcFundraising.js";
import { PrivateCapitalPortfolioTab } from "./financial/pcPortfolio.js";
import { SpvsTab } from "./financial/pcSpvs.js";
import { ResearchTab } from "./financial/research.js";
import { useErpSection } from "./erp/ErpNavContext";

// Financial Services & Regulated Enterprise SOW, Phase 2 (Investment
// Management) — Research/Theses/Committee/Portfolio tabs are specific to
// running a fund's book, not to private-capital deal work, so they only
// render for the "financial" vertical, never "private_capital".
export default function FinancialView({ orgId, vertical }) {
  const isFinancial = vertical === "financial";
  const isPrivateCapital = vertical === "private_capital";
  const [tab, setTab] = useErpSection("funds", [
    ["funds", "Funds"], ["entities", "Entities"], ["counterparties", "Counterparties"],
    ...(isFinancial ? [["research", "Research"], ["theses", "Theses"]] : []),
    ...(isFinancial || isPrivateCapital ? [["committee", "Committee"]] : []),
    ...(isFinancial ? [["portfolio", "Portfolio"]] : []),
    ...(isPrivateCapital ? [["deals", "Deals"], ["pcPortfolio", "Portfolio"], ["fundraising", "Fundraising"], ["exits", "Exits"], ["spvs", "SPVs"]] : []),
  ]);
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap" data-erp-tabs>
        <button onClick={() => setTab("funds")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "funds" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Funds</button>
        <button onClick={() => setTab("entities")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "entities" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Entities</button>
        <button onClick={() => setTab("counterparties")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "counterparties" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Counterparties</button>
        {isFinancial && <button onClick={() => setTab("research")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "research" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Research</button>}
        {isFinancial && <button onClick={() => setTab("theses")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "theses" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Theses</button>}
        {(isFinancial || isPrivateCapital) && <button onClick={() => setTab("committee")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "committee" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Committee</button>}
        {isFinancial && <button onClick={() => setTab("portfolio")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "portfolio" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Portfolio</button>}
        {isPrivateCapital && <button onClick={() => setTab("deals")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "deals" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Deals</button>}
        {isPrivateCapital && <button onClick={() => setTab("pcPortfolio")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "pcPortfolio" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Portfolio</button>}
        {isPrivateCapital && <button onClick={() => setTab("fundraising")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "fundraising" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Fundraising</button>}
        {isPrivateCapital && <button onClick={() => setTab("exits")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "exits" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Exits</button>}
        {isPrivateCapital && <button onClick={() => setTab("spvs")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "spvs" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>SPVs</button>}
      </div>
      {tab === "funds" && <FundsTab orgId={orgId} />}
      {tab === "entities" && <EntitiesTab orgId={orgId} />}
      {tab === "counterparties" && <CounterpartiesTab orgId={orgId} />}
      {isFinancial && tab === "research" && <ResearchTab orgId={orgId} />}
      {isFinancial && tab === "theses" && <ThesesTab orgId={orgId} />}
      {(isFinancial || isPrivateCapital) && tab === "committee" && <CommitteeTab orgId={orgId} />}
      {isFinancial && tab === "portfolio" && <PortfolioTab orgId={orgId} />}
      {isPrivateCapital && tab === "deals" && <DealsTab orgId={orgId} />}
      {isPrivateCapital && tab === "pcPortfolio" && <PrivateCapitalPortfolioTab orgId={orgId} />}
      {isPrivateCapital && tab === "fundraising" && <FundraisingTab orgId={orgId} />}
      {isPrivateCapital && tab === "exits" && <ExitsTab orgId={orgId} />}
      {isPrivateCapital && tab === "spvs" && <SpvsTab orgId={orgId} />}
    </div>
  );
}
