"use client";

// src/components/business/DocIntelligenceView.js
//
// Business Workspace > Document Intelligence: submit a document to an analyzer (built-in or custom), see
// results and their confidence/grounding, and resolve the human review queue. Owner/admin also manage the
// analyzer registry (create, promote through the lifecycle). RDS/SageMaker/Document Intelligence Gap
// Expansion SOW, Workstream C.

import { useEffect, useState, useCallback } from "react";
import { Note } from "./nas/ui";

const field = "w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm";
const label = "mb-1 block text-xs font-medium text-[var(--inaya-text-muted)]";
const btn = "rounded border border-[var(--inaya-accent)] px-3 py-1.5 text-xs font-medium text-[var(--inaya-accent)] disabled:opacity-50";
const STATUS_TONE = { PROCESSED: "text-emerald-400", NEEDS_REVIEW: "text-amber-400", REJECTED: "text-red-400" };
const j = (r) => r.json().then((body) => ({ ok: r.ok, body }));

export default function DocIntelligenceView({ orgId, canManage }) {
  const [analyzers, setAnalyzers] = useState([]);
  const [results, setResults] = useState([]);
  const [reviewQueue, setReviewQueue] = useState([]);
  const [selectedAnalyzer, setSelectedAnalyzer] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const [a, r] = await Promise.all([
      fetch(`/api/orgs/doc-intelligence/analyzers?orgId=${orgId}`).then((x) => x.json()).catch(() => ({ analyzers: [] })),
      fetch(`/api/orgs/doc-intelligence/results?orgId=${orgId}`).then((x) => x.json()).catch(() => ({ results: [] })),
    ]);
    setAnalyzers(a.analyzers || []); setResults(r.results || []);
    if (canManage) { const q = await fetch(`/api/orgs/doc-intelligence/review?orgId=${orgId}`).then((x) => x.json()).catch(() => ({ items: [] })); setReviewQueue(q.items || []); }
    if (!selectedAnalyzer && a.analyzers?.length) setSelectedAnalyzer(a.analyzers.find((x) => x.status === "ACTIVE")?.analyzerId || a.analyzers[0].analyzerId);
  }, [orgId, canManage, selectedAnalyzer]);

  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault(); if (!file || !selectedAnalyzer) return;
    setBusy(true); setError(""); setNotice("");
    const fd = new FormData(); fd.append("file", file);
    const { ok, body } = await j(await fetch(`/api/orgs/doc-intelligence/analyze?orgId=${orgId}&analyzerId=${selectedAnalyzer}`, { method: "POST", body: fd }).catch((err) => ({ json: () => Promise.resolve({ error: err.message }) })));
    if (!ok) setError(body.error || "Could not analyze this document.");
    else { setNotice(body.duplicate ? "This exact document was already analyzed by this analyzer." : `Analyzed: ${body.result.status === "PROCESSED" ? "processed" : "sent for human review"}.`); setFile(null); load(); }
    setBusy(false);
  }

  async function act(itemId, action, extra = {}) {
    setBusy(true);
    const { ok, body } = await j(await fetch(`/api/orgs/doc-intelligence/review/${itemId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, action, ...extra }) }));
    if (!ok) setError(body.error || "Could not resolve this item.");
    setBusy(false); load();
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Document Intelligence</h2>
        <p className="text-sm text-[var(--inaya-text-muted)]">Extract, classify or summarize a document with an analyzer. Every result shows its confidence and whether a value was found in the document itself (grounded) or only inferred.</p>
      </header>

      <form onSubmit={submit} className="max-w-xl space-y-3 rounded border border-white/10 p-4">
        <div>
          <label htmlFor="di-analyzer" className={label}>Analyzer</label>
          <select id="di-analyzer" className={field} value={selectedAnalyzer} onChange={(e) => setSelectedAnalyzer(e.target.value)}>
            {analyzers.map((a) => <option key={a.analyzerId} value={a.analyzerId} disabled={!["ACTIVE", "READY", "TESTING", "DRAFT"].includes(a.status)}>{a.name} ({a.method}, {a.status}{a.builtin ? ", built-in" : ""})</option>)}
          </select>
        </div>
        <div><label htmlFor="di-file" className={label}>Document</label><input id="di-file" type="file" className={field} onChange={(e) => setFile(e.target.files?.[0] || null)} accept=".pdf,.png,.jpg,.jpeg,.txt,.csv" /></div>
        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
        {notice && <p className="text-sm text-emerald-400" role="status">{notice}</p>}
        <button type="submit" disabled={busy || !file || !selectedAnalyzer} className={btn}>{busy ? "Analyzing..." : "Analyze"}</button>
      </form>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Recent results</h3>
        {!results.length && <Note>No documents analyzed yet.</Note>}
        <div className="space-y-2">
          {results.map((r) => (
            <div key={r.resultId} className="rounded border border-white/10 p-3 text-sm">
              <div className="flex items-center justify-between"><span className="font-medium">{r.filename}</span><span className={STATUS_TONE[r.status] || ""}>{r.status}{r.testMode ? " (test mode)" : ""}</span></div>
              <div className="mt-1 text-xs text-[var(--inaya-text-muted)]">{r.analyzerKey} &middot; {r.method} &middot; confidence {r.extractionConfidence != null ? `${Math.round(r.extractionConfidence * 100)}%` : "n/a"}</div>
              {r.fields && <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">{Object.entries(r.fields).map(([k, v]) => <div key={k}><span className="text-[var(--inaya-text-muted)]">{k}: </span><span>{String(v.value)}</span>{v.grounded === false && <span className="ml-1 text-amber-400" title="Not found verbatim in the document text">*ungrounded</span>}</div>)}</div>}
              {r.classification && <div className="mt-2 text-xs">Classified as <span className="font-medium">{r.classification.label}</span> ({Math.round(r.classification.confidence * 100)}%)</div>}
              {r.generated && <p className="mt-2 text-xs italic">{r.generated.text}</p>}
              {!!r.missing?.length && <div className="mt-1 text-xs text-amber-400">Missing: {r.missing.join(", ")}</div>}
            </div>
          ))}
        </div>
      </section>

      {canManage && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Human review queue</h3>
          {!reviewQueue.length && <Note>Nothing waiting for review.</Note>}
          <div className="space-y-2">
            {reviewQueue.map((i) => (
              <div key={i.itemId} className="rounded border border-white/10 p-3 text-sm">
                <div className="flex items-center justify-between"><span>{i.reason}</span><span className="text-xs uppercase text-[var(--inaya-text-muted)]">{i.severity}</span></div>
                <div className="mt-2 flex gap-2">
                  <button type="button" className={btn} disabled={busy} onClick={() => act(i.itemId, "approve")}>Approve</button>
                  <button type="button" className={btn} disabled={busy} onClick={() => { const reason = window.prompt("Reason for rejecting?"); if (reason) act(i.itemId, "reject", { reason }); }}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
