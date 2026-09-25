"use client";

// Verification surface (SOW §20) and operational health (SOW §35).

import { useState, useEffect } from "react";
import { api, BASE, Button, Field, inputClass, ErrorNote, Section, Pill, shortHash } from "./shared";

export function VerifyPanel() {
  const [id, setId] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function check(file) {
    setBusy(true); setError(""); setResult(null);
    try {
      const q = id.trim() ? `?id=${encodeURIComponent(id.trim())}` : "";
      const res = await fetch(`/api/documents-automation/verify${q}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: await file.arrayBuffer() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed.");
      setResult(data);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Section title="Check a PDF against Inaya's records">
        <p className="mb-3 text-xs text-[var(--inaya-text-muted)]">Drop in any PDF. If it is byte-for-byte identical to a finalized Inaya document, you will see its identity, status and approval state - never the customer, the amounts or the source records. Anyone can use the same check at <code>/verify-document</code>.</p>
        <Field label="Document ID (optional - printed in the PDF footer)"><input className={inputClass} value={id} onChange={(e) => setId(e.target.value)} /></Field>
        <div className="mt-3"><Field label="PDF file"><input type="file" accept="application/pdf" disabled={busy} onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} /></Field></div>
        <ErrorNote error={error} />
        {result && (
          <div className="mt-4 rounded-md border border-white/10 p-3 text-xs">
            {!result.found ? <div className="font-bold text-red-300">{result.message}</div> : (
              <>
                <div className={`text-sm font-bold ${result.hashMatches ? "text-emerald-300" : result.hashMatches === false ? "text-red-300" : "text-amber-300"}`}>{result.message}</div>
                <ul className="mt-2 space-y-0.5">
                  <li>{result.documentType} {result.documentNumber} (version {result.documentVersion})</li>
                  <li>Status: {result.status} {result.isCurrent ? "(current)" : "(no longer current)"}</li>
                  <li>Finalized: {result.finalizedAt || "-"}</li>
                  <li>Approval: {result.approvalStatus} - Evidence: {result.evidenceStatus}</li>
                  <li>Recorded fingerprint: <span className="font-mono">{shortHash(result.documentHash)}</span></li>
                </ul>
              </>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

export function HealthPanel({ orgId, canManage }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { if (canManage) api(`${BASE}/metrics?orgId=${orgId}`).then(setData).catch((e) => setError(e.message)); }, [orgId, canManage]);
  if (!canManage) return <p className="text-xs text-[var(--inaya-text-muted)]">Only an owner or admin can view document health.</p>;
  if (!data) return <div className="text-sm text-[var(--inaya-text-muted)]">{error || "Loading..."}</div>;
  const h = data.health;
  const m = data.metrics;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {[["Failed steps", h.failed, h.failed > 0], ["Evidence pending", h.evidencePending, h.evidencePending > 0], ["Awaiting approval", h.awaitingApproval, false], ["Stale approvals", h.staleApproval, h.staleApproval > 0]].map(([k, v, bad]) => (
          <div key={k} className="rounded-lg border border-white/10 bg-black/20 p-3"><div className="text-[11px] uppercase tracking-wide text-[var(--inaya-text-muted)]">{k}</div><div className={`text-2xl font-extrabold ${bad ? "text-red-300" : ""}`}>{v}</div></div>
        ))}
      </div>
      <Section title={`Last 7 days (since ${new Date(data.since).toLocaleDateString()})`}>
        <table className="w-full text-xs"><thead><tr className="text-left text-[var(--inaya-text-muted)]"><th>Measure</th><th>Count</th><th>Average</th><th>p95</th><th>Max</th></tr></thead><tbody>
          {Object.entries(m).map(([k, v]) => <tr key={k}><td className="py-0.5">{k.replaceAll("_", " ")}</td><td>{v.count}</td><td>{Math.round(v.avg)}</td><td>{Math.round(v.p95)}</td><td>{Math.round(v.max)}</td></tr>)}
        </tbody></table>
        {Object.keys(m).length === 0 && <p className="text-xs">No measurements yet.</p>}
        <p className="mt-2 text-[11px] text-[var(--inaya-text-muted)]">Durations are in milliseconds, sizes in bytes. Only numbers are recorded - never document content, keys or personal data.</p>
      </Section>
    </div>
  );
}
