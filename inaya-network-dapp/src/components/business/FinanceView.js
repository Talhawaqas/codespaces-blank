"use client";

// src/components/business/FinanceView.js
//
// Finance tab (Phase 5) — Invoices / Expenses / Payments / Reports, backed
// by /api/orgs/finance/*. Same self-contained-view pattern as
// TasksView/CRMView/ProcurementView/InventoryView: its own small api()
// helper, taking only {orgId, email} from the shell. Action buttons
// (send/markPaid/approve/etc.) are shown regardless of the caller's
// financeRole — the server is the real access-control boundary (same
// "buttons are UX clarity only" convention DocumentColumn/TasksView
// already established); a 403 just surfaces as an error message here.
//
// Carries a visible "Testnet / Beta" badge per the SOW's explicit
// requirement (§8) — this is a validation/demonstration layer, not
// regulated banking/tax/payroll infrastructure.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import { encryptAndShardFile } from "../../lib/clientCrypto";
import { SUPPORTED_CURRENCIES } from "../../lib/currency.js";
import ConfirmButton from "./ConfirmButton";
import { useErpSection, useErpTabsHidden, useErpCreate } from "./erp/ErpNavContext";

const DESTRUCTIVE_ACTIONS = new Set(["cancel", "reject"]);

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_COLORS = {
  DRAFT: "bg-white/10 text-[var(--inaya-text-primary)] border-white/15",
  SENT: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  PAID: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  OVERDUE: "bg-red-400/10 text-red-400 border-red-400/30",
  CANCELLED: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  PENDING_APPROVAL: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  APPROVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  RECORDED: "bg-white/10 text-[var(--inaya-text-primary)] border-white/15",
};

function StatusBadge({ status }) {
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_COLORS[status] || "bg-white/10 text-[var(--inaya-text-primary)] border-white/15"}`}>{status?.replace(/_/g, " ")}</span>;
}

export default function FinanceView({ orgId, email }) {
  const [tab, setTab] = useErpSection("invoices", ["invoices", "expenses", "payments", "reports", "ledger"]);
  const tabsHidden = useErpTabsHidden();
  const [departments, setDepartments] = useState([]);
  const [departmentsError, setDepartmentsError] = useState("");

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => { setDepartments(d.departments); setDepartmentsError(""); }).catch((err) => setDepartmentsError(`Couldn't load departments: ${err.message}`));
  }, [orgId]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        {!tabsHidden && (
          <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
            {[["invoices", "Invoices"], ["expenses", "Expenses"], ["payments", "Payments"], ["reports", "Reports"], ["ledger", "Ledger"]].map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
            ))}
          </div>
        )}
        <span className="text-[10px] font-bold uppercase px-2.5 py-1 rounded-full border bg-amber-400/10 text-amber-400 border-amber-400/30">Testnet / Beta</span>
      </div>
      {departmentsError && <p className="text-red-400 text-xs">{departmentsError}</p>}
      {tab === "invoices" && <InvoicesTab orgId={orgId} email={email} departments={departments} />}
      {tab === "expenses" && <ExpensesTab orgId={orgId} email={email} departments={departments} />}
      {tab === "payments" && <PaymentsTab orgId={orgId} departments={departments} />}
      {tab === "reports" && <ReportsTab orgId={orgId} />}
      {tab === "ledger" && <LedgerTab orgId={orgId} />}
    </div>
  );
}

// ============================================================
// INVOICES
// ============================================================
function InvoicesTab({ orgId, email, departments }) {
  const [invoices, setInvoices] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  useErpCreate("invoices", () => setShowCreate(true));
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setInvoices((await api(`/api/orgs/finance/invoices?orgId=${orgId}`)).invoices);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const filtered = (invoices || []).filter((inv) => !search.trim() || inv.invoiceNumber.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input aria-label="Search invoice #" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search invoice #…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New invoice</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!invoices ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : invoices.length === 0 ? (
          <EmptyState compact icon="🧾" description="No invoices yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No invoices match "{search}".</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((inv) => (
              <button key={inv.id} onClick={() => setSelected(inv)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{inv.invoiceNumber}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">Due {new Date(inv.dueDate).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{inv.currency} {inv.total.toFixed(2)}</span>
                  <StatusBadge status={inv.status} />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateInvoiceModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <InvoiceDetailModal orgId={orgId} email={email} invoice={selected} onClose={() => setSelected(null)} onChanged={() => { load(); setSelected(null); }} />}
    </div>
  );
}

function CreateInvoiceModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [contacts, setContacts] = useState([]);
  const [contactId, setContactId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [lineItems, setLineItems] = useState([{ description: "", quantity: "1", unitPrice: "" }]);
  const [terms, setTerms] = useState({ paymentTerms: "", poNumber: "", taxPercent: "", discountPercent: "", shippingAmount: "", feeAmount: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!departmentId) { setContacts([]); return; }
    api(`/api/orgs/crm/contacts?orgId=${orgId}&departmentId=${departmentId}&type=CUSTOMER`).then((d) => { setContacts(d.contacts); setError(""); }).catch((err) => { setContacts([]); setError(`Couldn't load customers: ${err.message}`); });
  }, [orgId, departmentId]);

  function updateItem(i, field, value) {
    setLineItems((items) => items.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));
  }
  function addItem() { setLineItems((items) => [...items, { description: "", quantity: "1", unitPrice: "" }]); }
  function removeItem(i) { setLineItems((items) => items.filter((_, idx) => idx !== i)); }

  const total = lineItems.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !contactId || !dueDate) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/finance/invoices", {
        method: "POST",
        body: JSON.stringify({
          orgId, departmentId, contactId, dueDate, currency, notes: notes.trim() || undefined,
          lineItems: lineItems.map((it) => ({ description: it.description.trim(), quantity: Number(it.quantity), unitPrice: Number(it.unitPrice) })),
          ...(terms.paymentTerms.trim() ? { paymentTerms: terms.paymentTerms.trim() } : {}),
          ...(terms.poNumber.trim() ? { poNumber: terms.poNumber.trim() } : {}),
          ...Object.fromEntries(["taxPercent", "discountPercent", "shippingAmount", "feeAmount"].filter((k) => terms[k] !== "").map((k) => [k, Number(terms[k])])),
        }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New invoice" onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select aria-label="Department" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setContactId(""); }} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select aria-label="Customer" value={contactId} onChange={(e) => setContactId(e.target.value)} required disabled={!departmentId} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
          <option value="">Customer…</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input value={dueDate} onChange={(e) => setDueDate(e.target.value)} type="date" required className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <div className="space-y-2 border-t border-white/5 pt-3">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Line items</p>
          {lineItems.map((item, i) => (
            <div key={i} className="grid grid-cols-[1fr_60px_80px_24px] gap-1.5">
              <input aria-label="Description" value={item.description} onChange={(e) => updateItem(i, "description", e.target.value)} placeholder="Description" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <input aria-label="Qty" value={item.quantity} onChange={(e) => updateItem(i, "quantity", e.target.value)} type="number" min="0.000001" step="any" placeholder="Qty" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <input aria-label="Price" value={item.unitPrice} onChange={(e) => updateItem(i, "unitPrice", e.target.value)} type="number" min="0" step="any" placeholder="Price" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <button type="button" onClick={() => removeItem(i)} disabled={lineItems.length === 1} className="text-[var(--inaya-text-muted)] hover:text-red-400 disabled:opacity-30 text-lg leading-none">×</button>
            </div>
          ))}
          <button type="button" onClick={addItem} className="text-[11px] font-bold uppercase text-[#00f2fe]">+ Add line</button>
          <p className="text-right text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">Total: {currency} {total.toFixed(2)}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 border-t border-white/5 pt-3">
          <p className="col-span-2 text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Commercial terms (optional)</p>
          {[["paymentTerms", "Payment terms (e.g. Net 30)"], ["poNumber", "Customer PO number"], ["taxPercent", "Tax % (blank = company default)"], ["discountPercent", "Invoice discount %"], ["shippingAmount", "Shipping amount"], ["feeAmount", "Fees amount"]].map(([k, label]) => (
            <input key={k} value={terms[k]} onChange={(e) => setTerms({ ...terms, [k]: e.target.value })} placeholder={label} aria-label={label} inputMode={k === "paymentTerms" || k === "poNumber" ? "text" : "decimal"} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
          ))}
          <p className="col-span-2 text-[10px] text-[var(--inaya-text-muted)]">The stored total is computed exactly by the server (tax, discount, shipping and fees included) - the amount shown above is only a line-item estimate.</p>
        </div>
        <textarea aria-label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" rows={2} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !contactId || !dueDate} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create invoice"}</button>
      </form>
    </Modal>
  );
}

const INVOICE_ACTIONS = {
  DRAFT: [["send", "Send"]],
  SENT: [["markPaid", "Mark paid"], ["cancel", "Cancel"]],
  OVERDUE: [["markPaid", "Mark paid"], ["cancel", "Cancel"]],
};

// Batch 3 — UBL 2.1 / Peppol BIS Billing 3.0 file (lib/einvoice/ubl.js).
// Checks first, so missing seller/buyer details are listed instead of a failed download.
function EInvoiceButton({ orgId, invoice }) {
  const [problems, setProblems] = useState(null);
  const [checking, setChecking] = useState(false);
  const base = `/api/orgs/finance/invoices/${invoice.id}/einvoice?orgId=${orgId}`;
  async function check() {
    setChecking(true);
    try {
      const r = await api(`${base}&check=1`);
      if (r.ready) { setProblems([]); window.location.href = base; } else setProblems(r.problems);
    } catch (err) { setProblems([err.message]); } finally { setChecking(false); }
  }
  return (
    <div className="space-y-1">
      <button onClick={check} disabled={checking} className="inline-block text-[11px] font-bold uppercase px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">{checking ? "Checking…" : "Download e-invoice (UBL / Peppol)"}</button>
      {problems?.length > 0 && (
        <ul className="text-[11px] text-amber-400 list-disc pl-4 space-y-0.5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      <p className="text-[10px] text-[var(--inaya-text-muted)]">A standards-format file for the buyer's accounting system. Sending it over the Peppol network needs a certified access point.</p>
    </div>
  );
}

function InvoiceDetailModal({ orgId, invoice, onClose, onChanged }) {
  const [activity, setActivity] = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/finance/invoices/${invoice.id}/activity?orgId=${orgId}`).then((d) => setActivity(d.activity)).catch(() => setActivity([]));
  }, [orgId, invoice.id]);

  async function handleAction(action) {
    setSubmitting(action);
    setError("");
    try {
      await api(`/api/orgs/finance/invoices/${invoice.id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Modal title={invoice.invoiceNumber} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <StatusBadge status={invoice.status} />
          <span className="text-[var(--inaya-text-primary)] text-lg font-mono tabular-nums">{invoice.currency} {invoice.total.toFixed(2)}</span>
        </div>
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">Issued {new Date(invoice.issueDate).toLocaleDateString()} · Due {new Date(invoice.dueDate).toLocaleDateString()}</p>
        <a
          href={`/api/orgs/finance/invoices/${invoice.id}/pdf?orgId=${orgId}`}
          target="_blank" rel="noreferrer"
          className="inline-block text-[11px] font-bold uppercase px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10"
        >
          Generate PDF Invoice
        </a>
        <EInvoiceButton orgId={orgId} invoice={invoice} />

        <div className="space-y-1 border-t border-white/5 pt-3">
          {invoice.lineItems.map((it, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-[var(--inaya-text-primary)]">{it.description} × {it.quantity}</span>
              <span className="text-[var(--inaya-text-primary)] font-mono tabular-nums">${(it.quantity * it.unitPrice).toFixed(2)}</span>
            </div>
          ))}
        </div>
        {invoice.notes && <p className="text-[var(--inaya-text-muted)] text-xs italic border-t border-white/5 pt-3">{invoice.notes}</p>}

        {(INVOICE_ACTIONS[invoice.status] || []).length > 0 && (
          <div className="flex gap-2 border-t border-white/5 pt-3">
            {INVOICE_ACTIONS[invoice.status].map(([action, label]) =>
              DESTRUCTIVE_ACTIONS.has(action) ? (
                <ConfirmButton key={action} disabled={!!submitting} onConfirm={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-[var(--inaya-text-primary)] hover:bg-white/15 disabled:opacity-40">
                  {submitting === action ? "…" : label}
                </ConfirmButton>
              ) : (
                <button key={action} disabled={!!submitting} onClick={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-[var(--inaya-text-primary)] hover:bg-white/15 disabled:opacity-40">
                  {submitting === action ? "…" : label}
                </button>
              )
            )}
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}

        <DocumentAutomationPanel orgId={orgId} invoiceId={invoice.id} />

        {activity && activity.length > 0 && (
          <div className="space-y-1.5 border-t border-white/5 pt-3">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Activity</p>
            {activity.map((e) => (
              <div key={e.eventId} className="text-xs border-b border-white/5 pb-1.5 last:border-0">
                <span className="text-[var(--inaya-text-primary)]">{e.action.replace(/_/g, " ")}</span>
                <div className="text-[11px] font-mono text-[#8a96ab]">{e.actorEmail} · {new Date(e.timestamp).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ============================================================
// NATIVE DOCUMENT & INVOICE AUTOMATION ENGINE
//
// The invoice-side entry point into the full engine (Document Automation
// view): idempotent generation of an official, numbered, evidence-recorded,
// encrypted document. Approval, finalization, secure delivery, verification
// and the Document Passport live in the Document Automation view -- this
// panel shows where the invoice's documents stand and jumps there. It sits
// alongside the older "Generate PDF Invoice" print view, which is unchanged.
// ============================================================
const DOC_STATUS_STYLE = { GENERATED: "text-blue-300", PENDING_APPROVAL: "text-amber-300", APPROVED: "text-emerald-300", FINALIZED: "text-emerald-300", DELIVERED: "text-emerald-300", VIEWED: "text-emerald-300", PAID: "text-emerald-300", SUPERSEDED: "text-[var(--inaya-text-muted)]", VOID: "text-red-300", CANCELLED: "text-[var(--inaya-text-muted)]", EXPIRED: "text-amber-300", REJECTED: "text-red-300" };

function DocumentAutomationPanel({ orgId, invoiceId }) {
  const [documents, setDocuments] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [attemptKey, setAttemptKey] = useState(() => `fin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const load = useCallback(async () => {
    try {
      const result = await api(`/api/orgs/finance/invoices/${invoiceId}/generate-document?orgId=${orgId}`);
      setDocuments(result.documents);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, invoiceId]);

  useEffect(() => { load(); }, [load]);

  async function generate(forceNewVersion) {
    setGenerating(true);
    setError("");
    try {
      // The key is stable for one attempt, so a double click or a retry
      // after a dropped connection returns the same document, never two.
      await api(`/api/orgs/finance/invoices/${invoiceId}/generate-document`, { method: "POST", body: JSON.stringify({ orgId, idempotencyKey: attemptKey, forceNewVersion }) });
      setAttemptKey(`fin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  const latest = (documents || [])[0];

  return (
    <div className="space-y-2 border-t border-white/5 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Official Document</p>
        <button onClick={() => generate(!!latest)} disabled={generating} className="text-[11px] font-bold uppercase px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
          {generating ? "Generating…" : latest ? "New version" : "Generate official document"}
        </button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {documents && documents.length === 0 && <p className="text-[11px] text-[var(--inaya-text-muted)]">No official document yet. Generating creates a numbered, encrypted PDF with a full evidence trail; approval and sharing are handled in Document Automation.</p>}
      {(documents || []).map((d) => (
        <div key={d.id} className="text-xs flex items-center justify-between bg-black/25 rounded-lg p-2.5 border border-white/5">
          <span className="text-[var(--inaya-text-primary)] font-mono">{d.documentNumber} · v{d.documentVersion}</span>
          <span className={`text-[11px] font-semibold ${DOC_STATUS_STYLE[d.status] || ""}`}>{d.status.replace("_", " ").toLowerCase()}{d.pipelineState && d.pipelineState !== "COMPLETE" ? ` · ${d.pipelineState.replace("_", " ").toLowerCase()}` : ""}</span>
        </div>
      ))}
      {latest && <a href={`/business?view=documentAutomation&doc=${latest.id}`} className="inline-block text-[11px] font-bold uppercase text-[#00f2fe]">Open in Document Automation →</a>}
    </div>
  );
}

// ============================================================
// EXPENSES
// ============================================================
function ExpensesTab({ orgId, email, departments }) {
  const [expenses, setExpenses] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  useErpCreate("expenses", () => setShowCreate(true));
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setExpenses((await api(`/api/orgs/finance/expenses?orgId=${orgId}`)).expenses);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const filtered = (expenses || []).filter((e) => !search.trim() || e.vendor.toLowerCase().includes(search.trim().toLowerCase()) || e.category.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input aria-label="Search vendor or category" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search vendor or category…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New expense</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!expenses ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : expenses.length === 0 ? (
          <EmptyState compact icon="🧾" description="No expenses yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No expenses match "{search}".</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((e) => (
              <button key={e.id} onClick={() => setSelected(e)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{e.vendor}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{e.category}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">${e.amount.toFixed(2)}</span>
                  <StatusBadge status={e.status} />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateExpenseModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <ExpenseDetailModal orgId={orgId} expense={selected} onClose={() => setSelected(null)} onChanged={() => { load(); setSelected(null); }} />}
    </div>
  );
}

function CreateExpenseModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [vendor, setVendor] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !vendor.trim() || !category.trim() || !amount) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/finance/expenses", {
        method: "POST",
        body: JSON.stringify({ orgId, departmentId, vendor: vendor.trim(), category: category.trim(), amount: Number(amount), expenseDate: expenseDate || undefined, description: description.trim() || undefined }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New expense" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input aria-label="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} required placeholder="Vendor" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} required placeholder="Category" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Amount (USD)" value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0.01" step="0.01" required placeholder="Amount (USD)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} type="date" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <textarea aria-label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" rows={2} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !vendor.trim() || !category.trim() || !amount} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create expense"}</button>
      </form>
    </Modal>
  );
}

const EXPENSE_ACTIONS = {
  DRAFT: [["submit", "Submit for approval"]],
  PENDING_APPROVAL: [["approve", "Approve"], ["reject", "Reject"]],
};

function ExpenseDetailModal({ orgId, expense, onClose, onChanged }) {
  const [attachments, setAttachments] = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState(null);
  const [passkey, setPasskey] = useState("");
  const [uploading, setUploading] = useState(false);

  const loadAttachments = useCallback(async () => {
    try {
      setAttachments((await api(`/api/orgs/finance/expenses/${expense.id}/attachments?orgId=${orgId}`)).attachments);
    } catch {
      setAttachments([]);
    }
  }, [orgId, expense.id]);

  useEffect(() => { loadAttachments(); }, [loadAttachments]);

  async function handleAction(action) {
    setSubmitting(action);
    setError("");
    try {
      await api(`/api/orgs/finance/expenses/${expense.id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(null);
    }
  }

  async function handleUploadReceipt(e) {
    e.preventDefault();
    if (!file || !passkey) return;
    setUploading(true);
    setError("");
    try {
      const { fileHash, sizeBytes, cidAlpha, cidBeta } = await encryptAndShardFile(file, passkey);
      await api(`/api/orgs/finance/expenses/${expense.id}/attachments`, { method: "POST", body: JSON.stringify({ orgId, filename: file.name, fileHash, sizeBytes, cidAlpha, cidBeta }) });
      setFile(null);
      setPasskey("");
      await loadAttachments();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal title={expense.vendor} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <StatusBadge status={expense.status} />
          <span className="text-[var(--inaya-text-primary)] text-lg font-mono tabular-nums">${expense.amount.toFixed(2)}</span>
        </div>
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{expense.category} · {new Date(expense.expenseDate).toLocaleDateString()}</p>
        {expense.description && <p className="text-[var(--inaya-text-primary)] text-xs">{expense.description}</p>}

        {(EXPENSE_ACTIONS[expense.status] || []).length > 0 && (
          <div className="flex gap-2 border-t border-white/5 pt-3">
            {EXPENSE_ACTIONS[expense.status].map(([action, label]) =>
              DESTRUCTIVE_ACTIONS.has(action) ? (
                <ConfirmButton key={action} disabled={!!submitting} onConfirm={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-[var(--inaya-text-primary)] hover:bg-white/15 disabled:opacity-40">
                  {submitting === action ? "…" : label}
                </ConfirmButton>
              ) : (
                <button key={action} disabled={!!submitting} onClick={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-[var(--inaya-text-primary)] hover:bg-white/15 disabled:opacity-40">
                  {submitting === action ? "…" : label}
                </button>
              )
            )}
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}

        <div className="space-y-2 border-t border-white/5 pt-3">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Receipts</p>
          {attachments && attachments.length > 0 && (
            <div className="space-y-1">
              {attachments.map((a) => <p key={a.id} className="text-xs text-[var(--inaya-text-primary)] truncate">📎 {a.filename}</p>)}
            </div>
          )}
          <form onSubmit={handleUploadReceipt} className="space-y-1.5">
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="w-full text-[11px] text-slate-400 file:mr-2 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-[11px] file:font-bold file:bg-[#00f2fe]/10 file:text-[#00f2fe]" />
            <input aria-label="Encryption passkey" type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} placeholder="Encryption passkey" className="w-full bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
            <button disabled={uploading || !file || !passkey} className="w-full py-1.5 rounded-lg text-[11px] font-bold uppercase bg-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{uploading ? "Uploading…" : "Attach receipt"}</button>
          </form>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// PAYMENTS
// ============================================================
function PaymentsTab({ orgId, departments }) {
  const [payments, setPayments] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  useErpCreate("payments", () => setShowCreate(true));
  const [approving, setApproving] = useState(null);
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState("all"); // all | vendor | customer

  const load = useCallback(async () => {
    try {
      const [paymentsRes, suppliersRes, poRes, contactsRes, invoicesRes] = await Promise.all([
        api(`/api/orgs/finance/payments?orgId=${orgId}`),
        api(`/api/orgs/procurement/suppliers?orgId=${orgId}`),
        api(`/api/orgs/procurement/orders?orgId=${orgId}`),
        api(`/api/orgs/crm/contacts?orgId=${orgId}`),
        api(`/api/orgs/finance/invoices?orgId=${orgId}`),
      ]);
      setPayments(paymentsRes.payments);
      setSuppliers(suppliersRes.suppliers);
      setPurchaseOrders(poRes.orders);
      setContacts(contactsRes.contacts);
      setInvoices(invoicesRes.invoices);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleApprove(id) {
    setApproving(id);
    setError("");
    try {
      await api(`/api/orgs/finance/payments/${id}/approve`, { method: "POST", body: JSON.stringify({ orgId }) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setApproving(null);
    }
  }

  const supplierNameById = new Map(suppliers.map((s) => [s.id, s.name]));
  const poSupplierIdById = new Map(purchaseOrders.map((po) => [po.id, po.supplierId]));
  const contactNameById = new Map(contacts.map((c) => [c.id, c.name]));
  const invoiceContactIdById = new Map(invoices.map((i) => [i.id, i.contactId]));

  function vendorNameFor(p) {
    const supplierId = p.relatedPurchaseOrderId ? poSupplierIdById.get(p.relatedPurchaseOrderId) : null;
    return supplierId ? supplierNameById.get(supplierId) || "Unknown vendor" : "Unlinked";
  }
  function customerNameFor(p) {
    const contactId = p.relatedInvoiceId ? invoiceContactIdById.get(p.relatedInvoiceId) : null;
    return contactId ? contactNameById.get(contactId) || "Unknown customer" : "Unlinked";
  }

  const searched = (payments || []).filter((p) => !search.trim() || (p.method || "").toLowerCase().includes(search.trim().toLowerCase()));
  const filtered = groupBy === "vendor" ? searched.filter((p) => p.direction === "OUTGOING") : groupBy === "customer" ? searched.filter((p) => p.direction === "INCOMING") : searched;

  let groups = null;
  if (groupBy !== "all") {
    const nameFor = groupBy === "vendor" ? vendorNameFor : customerNameFor;
    const map = new Map();
    for (const p of filtered) {
      const key = nameFor(p);
      const g = map.get(key) || { name: key, total: 0, payments: [] };
      g.total += p.amount;
      g.payments.push(p);
      map.set(key, g);
    }
    groups = [...map.values()].sort((a, b) => b.total - a.total);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <input aria-label="Search method" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search method…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1">
          {[["all", "All"], ["vendor", "By Vendor"], ["customer", "By Customer"]].map(([value, label]) => (
            <button key={value} onClick={() => setGroupBy(value)} className={`px-3 py-1.5 text-xs font-bold rounded-lg ${groupBy === value ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
          ))}
        </div>
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ Record payment</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!payments ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : payments.length === 0 ? (
          <EmptyState compact icon="💳" description="No payments recorded yet." ctaLabel="Record one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No payments match these filters.</p>
        ) : groups ? (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[var(--inaya-text-primary)] text-sm font-bold">{g.name}</p>
                  <p className="text-[var(--inaya-text-muted)] text-xs font-mono tabular-nums">${g.total.toFixed(2)}</p>
                </div>
                <div className="space-y-1.5">
                  {g.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-2.5">
                      <span className={p.direction === "INCOMING" ? "text-emerald-400 text-xs" : "text-red-400 text-xs"}>{p.direction === "INCOMING" ? "+" : "−"}${p.amount.toFixed(2)}</span>
                      <span className="text-[var(--inaya-text-muted)] text-[11px] font-mono">{p.method || "—"} · {new Date(p.paymentDate).toLocaleDateString()}</span>
                      <StatusBadge status={p.status} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className={p.direction === "INCOMING" ? "text-emerald-400 text-sm" : "text-red-400 text-sm"}>{p.direction === "INCOMING" ? "+" : "−"}${p.amount.toFixed(2)}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{p.method || "—"} · {new Date(p.paymentDate).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={p.status} />
                  {p.status === "RECORDED" && (
                    <button onClick={() => handleApprove(p.id)} disabled={approving === p.id} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1.5 rounded-lg disabled:opacity-40">
                      {approving === p.id ? "…" : "Approve"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreatePaymentModal orgId={orgId} departments={departments} purchaseOrders={purchaseOrders} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreatePaymentModal({ orgId, departments, purchaseOrders, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [direction, setDirection] = useState("INCOMING");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [relatedPurchaseOrderId, setRelatedPurchaseOrderId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !amount) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/finance/payments", {
        method: "POST",
        body: JSON.stringify({
          orgId, departmentId, direction, amount: Number(amount), method: method.trim() || undefined, paymentDate: paymentDate || undefined,
          relatedPurchaseOrderId: direction === "OUTGOING" && relatedPurchaseOrderId ? relatedPurchaseOrderId : undefined,
        }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Record payment" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={direction} onChange={(e) => setDirection(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="INCOMING">Incoming</option>
          <option value="OUTGOING">Outgoing</option>
        </select>
        {direction === "OUTGOING" && (
          <select aria-label="Link to a purchase order (optional)" value={relatedPurchaseOrderId} onChange={(e) => setRelatedPurchaseOrderId(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="">Link to a purchase order (optional)…</option>
            {(purchaseOrders || []).map((po) => <option key={po.id} value={po.id}>{po.id.slice(-6)} · {po.items.length} item{po.items.length === 1 ? "" : "s"} · {po.currency}</option>)}
          </select>
        )}
        <input aria-label="Amount (USD)" value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0.01" step="0.01" required placeholder="Amount (USD)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Method (e.g. bank transfer)" value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Method (e.g. bank transfer)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} type="date" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !amount} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Recording…" : "Record payment"}</button>
      </form>
    </Modal>
  );
}

// ============================================================
// REPORTS
// ============================================================
const REPORT_TYPES = [["revenue", "Revenue (paid invoices)"], ["expenses", "Approved expenses"], ["outstanding", "Outstanding invoices"], ["paid-unpaid", "All invoices"]];

function ReportsTab({ orgId }) {
  const [type, setType] = useState("revenue");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/finance/reports?orgId=${orgId}&type=${type}&format=json`).then(setReport).catch((err) => setError(err.message));
  }, [orgId, type]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {REPORT_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <a
          href={`/api/orgs/finance/reports?orgId=${orgId}&type=${type}&format=csv`}
          download
          onClick={() => window.dispatchEvent(new CustomEvent("inaya:guided-report-downloaded"))}
          className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg"
        >↓ Download CSV</a>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!report ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : report.rows.length === 0 ? (
          <EmptyState compact icon="📊" description="No data for this report yet." />
        ) : (
          <div className="space-y-3">
            <p className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{report.count} record{report.count === 1 ? "" : "s"} · Total ${report.totalAmount.toFixed(2)}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-[var(--inaya-text-muted)] uppercase text-[10px]">{Object.keys(report.rows[0]).map((k) => <th key={k} className="text-left py-1.5 pr-4 font-bold">{k}</th>)}</tr></thead>
                <tbody>
                  {report.rows.map((row, i) => (
                    <tr key={i} className="border-t border-white/5">
                      {Object.values(row).map((v, j) => <td key={j} className="py-1.5 pr-4 text-[var(--inaya-text-primary)] font-mono">{String(v)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// LEDGER — double-entry general ledger (lib/ledger.js). Entries for
// invoices, expenses and payments post automatically; manual entries and
// reversals are for Finance Managers / owners / admins.
// ============================================================
const LEDGER_REPORTS = [["trial-balance", "Trial balance"], ["pnl", "Profit & loss"], ["balance-sheet", "Balance sheet"]];
const money = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inputCls = "bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]";

function LedgerTab({ orgId }) {
  const [view, setView] = useState("journal");
  const [accounts, setAccounts] = useState([]);
  const [entries, setEntries] = useState(null);
  const [sync, setSync] = useState(null);
  const [error, setError] = useState("");
  const [showEntry, setShowEntry] = useState(false);
  useErpCreate("ledger", () => setShowEntry(true));
  const [showAccount, setShowAccount] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, e] = await Promise.all([api(`/api/orgs/finance/ledger/accounts?orgId=${orgId}`), api(`/api/orgs/finance/ledger/entries?orgId=${orgId}`)]);
      setAccounts(a.accounts); setEntries(e.entries); setSync(e.sync); setError("");
    } catch (err) { setError(err.message); }
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  const names = Object.fromEntries(accounts.map((a) => [a.code, a.name]));
  const reverse = async (id) => {
    try { await api(`/api/orgs/finance/ledger/entries/${id}/reverse`, { method: "POST", body: JSON.stringify({ orgId }) }); load(); } catch (err) { setError(err.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex bg-black/30 border border-white/10 rounded-lg p-0.5">
          {[["journal", "Journal"], ["accounts", "Chart of accounts"], ["reports", "Statements"]].map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} className={`px-3 py-1.5 text-[11px] font-bold rounded-md ${view === k ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{l}</button>
          ))}
        </div>
        {view === "journal" && <button onClick={() => setShowEntry(true)} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ Manual entry</button>}
        {view === "accounts" && <button onClick={() => setShowAccount(true)} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ Account</button>}
      </div>
      <p className="text-[var(--inaya-text-muted)] text-[11px]">Sent and paid invoices, approved expenses and approved payments post automatically. Non-USD amounts use reference exchange rates, not live FX.</p>
      {sync?.errors?.length > 0 && <p className="text-amber-400 text-xs">{sync.errors.length} record{sync.errors.length === 1 ? "" : "s"} couldn&apos;t be posted: {sync.errors.map((e) => e.error || e).join("; ")}</p>}
      {error && <p className="text-red-400 text-xs">{error}</p>}

      {view === "journal" && (
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
          {!entries ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : entries.length === 0 ? (
            <EmptyState compact icon="📒" description="No journal entries yet. They appear once an invoice is sent or an expense is approved." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-[var(--inaya-text-muted)] uppercase text-[10px]"><th className="text-left py-1.5 pr-4">Date</th><th className="text-left pr-4">Memo</th><th className="text-left pr-4">Account</th><th className="text-right pr-4">Debit</th><th className="text-right pr-4">Credit</th><th /></tr></thead>
                <tbody>
                  {entries.map((e) => e.lines.map((l, i) => (
                    <tr key={`${e.id}-${i}`} className={i === 0 ? "border-t border-white/10" : ""}>
                      <td className="py-1 pr-4 font-mono text-[var(--inaya-text-muted)]">{i === 0 ? e.date : ""}</td>
                      <td className="pr-4 text-[var(--inaya-text-primary)]">{i === 0 ? <>{e.memo}{e.reversalOf && <span className="ml-1 text-amber-400">(reversal)</span>}{!e.source && !e.reversalOf && <span className="ml-1 text-[var(--inaya-text-muted)]">(manual)</span>}</> : ""}</td>
                      <td className="pr-4 text-[var(--inaya-text-primary)] font-mono">{l.accountCode} {names[l.accountCode] || ""}{l.originalCurrency && <span className="text-[var(--inaya-text-muted)]"> · {l.originalCurrency} {money(l.originalAmount)} @ {l.fxRate}</span>}</td>
                      <td className="pr-4 text-right font-mono tabular-nums">{l.debit ? money(l.debit) : ""}</td>
                      <td className="pr-4 text-right font-mono tabular-nums">{l.credit ? money(l.credit) : ""}</td>
                      <td className="text-right">{i === 0 && !e.reversalOf && !e.source && <ConfirmButton onConfirm={() => reverse(e.id)} confirmLabel="Post reversal?" className="text-[10px] font-bold uppercase text-amber-400">Reverse</ConfirmButton>}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {view === "accounts" && (
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-[var(--inaya-text-muted)] uppercase text-[10px]"><th className="text-left py-1.5 pr-4">Code</th><th className="text-left pr-4">Name</th><th className="text-left">Type</th></tr></thead>
            <tbody>{accounts.map((a) => <tr key={a.code} className="border-t border-white/5"><td className="py-1.5 pr-4 font-mono">{a.code}</td><td className="pr-4 text-[var(--inaya-text-primary)]">{a.name}</td><td className="text-[var(--inaya-text-muted)]">{a.type}</td></tr>)}</tbody>
          </table>
        </div>
      )}

      {view === "reports" && <LedgerStatements orgId={orgId} />}
      {showEntry && <ManualEntryModal orgId={orgId} accounts={accounts} onClose={() => setShowEntry(false)} onPosted={() => { setShowEntry(false); load(); }} />}
      {showAccount && <AccountModal orgId={orgId} onClose={() => setShowAccount(false)} onCreated={() => { setShowAccount(false); load(); }} />}
    </div>
  );
}

function LedgerStatements({ orgId }) {
  const [type, setType] = useState("trial-balance");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setReport(null);
    api(`/api/orgs/finance/ledger/reports?orgId=${orgId}&type=${type}`).then((r) => { setReport(r); setError(""); }).catch((err) => setError(err.message));
  }, [orgId, type]);

  const Rows = ({ title, rows, total }) => (
    <div className="space-y-1">
      <p className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{title}</p>
      {rows.map((r) => <div key={r.code || r.name} className="flex justify-between text-xs"><span className="text-[var(--inaya-text-primary)]">{r.code} {r.name}</span><span className="font-mono tabular-nums">{money(r.amount)}</span></div>)}
      {total !== undefined && <div className="flex justify-between text-xs font-bold border-t border-white/10 pt-1"><span>Total {title.toLowerCase()}</span><span className="font-mono tabular-nums">{money(total)}</span></div>}
    </div>
  );
  const sum = (list) => list.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>{LEDGER_REPORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <a href={`/api/orgs/finance/ledger/reports?orgId=${orgId}&type=${type}&format=csv`} download className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">↓ Download CSV</a>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-4">
        {!report ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : type === "trial-balance" ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-[var(--inaya-text-muted)] uppercase text-[10px]"><th className="text-left py-1.5 pr-4">Account</th><th className="text-right pr-4">Debit</th><th className="text-right">Credit</th></tr></thead>
              <tbody>
                {report.rows.map((r) => <tr key={r.code} className="border-t border-white/5"><td className="py-1 pr-4">{r.code} {r.name}</td><td className="pr-4 text-right font-mono tabular-nums">{r.debit ? money(r.debit) : ""}</td><td className="text-right font-mono tabular-nums">{r.credit ? money(r.credit) : ""}</td></tr>)}
                <tr className="border-t border-white/20 font-bold"><td className="py-1 pr-4">Total {report.balanced ? "✓ balanced" : "⚠ out of balance"}</td><td className="pr-4 text-right font-mono tabular-nums">{money(report.totalDebit)}</td><td className="text-right font-mono tabular-nums">{money(report.totalCredit)}</td></tr>
              </tbody>
            </table>
          </div>
        ) : type === "pnl" ? (
          <>
            <Rows title="Revenue" rows={report.revenue} total={report.totalRevenue} />
            <Rows title="Expenses" rows={report.expenses} total={report.totalExpenses} />
            <div className="flex justify-between text-sm font-bold"><span>Net income</span><span className={`font-mono tabular-nums ${report.netIncome < 0 ? "text-red-400" : "text-emerald-400"}`}>{money(report.netIncome)}</span></div>
          </>
        ) : (
          <>
            <Rows title="Assets" rows={report.assets} total={report.totalAssets} />
            <Rows title="Liabilities" rows={report.liabilities} total={sum(report.liabilities)} />
            <Rows title="Equity" rows={[...report.equity, { code: "", name: "Retained earnings", amount: report.retainedEarnings }]} />
            <div className="flex justify-between text-sm font-bold"><span>Liabilities + equity {report.balanced ? "✓" : "⚠"}</span><span className="font-mono tabular-nums">{money(report.totalLiabilitiesAndEquity)}</span></div>
          </>
        )}
      </div>
    </div>
  );
}

function ManualEntryModal({ orgId, accounts, onClose, onPosted }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState([{ accountCode: "", debit: "", credit: "" }, { accountCode: "", debit: "", credit: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const cents = (v) => Math.round((Number(v) || 0) * 100);
  const dr = lines.reduce((s, l) => s + cents(l.debit), 0);
  const cr = lines.reduce((s, l) => s + cents(l.credit), 0);
  const balanced = dr > 0 && dr === cr;
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    setSubmitting(true); setError("");
    try {
      await api("/api/orgs/finance/ledger/entries", { method: "POST", body: JSON.stringify({ orgId, date, memo, lines: lines.filter((l) => l.accountCode).map((l) => ({ accountCode: l.accountCode, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })) }) });
      onPosted();
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  };

  return (
    <Modal title="Manual journal entry" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex gap-2"><input id="ledger-entry-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /><input aria-label="Memo" id="ledger-entry-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Memo" className={`${inputCls} flex-1`} /></div>
        {lines.map((l, i) => (
          <div key={i} className="flex gap-2">
            <select aria-label="Account" id={`ledger-line-${i}-account`} value={l.accountCode} onChange={(e) => setLine(i, { accountCode: e.target.value })} className={`${inputCls} flex-1 min-w-0`}>
              <option value="">Account…</option>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
            <input aria-label="Debit" id={`ledger-line-${i}-debit`} inputMode="decimal" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: "" })} placeholder="Debit" className={`${inputCls} w-24`} />
            <input aria-label="Credit" id={`ledger-line-${i}-credit`} inputMode="decimal" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: "" })} placeholder="Credit" className={`${inputCls} w-24`} />
          </div>
        ))}
        <button onClick={() => setLines((ls) => [...ls, { accountCode: "", debit: "", credit: "" }])} className="text-[11px] font-bold text-[#00f2fe]">+ Line</button>
        <p className={`text-xs font-mono ${balanced ? "text-emerald-400" : "text-amber-400"}`}>Debits {money(dr / 100)} · Credits {money(cr / 100)} {balanced ? "· balanced" : "· must balance"}</p>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={!balanced || submitting} onClick={submit} className="w-full text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">{submitting ? "Posting…" : "Post entry"}</button>
      </div>
    </Modal>
  );
}

function AccountModal({ orgId, onClose, onCreated }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("EXPENSE");
  const [error, setError] = useState("");
  const submit = async () => {
    try { await api("/api/orgs/finance/ledger/accounts", { method: "POST", body: JSON.stringify({ orgId, code, name, type }) }); onCreated(); } catch (err) { setError(err.message); }
  };
  return (
    <Modal title="New account" onClose={onClose}>
      <div className="space-y-3">
        <input aria-label="Code (3–6 digits)" id="ledger-account-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code (3–6 digits)" className={`${inputCls} w-full`} />
        <input aria-label="Name" id="ledger-account-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={`${inputCls} w-full`} />
        <select id="ledger-account-type" value={type} onChange={(e) => setType(e.target.value)} className={`${inputCls} w-full`}>{["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"].map((t) => <option key={t}>{t}</option>)}</select>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button onClick={submit} className="w-full text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">Add account</button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full ${wide ? "max-w-lg" : "max-w-md"} max-h-[85vh] overflow-y-auto`}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
