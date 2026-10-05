"use client";

// src/components/business/RoomV2Panel.js
//
// Data Room 2.0 controls for one room (Competitive Expansion SOW K), shown inside a room's expanded view: settings, documents (sections,
// view-only / download, lock, final version, bulk), visitors (batch and group invites with per-section scope), questions, health and the
// activity timeline. Everything here calls /api/orgs/data-rooms/[roomId]/v2 (FEATURE_DATA_ROOM_V2).

import { useCallback, useEffect, useState } from "react";

const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); } catch { return ""; } };
const j = async (path, opts = {}) => {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts });
  let d = null; try { d = await res.json(); } catch { d = {}; }
  if (!res.ok) throw Object.assign(new Error(d?.error || `Request failed (${res.status})`), { status: res.status, data: d });
  return d;
};

export default function RoomV2Panel({ orgId, roomId, closed }) {
  const base = `/api/orgs/data-rooms/${roomId}/v2`;
  const [ov, setOv] = useState(null); const [tab, setTab] = useState("overview"); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const [extra, setExtra] = useState({}); const [sel, setSel] = useState(new Set());
  const [s, setS] = useState({ watermark: true, defaultPermission: "view", sessionHours: 168, ipAllow: "", requireDeviceBinding: false, ndaRequired: false, ndaText: "", sections: "" });
  const [docIds, setDocIds] = useState(""); const [docSection, setDocSection] = useState(""); const [docPerm, setDocPerm] = useState("");
  const [inv, setInv] = useState({ emails: "", group: "", sections: [], role: "viewer", hours: "", ip: "" }); const [links, setLinks] = useState([]); const [grp, setGrp] = useState({ name: "", emails: "" });

  const load = useCallback(async () => {
    try {
      const o = await j(`${base}?orgId=${orgId}`); setOv(o); setErr("");
      if (o.settings) setS((x) => ({ ...x, watermark: o.settings.watermark, defaultPermission: o.settings.defaultPermission, sessionHours: o.settings.sessionHours, ipAllow: (o.settings.ipAllow || []).join(", "), requireDeviceBinding: o.settings.requireDeviceBinding, ndaRequired: o.settings.ndaRequired, ndaText: o.ndaText || "", sections: (o.sections || []).join(", ") }));
    } catch (e) { setErr(e.status === 404 ? "Data Room 2.0 is not enabled. An owner or admin can turn it on under Settings, Beta features." : e.message); }
  }, [base, orgId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!ov?.health.v2 || tab === "overview" || tab === "documents") return; j(`${base}?orgId=${orgId}&view=${tab}`).then((d) => setExtra((x) => ({ ...x, [tab]: d }))).catch((e) => setErr(e.message)); }, [tab, base, orgId, ov?.health.v2]);

  const run = async (body, ok) => { setErr(""); setMsg(""); try { const r = await j(base, { method: "POST", body: JSON.stringify({ orgId, ...body }) }); if (ok) setMsg(typeof ok === "function" ? ok(r) : ok); await load(); if (tab !== "overview" && tab !== "documents") setExtra((x) => ({ ...x, [tab]: undefined })); return r; } catch (e) { setErr(e.message); } };
  const list = (v) => String(v || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const ids = [...sel];

  if (err && !ov) return <p className="text-[11px] text-amber-300" role="status">{err}</p>;
  if (!ov) return <p className={`text-[11px] ${muted}`}>Loading…</p>;
  const v2 = ov.health.v2; const H = ov.health;
  return (
    <div className="mt-2 border border-[var(--inaya-overlay-10)] rounded-lg p-2 space-y-2">
      <div className="flex flex-wrap gap-1 items-center"><span className="text-[10px] font-bold uppercase text-[#00f2fe] mr-1">Data Room 2.0</span>
        {["overview", "documents", "visitors", "questions", "timeline"].map((t) => <button key={t} disabled={!v2 && t !== "overview"} className={`${btn} ${tab === t ? "!border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setTab(t)}>{t}</button>)}</div>
      {err && <p className="text-red-400 text-[11px]" role="alert">{err}</p>}{msg && <p className="text-emerald-400 text-[11px]" role="status">{msg}</p>}

      {tab === "overview" && (<div className="space-y-2 text-[11px]">
        {v2 && <p>Status <b>{H.status}</b> · {H.documents} documents ({H.locked} locked, {H.final} final) · visitors {H.visitors.active} active, {H.visitors.ndaAccepted} accepted the NDA · {H.openQuestions} open questions{H.lastActivityAt ? ` · last activity ${when(H.lastActivityAt)}` : ""}</p>}
        {H.warnings?.map((w) => <p key={w} className="text-amber-300">• {w}</p>)}
        {!closed && (<div className="space-y-1">
          <p className="font-bold uppercase text-[10px]">{v2 ? "Settings" : "Turn on Data Room 2.0 for this room"}</p>
          <div className="grid sm:grid-cols-4 gap-2">
            <label className="flex items-center gap-1"><input type="checkbox" checked={s.watermark} onChange={(e) => setS({ ...s, watermark: e.target.checked })} /> Watermark visitors</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={s.requireDeviceBinding} onChange={(e) => setS({ ...s, requireDeviceBinding: e.target.checked })} /> Tie to first device</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={s.ndaRequired} onChange={(e) => setS({ ...s, ndaRequired: e.target.checked })} /> Require NDA</label>
            <select aria-label="Default permission" className={field} value={s.defaultPermission} onChange={(e) => setS({ ...s, defaultPermission: e.target.value })}><option value="view">Documents are view-only by default</option><option value="download">Documents allow download by default</option></select>
            <input aria-label="Session hours" type="number" className={field} value={s.sessionHours} onChange={(e) => setS({ ...s, sessionHours: e.target.value })} placeholder="Visitor access hours" />
            <input aria-label="Allowed networks" className={`${field} sm:col-span-3`} value={s.ipAllow} onChange={(e) => setS({ ...s, ipAllow: e.target.value })} placeholder="Only these networks (optional): 203.0.113.0/24, 198.51.100.7" />
            <input aria-label="Sections" className={`${field} sm:col-span-4`} value={s.sections} onChange={(e) => setS({ ...s, sections: e.target.value })} placeholder="Sections, comma separated (Finance, Legal, Technical)" />
            {s.ndaRequired && <textarea aria-label="NDA text" className={`${field} sm:col-span-4`} rows={2} value={s.ndaText} onChange={(e) => setS({ ...s, ndaText: e.target.value })} placeholder="Confidentiality terms shown to visitors" />}
          </div>
          <button className={accent} onClick={() => run({ action: "settings", settings: { watermark: s.watermark, defaultPermission: s.defaultPermission, sessionHours: Number(s.sessionHours), ipAllow: list(s.ipAllow), requireDeviceBinding: s.requireDeviceBinding, ndaRequired: s.ndaRequired, ndaText: s.ndaText, sections: list(s.sections.replace(/,/g, " ").replace(/\s{2,}/g, " ").split(",").join(",")).length ? s.sections.split(",").map((x) => x.trim()).filter(Boolean) : undefined } }, "Settings saved.")}>{v2 ? "Save settings" : "Turn on"}</button>
        </div>)}
        <p className={muted}>View-only is a viewer mode, not a guarantee: a visitor who holds the passkey can keep what they decrypt, and revoking stops further access but cannot recall what was already seen.</p>
      </div>)}

      {tab === "documents" && v2 && (<div className="space-y-2 text-[11px]">
        {!closed && <div className="flex flex-wrap gap-2 items-end"><textarea aria-label="Document ids" className={`${field} flex-1 min-w-[200px]`} rows={2} value={docIds} onChange={(e) => setDocIds(e.target.value)} placeholder="Document IDs to add (one per line or comma separated)" />
          <select aria-label="Section" className={`${field} !w-auto`} value={docSection} onChange={(e) => setDocSection(e.target.value)}><option value="">No section</option>{ov.sections.map((x) => <option key={x}>{x}</option>)}</select>
          <button className={accent} disabled={!list(docIds).length} onClick={async () => { const r = await run({ action: "addDocuments", documentIds: list(docIds), section: docSection || null }, (x) => `${x.added} added${x.missing.length ? `, ${x.missing.length} not found` : ""}.`); if (r) setDocIds(""); }}>Add</button></div>}
        {ids.length > 0 && !closed && <div className="flex flex-wrap gap-1 items-center"><span>{ids.length} selected:</span>
          <select aria-label="Move to section" className={`${field} !w-auto`} value={docSection} onChange={(e) => setDocSection(e.target.value)}><option value="">Section…</option>{ov.sections.map((x) => <option key={x}>{x}</option>)}</select><button className={btn} disabled={!docSection} onClick={() => run({ action: "updateDocuments", documentIds: ids, patch: { section: docSection } }, (x) => `${x.updated} moved${x.refused.length ? `, ${x.refused.length} refused (${x.refused[0].reason})` : ""}.`)}>Move</button>
          <button className={btn} onClick={() => run({ action: "updateDocuments", documentIds: ids, patch: { permission: "view" } }, "Set to view-only.")}>View-only</button><button className={btn} onClick={() => run({ action: "updateDocuments", documentIds: ids, patch: { permission: "download" } }, "Download allowed.")}>Allow download</button>
          <button className={btn} onClick={() => run({ action: "updateDocuments", documentIds: ids, patch: { locked: true } }, "Locked.")}>Lock</button><button className={btn} onClick={() => run({ action: "updateDocuments", documentIds: ids, patch: { locked: false, final: false } }, "Unlocked.")}>Unlock</button>
          <button className={btn} onClick={() => run({ action: "updateDocuments", documentIds: ids, patch: { final: true } }, "Marked final and locked.")}>Mark final</button>
          <button className={`${btn} !text-red-400`} onClick={() => run({ action: "removeDocuments", documentIds: ids }, (x) => `${x.removed} removed${x.refused.length ? `, ${x.refused.length} refused (${x.refused[0].reason})` : ""}.`).then(() => setSel(new Set()))}>Remove</button></div>}
        {ov.documents.length === 0 ? <p className={muted}>No documents yet.</p> : ov.documents.map((d) => (
          <div key={d.documentId} className="flex items-center gap-2 border-t border-[var(--inaya-overlay-10)] py-1"><input type="checkbox" aria-label={`Select ${d.documentId}`} checked={sel.has(d.documentId)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(d.documentId) : n.delete(d.documentId); setSel(n); }} />
            <code className="text-[10px]">{d.documentId.slice(-8)}</code><span className="flex-1">{d.section || "no section"} · {d.permission === "download" ? "download allowed" : "view-only"}{d.locked ? " · locked" : ""}{d.final ? " · final version" : ""}</span></div>))}
      </div>)}

      {tab === "visitors" && v2 && (<div className="space-y-2 text-[11px]">
        {!closed && <div className="space-y-1"><p className="font-bold uppercase text-[10px]">Invite people</p>
          <textarea aria-label="Visitor emails" className={field} rows={2} value={inv.emails} onChange={(e) => setInv({ ...inv, emails: e.target.value })} placeholder="Email addresses (one per line or comma separated)" />
          <div className="grid sm:grid-cols-4 gap-2">
            <select aria-label="Group" className={field} value={inv.group} onChange={(e) => setInv({ ...inv, group: e.target.value })}><option value="">No saved group</option>{ov.groups.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.emails.length})</option>)}</select>
            <select aria-label="Role" className={field} value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}><option value="viewer">Viewer (view-only)</option><option value="downloader">Downloader (where allowed)</option></select>
            <input aria-label="Access hours" type="number" className={field} value={inv.hours} onChange={(e) => setInv({ ...inv, hours: e.target.value })} placeholder="Access hours (max room default)" />
            <input aria-label="Visitor networks" className={field} value={inv.ip} onChange={(e) => setInv({ ...inv, ip: e.target.value })} placeholder="Only from networks (optional)" />
          </div>
          {ov.sections.length > 0 && <div className="flex flex-wrap gap-2">{ov.sections.map((x) => <label key={x} className="flex items-center gap-1"><input type="checkbox" checked={inv.sections.includes(x)} onChange={(e) => setInv({ ...inv, sections: e.target.checked ? [...inv.sections, x] : inv.sections.filter((y) => y !== x) })} /> {x}</label>)}<span className={muted}>(none ticked = every section)</span></div>}
          <button className={accent} disabled={!list(inv.emails).length && !inv.group} onClick={async () => { const r = await run({ action: "invite", emails: list(inv.emails), group: inv.group || undefined, allowedSections: inv.sections.length ? inv.sections : null, role: inv.role, expiresInHours: inv.hours ? Number(inv.hours) : undefined, ipAllow: list(inv.ip) }, (x) => `${x.invites.length} invitation${x.invites.length === 1 ? "" : "s"} created.`); if (r) setLinks(r.invites); }}>Create invitations</button>
          {links.length > 0 && <div className="border border-emerald-400/30 rounded-lg p-2"><p className="text-emerald-400">Send each person their own link (shown once; valid 30 minutes, single use):</p>{links.map((l) => <p key={l.email} className="break-all font-mono text-[10px]">{l.email}: {l.url}</p>)}</div>}
          <div className="flex gap-2 items-end"><input aria-label="Group name" className={`${field} !w-40`} value={grp.name} onChange={(e) => setGrp({ ...grp, name: e.target.value })} placeholder="Save as group…" /><input aria-label="Group emails" className={field} value={grp.emails} onChange={(e) => setGrp({ ...grp, emails: e.target.value })} placeholder="Emails in the group" /><button className={btn} disabled={!grp.name || !list(grp.emails).length} onClick={() => run({ action: "saveGroup", name: grp.name, emails: list(grp.emails) }, "Group saved.")}>Save group</button></div>
        </div>}
        <p className="font-bold uppercase text-[10px]">Visitors</p>
        {!extra.visitors ? <p className={muted}>Loading…</p> : extra.visitors.visitors.length === 0 && extra.visitors.pendingInvites.length === 0 ? <p className={muted}>No visitors yet.</p> : (<>
          {extra.visitors.visitors.map((v) => <div key={v.email + v.since} className="flex flex-wrap items-center gap-2 border-t border-[var(--inaya-overlay-10)] py-1"><span className="flex-1">{v.email} · {v.role} · {v.allowedSections ? v.allowedSections.join(", ") : "all sections"} · {v.ndaAcceptedAt ? "NDA accepted" : "NDA pending"} · until {when(v.expiresAt)}</span>
            <button className={`${btn} !text-red-400`} onClick={async () => { if (window.confirm(`Revoke ${v.email}? They lose access immediately.`)) { try { await j(`/api/orgs/data-rooms/${roomId}`, { method: "PATCH", body: JSON.stringify({ orgId, action: "revoke", externalEmail: v.email }) }); setExtra((x) => ({ ...x, visitors: undefined })); setTab("overview"); setTimeout(() => setTab("visitors"), 50); } catch (e) { setErr(e.message); } } }}>Revoke</button></div>)}
          {extra.visitors.pendingInvites.map((p) => <p key={p.email + p.sentAt} className={muted}>Invitation waiting: {p.email} ({when(p.sentAt)})</p>)}</>)}
      </div>)}

      {tab === "questions" && v2 && (<div className="space-y-1 text-[11px]">
        {!extra.questions ? <p className={muted}>Loading…</p> : extra.questions.questions.length === 0 ? <p className={muted}>No questions yet. Visitors see only their own questions and your answers to them.</p> : extra.questions.questions.map((q) => (
          <div key={q.id} className="border-t border-[var(--inaya-overlay-10)] py-1"><p><b>{q.asker}</b> {when(q.createdAt)}: {q.text}</p>{q.answer ? <p className="text-emerald-400">Answered by {q.answer.by}: {q.answer.text}</p> : (
            <form className="flex gap-2 mt-1" onSubmit={(e) => { e.preventDefault(); const t = e.currentTarget.elements.ans.value; if (t.trim()) run({ action: "answer", questionId: q.id, text: t }, "Answered."); }}><input name="ans" aria-label="Answer" className={field} placeholder="Your answer" /><button className={accent}>Answer</button></form>)}</div>))}
      </div>)}

      {tab === "timeline" && v2 && (<div className="space-y-0.5 text-[11px] max-h-72 overflow-auto">
        {!extra.timeline ? <p className={muted}>Loading…</p> : extra.timeline.events.map((e, i) => <p key={i} className="border-t border-[var(--inaya-overlay-10)] py-0.5"><span className={muted}>{when(e.at)}</span> <b>{e.who || "system"}</b> {String(e.what).replace(/_/g, " ").toLowerCase()}{e.detail?.count ? ` (${e.detail.count})` : ""}</p>)}
      </div>)}
    </div>
  );
}
