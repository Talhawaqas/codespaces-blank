"use client";

// src/components/business/CRMView.js
//
// CRM tab of the Business Workspace (Phase 2) — Contacts (unified Lead/
// Customer records) and Deals (sales pipeline), backed by
// /api/orgs/crm/*. Same self-contained-view pattern TasksView.js
// established: its own `api()` helper, its own Modal, no dependency on
// business/page.js internals beyond the {orgId, canManage, email} props.
//
// A deal optionally links to an existing project (completing Customer ->
// Deal -> Project -> Task -> Document per the SOW) — the create-deal
// modal's project picker reuses the same department -> project drill-down
// idiom TasksView's create-task modal uses.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import ConfirmButton from "./ConfirmButton";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STAGE_LABELS = { NEW: "New", QUALIFIED: "Qualified", PROPOSAL: "Proposal", NEGOTIATION: "Negotiation", WON: "Won", LOST: "Lost" };
const STAGE_ORDER = ["NEW", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];
const STAGE_STYLES = {
  NEW: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  QUALIFIED: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  PROPOSAL: "bg-violet-400/10 text-violet-300 border-violet-400/30",
  NEGOTIATION: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  WON: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  LOST: "bg-red-400/10 text-red-400 border-red-400/30",
};
const ACTIONS_BY_STAGE = {
  NEW: [["advance", "Advance"], ["win", "Mark won"], ["lose", "Mark lost"]],
  QUALIFIED: [["advance", "Advance"], ["regress", "Back"], ["win", "Mark won"], ["lose", "Mark lost"]],
  PROPOSAL: [["advance", "Advance"], ["regress", "Back"], ["win", "Mark won"], ["lose", "Mark lost"]],
  NEGOTIATION: [["regress", "Back"], ["win", "Mark won"], ["lose", "Mark lost"]],
  WON: [["reopen", "Reopen"]],
  LOST: [["reopen", "Reopen"]],
};

function formatMoney(v) {
  if (v === null || v === undefined) return null;
  return `$${v.toLocaleString()}`;
}

export default function CRMView({ orgId, canManage, email }) {
  const [tab, setTab] = useState("contacts"); // 'contacts' | 'deals'
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState("");
  // Set by DealsTab's "View contact" link — ContactsTab auto-opens this
  // contact on mount, then the caller clears it, completing the SOW's
  // documented Customer -> Deal cross-navigation without a full router.
  const [focusContactId, setFocusContactId] = useState(null);

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => setDepartments(d.departments)).catch((err) => setError(err.message));
  }, [orgId]);

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
        <button onClick={() => setTab("contacts")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "contacts" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Contacts</button>
        <button onClick={() => setTab("deals")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "deals" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Deals</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {tab === "contacts" ? (
        <ContactsTab orgId={orgId} departments={departments} focusContactId={focusContactId} onFocusHandled={() => setFocusContactId(null)} />
      ) : (
        <DealsTab orgId={orgId} departments={departments} email={email} onViewContact={(id) => { setFocusContactId(id); setTab("contacts"); }} />
      )}
    </div>
  );
}

// ============================================================
// CONTACTS
// ============================================================
function ContactsTab({ orgId, departments, focusContactId, onFocusHandled }) {
  const [contacts, setContacts] = useState(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ orgId });
      if (typeFilter) params.set("type", typeFilter);
      if (search) params.set("search", search);
      const data = await api(`/api/orgs/crm/contacts?${params.toString()}`);
      setContacts(data.contacts);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, typeFilter, search]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!focusContactId || !contacts) return;
    const match = contacts.find((c) => c.id === focusContactId);
    if (match) setSelected(match);
    onFocusHandled();
  }, [focusContactId, contacts, onFocusHandled]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, company, email…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">All types</option>
          <option value="LEAD">Leads</option>
          <option value="CUSTOMER">Customers</option>
        </select>
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New contact</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!contacts ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : contacts.length === 0 ? (
          <EmptyState compact icon="🧑‍💼" description="No contacts match these filters." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {contacts.map((c) => (
              <button key={c.id} onClick={() => setSelected(c)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{c.name}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">{c.company || "—"}{c.email ? ` · ${c.email}` : ""}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${c.type === "CUSTOMER" ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "bg-amber-400/10 text-amber-400 border-amber-400/30"}`}>{c.type}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {showCreate && <CreateContactModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <ContactDetailModal orgId={orgId} contact={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function CreateContactModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [type, setType] = useState("LEAD");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/crm/contacts", { method: "POST", body: JSON.stringify({ orgId, departmentId, type, name: name.trim(), company: companyName.trim() || undefined, email: contactEmail.trim() || undefined, phone: phone.trim() || undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New contact" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="LEAD">Lead</option>
          <option value="CUSTOMER">Customer</option>
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Company (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} type="email" placeholder="Email (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !name.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create contact"}</button>
      </form>
    </Modal>
  );
}

function ContactDetailModal({ orgId, contact, onClose, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function toggleType() {
    setSaving(true);
    setError("");
    try {
      await api(`/api/orgs/crm/contacts/${contact.id}`, { method: "PATCH", body: JSON.stringify({ orgId, type: contact.type === "LEAD" ? "CUSTOMER" : "LEAD" }) });
      onChanged();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={contact.name} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{contact.company || "No company"}{contact.email ? ` · ${contact.email}` : ""}{contact.phone ? ` · ${contact.phone}` : ""}</p>
        <span className={`inline-block text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${contact.type === "CUSTOMER" ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "bg-amber-400/10 text-amber-400 border-amber-400/30"}`}>{contact.type}</span>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button onClick={toggleType} disabled={saving} className="text-[11px] font-bold uppercase px-3 py-2 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
          {saving ? "…" : contact.type === "LEAD" ? "Convert to Customer" : "Revert to Lead"}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// DEALS
// ============================================================
function DealsTab({ orgId, departments, email, onViewContact }) {
  const [deals, setDeals] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/crm/deals?orgId=${orgId}`);
      setDeals(data.deals);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const filteredDeals = (deals || []).filter((d) => !search.trim() || d.title.toLowerCase().includes(search.trim().toLowerCase()) || (d.contactName || "").toLowerCase().includes(search.trim().toLowerCase()));
  const byStage = {};
  for (const s of STAGE_ORDER) byStage[s] = filteredDeals.filter((d) => d.status === s);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search deal title or contact…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-64" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New deal</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {!deals ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : deals.length === 0 ? (
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
          <EmptyState compact icon="💼" description="No deals yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        </div>
      ) : filteredDeals.length === 0 ? (
        <p className="text-[var(--inaya-text-muted)] text-xs">No deals match "{search}".</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {STAGE_ORDER.map((stage) => (
            <div key={stage} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-3">
              <h4 className={`text-[11px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border inline-block mb-2 ${STAGE_STYLES[stage]}`}>{STAGE_LABELS[stage]} ({byStage[stage].length})</h4>
              <div className="space-y-1.5">
                {byStage[stage].map((d) => (
                  <div key={d.id} className="bg-black/20 border border-white/5 rounded-lg p-2">
                    <button onClick={() => setSelectedId(d.id)} className="w-full text-left">
                      <p className="text-[var(--inaya-text-primary)] text-xs truncate">{d.title}</p>
                      {formatMoney(d.value) && <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono truncate">{formatMoney(d.value)}</p>}
                    </button>
                    {d.contactName && (
                      <button onClick={() => onViewContact(d.contactId)} className="text-[#00f2fe] text-[11px] font-mono truncate hover:underline">
                        {d.contactName}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && <CreateDealModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selectedId && <DealDetailModal orgId={orgId} dealId={selectedId} email={email} onClose={() => setSelectedId(null)} onChanged={load} />}
    </div>
  );
}

function CreateDealModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [contacts, setContacts] = useState([]);
  const [contactId, setContactId] = useState("");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!departmentId) { setContacts([]); setContactId(""); return; }
    api(`/api/orgs/crm/contacts?orgId=${orgId}&departmentId=${departmentId}`).then((d) => { setContacts(d.contacts); setError(""); }).catch((err) => { setContacts([]); setError(`Couldn't load contacts: ${err.message}`); });
    setContactId("");
  }, [orgId, departmentId]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !contactId || !title.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/crm/deals", { method: "POST", body: JSON.stringify({ orgId, departmentId, contactId, title: title.trim(), value: value ? Number(value) : undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New deal" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={contactId} onChange={(e) => setContactId(e.target.value)} required disabled={!departmentId} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
          <option value="">Contact…</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Deal title" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={value} onChange={(e) => setValue(e.target.value)} type="number" min="0" placeholder="Value in USD (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !contactId || !title.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create deal"}</button>
      </form>
    </Modal>
  );
}

function DealDetailModal({ orgId, dealId, onClose, onChanged }) {
  const [deal, setDeal] = useState(null);
  const [acting, setActing] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/crm/deals/${dealId}?orgId=${orgId}`);
      setDeal(data);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, dealId]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(action) {
    setActing(action);
    setError("");
    try {
      await api(`/api/orgs/crm/deals/${dealId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  if (!deal) {
    return <Modal title="Deal" onClose={onClose}>{error ? <p className="text-red-400 text-xs">{error}</p> : <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>}</Modal>;
  }

  return (
    <Modal title={deal.title} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${STAGE_STYLES[deal.status]}`}>{STAGE_LABELS[deal.status]}</span>
          {formatMoney(deal.value) && <span className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{formatMoney(deal.value)}</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(ACTIONS_BY_STAGE[deal.status] || []).map(([action, label]) =>
            action === "lose" ? (
              <ConfirmButton key={action} onConfirm={() => handleAction(action)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
                {acting === action ? "…" : label}
              </ConfirmButton>
            ) : (
              <button key={action} onClick={() => handleAction(action)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
                {acting === action ? "…" : label}
              </button>
            )
          )}
        </div>
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
