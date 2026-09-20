"use client";

// src/components/business/BusinessEventsView.js
//
// Evidence Graph & Trusted Business Event Layer SOW — the Evidence view.
// Same self-contained-view pattern as AIActionRequestsView.js: a list,
// an expandable detail panel (timeline / Why? / Simulate / Passport),
// nothing here executes a real action — Simulate is explicitly read-only
// and Passport generation is a read-only export, matching what
// businessEventSimulate.js/businessEventPassport.js actually guarantee.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const RISK_STYLES = {
  LOW: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  MEDIUM: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  HIGH: "bg-red-400/10 text-red-400 border-red-400/30",
};

const STATUS_STYLES = {
  OPEN: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  DECIDED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  EXECUTED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  CLOSED: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
};

const SIMULATABLE_ACTIONS = {
  PURCHASE_ORDER: ["submit", "approve", "reject", "order", "cancel"],
  PURCHASE_REQUEST: ["submit", "approve", "reject", "cancel"],
  AI_ACTION_REQUEST: ["approve", "reject"],
  INVOICE: [],
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function EventDetail({ orgId, eventId, onClose }) {
  const [data, setData] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [error, setError] = useState("");
  const [simAction, setSimAction] = useState("");
  const [simResult, setSimResult] = useState(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [detail, why] = await Promise.all([
        api(`/api/orgs/business-events/${eventId}?orgId=${orgId}`),
        api(`/api/orgs/business-events/${eventId}/why?orgId=${orgId}`),
      ]);
      setData(detail);
      setExplanation(why.explanation);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, eventId]);

  useEffect(() => { load(); }, [load]);

  async function runSimulation() {
    if (!simAction) return;
    setBusy("simulate");
    setError("");
    setSimResult(null);
    try {
      const { simulation } = await api(`/api/orgs/business-events/${eventId}/simulate`, { method: "POST", body: JSON.stringify({ orgId, action: simAction }) });
      setSimResult(simulation);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function downloadPassport(format) {
    setBusy("passport" + format);
    setError("");
    try {
      const res = await fetch(`/api/orgs/business-events/${eventId}/passport?orgId=${orgId}&format=${format}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Could not generate the passport.");
      }
      const blob = await res.blob();
      downloadBlob(blob, `business-event-${eventId}-passport.${format === "pdf" ? "pdf" : "json"}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;
  const { event, timeline } = data;
  const availableActions = SIMULATABLE_ACTIONS[event.subjectType] || [];

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[var(--inaya-text-primary)] text-sm font-bold">{event.subjectSummary?.label || event.eventType}</p>
          <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{event.subjectType} · Created {new Date(event.createdAt).toLocaleString()}</p>
        </div>
        <button onClick={onClose} className="text-[11px] uppercase font-bold px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10">Close</button>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div>
        <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Timeline</p>
        <div className="space-y-1">
          {timeline.length === 0 ? (
            <p className="text-[var(--inaya-text-muted)] text-xs">No recorded activity yet.</p>
          ) : (
            timeline.map((t, i) => (
              <p key={i} className="text-[12px] font-mono text-[var(--inaya-text-muted)]">
                {new Date(t.timestamp).toLocaleString()} — <span className="text-[var(--inaya-text-primary)]">{t.action}</span> ({t.recordType}) by {t.actorEmail || "system"}
              </p>
            ))
          )}
        </div>
      </div>

      {explanation && (
        <div>
          <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Why?</p>
          <div className="space-y-1.5 text-xs">
            {explanation.sourceEvidence.map((e, i) => (
              <p key={i} className="text-[var(--inaya-text-muted)]">
                {e.relationship} → {e.targetType}{" "}
                <span className={e.state === "INCLUDED" ? "text-emerald-400" : e.state === "RESTRICTED" ? "text-amber-400" : "text-[var(--inaya-text-muted)]"}>[{e.state}]</span>
                {e.label ? `: ${e.label}` : ""}
              </p>
            ))}
            {explanation.aiFindings && (
              <p className="text-[var(--inaya-text-muted)]">AI recommendation: <span className="text-[var(--inaya-text-primary)]">{explanation.aiFindings.recommendation}</span> ({explanation.aiFindings.riskLevel} risk)</p>
            )}
            {explanation.rules.map((r, i) => (
              <p key={i} className="text-[var(--inaya-text-muted)]">Rule {r.ruleId}: <span className={r.result === "TRIGGERED" ? "text-amber-400" : "text-[var(--inaya-text-muted)]"}>{r.result}</span> — {r.reason}</p>
            ))}
            <p className="text-[var(--inaya-text-muted)]">Audit chain intact: <span className={explanation.proof.auditChainIntact ? "text-emerald-400" : "text-red-400"}>{explanation.proof.auditChainIntact === null ? "unknown" : explanation.proof.auditChainIntact ? "yes" : "no"}</span></p>
          </div>
        </div>
      )}

      {availableActions.length > 0 && (
        <div>
          <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">What If? (simulation only — nothing is executed)</p>
          <div className="flex items-center gap-2">
            <select value={simAction} onChange={(e) => setSimAction(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]">
              <option value="">Choose an action…</option>
              {availableActions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <button onClick={runSimulation} disabled={!simAction || !!busy} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
              {busy === "simulate" ? "…" : "Simulate"}
            </button>
          </div>
          {simResult && (
            <div className="mt-2 bg-black/30 border border-white/10 rounded-md p-2.5 text-[12px] font-mono space-y-1">
              <p className="text-amber-400 font-bold">SIMULATION ONLY — NO CHANGES WERE MADE</p>
              <p className="text-[var(--inaya-text-muted)]">Legal: <span className={simResult.legal ? "text-emerald-400" : "text-red-400"}>{String(simResult.legal)}</span> {simResult.reason && `— ${simResult.reason}`}</p>
              {simResult.legal && (
                <>
                  <p className="text-[var(--inaya-text-muted)]">{simResult.currentState} → {simResult.targetState}</p>
                  <p className="text-[var(--inaya-text-muted)]">Authorized: <span className={simResult.authorized ? "text-emerald-400" : "text-red-400"}>{String(simResult.authorized)}</span></p>
                  {simResult.expectedUnlockAt && <p className="text-[var(--inaya-text-muted)]">Expected unlock: {new Date(simResult.expectedUnlockAt).toLocaleString()} ({simResult.settlementDelayHours}h delay)</p>}
                </>
              )}
              {simResult.unmodeledEffects?.length > 0 && (
                <p className="text-[var(--inaya-text-muted)]">Unmodeled: {simResult.unmodeledEffects.map((u) => u.type).join(", ")} (referenced, not recalculated)</p>
              )}
            </div>
          )}
        </div>
      )}

      <div>
        <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-1">Business Event Passport</p>
        <div className="flex gap-1.5">
          <button onClick={() => downloadPassport("json")} disabled={!!busy} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
            {busy === "passportjson" ? "…" : "Download JSON"}
          </button>
          <button onClick={() => downloadPassport("pdf")} disabled={!!busy} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40">
            {busy === "passportpdf" ? "…" : "Download PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BusinessEventsView({ orgId }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    try {
      setEvents((await api(`/api/orgs/business-events?orgId=${orgId}`)).events);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Evidence</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Business Events connect an invoice, purchase order, or AI decision to everything Inaya checked about it — who approved it, what rules applied, and the cryptographic proof behind it. Simulation here is always read-only; nothing executes a real change.
        </p>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!events ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : events.length === 0 ? (
          <EmptyState compact icon="🔗" description="No business events yet." />
        ) : (
          <div className="space-y-2">
            {events.map((e) => (
              <div key={e.id}>
                <div
                  className="bg-black/20 border border-white/5 rounded-lg p-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-black/30"
                  onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                >
                  <div className="min-w-0">
                    <p className="text-[var(--inaya-text-primary)] text-sm truncate">{e.subjectSummary?.label || e.eventType}</p>
                    <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{e.subjectType} · Created {new Date(e.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${RISK_STYLES[e.riskLevel] || ""}`}>{e.riskLevel}</span>
                    <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLES[e.status] || ""}`}>{e.status}</span>
                  </div>
                </div>
                {expandedId === e.id && (
                  <div className="mt-2">
                    <EventDetail orgId={orgId} eventId={e.id} onClose={() => setExpandedId(null)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
