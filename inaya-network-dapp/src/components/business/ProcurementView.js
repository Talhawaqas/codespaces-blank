"use client";

// src/components/business/ProcurementView.js
//
// Procurement tab (Phase 3) — Suppliers, Purchase Requests, and Purchase
// Orders, backed by /api/orgs/procurement/*. Same self-contained-view
// pattern as TasksView/CRMView. Approve/reject on both requests and
// orders are shown to everyone but will 403 server-side for a non-
// manager — same "buttons are UX only, the server is the real gate"
// relationship every workflow view in this app has.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import ConfirmButton from "./ConfirmButton";
import { SUPPORTED_CURRENCIES } from "../../lib/currency.js";

const DESTRUCTIVE_ACTIONS = new Set(["cancel", "reject"]);

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const PR_STATUS_STYLES = {
  DRAFT: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  PENDING_APPROVAL: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  APPROVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  CANCELLED: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};
const PO_STATUS_STYLES = {
  ...PR_STATUS_STYLES,
  ORDERED: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  PARTIALLY_RECEIVED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  RECEIVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
};
const PR_ACTIONS = { DRAFT: [["submit", "Submit"], ["cancel", "Cancel"]], PENDING_APPROVAL: [["approve", "Approve"], ["reject", "Reject"], ["cancel", "Cancel"]] };
const PO_ACTIONS = {
  DRAFT: [["submit", "Submit"], ["cancel", "Cancel"]],
  PENDING_APPROVAL: [["approve", "Approve"], ["reject", "Reject"], ["cancel", "Cancel"]],
  APPROVED: [["order", "Mark ordered"], ["cancel", "Cancel"]],
  ORDERED: [["cancel", "Cancel"]],
};

export default function ProcurementView({ orgId, canManage }) {
  const [tab, setTab] = useState("suppliers");
  const [departments, setDepartments] = useState([]);
  const [departmentsError, setDepartmentsError] = useState("");

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => { setDepartments(d.departments); setDepartmentsError(""); }).catch((err) => setDepartmentsError(`Couldn't load departments: ${err.message}`));
  }, [orgId]);

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
        {[["suppliers", "Suppliers"], ["requests", "Requests"], ["orders", "Orders"], ["reports", "Reports"]].map(([key, label]) => (
          <button key={key} data-guide-id={`procurement-tab-${key}`} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </div>
      {departmentsError && <p className="text-red-400 text-xs">{departmentsError}</p>}
      {tab === "suppliers" && <SuppliersTab orgId={orgId} departments={departments} />}
      {tab === "requests" && <RequestsTab orgId={orgId} departments={departments} />}
      {tab === "orders" && <OrdersTab orgId={orgId} departments={departments} />}
      {tab === "reports" && <PoReportsTab orgId={orgId} />}
    </div>
  );
}

// ============================================================
// SUPPLIERS
// ============================================================
function SuppliersTab({ orgId, departments }) {
  const [suppliers, setSuppliers] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setSuppliers((await api(`/api/orgs/procurement/suppliers?orgId=${orgId}`)).suppliers);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const filtered = (suppliers || []).filter((s) => !search.trim() || s.name.toLowerCase().includes(search.trim().toLowerCase()) || (s.contactEmail || "").toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search suppliers…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New supplier</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!suppliers ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : suppliers.length === 0 ? (
          <EmptyState compact icon="🏭" description="No suppliers yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No suppliers match "{search}".</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{s.name}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{s.contactEmail || "No contact email"}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${s.status === "ACTIVE" ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "bg-white/5 text-[var(--inaya-text-muted)] border-white/10"}`}>{s.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateSupplierModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateSupplierModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/procurement/suppliers", { method: "POST", body: JSON.stringify({ orgId, departmentId, name: name.trim(), contactEmail: contactEmail.trim() || undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New supplier" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Supplier name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} type="email" placeholder="Contact email (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !name.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create supplier"}</button>
      </form>
    </Modal>
  );
}

// ============================================================
// PURCHASE REQUESTS
// ============================================================
function RequestsTab({ orgId, departments }) {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [acting, setActing] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      setRequests((await api(`/api/orgs/procurement/requests?orgId=${orgId}`)).requests);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(id, action) {
    setActing(id + action);
    setError("");
    try {
      await api(`/api/orgs/procurement/requests/${id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  const filtered = (requests || []).filter((r) => !search.trim() || r.title.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search requests…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New request</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!requests ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : requests.length === 0 ? (
          <EmptyState compact icon="📝" description="No purchase requests yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No requests match "{search}".</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{r.title}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{r.estimatedCost ? `$${r.estimatedCost.toLocaleString()}` : "No estimate"}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${PR_STATUS_STYLES[r.status]}`}>{r.status.replace("_", " ")}</span>
                  {(PR_ACTIONS[r.status] || []).map(([action, label]) =>
                    DESTRUCTIVE_ACTIONS.has(action) ? (
                      <ConfirmButton key={action} onConfirm={() => handleAction(r.id, action)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
                        {acting === r.id + action ? "…" : label}
                      </ConfirmButton>
                    ) : (
                      <button key={action} onClick={() => handleAction(r.id, action)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
                        {acting === r.id + action ? "…" : label}
                      </button>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateRequestModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateRequestModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [title, setTitle] = useState("");
  const [estimatedCost, setEstimatedCost] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !title.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/procurement/requests", { method: "POST", body: JSON.stringify({ orgId, departmentId, title: title.trim(), estimatedCost: estimatedCost ? Number(estimatedCost) : undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New purchase request" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="What do you need to buy?" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={estimatedCost} onChange={(e) => setEstimatedCost(e.target.value)} type="number" min="0" placeholder="Estimated cost in USD (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !title.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create request"}</button>
      </form>
    </Modal>
  );
}

// ============================================================
// PURCHASE ORDERS
// ============================================================
const OPEN_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED", "PARTIALLY_RECEIVED"];
const CLOSED_STATUSES = ["RECEIVED", "REJECTED", "CANCELLED"];
const LAST_N_DAYS_OPTIONS = [["", "Any time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]];

function OrdersTab({ orgId, departments }) {
  const [orders, setOrders] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [supplierFilter, setSupplierFilter] = useState("");
  const [openClosedFilter, setOpenClosedFilter] = useState("all");
  const [lastNDays, setLastNDays] = useState("");

  const load = useCallback(async () => {
    try {
      const [ordersRes, suppliersRes] = await Promise.all([
        api(`/api/orgs/procurement/orders?orgId=${orgId}`),
        api(`/api/orgs/procurement/suppliers?orgId=${orgId}`),
      ]);
      setOrders(ordersRes.orders);
      setSuppliers(suppliersRes.suppliers);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const supplierNameById = new Map(suppliers.map((s) => [s.id, s.name]));
  const filtered = (orders || []).filter((po) => {
    if (supplierFilter && po.supplierId !== supplierFilter) return false;
    if (openClosedFilter === "open" && !OPEN_STATUSES.includes(po.status)) return false;
    if (openClosedFilter === "closed" && !CLOSED_STATUSES.includes(po.status)) return false;
    if (lastNDays) {
      const cutoff = Date.now() - Number(lastNDays) * 24 * 60 * 60 * 1000;
      if (new Date(po.createdAt).getTime() < cutoff) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">All suppliers</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1">
          {[["all", "All"], ["open", "Open"], ["closed", "Closed"]].map(([value, label]) => (
            <button key={value} onClick={() => setOpenClosedFilter(value)} className={`px-3 py-1.5 text-xs font-bold rounded-lg ${openClosedFilter === value ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
          ))}
        </div>
        <select value={lastNDays} onChange={(e) => setLastNDays(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {LAST_N_DAYS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New PO</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!orders ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : orders.length === 0 ? (
          <EmptyState compact icon="📦" description="No purchase orders yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : filtered.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-xs">No purchase orders match these filters.</p>
        ) : (
          <div className="space-y-2">
            {filtered.map((po) => (
              <button key={po.id} onClick={() => setSelectedId(po.id)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{supplierNameById.get(po.supplierId) || "Unknown supplier"} · {po.items.length} item{po.items.length === 1 ? "" : "s"}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{po.currency} · {new Date(po.createdAt).toLocaleDateString()}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${PO_STATUS_STYLES[po.status]}`}>{po.status.replace("_", " ")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateOrderModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selectedId && <OrderDetailModal orgId={orgId} orderId={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />}
    </div>
  );
}

function CreateOrderModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [items, setItems] = useState([{ description: "", quantity: 1, unitPrice: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!departmentId) { setSuppliers([]); setSupplierId(""); return; }
    api(`/api/orgs/procurement/suppliers?orgId=${orgId}&departmentId=${departmentId}`).then((d) => { setSuppliers(d.suppliers); setError(""); }).catch((err) => { setSuppliers([]); setError(`Couldn't load suppliers: ${err.message}`); });
    setSupplierId("");
  }, [orgId, departmentId]);

  function updateItem(i, field, value) {
    setItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));
  }

  const validItems = items.filter((it) => it.description.trim() && Number(it.quantity) > 0);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !supplierId || validItems.length === 0) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/procurement/orders", {
        method: "POST",
        body: JSON.stringify({
          orgId, departmentId, supplierId, currency,
          items: validItems.map((it) => ({ description: it.description.trim(), quantity: Number(it.quantity), unitPrice: it.unitPrice ? Number(it.unitPrice) : undefined })),
        }),
      });
      window.dispatchEvent(new CustomEvent("inaya:guided-po-created"));
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New purchase order" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required disabled={!departmentId} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
          <option value="">Supplier…</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Line items</p>
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-[1fr_60px_70px] gap-1.5">
              <input value={item.description} onChange={(e) => updateItem(i, "description", e.target.value)} placeholder="Description" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
              <input value={item.quantity} onChange={(e) => updateItem(i, "quantity", e.target.value)} type="number" min="1" placeholder="Qty" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <input value={item.unitPrice} onChange={(e) => updateItem(i, "unitPrice", e.target.value)} type="number" min="0" placeholder="$/unit" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
            </div>
          ))}
          <button type="button" onClick={() => setItems((prev) => [...prev, { description: "", quantity: 1, unitPrice: "" }])} className="text-[11px] font-bold text-[#00f2fe]">+ Add item</button>
        </div>

        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !supplierId || validItems.length === 0} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create purchase order"}</button>
      </form>
    </Modal>
  );
}

function OrderDetailModal({ orgId, orderId, onClose, onChanged }) {
  const [po, setPo] = useState(null);
  const [acting, setActing] = useState("");
  const [error, setError] = useState("");
  const [receiveQty, setReceiveQty] = useState({});
  const [emailStatus, setEmailStatus] = useState("");
  const [editingItems, setEditingItems] = useState(false);
  const [draftItems, setDraftItems] = useState([]);

  const load = useCallback(async () => {
    try {
      setPo(await api(`/api/orgs/procurement/orders/${orderId}?orgId=${orgId}`));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, orderId]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(action) {
    setActing(action);
    setError("");
    try {
      await api(`/api/orgs/procurement/orders/${orderId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  async function handleReceive(itemIndex) {
    const quantity = Number(receiveQty[itemIndex]);
    if (!quantity || quantity <= 0) return;
    setActing(`receive-${itemIndex}`);
    setError("");
    try {
      await api(`/api/orgs/procurement/orders/${orderId}/receive`, { method: "POST", body: JSON.stringify({ orgId, receipts: [{ itemIndex, quantity }] }) });
      setReceiveQty((prev) => ({ ...prev, [itemIndex]: "" }));
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  async function handleEmail() {
    setActing("email");
    setError("");
    setEmailStatus("");
    try {
      const result = await api(`/api/orgs/procurement/orders/${orderId}/email`, { method: "POST", body: JSON.stringify({ orgId }) });
      setEmailStatus(result.sent ? `Sent to ${result.to}.` : `Not sent: ${result.reason || "email isn't configured"}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  function startEditingItems() {
    setDraftItems(po.items.map((it) => ({ ...it })));
    setEditingItems(true);
  }
  function updateDraftItem(i, field, value) {
    setDraftItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));
  }
  const validDraftItems = draftItems.filter((it) => it.description.trim() && Number(it.quantity) > 0);

  async function handleSaveItems() {
    setActing("save-items");
    setError("");
    try {
      await api(`/api/orgs/procurement/orders/${orderId}/items`, {
        method: "PATCH",
        body: JSON.stringify({
          orgId,
          items: validDraftItems.map((it) => ({
            description: it.description.trim(), sku: it.sku || undefined,
            productId: it.productId || undefined, warehouseId: it.warehouseId || undefined,
            quantity: Number(it.quantity), unitPrice: it.unitPrice ? Number(it.unitPrice) : undefined,
          })),
        }),
      });
      setEditingItems(false);
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  if (!po) return <Modal title="Purchase order" onClose={onClose}>{error ? <p className="text-red-400 text-xs">{error}</p> : <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>}</Modal>;

  const canReceive = ["ORDERED", "PARTIALLY_RECEIVED"].includes(po.status);
  const canEditItems = po.status === "DRAFT";

  return (
    <Modal title="Purchase order" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <span className={`inline-block text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${PO_STATUS_STYLES[po.status]}`}>{po.status.replace("_", " ")}</span>
          <span className="text-[var(--inaya-text-muted)] text-[11px] font-mono">{po.currency}</span>
        </div>

        {editingItems ? (
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Edit line items</p>
            {draftItems.map((item, i) => (
              <div key={i} className="grid grid-cols-[1fr_60px_70px] gap-1.5">
                <input value={item.description} onChange={(e) => updateDraftItem(i, "description", e.target.value)} placeholder="Description" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
                <input value={item.quantity} onChange={(e) => updateDraftItem(i, "quantity", e.target.value)} type="number" min="1" placeholder="Qty" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
                <input value={item.unitPrice ?? ""} onChange={(e) => updateDraftItem(i, "unitPrice", e.target.value)} type="number" min="0" placeholder="$/unit" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              </div>
            ))}
            <button type="button" onClick={() => setDraftItems((prev) => [...prev, { description: "", quantity: 1, unitPrice: "" }])} className="text-[11px] font-bold text-[#00f2fe]">+ Add item</button>
            <div className="flex gap-1.5">
              <button onClick={handleSaveItems} disabled={!!acting || validDraftItems.length === 0} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-emerald-400/10 text-emerald-400 border border-emerald-400/30 disabled:opacity-40">{acting === "save-items" ? "…" : "Save items"}</button>
              <button onClick={() => setEditingItems(false)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)]">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {po.items.map((item, i) => (
              <div key={i} className="bg-black/20 border border-white/5 rounded-lg p-2.5">
                <p className="text-[var(--inaya-text-primary)] text-xs">{item.description}</p>
                <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mt-0.5">Qty {item.quantity}{item.unitPrice ? ` · $${item.unitPrice}/unit` : ""} · Received {item.receivedQuantity}/{item.quantity}</p>
                {canReceive && item.receivedQuantity < item.quantity && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <input value={receiveQty[i] || ""} onChange={(e) => setReceiveQty((prev) => ({ ...prev, [i]: e.target.value }))} type="number" min="1" max={item.quantity - item.receivedQuantity} placeholder="Qty received" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-xs text-[var(--inaya-text-primary)] w-28" />
                    <button onClick={() => handleReceive(i)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-emerald-400/10 text-emerald-400 border border-emerald-400/30 disabled:opacity-40">
                      {acting === `receive-${i}` ? "…" : "Receive"}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {canEditItems && <button onClick={startEditingItems} className="text-[11px] font-bold text-[#00f2fe]">Edit line items</button>}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {(PO_ACTIONS[po.status] || []).map(([action, label]) =>
            DESTRUCTIVE_ACTIONS.has(action) ? (
              <ConfirmButton key={action} onConfirm={() => handleAction(action)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
                {acting === action ? "…" : label}
              </ConfirmButton>
            ) : (
              <button key={action} onClick={() => handleAction(action)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
                {acting === action ? "…" : label}
              </button>
            )
          )}
          <button onClick={handleEmail} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
            {acting === "email" ? "…" : "Email PO"}
          </button>
        </div>
        {emailStatus && <p className="text-[#00f2fe] text-[11px] font-semibold">{emailStatus}</p>}
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </Modal>
  );
}

// ============================================================
// PO / AR REPORTS
// ============================================================
const PO_REPORT_TYPES = [
  ["open-pos", "Open POs"], ["closed-pos", "Closed POs"],
  ["po-by-vendor", "POs by vendor"], ["po-by-department", "POs by department"],
  ["ar-payment-history", "AR payment history"],
];

function PoReportsTab({ orgId }) {
  const [type, setType] = useState("open-pos");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/procurement/reports?orgId=${orgId}&type=${type}&format=json`).then(setReport).catch((err) => setError(err.message));
  }, [orgId, type]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {PO_REPORT_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <a
          href={`/api/orgs/procurement/reports?orgId=${orgId}&type=${type}&format=csv`}
          download
          className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg"
        >↓ Download CSV</a>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!report ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : report.rows.length === 0 ? (
          <EmptyState compact icon="📊" description="No data for this report yet." />
        ) : (
          <div className="space-y-3">
            <p className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{report.count} record{report.count === 1 ? "" : "s"}</p>
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
