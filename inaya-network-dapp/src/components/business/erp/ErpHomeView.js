"use client";

// src/components/business/erp/ErpHomeView.js
//
// ERP mode's Home (docs/erp-mode-plan.md, Batch 4): the workspace overview
// laid out as a classic ERP welcome screen, boxed panels with coloured title
// bars. It carries everything the standard Home (OsHomeView) shows -- what
// needs attention, quick actions, the setup checklist, key figures, this
// week's changes, trust health, the OS assistant, recent departments and
// projects, the person's access, trust and audit links -- from the same
// APIs, plus ERP extras: pending approvals, resources and tips.

import { useCallback, useEffect, useMemo, useState } from "react";
import TrustHealthCard from "../../TrustHealthCard";
import { OsAssistantWidget, PermissionsSummary } from "../OsHomeView";
import { formatCurrency } from "../../../lib/format";
import ErpPanel from "./ErpPanel";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

const TIPS = [
  "Alt+1 to Alt+9 jump straight to a module tile. Alt+0 opens the tenth.",
  "Ctrl+K searches everything at once: records, people and screens.",
  "Need more room? Hide the task panel with the button next to the module name.",
  "Pin the screens you use most from All apps. They show up under My shortcuts on Home.",
  "Switch between the Classic and Inaya colour themes in Admin > Appearance.",
  "Files are encrypted on this computer before they're uploaded, so nobody else can read them.",
  "Every task panel has a My tasks group: one click opens the form you need.",
  "Back and Forward work like in any desktop app, and every screen has its own link you can share.",
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Row({ tone = "neutral", label, detail, action, onClick }) {
  return (
    <li className="erp-row">
      <span className={`erp-row-dot is-${tone}`} aria-hidden="true" />
      <span className="erp-row-text"><strong>{label}</strong>{detail && <span className="erp-row-detail"> · {detail}</span>}</span>
      {action && <button type="button" className="erp-link" onClick={onClick}>{action}</button>}
    </li>
  );
}

function Figure({ label, value, onClick }) {
  return (
    <button type="button" className="erp-figure" onClick={onClick}>
      <span className="erp-figure-value">{value ?? "–"}</span>
      <span className="erp-figure-label">{label}</span>
    </button>
  );
}

export default function ErpHomeView({ orgId, orgName, canManage, desktop, visibleKeys, onNavigate }) {
  const can = useMemo(() => new Set(visibleKeys), [visibleKeys]);
  const [data, setData] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [trustError, setTrustError] = useState("");
  const [error, setError] = useState("");
  const checklistKey = `inaya_bw_setup_hidden:${orgId}`;
  const [checklistHidden, setChecklistHidden] = useState(() => { try { return window.localStorage.getItem(checklistKey) === "1"; } catch { return false; } });

  const load = useCallback(async () => {
    const calls = {
      dashboard: `/api/orgs/dashboard?orgId=${orgId}`,
      trust: `/api/orgs/trust-health?orgId=${orgId}`,
      changed: `/api/orgs/activity-center?orgId=${orgId}&period=weekly`,
      tasks: `/api/orgs/tasks?orgId=${orgId}&overdue=true`,
      invoices: `/api/orgs/finance/invoices?orgId=${orgId}`,
      stock: `/api/orgs/inventory/products?orgId=${orgId}&lowStockOnly=true`,
    };
    const keys = Object.keys(calls);
    const results = await Promise.allSettled(keys.map((k) => api(calls[k])));
    const next = {};
    results.forEach((r, i) => { if (r.status === "fulfilled") next[keys[i]] = r.value; });
    setData(next);
    setError(results[0].status === "rejected" ? results[0].reason.message : "");
    setTrustError(results[1].status === "rejected" ? results[1].reason.message : "");
    setLoaded(true);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const { dashboard, trust, changed, tasks, invoices, stock } = data;
  const allInvoices = invoices?.invoices || [];
  const overdueInvoices = allInvoices.filter((i) => i.status === "OVERDUE");
  const openInvoices = allInvoices.filter((i) => i.status === "SENT" || i.status === "OVERDUE");
  const overdueTasks = tasks?.tasks || [];
  const lowStock = stock?.products || [];
  const pendingApprovals = dashboard?.pendingApprovals?.length || 0;
  const bullets = (changed?.sections || []).flatMap((s) => s.bullets).slice(0, 5);
  const attention = overdueInvoices.length + overdueTasks.length + lowStock.length + (canManage ? pendingApprovals : 0);
  // Totals per currency: invoices in different currencies are never added together.
  const totals = (list) => {
    const by = new Map();
    for (const i of list) by.set(i.currency || "", (by.get(i.currency || "") || 0) + (Number(i.total) || 0));
    return [...by.entries()].map(([cur, amount]) => formatCurrency(amount, cur || null)).join(" + ") || formatCurrency(0, null);
  };

  const quick = [
    ["finance", { section: "invoices", action: "new" }, "New invoice"],
    ["finance", { section: "expenses", action: "new" }, "New expense"],
    ["procurement", { section: "orders", action: "new" }, "New purchase order"],
    ["crm", { section: "contacts", action: "new" }, "New customer"],
    ["tasks", { section: "list", action: "new" }, "New task"],
    ["documents", undefined, "Upload a document"],
  ].filter(([view]) => can.has(view));

  const steps = [
    { done: (dashboard?.counts?.departments || 0) > 0, title: "Create a department", view: "departments" },
    { done: (dashboard?.counts?.projects || 0) > 0, title: "Start a project", view: "projects" },
    { done: (dashboard?.counts?.documents || 0) > 0, title: "Upload a document", view: "documents" },
    { done: allInvoices.length > 0, title: "Create your first invoice", view: "finance" },
  ];
  const stepsDone = steps.filter((s) => s.done).length;
  const showChecklist = loaded && !checklistHidden && stepsDone < steps.length;
  const day = Math.floor(Date.now() / 86400000);
  const tips = [0, 1, 2].map((i) => TIPS[(day + i * 3) % TIPS.length]);

  return (
    <div className="erp-home">
      <div className="erp-home-welcome">
        <p className="erp-home-greeting">{greeting()}.</p>
        <p className="erp-home-sub">
          {!loaded ? "Checking what needs you…" : attention > 0 ? `${attention} item${attention === 1 ? " needs" : "s need"} your attention at ${orgName}.` : `Nothing needs you right now at ${orgName}.`}
        </p>
        {error && <p className="erp-home-error" role="alert">{error}</p>}
      </div>

      <div className="erp-grid">
        <ErpPanel title="Needs your attention" tone="red">
          {!loaded ? <p className="erp-muted">Loading…</p> : attention === 0 ? (
            <p className="erp-muted">No overdue invoices or tasks, nothing low on stock{canManage ? " and nothing waiting for your approval" : ""}.</p>
          ) : (
            <ul className="erp-rows">
              {canManage && pendingApprovals > 0 && <Row tone="danger" label={`${pendingApprovals} waiting for approval`} action="Review" onClick={() => onNavigate("approvals")} />}
              {overdueInvoices.length > 0 && <Row tone="danger" label={`${overdueInvoices.length} overdue invoice${overdueInvoices.length === 1 ? "" : "s"}`} detail={totals(overdueInvoices)} action="Open" onClick={() => onNavigate("finance", { section: "invoices" })} />}
              {overdueTasks.length > 0 && <Row tone="danger" label={`${overdueTasks.length} overdue task${overdueTasks.length === 1 ? "" : "s"}`} action="Open" onClick={() => onNavigate("tasks")} />}
              {lowStock.length > 0 && <Row tone="warning" label={`${lowStock.length} product${lowStock.length === 1 ? "" : "s"} low on stock`} action="Reorder" onClick={() => onNavigate("inventory", { section: "products" })} />}
            </ul>
          )}
        </ErpPanel>

        <ErpPanel title="Quick tasks" tone="blue">
          <ul className="erp-quick">
            {quick.map(([view, target, label]) => (
              <li key={label}><button type="button" className="erp-quick-btn" onClick={() => onNavigate(view, target)}><span aria-hidden="true">+</span>{label}</button></li>
            ))}
            {can.has("ai") && <li><button type="button" className="erp-quick-btn" onClick={() => onNavigate("ai")}><span aria-hidden="true">›</span>Ask the AI assistant</button></li>}
          </ul>
        </ErpPanel>

        <ErpPanel title="Key figures" tone="green">
          <div className="erp-figures">
            <Figure label="Departments" value={dashboard?.counts?.departments} onClick={() => onNavigate("departments")} />
            <Figure label="Projects" value={dashboard?.counts?.projects} onClick={() => onNavigate("projects")} />
            <Figure label="Documents" value={dashboard?.counts?.documents} onClick={() => onNavigate("documents")} />
            {canManage && <Figure label="Pending approvals" value={loaded ? pendingApprovals : null} onClick={() => onNavigate("approvals")} />}
            {can.has("finance") && invoices && <Figure label="Open invoices" value={openInvoices.length} onClick={() => onNavigate("finance", { section: "invoices" })} />}
            {can.has("finance") && invoices && <Figure label="Receivable" value={totals(openInvoices)} onClick={() => onNavigate("finance", { section: "invoices" })} />}
          </div>
        </ErpPanel>

        {showChecklist && (
          <ErpPanel title={`Get started · ${stepsDone} of ${steps.length} done`} tone="amber" action="Hide" onAction={() => { try { window.localStorage.setItem(checklistKey, "1"); } catch { /* remembered for this visit only */ } setChecklistHidden(true); }}>
            <ul className="erp-rows">
              {steps.map((s) => (
                <Row key={s.title} tone={s.done ? "ok" : "neutral"} label={s.title} detail={s.done ? "Done" : null} action={s.done ? null : "Start"} onClick={() => onNavigate(s.view)} />
              ))}
            </ul>
          </ErpPanel>
        )}

        <ErpPanel title="This week" tone="purple" action="View all" onAction={() => onNavigate("whatChanged")}>
          {!loaded ? <p className="erp-muted">Loading…</p> : bullets.length === 0 ? <p className="erp-muted">A quiet week. Nothing new to report yet.</p> : (
            <ul className="erp-bullets">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          )}
        </ErpPanel>

        <ErpPanel title="Trust health" tone="blue" bodyClassName="erp-box-flush">
          <TrustHealthCard snapshot={trust} loading={!trust && !trustError} error={trustError} />
        </ErpPanel>

        <ErpPanel title="Ask the OS assistant" tone="purple" bodyClassName="erp-box-flush">
          <OsAssistantWidget orgId={orgId} />
        </ErpPanel>

        {(dashboard?.recentDepartments?.length > 0 || dashboard?.recentProjects?.length > 0) && (
          <ErpPanel title="Recent departments and projects" tone="graphite">
            <ul className="erp-rows">
              {(dashboard.recentDepartments || []).map((d) => (
                <Row key={`d${d.id}`} label={d.name} detail={`${d.projectCount} project${d.projectCount === 1 ? "" : "s"}`} action="Open" onClick={() => onNavigate("projects", { deptId: d.id })} />
              ))}
              {(dashboard.recentProjects || []).map((p) => (
                <Row key={`p${p.id}`} tone="ok" label={p.name} detail={`${p.departmentName} · ${p.documentCount} document${p.documentCount === 1 ? "" : "s"}`} action="Open" onClick={() => onNavigate("documents", { deptId: p.departmentId, projectId: p.id })} />
              ))}
            </ul>
          </ErpPanel>
        )}

        <ErpPanel title="Your access" tone="graphite" bodyClassName="erp-box-flush">
          <PermissionsSummary />
        </ErpPanel>

        <ErpPanel title="Trust and audit" tone="graphite">
          <ul className="erp-rows">
            {can.has("auditTrail") && <Row label="Audit trail" detail="Hash-chained and verifiable" action="Open" onClick={() => onNavigate("auditTrail")} />}
            {can.has("aiActions") && <Row label="AI action requests" detail="AI-proposed changes waiting for a person" action="Open" onClick={() => onNavigate("aiActions")} />}
            {can.has("activity") && <Row label="Activity" detail="Everything that happened, company-wide" action="Open" onClick={() => onNavigate("activity")} />}
          </ul>
        </ErpPanel>

        <ErpPanel title="Resources" tone="blue">
          <ul className="erp-rows">
            <li className="erp-row"><span className="erp-row-dot" aria-hidden="true" /><a className="erp-link erp-row-text" href="/docs/business-workspace-guide.md" download>Download the setup guide</a></li>
            {can.has("help") && <Row label="Help and support" detail="We reply by email" action="Open" onClick={() => onNavigate("help")} />}
            <Row label="Appearance" detail="Layout and colour theme" action="Open" onClick={() => onNavigate("appearance")} />
            {!desktop && <li className="erp-row"><span className="erp-row-dot" aria-hidden="true" /><a className="erp-link erp-row-text" href="/business/download">Get the desktop app for Windows and Linux</a></li>}
          </ul>
        </ErpPanel>

        <ErpPanel title="Did you know?" tone="amber">
          <ul className="erp-bullets">{tips.map((t) => <li key={t}>{t}</li>)}</ul>
        </ErpPanel>
      </div>
    </div>
  );
}
