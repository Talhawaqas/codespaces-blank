"use client";

// src/components/business/AIActionRequestsView.js
//
// Guarded Execution (Phase 4) — the human side of propose_task_status_
// change/propose_expense_decision: pending requests, Approve/Reject
// (gated server-side by review/route.js's resolveCanApprove — the SAME
// gate the real transitionX() would itself require, buttons shown to
// everyone same "UX clarity only" convention every other workflow view
// here uses), a live countdown once approved, and Cancel while still
// before unlockAt. Same self-contained-view pattern as every other
// Business Workspace view.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import ConfirmButton from "./ConfirmButton";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLES = {
  PENDING_APPROVAL: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  APPROVED: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  QUEUED: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  EXECUTED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  EXPIRED: "bg-white/5 text-[#94a3b8] border-white/10",
  CANCELLED: "bg-white/5 text-[#94a3b8] border-white/10",
};

function formatCountdown(unlockAt) {
  const ms = new Date(unlockAt).getTime() - Date.now();
  if (ms <= 0) return "Unlocking…";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `Unlocks in ${hours}h ${minutes}m`;
}

export default function AIActionRequestsView({ orgId }) {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setRequests((await api(`/api/orgs/ai-actions?orgId=${orgId}`)).requests);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  // Re-render every 60s so APPROVED countdowns stay live without a full
  // refetch — the actual unlockAt only ever changes server-side.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  async function handleReview(id, decision) {
    setActing(id + decision);
    setError("");
    try {
      await api(`/api/orgs/ai-actions/${id}/review`, { method: "POST", body: JSON.stringify({ orgId, decision }) });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  async function handleCancel(id) {
    setActing(id + "cancel");
    setError("");
    try {
      await api(`/api/orgs/ai-actions/${id}/cancel`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-white font-bold text-sm">AI Action Requests</h3>
        <p className="text-[#94a3b8] text-xs mt-0.5">
          Actions the AI Business Assistant proposed on someone's behalf. Nothing here executes automatically — an approver with the same authority the real action would require must approve it, and even then it only runs 36 hours later.
        </p>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        {!requests ? (
          <p className="text-[#94a3b8] font-mono text-sm">Loading…</p>
        ) : requests.length === 0 ? (
          <EmptyState compact icon="🤖" description="No AI-proposed actions yet." />
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-white text-sm truncate">{r.requestedContextSummary || `${r.proposedAction} · ${r.targetRecordType}`}</p>
                    <p className="text-[#94a3b8] text-[12px] font-mono mt-0.5">
                      Requested by {r.requestedByEmail || "assistant"} · {new Date(r.requestedAt).toLocaleString()}
                    </p>
                  </div>
                  <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLES[r.status] || ""}`}>{r.status.replace(/_/g, " ")}</span>
                </div>

                {r.status === "PENDING_APPROVAL" && (
                  <div className="flex gap-1.5">
                    <button onClick={() => handleReview(r.id, "approve")} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-emerald-400/10 text-emerald-400 border border-emerald-400/30 disabled:opacity-40">
                      {acting === r.id + "approve" ? "…" : "Approve"}
                    </button>
                    <ConfirmButton onConfirm={() => handleReview(r.id, "reject")} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-red-400/10 text-red-400 border border-red-400/30 disabled:opacity-40">
                      {acting === r.id + "reject" ? "…" : "Reject"}
                    </ConfirmButton>
                  </div>
                )}

                {r.status === "APPROVED" && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-[#00f2fe]">{formatCountdown(r.unlockAt)}</span>
                    <ConfirmButton onConfirm={() => handleCancel(r.id)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 disabled:opacity-40">
                      {acting === r.id + "cancel" ? "…" : "Cancel"}
                    </ConfirmButton>
                  </div>
                )}

                {r.status === "REJECTED" && r.reviewNote && (
                  <p className="text-[#8a96ab] text-[11px] italic">"{r.reviewNote}"</p>
                )}
                {r.status === "EXPIRED" && r.executionResult?.error && (
                  <p className="text-[#8a96ab] text-[11px] italic">{r.executionResult.error}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
