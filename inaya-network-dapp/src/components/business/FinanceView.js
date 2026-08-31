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
import ConfirmButton from "./ConfirmButton";

const DESTRUCTIVE_ACTIONS = new Set(["cancel", "reject"]);

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_COLORS = {
  DRAFT: "bg-white/10 text-slate-300 border-white/15",
  SENT: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  PAID: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  OVERDUE: "bg-red-400/10 text-red-400 border-red-400/30",
  CANCELLED: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  PENDING_APPROVAL: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  APPROVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  RECORDED: "bg-white/10 text-slate-300 border-white/15",
};

function StatusBadge({ status }) {
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_COLORS[status] || "bg-white/10 text-slate-300 border-white/15"}`}>{status?.replace(/_/g, " ")}</span>;
}

export default function FinanceView({ orgId, email }) {
  const [tab, setTab] = useState("invoices");
  const [departments, setDepartments] = useState([]);
  const [departmentsError, setDepartmentsError] = useState("");

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => { setDepartments(d.departments); setDepartmentsError(""); }).catch((err) => setDepartmentsError(`Couldn't load departments: ${err.message}`));
  }, [orgId]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
          {[["invoices", "Invoices"], ["expenses", "Expenses"], ["payments", "Payments"], ["reports", "Reports"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
          ))}
        </div>
        <span className="text-[10px] font-bold uppercase px-2.5 py-1 rounded-full border bg-amber-400/10 text-amber-400 border-amber-400/30">Testnet / Beta</span>
      </div>
      {departmentsError && <p className="text-red-400 text-xs">{departmentsError}</p>}
      {tab === "invoices" && <InvoicesTab orgId={orgId} email={email} departments={departments} />}
      {tab === "expenses" && <ExpensesTab orgId={orgId} email={email} departments={departments} />}
      {tab === "payments" && <PaymentsTab orgId={orgId} departments={departments} />}
      {tab === "reports" && <ReportsTab orgId={orgId} />}
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
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search invoice #…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
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
                  <span className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">${inv.total.toFixed(2)}</span>
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
  const [lineItems, setLineItems] = useState([{ description: "", quantity: "1", unitPrice: "" }]);
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
          orgId, departmentId, contactId, dueDate, notes: notes.trim() || undefined,
          lineItems: lineItems.map((it) => ({ description: it.description.trim(), quantity: Number(it.quantity), unitPrice: Number(it.unitPrice) })),
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
        <select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setContactId(""); }} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={contactId} onChange={(e) => setContactId(e.target.value)} required disabled={!departmentId} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
          <option value="">Customer…</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input value={dueDate} onChange={(e) => setDueDate(e.target.value)} type="date" required className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />

        <div className="space-y-2 border-t border-white/5 pt-3">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Line items</p>
          {lineItems.map((item, i) => (
            <div key={i} className="grid grid-cols-[1fr_60px_80px_24px] gap-1.5">
              <input value={item.description} onChange={(e) => updateItem(i, "description", e.target.value)} placeholder="Description" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <input value={item.quantity} onChange={(e) => updateItem(i, "quantity", e.target.value)} type="number" min="0.01" step="0.01" placeholder="Qty" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <input value={item.unitPrice} onChange={(e) => updateItem(i, "unitPrice", e.target.value)} type="number" min="0" step="0.01" placeholder="Price" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <button type="button" onClick={() => removeItem(i)} disabled={lineItems.length === 1} className="text-[var(--inaya-text-muted)] hover:text-red-400 disabled:opacity-30 text-lg leading-none">×</button>
            </div>
          ))}
          <button type="button" onClick={addItem} className="text-[11px] font-bold uppercase text-[#00f2fe]">+ Add line</button>
          <p className="text-right text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">Total: ${total.toFixed(2)}</p>
        </div>

        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" rows={2} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
          <span className="text-[var(--inaya-text-primary)] text-lg font-mono tabular-nums">${invoice.total.toFixed(2)}</span>
        </div>
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">Issued {new Date(invoice.issueDate).toLocaleDateString()} · Due {new Date(invoice.dueDate).toLocaleDateString()}</p>

        <div className="space-y-1 border-t border-white/5 pt-3">
          {invoice.lineItems.map((it, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-slate-300">{it.description} × {it.quantity}</span>
              <span className="text-[var(--inaya-text-primary)] font-mono tabular-nums">${(it.quantity * it.unitPrice).toFixed(2)}</span>
            </div>
          ))}
        </div>
        {invoice.notes && <p className="text-[var(--inaya-text-muted)] text-xs italic border-t border-white/5 pt-3">{invoice.notes}</p>}

        {(INVOICE_ACTIONS[invoice.status] || []).length > 0 && (
          <div className="flex gap-2 border-t border-white/5 pt-3">
            {INVOICE_ACTIONS[invoice.status].map(([action, label]) =>
              DESTRUCTIVE_ACTIONS.has(action) ? (
                <ConfirmButton key={action} disabled={!!submitting} onConfirm={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-slate-200 hover:bg-white/15 disabled:opacity-40">
                  {submitting === action ? "…" : label}
                </ConfirmButton>
              ) : (
                <button key={action} disabled={!!submitting} onClick={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-slate-200 hover:bg-white/15 disabled:opacity-40">
                  {submitting === action ? "…" : label}
                </button>
              )
            )}
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}

        {activity && activity.length > 0 && (
          <div className="space-y-1.5 border-t border-white/5 pt-3">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Activity</p>
            {activity.map((e) => (
              <div key={e.eventId} className="text-xs border-b border-white/5 pb-1.5 last:border-0">
                <span className="text-slate-300">{e.action.replace(/_/g, " ")}</span>
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
// EXPENSES
// ============================================================
function ExpensesTab({ orgId, email, departments }) {
  const [expenses, setExpenses] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
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
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search vendor or category…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
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
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input value={vendor} onChange={(e) => setVendor(e.target.value)} required placeholder="Vendor" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={category} onChange={(e) => setCategory(e.target.value)} required placeholder="Category" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0.01" step="0.01" required placeholder="Amount (USD)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} type="date" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" rows={2} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
        {expense.description && <p className="text-slate-300 text-xs">{expense.description}</p>}

        {(EXPENSE_ACTIONS[expense.status] || []).length > 0 && (
          <div className="flex gap-2 border-t border-white/5 pt-3">
            {EXPENSE_ACTIONS[expense.status].map(([action, label]) =>
              DESTRUCTIVE_ACTIONS.has(action) ? (
                <ConfirmButton key={action} disabled={!!submitting} onConfirm={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-slate-200 hover:bg-white/15 disabled:opacity-40">
                  {submitting === action ? "…" : label}
                </ConfirmButton>
              ) : (
                <button key={action} disabled={!!submitting} onClick={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-slate-200 hover:bg-white/15 disabled:opacity-40">
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
              {attachments.map((a) => <p key={a.id} className="text-xs text-slate-300 truncate">📎 {a.filename}</p>)}
            </div>
          )}
          <form onSubmit={handleUploadReceipt} className="space-y-1.5">
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="w-full text-[11px] text-slate-400 file:mr-2 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-[11px] file:font-bold file:bg-[#00f2fe]/10 file:text-[#00f2fe]" />
            <input type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} placeholder="Encryption passkey" className="w-full bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
            <button disabled={uploading || !file || !passkey} className="w-full py-1.5 rounded-lg text-[11px] font-bold uppercase bg-white/10 text-slate-200 disabled:opacity-40">{uploading ? "Uploading…" : "Attach receipt"}</button>
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
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [approving, setApproving] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setPayments((await api(`/api/orgs/finance/payments?orgId=${orgId}`)).payments);
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

  const filtered = (payments || []).filter((p) => !search.trim() || (p.method || "").toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search method…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ Record payment</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!payments ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : payments.length === 0 ? (
          <EmptyState compact icon="💳" description="No payments recorded yet." ctaLabel="Record one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No payments match "{search}".</p>
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
      {showCreate && <CreatePaymentModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreatePaymentModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [direction, setDirection] = useState("INCOMING");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
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
        body: JSON.stringify({ orgId, departmentId, direction, amount: Number(amount), method: method.trim() || undefined, paymentDate: paymentDate || undefined }),
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
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={direction} onChange={(e) => setDirection(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="INCOMING">Incoming</option>
          <option value="OUTGOING">Outgoing</option>
        </select>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0.01" step="0.01" required placeholder="Amount (USD)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Method (e.g. bank transfer)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
        <a href={`/api/orgs/finance/reports?orgId=${orgId}&type=${type}&format=csv`} download className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">↓ Download CSV</a>
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
                      {Object.values(row).map((v, j) => <td key={j} className="py-1.5 pr-4 text-slate-300 font-mono">{String(v)}</td>)}
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
