"use client";

// app/admin/dataroom/page.js
//
// Investor Data Room admin — upload/manage documents, and the actual
// point of this whole feature: see exactly who's viewed what and for how
// long. Same passphrase-gated session as the Enterprise Dashboard
// (/admin, src/lib/admin-auth.js) — POST /api/admin/login sets the shared
// inaya_admin_session cookie, every /api/admin/dataroom/* route re-checks
// it server-side.

import { useState, useEffect, useCallback } from "react";

// Mirrors the founder's existing Google Drive data room folder structure
// (kept as a local constant, not imported from src/lib/dataroom.js — that
// file pulls in server-only deps like mongodb, which can't bundle into a
// "use client" page).
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

function formatDuration(ms) {
  if (!ms) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function DataRoomAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [tab, setTab] = useState("documents"); // documents | visitors
  const [documents, setDocuments] = useState([]);
  const [visitors, setVisitors] = useState([]);
  const [expandedVisitor, setExpandedVisitor] = useState(null);
  const [loadError, setLoadError] = useState("");

  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadCategory, setUploadCategory] = useState(CATEGORIES[0]);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const loadData = useCallback(async () => {
    setLoadError("");
    try {
      const [docsRes, visitorsRes] = await Promise.all([
        fetch("/api/admin/dataroom/documents"),
        fetch("/api/admin/dataroom/visitors"),
      ]);
      if (!docsRes.ok || !visitorsRes.ok) throw new Error("Session may have expired — please log in again.");
      setDocuments((await docsRes.json()).items);
      setVisitors((await visitorsRes.json()).visitors);
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    if (authed) loadData();
  }, [authed, loadData]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLoginError(data.error || "Login failed.");
        return;
      }
      setAuthed(true);
    } catch {
      setLoginError("Login failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(e) {
    e.preventDefault();
    if (!uploadFile) return;
    setUploading(true);
    setUploadError("");
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);
      formData.append("title", uploadTitle);
      formData.append("category", uploadCategory || "General");

      const res = await fetch("/api/admin/dataroom/documents", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed.");

      setUploadTitle("");
      setUploadCategory(CATEGORIES[0]);
      setUploadFile(null);
      e.target.reset();
      await loadData();
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteDocument(id) {
    if (!window.confirm("Remove this document from the data room?")) return;
    await fetch(`/api/admin/dataroom/documents/${id}`, { method: "DELETE" });
    await loadData();
  }

  async function handleRevoke(visitorId) {
    if (!window.confirm("Revoke this visitor's access? They'll need to re-verify their email to get back in.")) return;
    await fetch(`/api/admin/dataroom/visitors/${visitorId}/revoke`, { method: "POST" });
    await loadData();
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Data Room Admin</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase</p>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none mb-3"
            placeholder="Passphrase"
          />
          {loginError && <p className="text-red-400 text-xs mb-3">{loginError}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5 disabled:opacity-50"
          >
            {loading ? "Checking…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-extrabold text-white mb-6">Investor Data Room</h1>

        <div className="flex gap-2 mb-6">
          {[["documents", "Documents"], ["visitors", "Visitors"]].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${tab === id ? "text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40" : "text-[#8a96ab] border border-white/5 hover:text-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {loadError && <p className="text-red-400 text-sm mb-4">{loadError}</p>}

        {tab === "documents" && (
          <div className="space-y-6">
            <form onSubmit={handleUpload} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5 space-y-3">
              <h2 className="text-white font-bold text-sm mb-2">Upload a document</h2>
              <input
                required
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Title (e.g. Q3 Financials)"
                className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none"
              />
              <select
                value={uploadCategory}
                onChange={(e) => setUploadCategory(e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c} className="bg-[#0b1120]">{c}</option>
                ))}
              </select>
              <input
                required
                type="file"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                className="w-full text-xs text-[#94a3b8]"
              />
              {uploadError && <p className="text-red-400 text-xs">{uploadError}</p>}
              <button
                type="submit"
                disabled={uploading}
                className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-xs rounded-xl px-4 py-2.5 disabled:opacity-50"
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
            </form>

            <div className="space-y-6">
              {groupByCategory(documents).map(([category, docs]) => (
                <div key={category}>
                  <h3 className="text-[#8a96ab] text-[10px] font-bold uppercase tracking-widest mb-2 flex items-center gap-1.5">
                    📁 {category}
                  </h3>
                  <div className="space-y-2">
                    {docs.map((doc) => (
                      <div key={doc._id} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4 flex items-center justify-between">
                        <div>
                          <p className="text-white text-sm font-semibold">{doc.title}</p>
                          <p className="text-[#8a96ab] text-[11px] font-mono mt-1">{formatBytes(doc.sizeBytes)} · {formatDate(doc.uploadedAt)}</p>
                        </div>
                        <button onClick={() => handleDeleteDocument(doc._id)} className="text-red-400 hover:text-red-300 text-xs font-bold">Remove</button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {documents.length === 0 && <p className="text-[#8a96ab] text-sm">No documents uploaded yet.</p>}
            </div>
          </div>
        )}

        {tab === "visitors" && (
          <div className="space-y-2">
            {visitors.map((v) => (
              <div key={v.visitorId} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="text-white text-sm font-semibold">{v.name} {v.revokedAt && <span className="text-red-400 text-[10px] font-mono ml-2">REVOKED</span>}</p>
                    <p className="text-[#8a96ab] text-[11px] font-mono mt-0.5">{v.email}</p>
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <div className="text-right">
                      <p className="text-[#00f2fe] font-bold">{v.totalViews} view{v.totalViews === 1 ? "" : "s"}</p>
                      <p className="text-[#8a96ab] font-mono text-[10px]">{formatDuration(v.totalDurationMs)} total</p>
                    </div>
                    <button
                      onClick={() => setExpandedVisitor(expandedVisitor === v.visitorId ? null : v.visitorId)}
                      className="text-[#94a3b8] hover:text-white"
                    >
                      {expandedVisitor === v.visitorId ? "Hide ▲" : "Details ▼"}
                    </button>
                    {!v.revokedAt && (
                      <button onClick={() => handleRevoke(v.visitorId)} className="text-red-400 hover:text-red-300 font-bold">Revoke</button>
                    )}
                  </div>
                </div>
                <p className="text-[#8a96ab] text-[10px] font-mono mt-2">
                  NDA: {v.ndaAcceptedAt ? `accepted ${formatDate(v.ndaAcceptedAt)}` : "not accepted"} · Last active: {formatDate(v.lastActiveAt)}
                </p>

                {expandedVisitor === v.visitorId && (
                  <div className="mt-3 border-t border-white/5 pt-3 space-y-1.5">
                    {v.views.length === 0 && <p className="text-[#8a96ab] text-xs">No document views yet.</p>}
                    {v.views.map((view, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-[#94a3b8]">{view.documentTitle}</span>
                        <span className="text-[#8a96ab] font-mono">{formatDate(view.openedAt)} · {formatDuration(view.durationMs)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {visitors.length === 0 && <p className="text-[#8a96ab] text-sm">No one has requested access yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
