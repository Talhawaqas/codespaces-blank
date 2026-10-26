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
import Modal from "./ui/Modal";
import StatusBadge from "./ui/StatusBadge";
import FormField from "./ui/FormField";
import RecordRow, { RecordList, RecordRows } from "./ui/RecordRow";
import RecordSharingPanel from "./RecordSharingPanel";
import { useErpSection, useErpTabsHidden, useErpCreate } from "./erp/ErpNavContext";
import SalesOrdersTab from "./SalesOrdersTab";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// STAGE_STYLES/STAGE_LABELS removed -- StatusBadge's shared STATUS_TONE
// map (src/components/business/ui/StatusBadge.js) already covers every
// one of these stage names with the exact same tones, and CSS uppercases
// the text regardless of the source string's casing.
const STAGE_ORDER = ["NEW", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];
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
  const [tab, setTab] = useErpSection("contacts", ["contacts", "deals", "orders"]);
  const tabsHidden = useErpTabsHidden();
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState("");
  // Set by DealsTab's "View contact" link — ContactsTab auto-opens this
  // contact on mount, then the caller clears it, completing the SOW's
  // documented Customer -> Deal cross-navigation without a full router.
  const [focusContactId, setFocusContactId] = useState(null);
  // "New sales order" from the ERP task panel opens the Orders tab's form.
  const [newOrderSignal, setNewOrderSignal] = useState(0);
  useErpCreate("orders", () => { setTab("orders"); setNewOrderSignal((n) => n + 1); });

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => setDepartments(d.departments)).catch((err) => setError(err.message));
  }, [orgId]);

  return (
    <div className="space-y-5">
      {!tabsHidden && (
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
          <button data-guide-id="crm-tab-contacts" onClick={() => setTab("contacts")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "contacts" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Contacts</button>
          <button data-guide-id="crm-tab-deals" onClick={() => setTab("deals")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "deals" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Deals</button>
          <button onClick={() => setTab("orders")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "orders" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Orders</button>
        </div>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {tab === "orders" ? (
        <SalesOrdersTab orgId={orgId} departments={departments} openCreateSignal={newOrderSignal} />
      ) : tab === "contacts" ? (
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
  useErpCreate("contacts", () => setShowCreate(true));
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
      <RecordList>
        {!contacts ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : contacts.length === 0 ? (
          <EmptyState compact icon="🧑‍💼" description="No contacts match these filters." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <RecordRows>
            {contacts.map((c) => (
              <RecordRow
                key={c.id}
                onClick={() => setSelected(c)}
                left={
                  <>
                    <span className="text-[var(--inaya-text-primary)] text-sm">{c.name}</span>
                    <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">{c.company || "—"}{c.email ? ` · ${c.email}` : ""}</p>
                  </>
                }
                right={<StatusBadge status={c.type} tone={c.type === "CUSTOMER" ? "success" : "warning"} />}
              />
            ))}
          </RecordRows>
        )}
      </RecordList>

      {showCreate && <CreateContactModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <ContactDetailModal orgId={orgId} contact={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

// Document Automation SOW section 7: billing/shipping addresses, tax id and
// payment terms so invoices, quotations and statements print complete customer
// details. All optional; an existing contact is unchanged.
const ADDRESS_FIELDS = [["line1", "Address line 1"], ["line2", "Address line 2"], ["city", "City"], ["region", "State / region"], ["postalCode", "Postal code"], ["country", "Country"]];
const inputCls = "w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]";

function AddressFields({ label, value, onChange }) {
  return (
    <fieldset className="space-y-1.5 border-t border-white/5 pt-2">
      <legend className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">{label}</legend>
      <div className="grid grid-cols-2 gap-1.5">
        {ADDRESS_FIELDS.map(([k, ph]) => (
          <input key={k} aria-label={`${label} ${ph}`} placeholder={ph} value={value[k] || ""} onChange={(e) => onChange({ ...value, [k]: e.target.value })} className={inputCls} />
        ))}
      </div>
    </fieldset>
  );
}

function cleanAddress(a) {
  const out = Object.fromEntries(Object.entries(a || {}).filter(([, v]) => String(v || "").trim()).map(([k, v]) => [k, String(v).trim()]));
  return Object.keys(out).length ? out : null;
}

function CreateContactModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [type, setType] = useState("LEAD");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [taxId, setTaxId] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [billing, setBilling] = useState({});
  const [shipping, setShipping] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/crm/contacts", { method: "POST", body: JSON.stringify({ orgId, departmentId, type, name: name.trim(), company: companyName.trim() || undefined, email: contactEmail.trim() || undefined, phone: phone.trim() || undefined, taxId: taxId.trim() || undefined, paymentTerms: paymentTerms.trim() || undefined, billingAddress: cleanAddress(billing) || undefined, shippingAddress: cleanAddress(shipping) || undefined }) });
      window.dispatchEvent(new CustomEvent("inaya:guided-contact-created"));
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
        <FormField label="Department" htmlFor="contact-dept" required>
          <select id="contact-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="">Department…</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </FormField>
        <FormField label="Type" htmlFor="contact-type">
          <select id="contact-type" value={type} onChange={(e) => setType(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="LEAD">Lead</option>
            <option value="CUSTOMER">Customer</option>
          </select>
        </FormField>
        <FormField label="Name" htmlFor="contact-name" required>
          <input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Full name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        </FormField>
        <FormField label="Company" htmlFor="contact-company">
          <input id="contact-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Optional" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        </FormField>
        <FormField label="Email" htmlFor="contact-email">
          <input id="contact-email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} type="email" placeholder="Optional" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        </FormField>
        <FormField label="Phone" htmlFor="contact-phone">
          <input id="contact-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        </FormField>
        <div className="grid grid-cols-2 gap-1.5 border-t border-white/5 pt-2">
          <input aria-label="Tax ID" placeholder="Tax ID / VAT (optional)" value={taxId} onChange={(e) => setTaxId(e.target.value)} className={inputCls} />
          <input aria-label="Payment terms" placeholder="Payment terms, e.g. Net 30" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} className={inputCls} />
        </div>
        <AddressFields label="Billing address" value={billing} onChange={setBilling} />
        <AddressFields label="Shipping address" value={shipping} onChange={setShipping} />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !name.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create contact"}</button>
      </form>
    </Modal>
  );
}

function ContactDetailModal({ orgId, contact, onClose, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [taxId, setTaxId] = useState(contact.taxId || "");
  const [paymentTerms, setPaymentTerms] = useState(contact.paymentTerms || "");
  const [billing, setBilling] = useState(contact.billingAddress || {});
  const [shipping, setShipping] = useState(contact.shippingAddress || {});

  async function saveBilling() {
    setSaving(true);
    setError("");
    try {
      await api(`/api/orgs/crm/contacts/${contact.id}`, { method: "PATCH", body: JSON.stringify({ orgId, taxId: taxId.trim() || null, paymentTerms: paymentTerms.trim() || null, billingAddress: cleanAddress(billing), shippingAddress: cleanAddress(shipping) }) });
      onChanged();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

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
        <StatusBadge status={contact.type} tone={contact.type === "CUSTOMER" ? "success" : "warning"} />
        {!editing && (
          <div className="space-y-1 text-[12px] font-mono text-[var(--inaya-text-muted)]">
            <p>Tax ID: {contact.taxId || "—"} · Payment terms: {contact.paymentTerms || "—"}</p>
            <p>Billing: {contact.billingAddress ? Object.values(contact.billingAddress).join(", ") : "—"}</p>
            <p>Shipping: {contact.shippingAddress ? Object.values(contact.shippingAddress).join(", ") : "—"}</p>
            <button onClick={() => setEditing(true)} className="text-[11px] font-bold uppercase text-[#00f2fe]">Edit billing details</button>
          </div>
        )}
        {editing && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-1.5">
              <input aria-label="Tax ID" placeholder="Tax ID / VAT" value={taxId} onChange={(e) => setTaxId(e.target.value)} className={inputCls} />
              <input aria-label="Payment terms" placeholder="Payment terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} className={inputCls} />
            </div>
            <AddressFields label="Billing address" value={billing} onChange={setBilling} />
            <AddressFields label="Shipping address" value={shipping} onChange={setShipping} />
            <button onClick={saveBilling} disabled={saving} className="text-[11px] font-bold uppercase px-3 py-2 rounded-md bg-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{saving ? "…" : "Save billing details"}</button>
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button onClick={toggleType} disabled={saving} className="text-[11px] font-bold uppercase px-3 py-2 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
          {saving ? "…" : contact.type === "LEAD" ? "Convert to Customer" : "Revert to Lead"}
        </button>
        <ContactActivityPanel orgId={orgId} contact={contact} />
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
  useErpCreate("deals", () => setShowCreate(true));
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
              <div className="mb-2 flex items-center gap-1.5">
                <StatusBadge status={stage} />
                <span className="text-[11px] text-[var(--inaya-text-muted)] font-mono">({byStage[stage].length})</span>
              </div>
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
      window.dispatchEvent(new CustomEvent("inaya:guided-deal-created"));
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
        <FormField label="Department" htmlFor="deal-dept" required>
          <select id="deal-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="">Department…</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </FormField>
        <FormField label="Contact" htmlFor="deal-contact" required>
          <select id="deal-contact" value={contactId} onChange={(e) => setContactId(e.target.value)} required disabled={!departmentId} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
            <option value="">Contact…</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FormField>
        <FormField label="Deal title" htmlFor="deal-title" required>
          <input id="deal-title" value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Q3 renewal" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        </FormField>
        <FormField label="Value (USD)" htmlFor="deal-value" hint="Optional">
          <input id="deal-value" value={value} onChange={(e) => setValue(e.target.value)} type="number" min="0" placeholder="0" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        </FormField>
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
          <StatusBadge status={deal.status} />
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
        <RecordSharingPanel orgId={orgId} basePath={`/api/orgs/crm/deals/${dealId}`} idPrefix="deal-share" />
      </div>
    </Modal>
  );
}

// ============================================================
// CONTACT ACTIVITY — explainable lead score, timeline, log a note or call,
// email from CRM (outbound only) and calendar invites (lib/crm-activity.js).
// ============================================================
const BAND_TONE = { HOT: "text-red-400 border-red-400/40 bg-red-400/10", WARM: "text-amber-400 border-amber-400/40 bg-amber-400/10", COLD: "text-[#4facfe] border-[#4facfe]/40 bg-[#4facfe]/10" };
const ACTIVITY_ICON = { NOTE: "📝", CALL: "📞", MEETING: "📅", EMAIL: "✉️" };

function ContactActivityPanel({ orgId, contact }) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState(null); // NOTE | CALL | EMAIL | MEETING
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/orgs/crm/contacts/${contact.id}`;

  const load = useCallback(async () => {
    try { setData(await api(`${base}/activities?orgId=${orgId}`)); } catch (err) { setError(err.message); }
  }, [orgId, base]);
  useEffect(() => { load(); }, [load]);

  const field = (k) => ({ value: form[k] ?? "", onChange: (e) => setForm((f) => ({ ...f, [k]: e.target.value })) });
  async function submit() {
    setBusy(true); setError(""); setNotice("");
    try {
      if (mode === "NOTE" || mode === "CALL") {
        await api(`${base}/activities`, { method: "POST", body: JSON.stringify({ orgId, type: mode, subject: form.subject, body: form.body, durationMinutes: form.duration ? Number(form.duration) : undefined }) });
      } else if (mode === "EMAIL") {
        const r = await api(`${base}/email`, { method: "POST", body: JSON.stringify({ orgId, subject: form.subject, body: form.body }) });
        setNotice(r.sent ? "Email sent." : `Logged, but not sent (${r.reason || "mail not configured"}).`);
      } else if (mode === "MEETING") {
        const r = await api(`${base}/meetings`, {
          method: "POST",
          body: JSON.stringify({ orgId, subject: form.subject, start: form.start ? new Date(form.start).toISOString() : "", durationMinutes: Number(form.duration) || 30, location: form.location, description: form.body, attendeeEmails: (form.attendees || "").split(/[,\s]+/).filter(Boolean) }),
        });
        const sent = r.deliveries.filter((d) => d.sent).length;
        setNotice(`Invite sent to ${sent} of ${r.deliveries.length} recipient${r.deliveries.length === 1 ? "" : "s"}.`);
      }
      setMode(null); setForm({}); await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (!data) return error ? <p className="text-red-400 text-xs">{error}</p> : <p className="text-[var(--inaya-text-muted)] font-mono text-xs">Loading activity…</p>;
  const { score, activities } = data;
  const btn = "text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40";

  return (
    <div className="space-y-3 border-t border-white/10 pt-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${BAND_TONE[score.band]}`}>{score.band} · {score.score}/100</span>
          <span className="text-[10px] uppercase font-bold text-[var(--inaya-text-muted)]">Lead score</span>
        </div>
        {score.reasons.length > 0 && <p className="text-[11px] text-[var(--inaya-text-muted)]">{score.reasons.map((r) => `+${r.points} ${r.label}`).join(" · ")}</p>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[["NOTE", "Add note"], ["CALL", "Log call"], ["EMAIL", "Send email"], ["MEETING", "Schedule meeting"]].map(([m, l]) => (
          <button key={m} disabled={busy || (m === "EMAIL" && !contact.email)} title={m === "EMAIL" && !contact.email ? "This contact has no email address." : undefined} onClick={() => { setMode(mode === m ? null : m); setForm({}); setError(""); }} className={btn}>{l}</button>
        ))}
      </div>
      {mode && (
        <div className="space-y-1.5">
          {mode !== "NOTE" && <input id="crm-activity-subject" placeholder={mode === "CALL" ? "Call summary" : "Subject"} {...field("subject")} className={`${inputCls} w-full`} />}
          {mode === "MEETING" && (
            <div className="grid grid-cols-2 gap-1.5">
              <input id="crm-meeting-start" type="datetime-local" aria-label="Start" {...field("start")} className={inputCls} />
              <input id="crm-meeting-duration" inputMode="numeric" placeholder="Minutes (30)" {...field("duration")} className={inputCls} />
              <input id="crm-meeting-location" placeholder="Location or video link" {...field("location")} className={`${inputCls} col-span-2`} />
              <input id="crm-meeting-attendees" placeholder="Other attendees (emails, comma-separated)" {...field("attendees")} className={`${inputCls} col-span-2`} />
            </div>
          )}
          {mode === "CALL" && <input id="crm-call-duration" inputMode="numeric" placeholder="Duration (minutes)" {...field("duration")} className={`${inputCls} w-full`} />}
          <textarea id="crm-activity-body" rows={3} placeholder={mode === "EMAIL" ? "Message" : mode === "MEETING" ? "Agenda (optional)" : "Notes"} {...field("body")} className={`${inputCls} w-full`} />
          {mode === "EMAIL" && <p className="text-[10px] text-[var(--inaya-text-muted)]">Sent from Inaya with your address as reply-to. Replies arrive in your own inbox.</p>}
          <button disabled={busy} onClick={submit} className="text-[11px] font-bold uppercase px-3 py-2 rounded-md bg-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{busy ? "…" : mode === "EMAIL" ? "Send" : mode === "MEETING" ? "Send invite" : "Save"}</button>
        </div>
      )}
      {notice && <p className="text-emerald-400 text-xs">{notice}</p>}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {activities.length === 0 ? <p className="text-[11px] text-[var(--inaya-text-muted)]">No activity logged yet.</p> : (
        <ul className="space-y-2 max-h-64 overflow-y-auto">
          {activities.map((a) => (
            <li key={a.id} className="text-xs">
              <p className="text-[var(--inaya-text-primary)]">{ACTIVITY_ICON[a.type]} <span className="font-bold">{a.subject || a.type.toLowerCase()}</span>{a.delivery === "NOT_SENT" && <span className="text-amber-400"> · not sent</span>}</p>
              <p className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{new Date(a.at).toLocaleString()}{a.durationMinutes ? ` · ${a.durationMinutes} min` : ""} · {a.createdByEmail}
                {a.hasInvite && <> · <a href={`${base}/meetings?orgId=${orgId}&activityId=${a.id}`} className="text-[#00f2fe]">invite.ics</a></>}
              </p>
              {a.body && <p className="text-[11px] text-[var(--inaya-text-muted)] whitespace-pre-wrap">{a.body}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Local Modal removed -- now imports the shared ./ui/Modal (see
// BUSINESS_WORKSPACE_UX_AUDIT.md #3.1: this was one of 12 byte-identical
// copies).
