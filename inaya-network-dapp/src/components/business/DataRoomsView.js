"use client";

// src/components/business/DataRoomsView.js
//
// Financial Services & Regulated Enterprise SOW, Phase 9 (§19, §102) —
// External Data Rooms: investor/diligence/audit rooms. Cross-vertical,
// same self-contained-view pattern as every other View component.
// Regulatory examination rooms have their own dedicated management UI
// already (Phase 4) — not duplicated here.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function DataRoomsView({ orgId, email }) {
  const [rooms, setRooms] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [roomType, setRoomType] = useState("investor");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setRooms((await api(`/api/orgs/data-rooms?orgId=${orgId}`)).rooms);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    try {
      setError("");
      await api("/api/orgs/data-rooms", { method: "POST", body: JSON.stringify({ orgId, roomType, name: name.trim() }) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!rooms) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select value={roomType} onChange={(e) => setRoomType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)]">
          {["investor", "diligence", "audit"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Room name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Create room</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {rooms.length === 0 ? <EmptyState compact icon="🗄️" description="No data rooms yet." /> : (
          <div className="space-y-2">
            {rooms.map((r) => (
              <RoomRow key={r.id} room={r} orgId={orgId} actorEmail={email} expanded={expanded === r.id} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} onChanged={load} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RoomRow({ room, orgId, actorEmail, expanded, onToggle, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [documentId, setDocumentId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteResult, setInviteResult] = useState(null);
  const [error, setError] = useState("");

  const loadDetail = useCallback(async () => {
    try {
      setError("");
      setDetail(await api(`/api/orgs/data-rooms/${room.id}?orgId=${orgId}`));
    } catch (err) {
      setError(err.message);
    }
  }, [room.id, orgId]);

  useEffect(() => { if (expanded) loadDetail(); }, [expanded, loadDetail]);

  async function act(action, extra) {
    try {
      setError("");
      const result = await api(`/api/orgs/data-rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ orgId, action, ...extra }) });
      if (action === "invite" && result.token) {
        setInviteResult(`${window.location.origin}/api/data-room-access/${result.token}`);
      }
      loadDetail();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-3">
      <div className="flex items-center justify-between gap-3">
        <button onClick={onToggle} className="text-left min-w-0">
          <span className="text-[var(--inaya-text-primary)] text-sm">{room.name}</span>
          <span className="text-[10px] font-mono text-[var(--inaya-text-muted)] ml-2 uppercase">{room.roomType}</span>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${room.closedAt ? "border-white/10 text-[var(--inaya-text-muted)]" : "border-emerald-400/30 text-emerald-400"}`}>{room.closedAt ? "closed" : "open"}</span>
          <span className="text-[11px] font-mono text-[var(--inaya-text-muted)]">{room.documentCount} doc(s)</span>
          {!room.closedAt && <button onClick={() => act("close")} className="text-[10px] font-bold uppercase text-red-400">Close</button>}
        </div>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-white/5 space-y-2">
          {error && <p className="text-red-400 text-[10px]">{error}</p>}
          {!room.closedAt && (
            <>
              <form onSubmit={(e) => { e.preventDefault(); act("addDocument", { documentId: documentId.trim() }); setDocumentId(""); }} className="flex gap-2">
                <input value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="Document ID" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
                <button disabled={!documentId.trim()} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">Add doc</button>
              </form>
              <form onSubmit={(e) => { e.preventDefault(); act("invite", { externalEmail: inviteEmail.trim() }); setInviteEmail(""); }} className="flex gap-2">
                <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="External email to invite" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
                <button disabled={!inviteEmail.trim()} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">Invite</button>
              </form>
              {inviteResult && <p className="text-[10px] font-mono text-emerald-400 break-all">Send this link to the invitee (expires in 30 min, single-use): {inviteResult}</p>}
            </>
          )}
          {detail && (
            <>
              <p className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] mt-1">Access log</p>
              {detail.accessLog.length === 0 ? <Empty /> : detail.accessLog.map((a, i) => (
                <div key={i} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-2 py-1">
                  <span className="text-[var(--inaya-text-primary)] text-[11px] truncate">{a.externalEmail} · {a.action}</span>
                  <span className="text-[var(--inaya-text-muted)] text-[10px] font-mono shrink-0 ml-2">{a.accessedAt}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Empty() {
  return <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">None.</p>;
}
