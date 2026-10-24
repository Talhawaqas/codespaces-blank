"use client";

// src/components/business/erp/ErpModuleOverview.js
//
// ERP mode (docs/erp-mode-plan.md, Batch 4): the "Overview" each core module
// opens on -- key figures, what needs attention and the latest records, in
// boxed panels. Read-only and built only on the list APIs the module's own
// screens already use, so it shows exactly what this person may see: a
// screen they have no access to shows that message instead of figures.

import { useEffect, useState } from "react";
import { formatCurrency, formatDate } from "../../../lib/format";
import ErpPanel from "./ErpPanel";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

/** Amounts per currency, never added across currencies. */
function totals(list, field) {
  const by = new Map();
  for (const x of list) by.set(x.currency || "", (by.get(x.currency || "") || 0) + (Number(x[field]) || 0));
  return [...by.entries()].map(([c, v]) => formatCurrency(v, c || null)).join(" + ") || "0.00";
}
const count = (list, pred) => list.filter(pred).length;
const recent = (list, n = 6) => [...list].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, n);
const pretty = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

// Each module: the lists it reads, and how they become figures, attention rows and recent records.
// Figures/rows/recent receive `d` (the loaded lists) and return display data; `go` targets are
// [view, { section, action }] pairs for onNavigate.
const MODULES = {
  accounting: {
    load: { invoices: "finance/invoices", expenses: "finance/expenses", payments: "finance/payments" },
    figures: (d) => [
      d.invoices && ["Open invoices", count(d.invoices, (i) => i.status === "SENT" || i.status === "OVERDUE"), ["finance", { section: "invoices" }]],
      d.invoices && ["Receivable", totals(d.invoices.filter((i) => i.status === "SENT" || i.status === "OVERDUE"), "total"), ["finance", { section: "invoices" }]],
      d.invoices && ["Paid invoices", count(d.invoices, (i) => i.status === "PAID"), ["finance", { section: "invoices" }]],
      d.expenses && ["Expenses to approve", count(d.expenses, (e) => e.status === "PENDING_APPROVAL"), ["finance", { section: "expenses" }]],
      d.payments && ["Payments recorded", d.payments.length, ["finance", { section: "payments" }]],
    ],
    attention: (d) => [
      d.invoices && count(d.invoices, (i) => i.status === "OVERDUE") > 0 && ["danger", `${count(d.invoices, (i) => i.status === "OVERDUE")} overdue invoice(s)`, totals(d.invoices.filter((i) => i.status === "OVERDUE"), "total"), ["finance", { section: "invoices" }]],
      d.invoices && count(d.invoices, (i) => i.status === "DRAFT") > 0 && ["warning", `${count(d.invoices, (i) => i.status === "DRAFT")} draft invoice(s) not sent yet`, null, ["finance", { section: "invoices" }]],
      d.expenses && count(d.expenses, (e) => e.status === "PENDING_APPROVAL") > 0 && ["warning", `${count(d.expenses, (e) => e.status === "PENDING_APPROVAL")} expense(s) waiting for approval`, totals(d.expenses.filter((e) => e.status === "PENDING_APPROVAL"), "amount"), ["finance", { section: "expenses" }]],
    ],
    recentTitle: "Latest invoices",
    recent: (d) => d.invoices && recent(d.invoices).map((i) => [i.invoiceNumber, `${formatCurrency(i.total, i.currency)} · due ${formatDate(i.dueDate)}`, pretty(i.status), ["finance", { section: "invoices" }]]),
    tasks: [["finance", "invoices", "New invoice"], ["finance", "expenses", "New expense"], ["finance", "payments", "Record a payment"], ["finance", "ledger", "Manual journal entry"]],
  },
  sales: {
    load: { contacts: "crm/contacts", deals: "crm/deals" },
    figures: (d) => [
      d.contacts && ["Customers and leads", d.contacts.length, ["crm", { section: "contacts" }]],
      d.deals && ["Open deals", count(d.deals, (x) => !["WON", "LOST"].includes(x.status)), ["crm", { section: "deals" }]],
      d.deals && ["Pipeline value", d.deals.filter((x) => !["WON", "LOST"].includes(x.status)).reduce((t, x) => t + (Number(x.value) || 0), 0).toLocaleString(), ["crm", { section: "deals" }]],
      d.deals && ["Won", count(d.deals, (x) => x.status === "WON"), ["crm", { section: "deals" }]],
      d.deals && ["Lost", count(d.deals, (x) => x.status === "LOST"), ["crm", { section: "deals" }]],
    ],
    attention: (d) => [
      d.deals && count(d.deals, (x) => x.status === "NEGOTIATION") > 0 && ["warning", `${count(d.deals, (x) => x.status === "NEGOTIATION")} deal(s) in negotiation`, null, ["crm", { section: "deals" }]],
      d.deals && count(d.deals, (x) => x.status === "NEW") > 0 && ["neutral", `${count(d.deals, (x) => x.status === "NEW")} new deal(s) to qualify`, null, ["crm", { section: "deals" }]],
    ],
    recentTitle: "Latest deals",
    recent: (d) => d.deals && recent(d.deals).map((x) => [x.title, x.value != null ? Number(x.value).toLocaleString() : "No value set", pretty(x.status), ["crm", { section: "deals" }]]),
    tasks: [["crm", "contacts", "New customer or lead"], ["crm", "deals", "New deal"]],
  },
  purchasing: {
    load: { requests: "procurement/requests", orders: "procurement/orders", suppliers: "procurement/suppliers" },
    figures: (d) => [
      d.requests && ["Requests to approve", count(d.requests, (r) => r.status === "PENDING_APPROVAL"), ["procurement", { section: "requests" }]],
      d.orders && ["Open orders", count(d.orders, (o) => ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(o.status)), ["procurement", { section: "orders" }]],
      d.orders && ["Orders to approve", count(d.orders, (o) => o.status === "PENDING_APPROVAL"), ["procurement", { section: "orders" }]],
      d.suppliers && ["Suppliers", d.suppliers.length, ["procurement", { section: "suppliers" }]],
    ],
    attention: (d) => [
      d.requests && count(d.requests, (r) => r.status === "PENDING_APPROVAL") > 0 && ["warning", `${count(d.requests, (r) => r.status === "PENDING_APPROVAL")} purchase request(s) waiting for approval`, null, ["procurement", { section: "requests" }]],
      d.orders && count(d.orders, (o) => o.status === "PENDING_APPROVAL") > 0 && ["warning", `${count(d.orders, (o) => o.status === "PENDING_APPROVAL")} purchase order(s) waiting for approval`, null, ["procurement", { section: "orders" }]],
      d.orders && count(d.orders, (o) => o.status === "PARTIALLY_RECEIVED") > 0 && ["neutral", `${count(d.orders, (o) => o.status === "PARTIALLY_RECEIVED")} order(s) partly received`, null, ["procurement", { section: "orders" }]],
    ],
    recentTitle: "Latest purchase orders",
    recent: (d) => d.orders && recent(d.orders).map((o) => [
      `${o.items?.[0]?.description || "Purchase order"}${o.items?.length > 1 ? ` +${o.items.length - 1} more` : ""}`,
      `${formatCurrency(o.total, o.currency)} · ${formatDate(o.createdAt)}`, pretty(o.status), ["procurement", { section: "orders" }],
    ]),
    tasks: [["procurement", "requests", "New purchase request"], ["procurement", "orders", "New purchase order"], ["procurement", "suppliers", "New supplier"]],
  },
  inventory: {
    load: { products: "inventory/products", warehouses: "inventory/warehouses" },
    figures: (d) => [
      d.products && ["Products", d.products.length, ["inventory", { section: "products" }]],
      d.products && ["Low on stock", count(d.products, (p) => p.lowStock), ["inventory", { section: "products" }]],
      d.products && ["Units in stock", d.products.reduce((t, p) => t + (Number(p.totalStock) || 0), 0).toLocaleString(), ["inventory", { section: "products" }]],
      d.warehouses && ["Warehouses", d.warehouses.length, ["inventory", { section: "warehouses" }]],
    ],
    attention: (d) => (d.products || []).filter((p) => p.lowStock).slice(0, 8).map((p) => ["warning", `${p.name} is low on stock`, `${p.totalStock} left, reorder at ${p.reorderThreshold}`, ["inventory", { section: "products" }]]),
    recentTitle: "Latest products",
    recent: (d) => d.products && recent(d.products).map((p) => [p.name, `${p.sku} · ${p.totalStock} in stock`, pretty(p.status), ["inventory", { section: "products" }]]),
    tasks: [["inventory", "products", "New product"], ["inventory", "warehouses", "New warehouse"]],
  },
  people: {
    load: { employees: "hr/employees", leave: "hr/leave-requests" },
    figures: (d) => [
      d.employees && ["Active employees", count(d.employees, (e) => e.employmentStatus === "ACTIVE"), ["hr", { section: "employees" }]],
      d.employees && ["Onboarding", count(d.employees, (e) => e.employmentStatus === "ONBOARDING"), ["hr", { section: "employees" }]],
      d.employees && ["On leave", count(d.employees, (e) => e.employmentStatus === "ON_LEAVE"), ["hr", { section: "employees" }]],
      d.leave && ["Leave to approve", count(d.leave, (r) => r.status === "PENDING"), ["hr", { section: "leave" }]],
    ],
    attention: (d) => [
      d.leave && count(d.leave, (r) => r.status === "PENDING") > 0 && ["warning", `${count(d.leave, (r) => r.status === "PENDING")} leave request(s) waiting for a decision`, null, ["hr", { section: "leave" }]],
      d.employees && count(d.employees, (e) => e.employmentStatus === "ONBOARDING") > 0 && ["neutral", `${count(d.employees, (e) => e.employmentStatus === "ONBOARDING")} employee(s) still onboarding`, null, ["hr", { section: "employees" }]],
    ],
    recentTitle: "Newest employees",
    recent: (d) => d.employees && recent(d.employees).map((e) => [e.fullName, e.jobTitle || "No job title", pretty(e.employmentStatus), ["hr", { section: "employees" }]]),
    tasks: [["hr", "employees", "New employee"], ["hr", "leave", "Request leave"]],
  },
};

export const ERP_OVERVIEW_MODULES = Object.keys(MODULES);

export default function ErpModuleOverview({ orgId, moduleId, onNavigate }) {
  const cfg = MODULES[moduleId];
  const [data, setData] = useState(null);
  const [denied, setDenied] = useState([]);

  useEffect(() => {
    if (!cfg) return undefined;
    let stop = false;
    setData(null);
    const keys = Object.keys(cfg.load);
    const listKey = { "finance/invoices": "invoices", "finance/expenses": "expenses", "finance/payments": "payments", "crm/contacts": "contacts", "crm/deals": "deals", "procurement/requests": "requests", "procurement/orders": "orders", "procurement/suppliers": "suppliers", "inventory/products": "products", "inventory/warehouses": "warehouses", "hr/employees": "employees", "hr/leave-requests": "leaveRequests" };
    Promise.allSettled(keys.map((k) => api(`/api/orgs/${cfg.load[k]}?orgId=${orgId}`))).then((results) => {
      if (stop) return;
      const d = {};
      const errors = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") d[keys[i]] = r.value[listKey[cfg.load[keys[i]]]] || [];
        else errors.push(r.reason.message);
      });
      setData(d);
      setDenied(errors);
    });
    return () => { stop = true; };
  }, [cfg, orgId]);

  if (!cfg) return null;
  const go = (target) => onNavigate(target[0], target[1]);
  const figures = data ? cfg.figures(data).filter(Boolean) : [];
  const attention = data ? cfg.attention(data).filter(Boolean) : [];
  const latest = data ? cfg.recent(data) : null;

  return (
    <div className="erp-grid">
      <ErpPanel title="Key figures" tone="green" className="erp-span-2">
        {!data ? <p className="erp-muted">Loading…</p> : figures.length === 0 ? (
          <p className="erp-muted">{denied[0] || "No figures to show yet."}</p>
        ) : (
          <div className="erp-figures">
            {figures.map(([label, value, target]) => (
              <button key={label} type="button" className="erp-figure" onClick={() => go(target)}>
                <span className="erp-figure-value">{value}</span>
                <span className="erp-figure-label">{label}</span>
              </button>
            ))}
          </div>
        )}
      </ErpPanel>

      <ErpPanel title="My tasks" tone="blue">
        <ul className="erp-quick">
          {cfg.tasks.map(([view, section, label]) => (
            <li key={label}><button type="button" className="erp-quick-btn" onClick={() => onNavigate(view, { section, action: "new" })}><span aria-hidden="true">+</span>{label}</button></li>
          ))}
        </ul>
      </ErpPanel>

      <ErpPanel title="Needs attention" tone="red">
        {!data ? <p className="erp-muted">Loading…</p> : attention.length === 0 ? <p className="erp-muted">Nothing needs attention here right now.</p> : (
          <ul className="erp-rows">
            {attention.map(([tone, label, detail, target]) => (
              <li key={label} className="erp-row">
                <span className={`erp-row-dot is-${tone}`} aria-hidden="true" />
                <span className="erp-row-text"><strong>{label}</strong>{detail && <span className="erp-row-detail"> · {detail}</span>}</span>
                <button type="button" className="erp-link" onClick={() => go(target)}>Open</button>
              </li>
            ))}
          </ul>
        )}
      </ErpPanel>

      <ErpPanel title={cfg.recentTitle} tone="graphite" className="erp-span-2">
        {!data ? <p className="erp-muted">Loading…</p> : !latest ? <p className="erp-muted">{denied[0] || "Nothing to show."}</p> : latest.length === 0 ? <p className="erp-muted">Nothing here yet. Use My tasks to add the first one.</p> : (
          <table className="erp-mini-table">
            <tbody>
              {latest.map(([name, detail, status, target], i) => (
                <tr key={`${name}-${i}`} onClick={() => go(target)}>
                  <td className="erp-mini-name">{name}</td>
                  <td className="erp-mini-detail">{detail}</td>
                  <td className="erp-mini-status">{status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ErpPanel>
    </div>
  );
}
