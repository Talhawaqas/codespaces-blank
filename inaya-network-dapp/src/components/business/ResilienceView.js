"use client";

// src/components/business/ResilienceView.js
//
// Autonomous Resilience Layer SOW, Phase 7 — the org-scoped dashboard:
// current resilience state per policy (VERIFIED/DEGRADED/FAILED/UNKNOWN/
// TEST_DUE, always computed, never asserted -- see resilience-status.js),
// last test summary, RTO/RPO compliance, asset coverage, and test
// history. Same self-contained-view pattern as AuditTrailView.js.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATE_STYLES = {
  VERIFIED: "bg-emerald-400/10 border-emerald-400/30 text-emerald-400",
  DEGRADED: "bg-amber-400/10 border-amber-400/30 text-amber-400",
  FAILED: "bg-red-400/10 border-red-400/30 text-red-400",
  TEST_DUE: "bg-amber-400/10 border-amber-400/30 text-amber-400",
  UNKNOWN: "bg-white/5 border-white/10 text-[var(--inaya-text-muted)]",
};

const STATE_LABELS = { VERIFIED: "Verified", DEGRADED: "Degraded", FAILED: "Failed", TEST_DUE: "Test due", UNKNOWN: "Unknown" };

function fmtMinutes(m) {
  return m == null ? "—" : `${m.toFixed(1)}m`;
}

export default function ResilienceView({ orgId }) {
  const [policies, setPolicies] = useState(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/resilience/status?orgId=${orgId}`);
      setPolicies(data.policies);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function runNow(policyId) {
    setRunning(policyId);
    setError("");
    try {
      await api(`/api/orgs/resilience/policies/${policyId}/run`, { method: "POST", body: JSON.stringify({ orgId }) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Resilience</h3>
          <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5 max-w-xl">
            Continuously-tested recovery capability, not just backup existence. Each policy's state below is
            computed from its own latest real recovery test — never asserted.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="text-[11px] font-bold uppercase px-3 py-2 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black shrink-0">
          + New policy
        </button>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}
      {showCreate && <CreatePolicyModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}

      {!policies ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : policies.length === 0 ? (
        <EmptyState compact icon="🛡️" description="No resilience policies yet — define recovery requirements to start testing." />
      ) : (
        <div className="space-y-3">
          {policies.map((p) => (
            <div key={p.policyId} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
              <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                <div>
                  <p className="text-[var(--inaya-text-primary)] font-bold text-sm">{p.name}</p>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">
                    Required RTO {p.requiredRTOMinutes}m · Required RPO {p.requiredRPOMinutes}m · {p.testFrequency} · {p.status}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold uppercase px-2.5 py-1 rounded-md border ${STATE_STYLES[p.resilienceState]}`}>{STATE_LABELS[p.resilienceState]}</span>
                  <button
                    onClick={() => runNow(p.policyId)}
                    disabled={running === p.policyId || p.status !== "ACTIVE"}
                    className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40"
                  >
                    {running === p.policyId ? "Running…" : "Run now"}
                  </button>
                </div>
              </div>

              {p.latestTestRun ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center border-t border-white/5 pt-3">
                  <div>
                    <p className="text-[var(--inaya-text-primary)] font-mono text-sm font-bold">{fmtMinutes(p.latestTestRun.actualRTOMinutes)}</p>
                    <p className="text-[10px] text-[var(--inaya-text-muted)] uppercase">Actual RTO</p>
                  </div>
                  <div>
                    <p className="text-[var(--inaya-text-primary)] font-mono text-sm font-bold">{fmtMinutes(p.latestTestRun.actualRPOMinutes)}</p>
                    <p className="text-[10px] text-[var(--inaya-text-muted)] uppercase">Actual RPO</p>
                  </div>
                  <div>
                    <p className="text-[var(--inaya-text-primary)] font-mono text-sm font-bold">
                      {p.latestTestRun.assetResults.filter((a) => a.recovered && a.integrityPass && a.permissionPass && a.dependencyOk).length} / {p.latestTestRun.assetResults.length}
                    </p>
                    <p className="text-[10px] text-[var(--inaya-text-muted)] uppercase">Assets recovered</p>
                  </div>
                  <div>
                    <p className="text-[var(--inaya-text-primary)] font-mono text-sm font-bold">{new Date(p.latestTestRun.completedAt).toLocaleDateString()}</p>
                    <p className="text-[10px] text-[var(--inaya-text-muted)] uppercase">Last tested</p>
                  </div>
                </div>
              ) : (
                <p className="text-[var(--inaya-text-muted)] text-xs border-t border-white/5 pt-3">No test has run yet.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreatePolicyModal({ orgId, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [rto, setRto] = useState("30");
  const [rpo, setRpo] = useState("15");
  const [categories, setCategories] = useState("Finance:CRITICAL, HR:HIGH");
  const [frequency, setFrequency] = useState("daily");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    const criticalAssetCategories = categories.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [label, priority] = s.split(":").map((p) => p.trim());
      return { label, priority: priority || "STANDARD" };
    });
    if (!name.trim() || criticalAssetCategories.length === 0) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/resilience/policies", {
        method: "POST",
        body: JSON.stringify({ orgId, name: name.trim(), requiredRTOMinutes: Number(rto), requiredRPOMinutes: Number(rpo), criticalAssetCategories, testFrequency: frequency }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit} className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full max-w-md space-y-3">
        <h4 className="text-[var(--inaya-text-primary)] font-bold text-sm">New resilience policy</h4>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Policy name (e.g. Core Financial Systems)" className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <div className="flex gap-2">
          <input type="number" value={rto} onChange={(e) => setRto(e.target.value)} placeholder="Required RTO (minutes)" className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
          <input type="number" value={rpo} onChange={(e) => setRpo(e.target.value)} placeholder="Required RPO (minutes)" className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        </div>
        <input value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="Categories, e.g. Finance:CRITICAL, HR:HIGH" className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className="text-xs px-3 py-2 rounded-lg bg-white/5 text-[var(--inaya-text-muted)]">Cancel</button>
          <button type="submit" disabled={submitting} className="text-xs font-bold px-3 py-2 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {submitting ? "Creating…" : "Create policy"}
          </button>
        </div>
      </form>
    </div>
  );
}
