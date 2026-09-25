"use client";

// src/components/business/AiSecurityView.js
//
// AI Security Workflow 2026 SOW, Phase 22/23 (§27, §28). The Overview/
// Activity/Model-inventory/"Why?" panels this pass builds for real --
// Risk trending and full incident-response tooling are the documented
// next-pass polish (see AI_SECURITY_IMPLEMENTATION_REPORT.md). Same
// self-contained-view pattern as every other business/*View.js this
// session: a local api() fetch wrapper, real calls against real API
// routes, no client-side simulation of a decision.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const DECISION_STYLES = {
  ALLOW: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  WARN: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  REDACT: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  BLOCK: "bg-red-400/10 text-red-400 border-red-400/30",
  REQUIRE_APPROVAL: "bg-blue-400/10 text-blue-400 border-blue-400/30",
};

const MODEL_STATUS_STYLES = {
  APPROVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REVIEW: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  BLOCKED: "bg-red-400/10 text-red-400 border-red-400/30",
};

function ExplainModal({ orgId, eventId, onClose }) {
  const [explain, setExplain] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/ai-security/explain/${eventId}?orgId=${orgId}`).then(setExplain).catch((err) => setError(err.message));
  }, [orgId, eventId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="max-w-lg w-full rounded-lg border border-white/10 bg-[var(--inaya-bg,#0a0a0a)] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">Why was this {explain?.decision || "…"}?</div>
          <button onClick={onClose} className="text-xs text-[var(--inaya-text-muted)]">Close</button>
        </div>
        {error && <div className="text-sm text-red-400">{error}</div>}
        {explain && (
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-[var(--inaya-text-muted)] mb-1">Why</div>
              <ul className="list-disc pl-4 space-y-1">
                {explain.why.map((reason, i) => <li key={i}>{reason}</li>)}
              </ul>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-[var(--inaya-text-muted)] mb-1">Evidence</div>
              <div className="text-xs text-[var(--inaya-text-muted)] space-y-0.5">
                <div>Request ID: {explain.evidence.requestId}</div>
                <div>Controls triggered: {explain.evidence.controlsTriggered.join(", ") || "none"}</div>
                <div>Policy version: {explain.evidence.policyVersion}</div>
                <div>Model: {explain.evidence.modelId || "n/a"}</div>
                <div>Surface: {explain.evidence.surface}</div>
                <div>Time: {new Date(explain.evidence.timestamp).toLocaleString()}</div>
              </div>
            </div>
            <p className="text-xs text-[var(--inaya-text-muted)] italic">
              This shows real provenance -- not the model&apos;s internal reasoning.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function EventsTab({ orgId }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [explainId, setExplainId] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ orgId, limit: "100" });
      if (filter) params.set("decision", filter);
      const result = await api(`/api/orgs/ai-security/events?${params}`);
      setEvents(result.events);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, filter]);

  useEffect(() => { load(); }, [load]);

  if (events === null) return <div className="text-sm text-[var(--inaya-text-muted)]">Loading…</div>;

  const counts = events.reduce((acc, e) => { acc[e.decision] = (acc[e.decision] || 0) + 1; return acc; }, {});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {["", "ALLOW", "WARN", "REDACT", "BLOCK", "REQUIRE_APPROVAL"].map((d) => (
          <button
            key={d || "all"}
            onClick={() => setFilter(d)}
            className={`rounded-full border px-3 py-1 text-xs ${filter === d ? "border-white/40" : "border-white/10"} ${d ? DECISION_STYLES[d] : ""}`}
          >
            {d || "All"} {d && counts[d] ? `(${counts[d]})` : ""}
          </button>
        ))}
      </div>
      {error && <div className="text-sm text-red-400">{error}</div>}
      {events.length === 0 ? (
        <EmptyState title="No AI security events yet" description="Events appear here as AI requests are evaluated by the security gateway." />
      ) : (
        <div className="space-y-2">
          {events.map((e) => (
            <div key={e._id} className="rounded border border-white/10 p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${DECISION_STYLES[e.decision] || ""}`}>{e.decision}</span>
                  <span className="text-xs text-[var(--inaya-text-muted)]">{e.category}</span>
                  <span className="text-xs text-[var(--inaya-text-muted)]">{e.surface}</span>
                </div>
                <div className="text-sm mt-1 truncate">{e.reasons?.[0] || "—"}</div>
                <div className="text-xs text-[var(--inaya-text-muted)]">{new Date(e.createdAt).toLocaleString()} · {e.actorEmail || "system"}</div>
              </div>
              <button onClick={() => setExplainId(e._id)} className="shrink-0 rounded border border-white/10 px-2 py-1 text-xs">Why?</button>
            </div>
          ))}
        </div>
      )}
      {explainId && <ExplainModal orgId={orgId} eventId={explainId} onClose={() => setExplainId(null)} />}
    </div>
  );
}

function ModelsTab({ orgId }) {
  const [models, setModels] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/ai-security/models?orgId=${orgId}`).then((r) => setModels(r.models)).catch((err) => setError(err.message));
  }, [orgId]);

  if (models === null) return <div className="text-sm text-[var(--inaya-text-muted)]">Loading…</div>;

  return (
    <div className="space-y-2">
      {error && <div className="text-sm text-red-400">{error}</div>}
      {models.map((m) => (
        <div key={m.id} className="rounded border border-white/10 p-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">{m.id}</div>
            <span className={`rounded-full border px-2 py-0.5 text-xs ${MODEL_STATUS_STYLES[m.status] || ""}`}>{m.status}</span>
          </div>
          <div className="text-xs text-[var(--inaya-text-muted)] mt-1">Risk: {m.riskLevel} · Verticals: {m.allowedVerticals?.join(", ")}</div>
          {m.note && <div className="text-xs text-[var(--inaya-text-muted)] mt-1 italic">{m.note}</div>}
        </div>
      ))}
    </div>
  );
}

function PolicyTab({ orgId }) {
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api(`/api/orgs/ai-security/policy?orgId=${orgId}`);
      setPolicy(result.policy);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function toggle(field) {
    if (!policy) return;
    setBusy(true);
    setError("");
    try {
      // The API itself enforces manager-only writes (canManageAiSecurity)
      // -- a non-manager gets a clear 403 here rather than the UI
      // silently disabling the control based on a guessed client-side role.
      await api("/api/orgs/ai-security/policy", { method: "PUT", body: JSON.stringify({ orgId, policy: { [field]: !policy[field] } }) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (policy === null) return <div className="text-sm text-[var(--inaya-text-muted)]">Loading…</div>;

  return (
    <div className="space-y-3">
      {error && <div className="text-sm text-red-400">{error}</div>}
      <div className="text-xs text-[var(--inaya-text-muted)]">Version {policy.version} {policy.version === 0 ? "(default, not yet customized)" : ""}</div>
      {[
        ["allowExternalModels", "Allow external (non-approved) models"],
        ["allowSensitiveData", "Allow high-sensitivity data (SSN/card-shaped values) in AI requests"],
        ["requireHumanApprovalForHighRisk", "Require human approval for high-risk AI actions"],
      ].map(([field, label]) => (
        <div key={field} className="flex items-center justify-between rounded border border-white/10 p-3">
          <div className="text-sm">{label}</div>
          <button
            disabled={busy}
            onClick={() => toggle(field)}
            className={`rounded-full border px-3 py-1 text-xs disabled:opacity-50 ${policy[field] ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "border-white/10"}`}
          >
            {policy[field] ? "ON" : "OFF"}
          </button>
        </div>
      ))}
      <p className="text-xs text-[var(--inaya-text-muted)]">Only an org owner or admin can change these settings.</p>
    </div>
  );
}

export default function AiSecurityView({ orgId }) {
  const [tab, setTab] = useState("events");

  return (
    <div className="space-y-4">
      <div className="flex gap-2 border-b border-white/10">
        {[["events", "Activity"], ["models", "Model Inventory"], ["policy", "Policy"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === key ? "border-[var(--inaya-accent)] text-[var(--inaya-text)]" : "border-transparent text-[var(--inaya-text-muted)]"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "events" && <EventsTab orgId={orgId} />}
      {tab === "models" && <ModelsTab orgId={orgId} />}
      {tab === "policy" && <PolicyTab orgId={orgId} />}
    </div>
  );
}
