"use client";

// src/components/operator/OperatorEvents.js
//
// SOW §12-13 combined: operator alerts and event history are the same
// underlying node_events feed (severity "warning" reads as an alert,
// "info" as a routine history entry) -- written only server-side by the
// hourly snapshot cron / nodeUptimeHistory.js, never by the client.

import { useState, useEffect } from "react";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const SEVERITY_STYLE = {
  warning: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  info: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
};

const TYPE_LABELS = {
  TELEMETRY_STARTED: "Telemetry started",
  NODE_OFFLINE: "Node offline",
  NODE_RECOVERED: "Node recovered",
  VERSION_CHANGED: "Version changed",
  QUALIFICATION_ACHIEVED: "Qualification achieved",
  QUALIFICATION_RESET: "Qualification reset",
};

export default function OperatorEvents() {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/nodes/operator/events?limit=100").then((d) => setEvents(d.events)).catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!events) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  const alerts = events.filter((e) => e.severity === "warning");

  return (
    <div className="space-y-4">
      {alerts.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Active Signals</p>
          {alerts.slice(0, 5).map((e, i) => (
            <div key={i} className={`rounded-xl border px-4 py-2.5 text-xs font-semibold ${SEVERITY_STYLE.warning}`}>
              <div className="flex items-center justify-between gap-3">
                <span>{e.message}</span>
                <span className="text-[10px] uppercase opacity-70 shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-5">
        <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-3">Event History</p>
        {events.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-sm italic">No events recorded yet — this fills in as telemetry accumulates.</p>
        ) : (
          <div className="space-y-2.5">
            {events.map((e, i) => (
              <div key={i} className="flex items-start justify-between gap-3 border-b border-[var(--inaya-border)] pb-2.5 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border mr-2 ${SEVERITY_STYLE[e.severity] || SEVERITY_STYLE.info}`}>{TYPE_LABELS[e.type] || e.type}</span>
                  <span className="text-[var(--inaya-text-primary)] text-xs">{e.message}</span>
                </div>
                <span className="text-[var(--inaya-text-muted)] text-[11px] font-mono shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
