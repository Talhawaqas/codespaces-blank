"use client";

// Public document verification (SOW §19/§20). No account needed: drop in a
// PDF (or type the document ID / SHA-256) and Inaya answers whether it is
// byte-identical to a finalized document -- revealing only the document's
// identity, status, approval and evidence state, never source records,
// amounts or customers.

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function Verify() {
  const params = useSearchParams();
  const [id, setId] = useState(params.get("id") || "");
  const [hash, setHash] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(file) {
    setBusy(true); setError(""); setResult(null);
    try {
      let res;
      if (file) res = await fetch(`/api/documents-automation/verify${id.trim() ? `?id=${encodeURIComponent(id.trim())}` : ""}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: await file.arrayBuffer() });
      else {
        const q = new URLSearchParams();
        if (id.trim()) q.set("id", id.trim());
        if (hash.trim()) q.set("hash", hash.trim());
        res = await fetch(`/api/documents-automation/verify?${q}`);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed.");
      setResult(data);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-12 text-[var(--inaya-text-primary,#fff)]">
      <h1 className="text-2xl font-extrabold">Verify a document</h1>
      <p className="mt-2 text-sm text-[var(--inaya-text-muted,#9aa)]">Check that a PDF is exactly the document Inaya finalized. Nothing about the customer, the amounts or the underlying records is ever shown.</p>
      <div className="mt-6 space-y-4 rounded-lg border border-white/10 bg-black/20 p-5">
        <label className="block text-xs font-semibold">Document ID <span className="font-normal text-[var(--inaya-text-muted,#9aa)]">(printed in the PDF footer, optional)</span>
          <input className="mt-1 w-full rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 text-sm" value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label className="block text-xs font-semibold">PDF file
          <input className="mt-1 block text-sm" type="file" accept="application/pdf" disabled={busy} onChange={(e) => e.target.files?.[0] && run(e.target.files[0])} />
        </label>
        <div className="text-center text-xs text-[var(--inaya-text-muted,#9aa)]">or</div>
        <label className="block text-xs font-semibold">SHA-256 of the file
          <input className="mt-1 w-full rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 font-mono text-xs" value={hash} onChange={(e) => setHash(e.target.value)} />
        </label>
        <button disabled={busy || (!id.trim() && !hash.trim())} onClick={() => run(null)} className="rounded-md border border-cyan-400/50 bg-cyan-400/10 px-4 py-1.5 text-xs font-semibold text-cyan-300 disabled:opacity-40">Look up</button>
        {error && <div role="alert" className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</div>}
        {result && (
          <div className="rounded-md border border-white/10 p-4 text-sm" role="status">
            {!result.found ? <div className="font-bold text-red-300">{result.message}</div> : (
              <>
                <div className={`font-bold ${result.hashMatches ? "text-emerald-300" : result.hashMatches === false ? "text-red-300" : "text-amber-300"}`}>{result.message}</div>
                <dl className="mt-3 grid grid-cols-[130px_1fr] gap-y-1 text-xs">
                  <dt className="text-[var(--inaya-text-muted,#9aa)]">Document</dt><dd>{result.documentType} {result.documentNumber} (version {result.documentVersion})</dd>
                  <dt className="text-[var(--inaya-text-muted,#9aa)]">Status</dt><dd>{result.status} {result.isCurrent ? "- current" : "- no longer current"}</dd>
                  <dt className="text-[var(--inaya-text-muted,#9aa)]">Finalized</dt><dd>{result.finalizedAt ? new Date(result.finalizedAt).toLocaleString() : "-"}</dd>
                  <dt className="text-[var(--inaya-text-muted,#9aa)]">Approval</dt><dd>{result.approvalStatus}</dd>
                  <dt className="text-[var(--inaya-text-muted,#9aa)]">Evidence</dt><dd>{result.evidenceStatus}</dd>
                  <dt className="text-[var(--inaya-text-muted,#9aa)]">Fingerprint</dt><dd className="break-all font-mono">{result.documentHash}</dd>
                </dl>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

export default function VerifyDocumentPage() {
  return <Suspense fallback={null}><Verify /></Suspense>;
}
