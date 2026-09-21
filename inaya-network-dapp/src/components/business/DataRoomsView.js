"use client";

// src/components/business/DataRoomsView.js
//
// Financial Services & Regulated Enterprise SOW, Phase 9 (§19, §102) —
// External Data Rooms: investor/diligence/audit/legal rooms. Cross-
// vertical, same self-contained-view pattern as every other View
// component. Regulatory examination rooms have their own dedicated
// management UI already (Phase 4) — not duplicated here.
//
// Modular Enterprise Adoption Features SOW, Feature 2 — extends this
// existing view (not a fork) with template-based room creation: a
// gallery of the org's own templates plus the SOW's four built-in
// examples, cloneable in one click.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function TemplateGallery({ orgId, onChanged }) {
  const [templates, setTemplates] = useState(null);
  const [builtin, setBuiltin] = useState({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/data-room-templates?orgId=${orgId}`);
      setTemplates(data.templates);
      setBuiltin(data.builtin);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function clone(key) {
    try {
      setError("");
      await api("/api/orgs/data-room-templates", { method: "POST", body: JSON.stringify({ orgId, cloneBuiltin: key }) });
      load();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!templates) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading templates…</p>;

  return (
    <div className="space-y-2">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold">Start from a built-in template</p>
      <div className="flex flex-wrap gap-2">
        {Object.entries(builtin).map(([key, t]) => (
          <button key={key} onClick={() => clone(key)} className="text-[11px] text-left bg-black/30 border border-white/10 rounded-lg px-3 py-2 hover:bg-black/45">
            <span className="text-[var(--inaya-text-primary)] font-bold block">{t.name}</span>
            <span className="text-[var(--inaya-text-muted)]">{t.sections.length} sections{t.ndaRequired ? " · NDA required" : ""}</span>
          </button>
        ))}
      </div>
      {templates.length > 0 && (
        <>
          <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mt-2">Your templates</p>
          <div className="flex flex-wrap gap-1.5">
            {templates.map((t) => (
              <span key={t.id} className="text-[11px] text-[var(--inaya-text-primary)] bg-black/20 border border-white/10 rounded-md px-2 py-1">{t.name}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function DataRoomsView({ orgId, email }) {
  const [rooms, setRooms] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [roomType, setRoomType] = useState("investor");
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [showGallery, setShowGallery] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const [roomsData, templatesData] = await Promise.all([
        api(`/api/orgs/data-rooms?orgId=${orgId}`),
        api(`/api/orgs/data-room-templates?orgId=${orgId}`),
      ]);
      setRooms(roomsData.rooms);
      setTemplates(templatesData.templates);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    try {
      setError("");
      const body = templateId ? { orgId, templateId, name: name.trim() } : { orgId, roomType, name: name.trim() };
      await api("/api/orgs/data-rooms", { method: "POST", body: JSON.stringify(body) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!rooms) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <button onClick={() => setShowGallery(!showGallery)} className="text-[11px] font-bold uppercase text-[#00f2fe]">
        {showGallery ? "Hide" : "Browse"} template gallery
      </button>
      {showGallery && (
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
          <TemplateGallery orgId={orgId} onChanged={load} />
        </div>
      )}

      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select
          value={templateId ? `template:${templateId}` : `type:${roomType}`}
          onChange={(e) => {
            const [kind, value] = e.target.value.split(":");
            if (kind === "template") { setTemplateId(value); } else { setTemplateId(""); setRoomType(value); }
          }}
          className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)]"
        >
          <optgroup label="Plain room type">
            {["investor", "diligence", "audit", "legal"].map((t) => <option key={t} value={`type:${t}`}>{t}</option>)}
          </optgroup>
          {templates.length > 0 && (
            <optgroup label="From a template">
              {templates.map((t) => <option key={t.id} value={`template:${t.id}`}>{t.name}</option>)}
            </optgroup>
          )}
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
  const [section, setSection] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteResult, setInviteResult] = useState(null);
  const [error, setError] = useState("");

  async function downloadEvidence() {
    try {
      setError("");
      const { evidence } = await api(`/api/orgs/data-rooms/${room.id}/evidence?orgId=${orgId}`);
      const blob = new Blob([JSON.stringify(evidence, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `data-room-${room.id}-evidence.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

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
          {room.ndaRequired && <span className="text-[10px] font-bold uppercase text-amber-400 ml-2">NDA</span>}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${room.closedAt ? "border-white/10 text-[var(--inaya-text-muted)]" : "border-emerald-400/30 text-emerald-400"}`}>{room.closedAt ? "closed" : "open"}</span>
          <span className="text-[11px] font-mono text-[var(--inaya-text-muted)]">{room.documentCount} doc(s)</span>
          <button onClick={downloadEvidence} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-[#00f2fe]">Evidence</button>
          {!room.closedAt && <button onClick={() => act("close")} className="text-[10px] font-bold uppercase text-red-400">Close</button>}
        </div>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-white/5 space-y-2">
          {error && <p className="text-red-400 text-[10px]">{error}</p>}
          {room.sections?.length > 0 && (
            <p className="text-[10px] text-[var(--inaya-text-muted)]">Sections: {room.sections.join(", ")}</p>
          )}
          {!room.closedAt && (
            <>
              <form onSubmit={(e) => { e.preventDefault(); act("addDocument", { documentId: documentId.trim(), section: section || undefined }); setDocumentId(""); setSection(""); }} className="flex gap-2">
                <input value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder="Document ID" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
                {room.sections?.length > 0 && (
                  <select value={section} onChange={(e) => setSection(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)]">
                    <option value="">No section</option>
                    {room.sections.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
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
