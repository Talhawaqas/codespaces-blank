"use client";

// src/components/business/WhatIfStudioView.js
//
// Modular Enterprise Adoption Features SOW — Interactive What-If Scenario
// Studio. A visual front-end over the Digital Twin simulation API
// (digitalTwinSimulate.js) — NOT a second simulation engine, per the
// SOW's own explicit instruction. Same self-contained-view pattern as
// BusinessEventsView.js: a scenario builder, a results panel (current vs
// simulated where the engine actually computed a shift, dependency list,
// explainability, unknowns, provenance), and scenario history.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const SCENARIO_LABELS = {
  SUPPLIER_UNAVAILABLE: "Supplier becomes unavailable",
  EMPLOYEE_ACCESS_REMOVED: "Employee loses project access",
  PROJECT_DELAYED: "Project is delayed",
  WAREHOUSE_UNAVAILABLE: "Warehouse becomes unavailable",
};

const STATUS_STYLES = {
  COMPLETE: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  PARTIAL: "bg-amber-400/10 text-amber-400 border-amber-400/30",
};

function ResultPanel({ simulation }) {
  const { scenario, directImpact, indirectImpact, unknowns, resultStatus, simulationId, integrityHash, modelVersion, rulesVersion, runAt } = simulation;
  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-amber-400 font-bold text-xs">SIMULATION ONLY — NO CHANGES WERE MADE</p>
        <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLES[resultStatus] || ""}`}>{resultStatus}</span>
      </div>

      <div>
        <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Current vs Simulated</p>
        <div className="bg-black/30 border border-white/10 rounded-md p-2.5 text-[12px] font-mono space-y-1">
          {directImpact.affectedPurchaseOrders && (
            <p className="text-[var(--inaya-text-muted)]">Open purchase orders affected: <span className="text-[var(--inaya-text-primary)]">{directImpact.affectedPurchaseOrders.length}</span></p>
          )}
          {directImpact.affectedPurchaseRequests && (
            <p className="text-[var(--inaya-text-muted)]">Open purchase requests affected: <span className="text-[var(--inaya-text-primary)]">{directImpact.affectedPurchaseRequests.length}</span></p>
          )}
          {directImpact.projectMembershipsAffected && (
            <p className="text-[var(--inaya-text-muted)]">Project memberships affected: <span className="text-[var(--inaya-text-primary)]">{directImpact.projectMembershipsAffected.length}</span></p>
          )}
          {directImpact.tasksAffected && (
            <p className="text-[var(--inaya-text-muted)]">Tasks needing reassignment: <span className="text-[var(--inaya-text-primary)]">{directImpact.tasksAffected.length}</span></p>
          )}
          {directImpact.openTaskCount !== undefined && (
            <>
              <p className="text-[var(--inaya-text-muted)]">Open tasks in project: <span className="text-[var(--inaya-text-primary)]">{directImpact.openTaskCount}</span></p>
              <p className="text-[var(--inaya-text-muted)]">Tasks with a computed date shift: <span className="text-[var(--inaya-text-primary)]">{directImpact.tasksWithComputedShift?.length || 0}</span> (of {directImpact.tasksWithNoDueDate + (directImpact.tasksWithComputedShift?.length || 0)} open, {directImpact.tasksWithNoDueDate} have no due date)</p>
            </>
          )}
          {directImpact.affectedStockLevels && (
            <p className="text-[var(--inaya-text-muted)]">Affected stock records: <span className="text-[var(--inaya-text-primary)]">{directImpact.affectedStockLevels.length}</span></p>
          )}
        </div>
      </div>

      {directImpact.tasksWithComputedShift?.length > 0 && (
        <div>
          <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Dependency Impact — Tasks</p>
          <div className="space-y-1">
            {directImpact.tasksWithComputedShift.map((t) => (
              <p key={t.taskId} className="text-[12px] font-mono text-[var(--inaya-text-muted)]">
                {t.title}: <span className="text-[var(--inaya-text-primary)]">{new Date(t.currentDueDate).toLocaleDateString()}</span> → <span className="text-amber-400">{new Date(t.shiftedDueDate).toLocaleDateString()}</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {directImpact.tasksAffected?.length > 0 && (
        <div>
          <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Dependency Impact — Tasks</p>
          <div className="space-y-1">
            {directImpact.tasksAffected.map((t) => (
              <p key={t.taskId} className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{t.title} ({t.status}) — reassignment {t.expectedReassignment}</p>
            ))}
          </div>
        </div>
      )}

      {indirectImpact && (
        <div>
          <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Indirect Impact</p>
          <p className="text-[12px] text-[var(--inaya-text-muted)]">{indirectImpact.note}</p>
        </div>
      )}

      <div>
        <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">What's Unknown</p>
        <div className="space-y-1">
          {unknowns.map((u, i) => (
            <p key={i} className="text-[12px] text-[var(--inaya-text-muted)]">
              <span className="text-amber-400 uppercase font-bold">{u.area}:</span> {u.reason}
            </p>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Provenance</p>
        <p className="text-[11px] font-mono text-[var(--inaya-text-muted)]">Simulation {simulationId} · model v{modelVersion} · rules v{rulesVersion} · {new Date(runAt).toLocaleString()}</p>
        <p className="text-[11px] font-mono text-[var(--inaya-text-muted)] break-all">Integrity hash: {integrityHash}</p>
      </div>
    </div>
  );
}

export default function WhatIfStudioView({ orgId }) {
  const [scenarioType, setScenarioType] = useState("SUPPLIER_UNAVAILABLE");
  const [suppliers, setSuppliers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [projects, setProjects] = useState([]);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [entityId, setEntityId] = useState("");
  const [delayDays, setDelayDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api(`/api/orgs/digital-twin/simulate?orgId=${orgId}`)).history);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    setEntityId("");
    setResult(null);
    (async () => {
      try {
        if (scenarioType === "SUPPLIER_UNAVAILABLE") setSuppliers((await api(`/api/orgs/procurement/suppliers?orgId=${orgId}`)).suppliers || []);
        if (scenarioType === "WAREHOUSE_UNAVAILABLE") setWarehouses((await api(`/api/orgs/inventory/warehouses?orgId=${orgId}`)).warehouses || []);
        if (scenarioType === "PROJECT_DELAYED") setDepartments((await api(`/api/orgs/departments?orgId=${orgId}`)).departments || []);
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [scenarioType, orgId]);

  useEffect(() => {
    if (scenarioType !== "PROJECT_DELAYED" || !selectedDepartment) return;
    (async () => {
      try {
        setProjects((await api(`/api/orgs/projects?orgId=${orgId}&departmentId=${selectedDepartment}`)).projects || []);
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [selectedDepartment, scenarioType, orgId]);

  async function runSimulation() {
    if (!entityId) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const params = scenarioType === "PROJECT_DELAYED" ? { delayDays: Number(delayDays) } : {};
      const { simulation } = await api("/api/orgs/digital-twin/simulate", { method: "POST", body: JSON.stringify({ orgId, scenarioType, entityId, params }) });
      setResult(simulation);
      loadHistory();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">What-If Scenario Studio</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Model a business disruption using your organization's own real data before it happens. Every simulation is read-only — nothing here can ever change a real record.
        </p>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-4">
        <div>
          <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Scenario Builder</p>
          <div className="flex flex-wrap items-center gap-2">
            <select value={scenarioType} onChange={(e) => setScenarioType(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]">
              {Object.entries(SCENARIO_LABELS).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
            </select>

            {scenarioType === "SUPPLIER_UNAVAILABLE" && (
              <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]">
                <option value="">Choose a supplier…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            {scenarioType === "WAREHOUSE_UNAVAILABLE" && (
              <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]">
                <option value="">Choose a warehouse…</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            )}
            {scenarioType === "EMPLOYEE_ACCESS_REMOVED" && (
              <input type="email" placeholder="employee@example.com" value={entityId} onChange={(e) => setEntityId(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]" />
            )}
            {scenarioType === "PROJECT_DELAYED" && (
              <>
                <select value={selectedDepartment} onChange={(e) => { setSelectedDepartment(e.target.value); setEntityId(""); }} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]">
                  <option value="">Choose a department…</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <select value={entityId} onChange={(e) => setEntityId(e.target.value)} disabled={!selectedDepartment} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)] disabled:opacity-40">
                  <option value="">Choose a project…</option>
                  {projects.map((p) => <option key={p.id || p._id} value={p.id || p._id}>{p.name}</option>)}
                </select>
                <input type="number" min="1" value={delayDays} onChange={(e) => setDelayDays(e.target.value)} className="w-20 bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]" />
                <span className="text-[11px] text-[var(--inaya-text-muted)]">days delay</span>
              </>
            )}

            <button onClick={runSimulation} disabled={!entityId || busy} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
              {busy ? "…" : "Run Simulation"}
            </button>
          </div>
        </div>

        {result && <ResultPanel simulation={result} />}
      </div>

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-2">Scenario History</p>
        {!history ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : history.length === 0 ? (
          <EmptyState compact icon="🔮" description="No simulations run yet." />
        ) : (
          <div className="space-y-1.5">
            {history.map((h) => (
              <div key={h.simulationId} className="bg-black/20 border border-white/5 rounded-lg p-2.5 flex items-center justify-between gap-3">
                <p className="text-[12px] text-[var(--inaya-text-primary)]">{SCENARIO_LABELS[h.scenarioType] || h.scenarioType}</p>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border ${STATUS_STYLES[h.resultStatus] || ""}`}>{h.resultStatus}</span>
                  <span className="text-[11px] font-mono text-[var(--inaya-text-muted)]">{new Date(h.runAt).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
