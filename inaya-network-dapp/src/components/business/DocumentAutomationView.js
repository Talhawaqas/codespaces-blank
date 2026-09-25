"use client";

// Native Document & Invoice Automation Engine -- the Business Workspace
// entry point (SOW §32): Create Document -> Select Type -> Select Record ->
// Review Data -> Preview -> Generate -> Approve -> Finalize -> Store -> Share,
// with draft / generated / approved / finalized / superseded versions clearly
// distinguished, plus templates, settings, verification and health.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import { api, BASE, Button, ErrorNote, StatusPill, PipelinePill, Pill, money, fmtDate, STATUS_LABELS, inputClass } from "./documents/shared";
import CreateDocumentWizard from "./documents/CreateDocumentWizard";
import DocumentDetail from "./documents/DocumentDetail";
import TemplatesPanel from "./documents/TemplatesPanel";
import SettingsPanel from "./documents/SettingsPanel";
import { VerifyPanel, HealthPanel } from "./documents/VerifyHealthPanels";

const TABS = ["Documents", "Create", "Templates", "Settings", "Verify", "Health"];

export default function DocumentAutomationView({ orgId, canManage, initialDocumentId }) {
  const [tab, setTab] = useState("Documents");
  const [meta, setMeta] = useState(null);
  const [docs, setDocs] = useState(null);
  const [selected, setSelected] = useState(initialDocumentId || null);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState("");

  const loadMeta = useCallback(async () => {
    try { setMeta(await api(`${BASE}/types?orgId=${orgId}`)); } catch (e) { setError(e.message); }
  }, [orgId]);

  const loadDocs = useCallback(async () => {
    try {
      const p = new URLSearchParams({ orgId, limit: "100" });
      if (q.trim()) p.set("q", q.trim());
      if (typeFilter) p.set("documentType", typeFilter);
      if (statusFilter) p.set("status", statusFilter);
      setDocs((await api(`${BASE}/documents?${p}`)).documents);
    } catch (e) { setError(e.message); }
  }, [orgId, q, typeFilter, statusFilter]);

  useEffect(() => { loadMeta(); }, [loadMeta]);
  // Deep link from an invoice or a notification: ?view=documentAutomation&doc=<id>
  useEffect(() => { const d = new URLSearchParams(window.location.search).get("doc"); if (d) setSelected(d); }, []);
  useEffect(() => { const t = setTimeout(loadDocs, 250); return () => clearTimeout(t); }, [loadDocs]);

  if (!meta) return <div className="text-sm text-[var(--inaya-text-muted)]">{error || "Loading..."}</div>;

  const typeOf = (id) => meta.types.find((t) => t.id === id);
  // The server decides what this member may do (canManageFinance etc.); the client only mirrors it.
  const canManageFinance = !!typeOf("invoice")?.canApprove;
  const canApproveSelected = (d) => !!typeOf(d?.documentType)?.canApprove;
  const canGenerateSelected = (d) => !!typeOf(d?.documentType)?.canGenerate;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-white/10" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); if (t !== "Documents") setSelected(null); }} className={`px-3 py-2 text-sm font-semibold ${tab === t ? "border-b-2 border-cyan-400 text-cyan-300" : "text-[var(--inaya-text-muted)] hover:text-white"}`}>{t}</button>
        ))}
      </div>
      <ErrorNote error={error} />

      {tab === "Documents" && !selected && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <input className={`${inputClass} max-w-xs`} placeholder="Search number, customer, type, status, date..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />
            <select className={`${inputClass} max-w-[200px]`} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type"><option value="">All types</option>{meta.types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
            <select className={`${inputClass} max-w-[200px]`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status"><option value="">All statuses</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <Button tone="primary" onClick={() => setTab("Create")}>Create document</Button>
          </div>
          {docs === null ? <div className="text-sm text-[var(--inaya-text-muted)]">Loading...</div> : docs.length === 0 ? (
            <EmptyState title="No documents yet" description="Generate an official, numbered, encrypted, verifiable document from an invoice, purchase order, quotation, payment, customer or report." ctaLabel="Create document" onCta={() => setTab("Create")} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-sm">
                <thead className="bg-black/30 text-left text-[11px] uppercase tracking-wide text-[var(--inaya-text-muted)]"><tr><th className="px-3 py-2">Number</th><th>Type</th><th>Counterparty</th><th className="text-right">Total</th><th>Status</th><th>Created</th></tr></thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id} onClick={() => setSelected(d.id)} className="cursor-pointer border-t border-white/5 hover:bg-white/5">
                      <td className="px-3 py-2 font-semibold">{d.documentNumber || "(numbering)"} <span className="text-xs font-normal text-[var(--inaya-text-muted)]">v{d.documentVersion}</span></td>
                      <td className="text-xs">{d.documentType.replace("_", " ")}</td>
                      <td className="text-xs">{d.counterpartyName || "-"}</td>
                      <td className="text-right text-xs">{money(d.grandTotal, d.currency)}</td>
                      <td><div className="flex flex-wrap items-center gap-1"><StatusPill status={d.status} /><PipelinePill state={d.pipelineState} />{d.approval.required && d.status === "GENERATED" && <Pill className="bg-blue-400/10 text-blue-400 border-blue-400/30">needs approval</Pill>}{d.evidence.nodes > 0 && <span title={`${d.evidence.nodes} evidence nodes`} className="text-[10px] text-[var(--inaya-text-muted)]">evidence {d.evidence.nodes}</span>}</div></td>
                      <td className="text-xs text-[var(--inaya-text-muted)]">{fmtDate(d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "Documents" && selected && (
        <DocumentDetail
          orgId={orgId} documentId={selected}
          canApprove={docs?.find((d) => d.id === selected) ? canApproveSelected(docs.find((d) => d.id === selected)) : canManageFinance}
          canGenerate={docs?.find((d) => d.id === selected) ? canGenerateSelected(docs.find((d) => d.id === selected)) : canManageFinance}
          onChanged={loadDocs} onClose={() => setSelected(null)}
        />
      )}

      {tab === "Create" && <CreateDocumentWizard orgId={orgId} types={meta.types} templates={meta.templates} onCreated={(d) => { setTab("Documents"); setSelected(d.id); loadDocs(); }} />}
      {tab === "Templates" && <TemplatesPanel orgId={orgId} types={meta.types} canManage={canManage} onChanged={loadMeta} />}
      {tab === "Settings" && <SettingsPanel orgId={orgId} canManage={canManageFinance} />}
      {tab === "Verify" && <VerifyPanel />}
      {tab === "Health" && <HealthPanel orgId={orgId} canManage={canManage} />}
    </div>
  );
}
