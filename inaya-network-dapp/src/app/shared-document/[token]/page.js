"use client";

// Recipient page for a secure document link (SOW §19). Shows only what a
// recipient is authorized to see -- the document's identity, when it was
// finalized, when the link expires -- then lets them view or download the
// exact approved PDF and verify its fingerprint. Expired, revoked,
// superseded and voided documents explain themselves and serve nothing.

import { useEffect, useState } from "react";

export default function SharedDocumentPage({ params }) {
  const { token } = params;
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(null);

  useEffect(() => {
    fetch(`/api/documents-automation/deliver/${encodeURIComponent(token)}?meta=1`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "This link is not available."); setMeta(d.document); })
      .catch((e) => setError(e.message));
  }, [token]);

  async function verifyDownloaded() {
    try {
      const res = await fetch(`/api/documents-automation/verify?hash=${meta.documentHash}&id=`);
      setVerified(await res.json());
    } catch { setVerified({ found: false, message: "Could not verify right now." }); }
  }

  const url = `/api/documents-automation/deliver/${encodeURIComponent(token)}`;
  return (
    <main className="mx-auto max-w-xl px-5 py-12 text-[var(--inaya-text-primary,#fff)]">
      <h1 className="text-2xl font-extrabold">Secure document</h1>
      {error && <div role="alert" className="mt-6 rounded-lg border border-red-400/30 bg-red-400/10 p-5 text-sm text-red-200">{error}</div>}
      {meta && (
        <div className="mt-6 space-y-4 rounded-lg border border-white/10 bg-black/20 p-5">
          <div>
            <div className="text-lg font-bold">{meta.documentType} {meta.documentNumber}</div>
            <div className="text-xs text-[var(--inaya-text-muted,#9aa)]">{meta.issuer ? `From ${meta.issuer} - ` : ""}version {meta.documentVersion}{meta.finalizedAt ? ` - finalized ${new Date(meta.finalizedAt).toLocaleString()}` : ""}</div>
          </div>
          <div className="flex flex-wrap gap-3">
            <a href={url} target="_blank" rel="noreferrer" className="rounded-md border border-cyan-400/50 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-300">View document</a>
            <a href={`${url}?download=1`} className="rounded-md border border-white/20 px-4 py-2 text-sm font-semibold">Download PDF</a>
            <button onClick={verifyDownloaded} className="rounded-md border border-white/20 px-4 py-2 text-sm font-semibold">Verify authenticity</button>
          </div>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
            <dt className="text-[var(--inaya-text-muted,#9aa)]">Pages</dt><dd>{meta.pages || "-"}</dd>
            <dt className="text-[var(--inaya-text-muted,#9aa)]">Link expires</dt><dd>{new Date(meta.expiresAt).toLocaleString()}</dd>
            <dt className="text-[var(--inaya-text-muted,#9aa)]">Fingerprint</dt><dd className="break-all font-mono">{meta.documentHash}</dd>
          </dl>
          {verified && <div role="status" className={`rounded-md border p-3 text-xs ${verified.found && verified.isCurrent ? "border-emerald-400/30 text-emerald-300" : "border-amber-400/30 text-amber-300"}`}>{verified.found ? `Inaya has this exact fingerprint on record: ${verified.documentType} ${verified.documentNumber}, status ${verified.status}, approval ${verified.approvalStatus}, evidence ${verified.evidenceStatus}.` : verified.message}</div>}
          <p className="text-[11px] text-[var(--inaya-text-muted,#9aa)]">This link opens only this document, is time-limited, and can be revoked by the sender. To check a copy you saved, use <a className="underline" href="/verify-document">verify a document</a>.</p>
        </div>
      )}
    </main>
  );
}
