"use client";

// src/components/TrustHealthCard.js
//
// Enterprise OS SOW, Phase 2 — surface-agnostic presentational component
// for a trustHealth.js snapshot (either scope: "org" or scope: "wallet",
// see GET /api/orgs/trust-health / GET /api/wallet/trust-health). Pure
// presentation: the snapshot is fetched by whichever OsHome view renders
// this (Phase 7), same "fetch in the container, render in the leaf"
// split InsightsView.js already uses. Card container styling matches
// InsightsView.js's existing KPI card convention exactly (bg-[var(--inaya-
// surface)] border border-white/5 rounded-2xl) rather than inventing a
// new look for one more card.

const STATUS_STYLE = {
  good: { label: "All good", dot: "bg-emerald-400", text: "text-emerald-400", ring: "border-emerald-400/30" },
  attention: { label: "Needs attention", dot: "bg-amber-400", text: "text-amber-400", ring: "border-amber-400/30" },
  critical: { label: "Action required", dot: "bg-red-400", text: "text-red-400", ring: "border-red-400/30" },
};

function Row({ label, value }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-[var(--inaya-text-muted)]">{label}</span>
      <span className="text-[var(--inaya-text-primary)] font-mono font-semibold">{value}</span>
    </div>
  );
}

export default function TrustHealthCard({ snapshot, loading, error }) {
  if (loading) {
    return (
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4 animate-pulse">
        <div className="h-4 w-32 bg-white/10 rounded mb-3" />
        <div className="h-3 w-full bg-white/5 rounded mb-2" />
        <div className="h-3 w-2/3 bg-white/5 rounded" />
      </div>
    );
  }
  if (error || !snapshot) {
    return (
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
        <p className="text-[12px] text-[var(--inaya-text-muted)]">Trust &amp; health status unavailable{error ? `: ${error}` : "."}</p>
      </div>
    );
  }

  const style = STATUS_STYLE[snapshot.overallStatus] || STATUS_STYLE.good;
  const isOrg = snapshot.scope === "org";

  return (
    <div className={`bg-[var(--inaya-surface)] border ${style.ring} rounded-2xl p-4`}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)]">Trust &amp; Health</p>
        <span className={`flex items-center gap-1.5 text-[11px] font-bold uppercase ${style.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
          {style.label}
        </span>
      </div>

      {isOrg ? (
        <div className="space-y-1.5">
          <Row label="Audit trail" value={snapshot.auditTrail?.intact ? "Intact" : `Broken at #${snapshot.auditTrail?.brokenAtSeq}`} />
          <Row label="High-risk AI actions pending" value={snapshot.aiActions?.pendingHighRisk} />
          <Row label="Medium-risk AI actions pending" value={snapshot.aiActions?.pendingMediumRisk} />
          <Row label="Past settlement delay, unexecuted" value={snapshot.aiActions?.stalePastSettlement} />
          {snapshot.businessHealth && (
            <>
              <Row label="Overdue invoices" value={snapshot.businessHealth.overdueInvoices} />
              <Row label="Overdue tasks" value={snapshot.businessHealth.overdueTasks} />
              <Row label="Low-stock items" value={snapshot.businessHealth.lowStockItems} />
            </>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <Row label="Backup status" value={snapshot.backup?.worstState || "No assets found"} />
          <Row label="Assets needing recovery" value={snapshot.backup?.assetsNeedingRecovery} />
          <Row label="Assets checked" value={snapshot.backup?.assetsCapped ? `${snapshot.backup.assetsChecked}+` : snapshot.backup?.assetsChecked} />
          <Row label="Recent blocked threats" value={snapshot.security?.recentBlocked} />
          <Row label="Recent warnings" value={snapshot.security?.recentWarned} />
        </div>
      )}

      {snapshot.scopeNotes && (
        <p className="text-[11px] text-[var(--inaya-text-muted)] mt-3 pt-3 border-t border-white/5 leading-relaxed">{snapshot.scopeNotes}</p>
      )}
    </div>
  );
}
