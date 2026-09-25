"use client";

// Identity-verified recipient page (SOW §16/§17/§19) built on the existing
// external Data Room: opening the emailed link proves control of the
// recipient's email address (the room's magic-link exchange sets a session
// cookie), then lists ONLY the generated documents delivered to them, with
// confidentiality terms if the sender required them. The session expires,
// and the sender can revoke it at any time.

import { useEffect, useState } from "react";

export default function DocumentRoomPage({ params }) {
  const { token } = params;
  const [state, setState] = useState("verifying");
  const [error, setError] = useState("");
  const [docs, setDocs] = useState([]);
  const [nda, setNda] = useState(null);

  async function loadDocs() {
    const res = await fetch("/api/document-room/documents");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load documents.");
    if (data.ndaRequired) { setNda(data.ndaText || "Please accept the confidentiality terms to continue."); setDocs([]); } else { setNda(null); setDocs(data.documents); }
  }

  useEffect(() => {
    (async () => {
      try {
        const ex = await fetch(`/api/data-room-access/${encodeURIComponent(token)}`);
        if (!ex.ok) throw new Error((await ex.json().catch(() => ({}))).error || "This link is invalid or has expired.");
        await loadDocs();
        setState("ready");
      } catch (e) { setError(e.message); setState("error"); }
    })();
  }, [token]);

  async function accept() {
    const res = await fetch("/api/data-room-access/nda", { method: "POST" });
    if (res.ok) await loadDocs(); else setError("Could not record your acceptance.");
  }

  return (
    <main className="mx-auto max-w-xl px-5 py-12 text-[var(--inaya-text-primary,#fff)]">
      <h1 className="text-2xl font-extrabold">Your documents</h1>
      {state === "verifying" && <p className="mt-4 text-sm text-[var(--inaya-text-muted,#9aa)]">Verifying your link...</p>}
      {state === "error" && <div role="alert" className="mt-6 rounded-lg border border-red-400/30 bg-red-400/10 p-5 text-sm text-red-200">{error} Ask the sender for a new link.</div>}
      {state === "ready" && (
        <div className="mt-6 space-y-3">
          {nda && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-sm">
              <p>{nda}</p>
              <button onClick={accept} className="mt-3 rounded-md border border-amber-400/50 px-4 py-1.5 text-xs font-semibold">I accept</button>
            </div>
          )}
          {!nda && docs.length === 0 && <p className="text-sm text-[var(--inaya-text-muted,#9aa)]">No documents are available to you right now.</p>}
          {docs.map((d) => (
            <div key={d.objectId} className="rounded-lg border border-white/10 bg-black/20 p-4">
              <div className="font-bold">{d.documentType} {d.documentNumber}</div>
              <div className="text-xs text-[var(--inaya-text-muted,#9aa)]">Version {d.documentVersion} - finalized {d.finalizedAt ? new Date(d.finalizedAt).toLocaleString() : "-"} - {d.pages || "?"} page(s)</div>
              <div className="mt-1 break-all font-mono text-[10px] text-[var(--inaya-text-muted,#9aa)]">{d.documentHash}</div>
              <div className="mt-3 flex gap-3">
                <a className="rounded-md border border-cyan-400/50 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-300" target="_blank" rel="noreferrer" href={`/api/document-room/documents/${d.objectId}`}>View</a>
                <a className="rounded-md border border-white/20 px-3 py-1.5 text-xs font-semibold" href={`/api/document-room/documents/${d.objectId}?download=1`}>Download</a>
              </div>
            </div>
          ))}
          <p className="text-[11px] text-[var(--inaya-text-muted,#9aa)]">Your access is limited to the documents shown here and ends automatically. Check a saved copy at <a className="underline" href="/verify-document">verify a document</a>.</p>
        </div>
      )}
    </main>
  );
}
