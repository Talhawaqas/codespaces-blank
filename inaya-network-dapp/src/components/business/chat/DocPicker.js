"use client";

// src/components/business/chat/DocPicker.js
//
// Pick one of your existing Inaya documents to attach to a chat message as a reference (CHAT-013). It uses the organization's unified search, which only
// returns documents the signed-in person can already open, so the picker cannot reveal anything new. Only the id, name and size travel in the message;
// the recipient still needs their own access to open it.

import { useEffect, useRef, useState } from "react";

export default function DocPicker({ orgId, onPick, onClose }) {
  const [q, setQ] = useState(""); const [rows, setRows] = useState([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current); if (q.trim().length < 2) { setRows([]); return undefined; }
    timer.current = setTimeout(async () => {
      setBusy(true); setErr("");
      try { const r = await fetch(`/api/orgs/search?orgId=${encodeURIComponent(orgId)}&q=${encodeURIComponent(q.trim())}`, { credentials: "include" }); const j = await r.json(); if (!r.ok) throw new Error(j.error || "Search failed."); setRows((j.results || []).filter((x) => x.entityType === "document").slice(0, 12)); }
      catch (e) { setErr(e.message); } finally { setBusy(false); }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [q, orgId]);
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center pt-24 px-4" onClick={onClose}>
      <div className="fixed inset-0 bg-black/70" />
      <div role="dialog" aria-label="Attach an Inaya document" className="relative w-full max-w-md bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-sm mb-2">Attach an Inaya document</h3>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your documents by name" aria-label="Search documents" className="w-full bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-3 py-2 text-sm" />
        <div className="mt-2 max-h-64 overflow-auto">
          {busy && <p className="text-xs opacity-70 p-2">Searching…</p>}
          {err && <p className="text-xs text-amber-300 p-2" role="alert">{err}</p>}
          {!busy && q.trim().length >= 2 && !rows.length && !err && <p className="text-xs opacity-70 p-2">No documents match.</p>}
          {rows.map((r) => <button key={r.id} className="block w-full text-left px-2 py-2 rounded hover:bg-white/5 text-sm" onClick={() => onPick({ documentId: r.id, name: r.title, size: r.sizeBytes || 0 })}>{r.title}<span className="block text-[10px] opacity-60">{r.subtitle}</span></button>)}
        </div>
        <p className="text-[10px] opacity-60 mt-2">Only a reference is sent. The people in this chat still need their own access to open the file.</p>
        <button className="mt-2 text-xs underline" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
