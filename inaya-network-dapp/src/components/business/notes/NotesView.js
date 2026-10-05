"use client";

// src/components/business/notes/NotesView.js
//
// Secure Notes (Competitive Expansion SOW workstream C). Everything is encrypted in this browser; Inaya stores ciphertext only and cannot
// recover a forgotten passphrase. Search runs locally over decrypted notes. Rich text and Markdown from other people are NEVER trusted:
// rich text goes through an allowlist sanitizer and Markdown is rendered to React elements (no HTML injection path).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import EmptyState from "../../EmptyState";
import { ConflictError, KeyChangedError, NotesClient, TYPES } from "../../../lib/notes/client/NotesClient";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[11px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2.5 py-1.5 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1.5 text-[12px] text-[var(--inaya-text-primary)]";
const TYPE_LABEL = { text: "Plain text", rich: "Rich text", markdown: "Markdown", checklist: "Checklist", code: "Code" };
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); } catch { return ""; } };

const makeApi = (orgId) => async (method, path, body) => {
  const p = path === "/" ? "" : path.replace(/^\/\?/, "?"); const url = `/api/orgs/notes${p}`;
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}orgId=${orgId}`, { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify({ orgId, ...body }) } : {}) });
  let data = null; try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
};

// ---- safe rendering ---------------------------------------------------------------------------------------------------
const ALLOWED = new Set(["B", "STRONG", "I", "EM", "U", "P", "BR", "UL", "OL", "LI", "H1", "H2", "H3", "BLOCKQUOTE", "CODE", "PRE", "DIV", "SPAN", "A"]);
export function sanitizeHtml(html) {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<body>${String(html || "")}</body>`, "text/html");
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1 || !ALLOWED.has(child.tagName)) { child.remove(); continue; }
      for (const a of [...child.attributes]) { if (!(child.tagName === "A" && a.name === "href")) child.removeAttribute(a.name); }
      if (child.tagName === "A") { const h = child.getAttribute("href") || ""; if (/^https?:\/\//i.test(h)) { child.setAttribute("rel", "noopener noreferrer nofollow"); child.setAttribute("target", "_blank"); } else child.removeAttribute("href"); }
      walk(child);
    }
  };
  walk(doc.body); return doc.body.innerHTML;
}
function inline(text, k) {
  const out = []; const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g; let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index)); const t = m[0];
    if (m[1]) out.push(<code key={`${k}${i++}`} className="bg-black/40 px-1 rounded">{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={`${k}${i++}`}>{t.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={`${k}${i++}`}>{t.slice(1, -1)}</em>);
    else { const [, label, href] = /\[([^\]]+)\]\((.+)\)/.exec(t); out.push(<a key={`${k}${i++}`} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-[#00f2fe] underline">{label}</a>); }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last)); return out;
}
export function Markdown({ text }) {
  const lines = String(text || "").split("\n"); const out = []; let list = null, code = null;
  const flush = () => { if (list) { out.push(<ul key={`l${out.length}`} className="list-disc ml-5 my-1">{list}</ul>); list = null; } };
  lines.forEach((ln, n) => {
    if (/^```/.test(ln)) { if (code) { out.push(<pre key={`c${n}`} className="bg-black/40 rounded p-2 my-2 overflow-auto text-[12px]">{code.join("\n")}</pre>); code = null; } else { flush(); code = []; } return; }
    if (code) { code.push(ln); return; }
    const h = /^(#{1,3})\s+(.*)$/.exec(ln); const li = /^\s*[-*]\s+(.*)$/.exec(ln);
    if (li) { (list ||= []).push(<li key={n}>{inline(li[1], n)}</li>); return; }
    flush();
    if (h) { const S = `h${h[1].length}`; out.push(<S key={n} className="font-bold mt-2 text-[14px]">{inline(h[2], n)}</S>); }
    else if (ln.trim()) out.push(<p key={n} className="my-1">{inline(ln, n)}</p>);
  });
  flush(); if (code) out.push(<pre key="cx" className="bg-black/40 rounded p-2 my-2 overflow-auto text-[12px]">{code.join("\n")}</pre>);
  return <div className="text-[13px] leading-relaxed">{out}</div>;
}
const plain = (p) => (p.type === "rich" ? String(p.body || "").replace(/<[^>]*>/g, " ") : p.type === "checklist" ? (p.items || []).map((i) => i.text).join(" ") : p.body || "").replace(/\s+/g, " ").trim();

function Modal({ title, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`${card} bg-[var(--inaya-bg,#0b0f14)] w-full max-w-lg p-5 max-h-[85vh] overflow-auto`}>
        <div className="flex justify-between items-center mb-3"><h3 className="text-sm font-bold">{title}</h3><button className={btn} onClick={onClose}>Close</button></div>{children}
      </div>
    </div>, document.body);
}

// ---- passphrase gate --------------------------------------------------------------------------------------------------
function Gate({ client, hasVault, onReady }) {
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault(); setErr("");
    if (!hasVault && pw !== pw2) { setErr("The two passphrases do not match."); return; }
    setBusy(true);
    try { if (hasVault) await client.unlock(pw); else await client.setup(pw); onReady(); } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={go} className={`${card} p-5 max-w-md mx-auto space-y-3`}>
      <h3 className="text-sm font-bold">{hasVault ? "Unlock your notes" : "Set up Secure Notes"}</h3>
      <p className={`text-[12px] ${muted}`}>{hasVault ? "Type your notes passphrase. It is checked in this browser and never sent to Inaya." : "Your notes are encrypted in this browser with a passphrase only you know. Inaya cannot read them and cannot recover the passphrase. If you forget it, your notes cannot be opened."}</p>
      <input id="notes-pass" type="password" autoComplete={hasVault ? "current-password" : "new-password"} className={field} placeholder={hasVault ? "Notes passphrase" : "Choose a passphrase (at least 10 characters)"} value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Notes passphrase" />
      {!hasVault && <input id="notes-pass2" type="password" autoComplete="new-password" className={field} placeholder="Repeat the passphrase" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-label="Repeat the passphrase" />}
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      <button className={accent} disabled={busy || !pw}>{busy ? "Working…" : hasVault ? "Unlock" : "Create vault"}</button>
    </form>
  );
}

// ---- editor body per type --------------------------------------------------------------------------------------------
function RichEditor({ value, onChange, readOnly }) {
  const ref = useRef(null); const last = useRef(null);
  useEffect(() => { if (ref.current && value !== last.current) { ref.current.innerHTML = sanitizeHtml(value); last.current = value; } }, [value]);
  const cmd = (c) => { ref.current?.focus(); document.execCommand(c); push(); };
  const push = () => { const clean = sanitizeHtml(ref.current.innerHTML); if (clean !== ref.current.innerHTML) ref.current.innerHTML = clean; last.current = clean; onChange(clean); };
  // Pasted or dropped content is reduced to plain text: no markup from outside ever enters the editor.
  const paste = (e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") || ""); };
  return (
    <div>
      {!readOnly && <div className="flex gap-1 mb-1">{[["Bold", "bold", "B"], ["Italic", "italic", "I"], ["Underline", "underline", "U"], ["Bulleted list", "insertUnorderedList", "• List"], ["Numbered list", "insertOrderedList", "1. List"]].map(([label, c, t]) => <button key={c} type="button" className={btn} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd(c)}>{t}</button>)}</div>}
      <div ref={ref} contentEditable={!readOnly} suppressContentEditableWarning role="textbox" aria-label="Note body" aria-multiline="true" onInput={push} onPaste={paste} onDrop={(e) => e.preventDefault()} className={`${field} min-h-[220px] text-[13px] leading-relaxed [&_ul]:list-disc [&_ul]:ml-5 [&_ol]:list-decimal [&_ol]:ml-5`} />
    </div>
  );
}
function Checklist({ items, onChange, readOnly }) {
  const set = (i, patch) => onChange(items.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  return (
    <div className="space-y-1">
      {items.map((it, i) => (
        <div key={it.id} className="flex items-center gap-2">
          <input type="checkbox" checked={it.done} disabled={readOnly} onChange={(e) => set(i, { done: e.target.checked })} aria-label={`Done: ${it.text || "item"}`} />
          <input className={`${field} ${it.done ? "line-through opacity-60" : ""}`} value={it.text} readOnly={readOnly} onChange={(e) => set(i, { text: e.target.value })} aria-label="Item" />
          {!readOnly && <button type="button" className={btn} aria-label="Remove item" onClick={() => onChange(items.filter((_, n) => n !== i))}>×</button>}
        </div>))}
      {!readOnly && <button type="button" className={btn} onClick={() => onChange([...items, { id: Math.random().toString(36).slice(2, 8), text: "", done: false }])}>+ Add item</button>}
    </div>
  );
}

// ---- main view ------------------------------------------------------------------------------------------------------
export default function NotesView({ orgId, email }) {
  const client = useMemo(() => new NotesClient({ api: makeApi(orgId), email }), [orgId, email]);
  const [phase, setPhase] = useState("loading"); const [err, setErr] = useState("");
  const [notes, setNotes] = useState([]); const [filter, setFilter] = useState("all"); const [tag, setTag] = useState(""); const [q, setQ] = useState(""); const [, bump] = useState(0);
  const [sel, setSel] = useState(null); const [draft, setDraft] = useState(null); const [status, setStatus] = useState(""); const [conflict, setConflict] = useState(null);
  const [modal, setModal] = useState(null); const selRef = useRef(null); const timer = useRef(null); const inflight = useRef(false); const dirty = useRef(false);

  useEffect(() => { client.hasVault().then((h) => setPhase(h ? "locked" : "setup")).catch((e) => { setErr(e.status === 404 ? "Secure Notes is not turned on for your organization. An owner or admin can enable it under Settings, Beta features." : e.message); setPhase("error"); }); return () => clearTimeout(timer.current); }, [client]);
  const reload = useCallback(async (state = "active") => { try { setNotes(await client.list(state)); setErr(""); } catch (e) { setErr(e.message); } }, [client]);
  useEffect(() => { if (phase === "ready") reload(filter === "trash" ? "trashed" : "active"); }, [phase, filter, reload]);
  // Deep link from Secure Chat or a notification: /business?view=notes&note=<id>
  const deepLinked = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || deepLinked.current) return; deepLinked.current = true;
    const id = new URLSearchParams(window.location.search).get("note"); if (id && /^[0-9a-f]{24}$/.test(id)) openNote({ noteId: id });
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const ix = client.index;
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return notes.filter((n) => {
      if (filter === "trash") return true;
      const archived = ix.archived.includes(n.noteId);
      if (filter === "archived" ? !archived : archived) return false;
      if (filter === "pinned" && !ix.pins.includes(n.noteId)) return false;
      if (filter === "favorites" && !ix.favorites.includes(n.noteId)) return false;
      if (filter === "shared" && n.perm === "owner" && n.participants.length < 2) return false;
      if (tag && !(ix.noteTags[n.noteId] || []).includes(tag)) return false;
      if (needle && !((n.payload?.title || "") + " " + plain(n.payload || {})).toLowerCase().includes(needle)) return false;
      return true;
    }).sort((a, b) => (ix.pins.includes(b.noteId) - ix.pins.includes(a.noteId)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }, [notes, filter, tag, q, ix, phase, client.indexVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openNote(n) {
    clearTimeout(timer.current); setConflict(null); setStatus("");
    try { let m = await client.open(n.noteId); if (m.payload && m.rotationDue && m.ownerEmail === client.email) { await client.rotateIfDue(m); m = await client.open(n.noteId); } setSel(m); setDraft(m.payload ? { ...m.payload } : { v: 1, type: "text", title: "", body: "" }); dirty.current = false; }
    catch (e) { setErr(e.message); }
  }
  async function newNote(type) {
    try { const r = await client.create({ type, title: "", body: "", items: type === "checklist" ? [{ id: "1", text: "", done: false }] : undefined }); await reload("active"); setFilter("all"); await openNote({ noteId: r.noteId }); }
    catch (e) { setErr(e.message); }
  }

  selRef.current = sel;
  const unreadable = !!sel && sel.payload === null;
  const readOnly = !sel || sel.perm === "read" || sel.state === "trashed" || unreadable;
  const persist = useCallback(async () => {
    const cur = selRef.current; if (inflight.current || !cur || !dirty.current) return;
    inflight.current = true; dirty.current = false; setStatus("Saving…");
    try {
      const r = await client.save(cur, draftRef.current); setSel((s) => ({ ...s, payload: draftRef.current, rev: r.rev, updatedAt: r.at, lastEditedBy: client.email })); setStatus("Saved");
      setNotes((all) => all.map((n) => (n.noteId === cur.noteId ? { ...n, rev: r.rev, updatedAt: r.at, payload: draftRef.current } : n)));
    } catch (e) {
      if (e instanceof ConflictError) { setConflict(e.latest); setStatus("Conflict"); } else { setStatus(""); setErr(e.status === 403 ? "You have read-only access to this note." : e.message); }
    } finally { inflight.current = false; if (dirty.current && !conflict) schedule(); }
  }, [client, sel, conflict]); // eslint-disable-line react-hooks/exhaustive-deps
  const draftRef = useRef(null); draftRef.current = draft;
  const schedule = () => { clearTimeout(timer.current); timer.current = setTimeout(() => persist(), 1200); };
  const edit = (patch) => { if (readOnly) return; setDraft((d) => { const next = { ...d, ...patch }; draftRef.current = next; return next; }); dirty.current = true; setStatus("Unsaved changes"); schedule(); };

  async function resolve(how) {
    const theirs = conflict; setConflict(null);
    try {
      if (how === "theirs") { const m = await client.open(sel.noteId); setSel(m); setDraft(m.payload ? { ...m.payload } : draftRef.current); dirty.current = false; setStatus(m.payload ? "Loaded their version" : "Their version cannot be opened"); }
      else if (how === "mine") { const m = await client.meta(sel.noteId); const merged = { ...sel, ...m, payload: sel.payload }; selRef.current = merged; setSel(merged); dirty.current = true; await persist(); }
      else if (how === "copy") { const r = await client.create({ ...draftRef.current, title: `${draftRef.current.title || "Untitled"} (my copy)` }); const m = await client.open(sel.noteId); setSel(m); setDraft(m.payload ? { ...m.payload } : draftRef.current); dirty.current = false; await reload("active"); setStatus(`Your version was saved as a new note (${r.noteId.slice(0, 6)}).`); }
    } catch (e) { setErr(e.message); setConflict(theirs); }
  }

  const mutate = async (fn) => { try { await fn(); bump((x) => x + 1); } catch (e) { setErr(e.message); } };
  const lifecycle = async (action) => {
    try {
      if (action === "trash") await client.trash(sel.noteId); else if (action === "restore") await client.restore(sel.noteId);
      else if (action === "delete") { if (!window.confirm("Delete this note forever? This cannot be undone.")) return; await client.deletePermanently(sel.noteId); }
      else if (action === "leave") { if (!window.confirm("Leave this note? You will lose access.")) return; await client.leave(sel.noteId); }
      setSel(null); setDraft(null); await reload(filter === "trash" ? "trashed" : "active");
    } catch (e) { setErr(e.message); }
  };

  if (phase === "loading") return <p className={`text-[12px] ${muted}`}>Loading…</p>;
  if (phase === "error") return <EmptyState title="Secure Notes" description={err} />;
  if (phase !== "ready") return <Gate client={client} hasVault={phase === "locked"} onReady={() => setPhase("ready")} />;

  const tagList = Object.entries(ix.tags);
  const FILTERS = [["all", "All"], ["pinned", "Pinned"], ["favorites", "Favorites"], ["shared", "Shared"], ["archived", "Archived"], ["trash", "Trash"]];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(([k, label]) => <button key={k} className={`${btn} ${filter === k ? "!bg-[#00f2fe]/15 !border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => { setFilter(k); setSel(null); setDraft(null); }}>{label}</button>)}
        <input className={`${field} !w-48 ml-auto`} placeholder="Search your notes" aria-label="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="New note" className={`${field} !w-auto`} value="" onChange={(e) => e.target.value && newNote(e.target.value)}><option value="">+ New note…</option>{TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
        <button className={btn} onClick={() => setModal("account")}>Passphrase</button>
        <button className={btn} onClick={() => { client.lock(); setPhase("locked"); setSel(null); setDraft(null); setNotes([]); }}>Lock</button>
      </div>
      {err && <p className="text-red-400 text-[12px]" role="alert">{err} <button className="underline" onClick={() => setErr("")}>dismiss</button></p>}
      <p className={`text-[11px] ${muted}`}>Search runs in this browser over notes it has decrypted. Inaya sees who a note is shared with, its size and times, never the title or text.</p>

      <div className="grid md:grid-cols-[280px_1fr] gap-3">
        <div className="space-y-2">
          {tagList.length > 0 && <div className="flex flex-wrap gap-1">{tagList.map(([id, t]) => <button key={id} className={`${btn} ${tag === id ? "!border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setTag(tag === id ? "" : id)}>#{t.name}</button>)}</div>}
          {visible.length === 0 ? <EmptyState compact icon="📝" description={filter === "trash" ? "The trash is empty." : "No notes here yet. Use + New note."} /> : visible.map((n) => (
            <button key={n.noteId} className={`${card} w-full text-left p-2.5 ${sel?.noteId === n.noteId ? "!border-[#00f2fe]/40" : ""}`} onClick={() => openNote(n)}>
              <p className="text-[12px] font-bold truncate">{ix.pins.includes(n.noteId) ? "📌 " : ""}{ix.favorites.includes(n.noteId) ? "★ " : ""}{n.payload?.title || (n.payload ? "Untitled" : "Cannot be opened")}</p>
              <p className={`text-[11px] truncate ${muted}`}>{n.payload ? plain(n.payload).slice(0, 80) || TYPE_LABEL[n.payload.type] : n.error}</p>
              <p className={`text-[10px] ${muted}`}>{when(n.updatedAt)}{n.participants.length > 1 ? ` · shared with ${n.participants.length - 1}` : ""}{n.perm === "read" ? " · read only" : ""}{(ix.noteTags[n.noteId] || []).map((t) => ix.tags[t] && ` #${ix.tags[t].name}`)}</p>
            </button>))}
        </div>

        <div className={`${card} p-3 min-h-[320px]`}>
          {!sel || !draft ? <EmptyState compact icon="🔒" description="Choose a note, or create one. Everything is encrypted before it leaves this browser." /> : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input className={`${field} flex-1 !text-[14px] font-bold`} placeholder="Title" aria-label="Title" value={draft.title} readOnly={readOnly} onChange={(e) => edit({ title: e.target.value })} />
                <span className={`text-[11px] ${muted}`} aria-live="polite">{status}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {sel.state !== "trashed" && <><button className={btn} onClick={() => mutate(() => client.pin(sel.noteId, !ix.pins.includes(sel.noteId)))}>{ix.pins.includes(sel.noteId) ? "Unpin" : "Pin"}</button>
                  <button className={btn} onClick={() => mutate(() => client.favorite(sel.noteId, !ix.favorites.includes(sel.noteId)))}>{ix.favorites.includes(sel.noteId) ? "Unfavorite" : "Favorite"}</button>
                  <button className={btn} onClick={() => mutate(() => client.archive(sel.noteId, !ix.archived.includes(sel.noteId)))}>{ix.archived.includes(sel.noteId) ? "Unarchive" : "Archive"}</button>
                  <button className={btn} onClick={() => setModal("tags")}>Tags</button><button className={btn} onClick={() => setModal("history")}>History</button><button className={btn} onClick={() => setModal("share")}>{sel.perm === "owner" ? "Share" : "People"}</button></>}
                {sel.perm === "owner" && (sel.state === "trashed" ? <><button className={btn} onClick={() => lifecycle("restore")}>Restore</button><button className={`${btn} !text-red-400`} onClick={() => lifecycle("delete")}>Delete forever</button></> : <button className={btn} onClick={() => lifecycle("trash")}>Move to trash</button>)}
                {sel.perm !== "owner" && <button className={btn} onClick={() => lifecycle("leave")}>Leave</button>}
              </div>
              <p className={`text-[11px] ${muted}`}>{TYPE_LABEL[draft.type]} · version {sel.rev} · last edited by {sel.lastEditedBy} {when(sel.updatedAt)}{sel.perm === "read" ? " · you can read this note but not change it" : ""}</p>
              {unreadable && <div className="border border-red-400/40 bg-red-400/10 rounded-lg p-3 text-[12px]" role="alert">The newest version of this note could not be opened. It may have been damaged or altered. Open <b>History</b> to restore an earlier version, which becomes the new latest version.</div>}
              {conflict && (
                <div className="border border-amber-400/40 bg-amber-400/10 rounded-lg p-3 text-[12px] space-y-2" role="alert">
                  <p><b>{conflict.by}</b> saved a newer version ({when(conflict.at)}). Nothing was overwritten. Choose what to keep:</p>
                  {conflict.payload && <pre className="bg-black/40 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">{conflict.payload.title}{"\n"}{plain(conflict.payload).slice(0, 400)}</pre>}
                  <div className="flex flex-wrap gap-2"><button className={btn} onClick={() => resolve("theirs")}>Use their version</button><button className={btn} onClick={() => resolve("mine")}>Keep mine as the newest</button><button className={btn} onClick={() => resolve("copy")}>Save mine as a separate note</button></div>
                </div>)}
              {draft.type === "rich" ? <RichEditor value={draft.body} readOnly={readOnly} onChange={(body) => edit({ body })} />
                : draft.type === "checklist" ? <Checklist items={draft.items || []} readOnly={readOnly} onChange={(items) => edit({ items })} />
                : draft.type === "markdown" ? (<div className="grid lg:grid-cols-2 gap-2"><textarea className={`${field} min-h-[220px] font-mono`} aria-label="Note body" value={draft.body} readOnly={readOnly} onChange={(e) => edit({ body: e.target.value })} /><div className={`${field} min-h-[220px] overflow-auto`} aria-label="Preview"><Markdown text={draft.body} /></div></div>)
                : <>{draft.type === "code" && <input className={`${field} !w-40`} placeholder="Language (optional)" aria-label="Language" value={draft.lang || ""} readOnly={readOnly} onChange={(e) => edit({ lang: e.target.value })} />}
                  <textarea className={`${field} min-h-[260px] ${draft.type === "code" ? "font-mono" : ""}`} aria-label="Note body" spellCheck={draft.type !== "code"} value={draft.body} readOnly={readOnly} onChange={(e) => edit({ body: e.target.value })} /></>}
            </div>)}
        </div>
      </div>

      {modal === "tags" && sel && <TagsModal client={client} noteId={sel.noteId} onClose={() => { setModal(null); bump((x) => x + 1); }} />}
      {modal === "history" && sel && <HistoryModal client={client} meta={sel} canRestore={!readOnly || (sel.payload === null && sel.perm !== "read" && sel.state !== "trashed")} onClose={() => setModal(null)} onRestored={async () => { setModal(null); await openNote(sel); await reload(); }} />}
      {modal === "share" && sel && <ShareModal client={client} meta={sel} orgId={orgId} onClose={async () => { setModal(null); try { const m = await client.open(sel.noteId); setSel(m); } catch { setSel(null); setDraft(null); } await reload(); }} />}
      {modal === "account" && <AccountModal client={client} onClose={() => setModal(null)} />}
    </div>
  );
}

// ---- picker used by Secure Chat to attach a note reference -----------------------------------------------------------
export function NotePicker({ orgId, email, onPick, onClose }) {
  const client = useMemo(() => new NotesClient({ api: makeApi(orgId), email }), [orgId, email]);
  const [phase, setPhase] = useState("loading"); const [notes, setNotes] = useState([]); const [err, setErr] = useState("");
  useEffect(() => { client.hasVault().then((h) => setPhase(h ? "locked" : "none")).catch((e) => { setErr(e.message); setPhase("error"); }); }, [client]);
  const ready = async () => { try { setNotes((await client.list()).filter((n) => n.payload)); setPhase("ready"); } catch (e) { setErr(e.message); } };
  return (
    <Modal title="Attach a note" onClose={onClose}>
      {phase === "loading" && <p className={`text-[12px] ${muted}`}>Loading…</p>}
      {phase === "none" && <p className={`text-[12px] ${muted}`}>You have not set up Secure Notes yet. Open Secure Notes first.</p>}
      {phase === "locked" && <Gate client={client} hasVault onReady={ready} />}
      {phase === "ready" && (notes.length === 0 ? <p className={`text-[12px] ${muted}`}>You have no notes yet.</p> : notes.map((n) => <button key={n.noteId} className={`${card} w-full text-left p-2 mb-1 text-[12px]`} onClick={() => onPick({ noteId: n.noteId, title: n.payload.title || "Untitled" })}>{n.payload.title || "Untitled"}</button>))}
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      <p className={`text-[11px] ${muted} mt-2`}>Only a reference is sent. People in the chat can open the note only if it is shared with them.</p>
    </Modal>
  );
}

// ---- dialogs -----------------------------------------------------------------------------------------------------
function TagsModal({ client, noteId, onClose }) {
  const [name, setName] = useState(""); const [err, setErr] = useState(""); const [, bump] = useState(0);
  const run = async (fn) => { setErr(""); try { await fn(); bump((x) => x + 1); } catch (e) { setErr(e.message); } };
  const ix = client.index;
  return (
    <Modal title="Tags" onClose={onClose}>
      <p className={`text-[12px] ${muted} mb-2`}>Tags are private to you and stored encrypted. Other people on a shared note do not see them.</p>
      {Object.entries(ix.tags).map(([id, t]) => (
        <div key={id} className="flex items-center gap-2 mb-1">
          <input type="checkbox" aria-label={`Tag ${t.name}`} checked={(ix.noteTags[noteId] || []).includes(id)} onChange={(e) => run(() => client.tagNote(noteId, id, e.target.checked))} />
          <input className={field} aria-label={`Rename ${t.name}`} defaultValue={t.name} onBlur={(e) => e.target.value.trim() && e.target.value !== t.name && run(() => client.renameTag(id, e.target.value))} />
          <button className={`${btn} !text-red-400`} onClick={() => window.confirm(`Delete the tag "${t.name}" from all notes?`) && run(() => client.deleteTag(id))}>Delete</button>
        </div>))}
      <div className="flex gap-2 mt-2"><input className={field} placeholder="New tag" aria-label="New tag" value={name} onChange={(e) => setName(e.target.value)} /><button className={accent} onClick={() => run(async () => { const id = await client.createTag(name); await client.tagNote(noteId, id, true); setName(""); })}>Add</button></div>
      {err && <p className="text-red-400 text-[12px] mt-2" role="alert">{err}</p>}
    </Modal>
  );
}
function HistoryModal({ client, meta, canRestore, onClose, onRestored }) {
  const [rows, setRows] = useState(null); const [view, setView] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { client.history(meta.noteId).then((r) => setRows(r.revisions)).catch((e) => setErr(e.message)); }, [client, meta.noteId]);
  return (
    <Modal title="Version history" onClose={onClose}>
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      {!rows ? <p className={`text-[12px] ${muted}`}>Loading…</p> : rows.map((r) => (
        <div key={r.rev} className="flex items-center gap-2 py-1.5 border-t border-[var(--inaya-overlay-10)] first:border-0 text-[12px]">
          <span className="flex-1">Version {r.rev}{r.rev === meta.rev ? " (current)" : ""} · {r.by} · {when(r.at)}</span>
          <button className={btn} onClick={async () => { try { setView({ rev: r.rev, ...(await client.revisionPayload(meta, r.rev)) }); } catch (e) { setErr(e.message); } }}>View</button>
          {canRestore && r.rev !== meta.rev && <button className={btn} onClick={async () => { try { await client.restoreRevision(meta, r.rev); onRestored(); } catch (e) { setErr(e instanceof ConflictError ? "The note changed while you were looking. Reopen it and try again." : e.message); } }}>Restore</button>}
        </div>))}
      {view && <div className={`${card} p-2 mt-2`}><p className="text-[12px] font-bold">{view.payload.title || "Untitled"}</p><pre className="text-[12px] whitespace-pre-wrap max-h-48 overflow-auto">{plain(view.payload)}</pre></div>}
      <p className={`text-[11px] ${muted} mt-2`}>Restoring adds the old text as a new version; nothing is erased. The latest {200} versions are kept.</p>
    </Modal>
  );
}
function ShareModal({ client, meta, orgId, onClose }) {
  const [people, setPeople] = useState(null); const [target, setTarget] = useState(""); const [perm, setPerm] = useState("read"); const [err, setErr] = useState(""); const [fp, setFp] = useState(""); const [m, setM] = useState(meta); const [keyChange, setKeyChange] = useState(null);
  const owner = m.perm === "owner";
  const refresh = async () => setM(await client.open(meta.noteId));
  useEffect(() => { if (owner) client.people().then((r) => setPeople(r)).catch((e) => setErr(e.message)); }, [client, owner]);
  const run = async (fn) => { setErr(""); try { await fn(); await refresh().catch(() => {}); } catch (e) { if (e instanceof KeyChangedError) setKeyChange(e); else setErr(e.message); } };
  const candidates = (people?.people || []).filter((p) => !m.participants.some((x) => x.email === p.email));
  return (
    <Modal title={owner ? "Share this note" : "People on this note"} onClose={onClose}>
      <p className={`text-[12px] ${muted} mb-2`}>Only members who have set up Secure Notes can be added. The note key is sealed to each person in their browser. People you add can read the whole history. Removing someone changes the key, but cannot erase what they already read.</p>
      {m.participants.map((p) => (
        <div key={p.email} className="flex items-center gap-2 py-1 text-[12px]"><span className="flex-1">{p.email}</span>
          {p.perm === "owner" ? <span className={muted}>owner</span> : owner ? <><select aria-label={`Permission for ${p.email}`} className={`${field} !w-auto`} value={p.perm} onChange={(e) => run(() => client.setPermission(m.noteId, p.email, e.target.value))}><option value="read">Can read</option><option value="write">Can edit</option></select><button className={`${btn} !text-red-400`} onClick={() => window.confirm(`Remove ${p.email}? The note key will be changed.`) && run(() => client.removePerson(m, p.email))}>Remove</button></> : <span className={muted}>{p.perm === "write" ? "can edit" : "can read"}</span>}
        </div>))}
      {owner && (people === null ? <p className={`text-[12px] ${muted}`}>Loading…</p> : (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2"><select aria-label="Person" className={field} value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose a person…</option>{candidates.map((p) => <option key={p.email} value={p.email}>{p.email}</option>)}</select>
            <select aria-label="Permission" className={`${field} !w-auto`} value={perm} onChange={(e) => setPerm(e.target.value)}><option value="read">Can read</option><option value="write">Can edit</option></select>
            <button className={accent} disabled={!target} onClick={() => run(async () => { const r = await client.share(m, target, perm); setFp(r.fingerprint); setTarget(""); })}>Share</button></div>
          {people.withoutVault > 0 && <p className={`text-[11px] ${muted}`}>{people.withoutVault} other member{people.withoutVault === 1 ? " has" : "s have"} not set up Secure Notes yet.</p>}
          {fp && <p className={`text-[11px] ${muted}`}>Shared. Their key fingerprint is <code>{fp}</code>. Compare it with them if you want to be sure it is really their key.</p>}
          {keyChange && <div className="border border-amber-400/40 bg-amber-400/10 rounded-lg p-2 text-[12px] space-y-1" role="alert"><p>{keyChange.email}'s key is different from the one you shared with before. This can happen if they reset Secure Notes, but it could also mean something is wrong. Check with them first.</p><p>Before: <code>{keyChange.was}</code><br />Now: <code>{keyChange.now}</code></p><button className={btn} onClick={() => { const t = keyChange.email; setKeyChange(null); run(async () => { const r = await client.share(m, t, perm, { acceptKeyChange: true }); setFp(r.fingerprint); }); }}>I checked, share anyway</button></div>}
        </div>))}
      {err && <p className="text-red-400 text-[12px] mt-2" role="alert">{err}</p>}
    </Modal>
  );
}
function AccountModal({ client, onClose }) {
  const [oldp, setOld] = useState(""); const [newp, setNew] = useState(""); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  return (
    <Modal title="Change your notes passphrase" onClose={onClose}>
      <p className={`text-[12px] ${muted} mb-2`}>Your notes are not re-encrypted; only the wrapping of your key changes. Inaya cannot recover a forgotten passphrase.</p>
      <div className="space-y-2">
        <input type="password" className={field} placeholder="Current passphrase" aria-label="Current passphrase" value={oldp} onChange={(e) => setOld(e.target.value)} />
        <input type="password" className={field} placeholder="New passphrase (at least 10 characters)" aria-label="New passphrase" value={newp} onChange={(e) => setNew(e.target.value)} />
        <button className={accent} disabled={!oldp || !newp} onClick={async () => { setErr(""); setMsg(""); try { await client.changePassphrase(oldp, newp); setMsg("Passphrase changed."); setOld(""); setNew(""); } catch (e) { setErr(e.message); } }}>Change passphrase</button>
        {msg && <p className="text-emerald-400 text-[12px]" role="status">{msg}</p>}{err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}
