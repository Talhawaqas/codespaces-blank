"use client";

// src/components/business/BookkeeperView.js
//
// AI Bookkeeper SOW section 44: Business Workspace > AI Bookkeeper. Overview, Transactions, Documents, Review queue, Reconciliation, Sources, Rules,
// Reports (with read-only what-if), Settings. Real calls to /api/orgs/finance/bookkeeper/*; the server enforces every permission; nothing is
// computed or simulated in the browser, and no savings figures are shown.

import { useState } from "react";
import EmptyState from "../EmptyState";
import { Note } from "./nas/ui";
import { OverviewPanel, TransactionsPanel, DocumentsPanel } from "./bookkeeper/panels";
import { ReviewPanel, ReconciliationPanel, SourcesPanel, RulesPanel, ReportsPanel, SettingsPanel } from "./bookkeeper/panels2";

const TABS = [["overview", "Overview"], ["transactions", "Transactions"], ["documents", "Invoices & receipts"], ["review", "Review queue"], ["reconciliation", "Reconciliation"], ["sources", "Sources"], ["rules", "Rules"], ["reports", "Reports"], ["settings", "Policy"]];

export default function BookkeeperView({ orgId, canManage, canAdmin, hasFinance = true }) {
  const [tab, setTab] = useState("overview"); const [openTxn, setOpenTxn] = useState(null);
  if (!hasFinance) return <EmptyState title="No access to AI Bookkeeper" description="Ask an organization owner or admin to give you a Finance role." />;
  const goTxn = (id) => { setOpenTxn(id); setTab("transactions"); };
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">AI Bookkeeper</h2>
        <p className="text-sm text-[var(--inaya-text-muted)]">Captures bills and receipts from upload, email and WhatsApp, imports bank statements, categorizes, matches and reconciles, and sends anything uncertain or risky to you.
          The AI recommends; you and your existing approvals decide. Nothing is posted or paid without a person, and every step is audited and recorded as evidence.</p>
      </header>
      <nav aria-label="Bookkeeper sections" className="flex flex-wrap gap-1">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => { setTab(id); if (id !== "transactions") setOpenTxn(null); }} aria-current={tab === id ? "page" : undefined}
            className={`rounded border px-3 py-1.5 text-xs font-medium ${tab === id ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </nav>
      {tab === "overview" && <OverviewPanel orgId={orgId} canManage={canManage} onOpenTxn={goTxn} goTab={setTab} />}
      {tab === "transactions" && <TransactionsPanel orgId={orgId} canManage={canManage} openId={openTxn} setOpenId={setOpenTxn} />}
      {tab === "documents" && <DocumentsPanel orgId={orgId} canManage={canManage} />}
      {tab === "review" && <ReviewPanel orgId={orgId} canManage={canManage} />}
      {tab === "reconciliation" && <ReconciliationPanel orgId={orgId} canManage={canManage} />}
      {tab === "sources" && <SourcesPanel orgId={orgId} canAdmin={canAdmin} canManage={canManage} />}
      {tab === "rules" && <RulesPanel orgId={orgId} canManage={canManage} />}
      {tab === "reports" && <ReportsPanel orgId={orgId} />}
      {tab === "settings" && <SettingsPanel orgId={orgId} canAdmin={canAdmin} />}
      <Note>Live bank feeds, live email providers and WhatsApp are not verified against real providers; statement import, upload and signed relays are. There is no general ledger: &quot;posted&quot; means a recorded payment or a draft expense.</Note>
    </div>
  );
}
