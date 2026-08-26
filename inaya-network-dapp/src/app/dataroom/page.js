"use client";

// app/dataroom/page.js
//
// Public Investor Data Room — one component managing internal view state
// (gate -> check-email -> nda -> documents -> viewer) rather than a sprawl
// of separate Next.js route folders for what's fundamentally one linear
// flow, same pattern as src/components/learn/LearnSection.js from earlier
// today. Reads ?token= on load to auto-verify when arriving from the
// magic-link email. Matches this app's existing dark-navy/glassmorphism
// Tailwind conventions (same as /download, /business/download).

import { useState, useEffect, useRef, useCallback } from "react";

const HEARTBEAT_INTERVAL_MS = 15000;

// Mirrors the founder's existing Google Drive data room folder structure.
const CATEGORIES = ["Executive Documents", "Fundraising", "Operations", "Product & Demo", "Technical"];

function groupByCategory(documents) {
  const groups = new Map(CATEGORIES.map((c) => [c, []]));
  for (const doc of documents) {
    const key = groups.has(doc.category) ? doc.category : doc.category || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }
  return [...groups.entries()].filter(([, docs]) => docs.length > 0);
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export default function DataRoomPage() {
  const [view, setView] = useState("loading"); // loading | gate | checkEmail | nda | documents | viewer | error
  const [visitor, setVisitor] = useState(null); // { name, email, ndaAcceptedAt }
  const [error, setError] = useState(null);
  const [devVerifyUrl, setDevVerifyUrl] = useState(null);

  const [nameInput, setNameInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ndaChecked, setNdaChecked] = useState(false);

  const [documents, setDocuments] = useState([]);
  const [activeDocument, setActiveDocument] = useState(null);
  const heartbeatRef = useRef(null);

  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch("/api/dataroom/documents");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load documents.");
      setDocuments(data.items);
      setView("documents");
    } catch (err) {
      setError(err.message);
      setView("error");
    }
  }, []);

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const token = params.get("token");

      if (token) {
        try {
          const res = await fetch(`/api/dataroom/verify?token=${encodeURIComponent(token)}`);
          const data = await res.json();
          window.history.replaceState({}, "", "/dataroom");
          if (!res.ok) {
            setError(data.error || "This link is invalid or has expired.");
            setView("error");
            return;
          }
          setVisitor({ name: data.name, email: data.email, ndaAcceptedAt: data.ndaAcceptedAt });
          setView(data.ndaAcceptedAt ? "documentsPending" : "nda");
          return;
        } catch {
          setError("Could not verify this link.");
          setView("error");
          return;
        }
      }

      try {
        const res = await fetch("/api/dataroom/session");
        const data = await res.json();
        if (data.visitor) {
          setVisitor(data.visitor);
          setView(data.visitor.ndaAcceptedAt ? "documentsPending" : "nda");
        } else {
          setView("gate");
        }
      } catch {
        setView("gate");
      }
    })();
  }, []);

  // "documentsPending" is a transient state so the effect above can hand
  // off to this one to actually fetch the list, avoiding a dependency
  // cycle between the mount effect and loadDocuments.
  useEffect(() => {
    if (view === "documentsPending") loadDocuments();
  }, [view, loadDocuments]);

  const handleRequestAccess = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/dataroom/request-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameInput, email: emailInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send a verification link.");
      setDevVerifyUrl(data.verifyUrl || null);
      setView("checkEmail");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAcceptNda = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/dataroom/accept-nda", { method: "POST" });
      if (!res.ok) throw new Error("Could not record NDA acceptance.");
      await loadDocuments();
    } catch (err) {
      setError(err.message);
      setView("error");
    } finally {
      setSubmitting(false);
    }
  };

  const openDocument = (doc) => {
    setActiveDocument(doc);
    setView("viewer");
  };

  const postViewEvent = useCallback((documentId, event) => {
    fetch(`/api/dataroom/documents/${documentId}/view-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
      keepalive: event === "closed",
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (view !== "viewer" || !activeDocument) return;
    heartbeatRef.current = setInterval(() => postViewEvent(activeDocument.id, "heartbeat"), HEARTBEAT_INTERVAL_MS);
    const handleBeforeUnload = () => postViewEvent(activeDocument.id, "closed");
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      clearInterval(heartbeatRef.current);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      postViewEvent(activeDocument.id, "closed");
    };
  }, [view, activeDocument, postViewEvent]);

  const closeViewer = () => {
    setActiveDocument(null);
    setView("documents");
  };

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2.5 mb-8">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center shrink-0">
            <span className="text-black font-extrabold text-sm">I</span>
          </div>
          <span className="text-white font-extrabold tracking-wide">INAYA</span>
          <span className="text-[#8a96ab] text-xs font-mono ml-2">Investor Data Room</span>
        </div>

        {view === "loading" && <p className="text-[#8a96ab] text-xs font-mono">Loading…</p>}

        {view === "error" && (
          <div className="bg-[#090d16]/80 border border-red-500/20 rounded-xl p-6">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {view === "gate" && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6 md:p-8">
            <h1 className="text-xl font-extrabold text-white mb-1">Request Access</h1>
            <p className="text-[#94a3b8] text-sm mb-6">Enter your name and email to verify your identity and continue to the data room.</p>
            <form onSubmit={handleRequestAccess} className="space-y-4">
              <div>
                <label className="text-[12px] font-bold uppercase tracking-wider text-[#8a96ab] block mb-1.5">Full name</label>
                <input
                  required
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none"
                  placeholder="Jane Investor"
                />
              </div>
              <div>
                <label className="text-[12px] font-bold uppercase tracking-wider text-[#8a96ab] block mb-1.5">Email</label>
                <input
                  required
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none"
                  placeholder="jane@fund.vc"
                />
              </div>
              {error && <p className="text-red-400 text-xs">{error}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-3 hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Continue"}
              </button>
            </form>
          </div>
        )}

        {view === "checkEmail" && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6 md:p-8">
            <h1 className="text-xl font-extrabold text-white mb-1">Check your email</h1>
            <p className="text-[#94a3b8] text-sm">
              We sent a verification link to <span className="text-white font-semibold">{emailInput}</span>. Click it to continue.
            </p>
            {devVerifyUrl && (
              <div className="mt-4 bg-amber-400/10 border border-amber-400/20 rounded-lg p-3">
                <p className="text-amber-400 text-[13px] font-mono mb-1">Email delivery isn't configured — use this link directly:</p>
                <a href={devVerifyUrl} className="text-[#00f2fe] text-xs break-all underline">{devVerifyUrl}</a>
              </div>
            )}
          </div>
        )}

        {view === "nda" && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6 md:p-8">
            <h1 className="text-xl font-extrabold text-white mb-1">Non-Disclosure Agreement</h1>
            <p className="text-[#94a3b8] text-sm mb-4">Welcome, {visitor?.name}. Please review and accept before continuing.</p>
            <div className="bg-black/30 border border-white/5 rounded-lg p-4 max-h-64 overflow-y-auto text-xs text-[#94a3b8] leading-relaxed mb-5">
              <p>
                By accessing this data room, you agree to keep all information, documents, and materials made available to you
                strictly confidential. You agree not to copy, distribute, or disclose any contents to third parties without prior
                written consent from Inaya Network, and to use the information solely for the purpose of evaluating a potential
                investment.
              </p>
            </div>
            <label className="flex items-center gap-2.5 mb-5 cursor-pointer">
              <input type="checkbox" checked={ndaChecked} onChange={(e) => setNdaChecked(e.target.checked)} className="w-4 h-4" />
              <span className="text-sm text-white">I agree to the terms above.</span>
            </label>
            <button
              onClick={handleAcceptNda}
              disabled={!ndaChecked || submitting}
              className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-3 hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {submitting ? "Continuing…" : "Continue to Data Room"}
            </button>
          </div>
        )}

        {(view === "documentsPending") && <p className="text-[#8a96ab] text-xs font-mono">Loading documents…</p>}

        {view === "documents" && (
          <div>
            <h1 className="text-xl font-extrabold text-white mb-1">Data Room</h1>
            <p className="text-[#94a3b8] text-sm mb-6">Welcome back, {visitor?.name}.</p>
            {documents.length === 0 ? (
              <p className="text-[#8a96ab] text-sm">No documents have been uploaded yet.</p>
            ) : (
              <div className="space-y-6">
                {groupByCategory(documents).map(([category, docs]) => (
                  <div key={category}>
                    <h2 className="text-[#8a96ab] text-[12px] font-bold uppercase tracking-widest mb-2 flex items-center gap-1.5">
                      📁 {category}
                    </h2>
                    <div className="space-y-2">
                      {docs.map((doc) => (
                        <button
                          key={doc.id}
                          onClick={() => openDocument(doc)}
                          className="w-full text-left bg-[#090d16]/80 border border-white/5 hover:border-[#00f2fe]/40 rounded-xl p-4 flex items-center justify-between transition-all"
                        >
                          <div>
                            <p className="text-white text-sm font-semibold">{doc.title}</p>
                            <p className="text-[#8a96ab] text-[13px] font-mono mt-1">{formatBytes(doc.sizeBytes)}</p>
                          </div>
                          <span className="text-[#00f2fe] text-xs font-bold">View →</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {view === "viewer" && activeDocument && (
          <div>
            <button onClick={closeViewer} className="text-[#8a96ab] hover:text-slate-300 text-xs font-mono mb-4">← Back to documents</button>
            <h1 className="text-lg font-bold text-white mb-3">{activeDocument.title}</h1>
            {activeDocument.mimeType === "application/pdf" ? (
              <iframe
                src={`/api/dataroom/documents/${activeDocument.id}/stream`}
                className="w-full rounded-xl border border-white/5 bg-white"
                style={{ height: "80vh" }}
                title={activeDocument.title}
              />
            ) : activeDocument.mimeType === "video/mp4" ? (
              <video
                key={activeDocument.id}
                src={`/api/dataroom/documents/${activeDocument.id}/stream`}
                controls
                className="w-full rounded-xl border border-white/5 bg-black"
                style={{ maxHeight: "80vh" }}
              />
            ) : (
              <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6">
                <p className="text-[#94a3b8] text-sm mb-4">This file type doesn't support inline preview.</p>
                <a
                  href={`/api/dataroom/documents/${activeDocument.id}/stream`}
                  download={activeDocument.filename}
                  className="inline-block bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5"
                >
                  Download {activeDocument.filename}
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
