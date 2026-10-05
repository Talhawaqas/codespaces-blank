"use client";

// src/components/business/chat/ChatView.js
//
// Secure Chat (Competitive Expansion SOW workstream A, UI spec section 37): conversation list on the left, the conversation in
// the middle, context and security details on the right. Plain, honest security wording; no badge that claims more than is
// verified. Messages are encrypted in this browser before they are sent (see useChat.js).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChat } from "./useChat";
import EmptyState from "../../EmptyState";
import { NotePicker } from "../notes/NotesView";
import { inayaNoteRef, inayaDocRef } from "../../../lib/chat/client/attachments";
import DocPicker from "./DocPicker";
import { reportMetric } from "./reportMetric.js";
import { isDesktopApp, popOutChat } from "./desktop.js";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[12px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-3 py-2 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accentBtn = "text-[12px] font-bold uppercase bg-[#00f2fe]/15 border border-[#00f2fe]/40 px-3 py-2 rounded-lg text-[#00f2fe] hover:bg-[#00f2fe]/25 disabled:opacity-40";

const timeOf = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const dayOf = (iso) => { try { return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return ""; } };
const initials = (e) => String(e || "?").slice(0, 2).toUpperCase();
const sizeOf = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function titleFor(conv, titles, me, peers) {
  if (titles[conv.id]) return titles[conv.id];
  const others = (peers?.[conv.id] || conv.participants || []).filter((p) => p.email !== me && p.status !== "removed" && p.status !== "left").map((p) => p.email.split("@")[0]);
  if (conv.kind === "direct") return others[0] || "Direct conversation";
  return others.length ? others.slice(0, 3).join(", ") + (others.length > 3 ? ` +${others.length - 3}` : "") : "New conversation";
}

function Avatar({ email, online }) {
  return (
    <span className="relative inline-flex w-8 h-8 shrink-0 items-center justify-center rounded-full bg-[var(--inaya-overlay-10)] text-[11px] font-bold text-[var(--inaya-text-primary)]">
      {initials(email)}
      {online !== undefined && <span aria-label={online ? "online" : "offline"} className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-[var(--inaya-bg,#0b0f14)] ${online ? "bg-emerald-400" : "bg-slate-500"}`} />}
    </span>
  );
}

function AttachmentView({ client, convId, att, embedDisabled = false }) {
  const [url, setUrl] = useState(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const isImage = !embedDisabled && att.kind === "blob" && /^image\/(png|jpe?g|gif|webp)$/.test(att.type || "") && att.plainSize <= 6 * 1048576;
  useEffect(() => {
    let revoke; let off = false;
    if (isImage) (async () => { try { const b = await client.downloadAttachment(convId, att); if (off) return; revoke = URL.createObjectURL(new Blob([b], { type: att.type })); setUrl(revoke); } catch (e) { setErr(e.message); } })();
    return () => { off = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [client, convId, att, isImage]);
  async function download() {
    setBusy(true); setErr("");
    try { const b = await client.downloadAttachment(convId, att); const u = URL.createObjectURL(new Blob([b], { type: att.type })); const a = document.createElement("a"); a.href = u; a.download = att.name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  if (att.kind === "inaya-note") { const ok = /^[0-9a-f]{24}$/.test(String(att.noteId)); return <div className={`${card} px-3 py-2 text-[12px]`}>Secure note: <b>{String(att.title || "Untitled").slice(0, 120)}</b> {ok && <a className="underline text-[#00f2fe]" href={`/business?view=notes&note=${att.noteId}`}>Open</a>} <span className={muted}>You need access to the note and your notes passphrase.</span></div>; }
  if (att.kind === "inaya-doc") return <div className={`${card} px-3 py-2 text-[12px]`}>Inaya document: <b>{att.name}</b> <span className={muted}>{att.size > 0 ? `(${sizeOf(att.size)})` : ""}. Open it from Files; your normal access rules apply.</span></div>;
  return (
    <div className={`${card} px-3 py-2 text-[12px] max-w-xs`}>
      {url && <img src={url} alt={att.name} className="rounded mb-2 max-h-56" />}
      <div className="flex items-center justify-between gap-3">
        <span className="truncate">{att.name} <span className={muted}>{sizeOf(att.plainSize)} · encrypted</span></span>
        <button className={btn} onClick={download} disabled={busy}>{busy ? "…" : "Save"}</button>
      </div>
      {err && <p className="text-red-400 mt-1">{err}</p>}
    </div>
  );
}

function NewChat({ client, me, onClose, onCreate }) {
  const [q, setQ] = useState(""); const [searched, setSearched] = useState(""); const [people, setPeople] = useState([]); const [picked, setPicked] = useState([]); const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  useEffect(() => { if (q.trim().length < 2) { setPeople([]); return; } const t = setTimeout(async () => { try { const r = await client.api.contacts(q.trim()); setPeople(r.people || []); setSearched(q.trim()); } catch { /* ignore */ } }, 250); return () => clearTimeout(t); }, [q, client]);
  async function go() {
    setBusy(true); setErr("");
    try { await onCreate({ kind: picked.length === 1 ? "direct" : "group", emails: picked, name: name.trim() }); onClose(); } catch (e) { setErr(e.message); setBusy(false); }
  }
  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="New secure chat">
      <div className={`${card} bg-[var(--inaya-bg,#0b0f14)] w-full max-w-md p-5`}>
        <h3 className="text-sm font-bold mb-3">New secure chat</h3>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people in your organization" className="w-full bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-3 py-2 text-sm" />
        <div className="mt-2 max-h-40 overflow-auto">
          {people.map((p) => <button key={p.email} className="block w-full text-left px-2 py-1.5 text-sm hover:bg-[var(--inaya-overlay-10)] rounded" onClick={() => { setPicked((x) => (x.includes(p.email) ? x : [...x, p.email])); setQ(""); }}>{p.email}</button>)}
          {q.trim().length >= 2 && searched === q.trim() && !people.length && <p className={`text-xs ${muted} px-2 py-1`}>No one found. You can only chat with people in your organization.</p>}
        </div>
        {picked.length > 0 && <div className="flex flex-wrap gap-1 mt-3">{picked.map((e) => <span key={e} className="text-xs bg-[#00f2fe]/10 border border-[#00f2fe]/30 rounded-full px-2 py-1">{e} <button aria-label={`Remove ${e}`} onClick={() => setPicked((x) => x.filter((y) => y !== e))}>×</button></span>)}</div>}
        {picked.length > 1 && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name (optional, encrypted)" maxLength={120} className="w-full mt-3 bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-3 py-2 text-sm" />}
        <p className={`text-[11px] ${muted} mt-3`}>End-to-end encrypted. People who join later cannot read earlier messages.</p>
        {err && <p className="text-red-400 text-xs mt-2">{err}</p>}
        <div className="flex justify-end gap-2 mt-4"><button className={btn} onClick={onClose}>Cancel</button><button className={accentBtn} onClick={go} disabled={busy || !picked.length}>{busy ? "Creating…" : "Start chat"}</button></div>
      </div>
    </div>, document.body
  );
}

function ContactsPanel({ client, onClose }) {
  const [data, setData] = useState({ contacts: [], incoming: [], outgoing: [], blocked: [] }); const [to, setTo] = useState(""); const [purpose, setPurpose] = useState(""); const [msg, setMsg] = useState("");
  const load = useCallback(async () => { try { setData(await client.api.contactList()); } catch (e) { setMsg(e.message); } }, [client]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn) => { try { await fn(); setMsg(""); } catch (e) { setMsg(e.message); } load(); };
  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Contacts">
      <div className={`${card} bg-[var(--inaya-bg,#0b0f14)] w-full max-w-lg p-5 max-h-[85vh] overflow-auto`}>
        <div className="flex justify-between items-center mb-3"><h3 className="text-sm font-bold">Contacts and requests</h3><button className={btn} onClick={onClose}>Close</button></div>
        <div className="flex gap-2 mb-1"><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Email address" className="flex-1 bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-3 py-2 text-sm" /><button className={accentBtn} disabled={!to} onClick={() => act(async () => { await client.api.requestContact({ to, purpose }); setTo(""); setPurpose(""); })}>Request</button></div>
        <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Why you want to connect (required outside your organization)" maxLength={140} className="w-full mb-3 bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-3 py-2 text-xs" />
        {msg && <p className="text-red-400 text-xs mb-2">{msg}</p>}
        {[["Incoming requests", data.incoming, (r) => (<><span>{r.from}{r.purpose ? <span className={muted}> — {r.purpose}</span> : null}</span><span className="flex gap-1"><button className={accentBtn} onClick={() => act(() => client.api.acceptRequest(r.id))}>Accept</button><button className={btn} onClick={() => act(() => client.api.denyRequest(r.id))}>Deny</button></span></>)],
          ["Sent requests", data.outgoing, (r) => (<><span>{r.to}</span><button className={btn} onClick={() => act(() => client.api.cancelRequest(r.id))}>Cancel</button></>)],
          ["Contacts", data.contacts, (r) => (<><span>{r.email}</span><span className="flex gap-1"><button className={btn} onClick={() => act(() => client.api.removeContact(r.id))}>Remove</button><button className={btn} onClick={() => act(() => client.api.block(r.email))}>Block</button></span></>)],
          ["Blocked", data.blocked, (r) => (<><span>{r.email}</span><button className={btn} onClick={() => act(() => client.api.unblock(r.email))}>Unblock</button></>)]].map(([label, rows, render]) => (
          <div key={label} className="mb-3"><p className={`text-[11px] uppercase tracking-wide ${muted} mb-1`}>{label} ({rows.length})</p>
            {rows.map((r, i) => <div key={r.id || r.email || i} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-[var(--inaya-overlay-10)]">{render(r)}</div>)}</div>))}
      </div>
    </div>, document.body
  );
}

export default function ChatView({ orgId, email, canManage }) {
  const chat = useChat({ orgId, email });
  const { status, error, takeOver, conversations, titles, last, peers, tick } = chat;
  const [sel, setSel] = useState(null); const [detail, setDetail] = useState(null); const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState(""); const [files, setFiles] = useState([]); const [noteRef, setNoteRef] = useState(null); const [pickNote, setPickNote] = useState(false); const [docRefs, setDocRefs] = useState([]); const [pickDoc, setPickDoc] = useState(false); const [sendErr, setSendErr] = useState(""); const [sending, setSending] = useState(false);
  const [search, setSearch] = useState(""); const [hits, setHits] = useState([]); const [showNew, setShowNew] = useState(false); const [showContacts, setShowContacts] = useState(false);
  const [typing, setTyping] = useState([]); const [online, setOnline] = useState({}); const [receipts, setReceipts] = useState([]); const [prefs, setPrefs] = useState({ appearOffline: false });
  const [netOnline, setNetOnline] = useState(true); const [usage, setUsage] = useState(null);
  useEffect(() => {
    const sync = () => setNetOnline(navigator.onLine !== false); sync();
    window.addEventListener("online", sync); window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);
  useEffect(() => { navigator.storage?.estimate?.().then((e) => setUsage(e?.usage ?? null)).catch(() => {}); }, [status, tick]);
  const [showInfo, setShowInfo] = useState(false); const [orgSettings, setOrgSettings] = useState(null); const [addEmail, setAddEmail] = useState(""); const [renaming, setRenaming] = useState(""); const endRef = useRef(null); const lastTyping = useRef(0);
  const client = chat.client();

  const open = conversations.find((c) => c.id === sel) || null;
  const members = useMemo(() => (detail?.roster || []).filter((p) => p.status === "active" || p.status === "pending"), [detail]);

  // load the open conversation (local decrypted cache + server detail)
  useEffect(() => {
    if (!client || !sel) return; let off = false;
    (async () => {
      const m = await client.messages(sel); if (off) return; setMsgs(m);
      try { const d = await client.api.conversationDetail({ conversationId: sel }); if (!off) setDetail(d); } catch { /* conversation may be gone */ }
      const c = conversations.find((x) => x.id === sel);
      if (c && c.lastSeq) client.api.markRead({ conversationId: sel, seq: c.lastSeq }).catch(() => {});
      client.api.receipts({ conversationId: sel }).then((r) => !off && setReceipts(r.receipts || [])).catch(() => {});
    })();
    return () => { off = true; };
  }, [client, sel, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs.length, sel]);

  // presence + typing + heartbeat. Every poll waits for its previous answer before the next is scheduled (a slow server must
  // never be buried under overlapping requests), pauses while the tab is hidden, and presence is asked far less often than typing.
  useEffect(() => {
    if (!client) return; let off = false; let timer;
    client.api.prefs().then((p) => !off && setPrefs(p)).catch(() => {});
    const beat = async () => { if (off) return; if (!document.hidden) await client.api.heartbeat().catch(() => {}); if (!off) timer = setTimeout(beat, 45000); };
    beat();
    return () => { off = true; clearTimeout(timer); };
  }, [client]);
  useEffect(() => {
    if (!client || !sel) return; let off = false; let timer;
    const loop = async () => {
      if (off) return;
      if (!document.hidden) { try { const r = await client.api.getTyping({ conversationId: sel }); if (!off) setTyping(r.typing || []); } catch { /* ignore */ } }
      if (!off) timer = setTimeout(loop, 5000);
    };
    loop(); return () => { off = true; clearTimeout(timer); };
  }, [client, sel]);
  const memberKey = members.map((p) => p.email).join(",");
  useEffect(() => {
    if (!client || !memberKey) return; let off = false; let timer;
    const loop = async () => {
      if (off) return;
      if (!document.hidden) { try { const p = await client.api.presence(memberKey.split(",")); if (!off) setOnline(Object.fromEntries((p.presence || []).map((x) => [x.email, x.state === "online"]))); } catch { /* ignore */ } }
      if (!off) timer = setTimeout(loop, 30000);
    };
    loop(); return () => { off = true; clearTimeout(timer); };
  }, [client, memberKey]);

  useEffect(() => { if (!client || search.trim().length < 2) { setHits([]); return; } client.search(search.trim()).then(setHits); }, [client, search, tick]);

  async function send() {
    if ((!text.trim() && !files.length && !noteRef && !docRefs.length) || !sel || sending) return;
    setSending(true); setSendErr("");
    try {
      await chat.run(async (c) => {
        const attachments = [];
        for (const f of files) attachments.push(await c.attachFile(sel, { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, type: f.type }));
        if (noteRef) attachments.push(inayaNoteRef(noteRef));
        for (const d of docRefs) attachments.push(inayaDocRef(d));
        const t0 = performance.now(); await c.send(sel, { text: text.trim(), attachments });
        if (!attachments.length) reportMetric(orgId, "chat.delivery_latency_ms", performance.now() - t0);
      });
      setText(""); setFiles([]); setNoteRef(null); setDocRefs([]); setMsgs(await client.messages(sel));
      client.api.setTyping({ conversationId: sel, typing: false }).catch(() => {});
    } catch (e) { setSendErr(e.queued ? "You appear to be offline. The message is saved and will send automatically when you are back online." : e.message); }
    finally { setSending(false); }
  }
  // Local drafts: restored when a conversation opens, saved shortly after typing stops, cleared on send. Stored in the sealed device store only.
  useEffect(() => { if (!client || !sel) { setText(""); return; } let off = false; client.getDraft(sel).then((d) => { if (!off) setText(d); }).catch(() => {}); return () => { off = true; }; }, [client, sel]);
  useEffect(() => { if (!client || !sel) return; const t = setTimeout(() => { client.setDraft(sel, text).catch(() => {}); }, 600); return () => clearTimeout(t); }, [client, sel, text]);
  function onType(v) { setText(v); const n = Date.now(); if (sel && n - lastTyping.current > 3000 && v) { lastTyping.current = n; client?.api.setTyping({ conversationId: sel, typing: true }).catch(() => {}); } }

  if (status === "unsupported") return <EmptyState title="This browser cannot run Secure Chat" description="Secure Chat needs a modern browser with WebCrypto and IndexedDB. Use the desktop app or a current browser." />;
  if (status === "off") return <EmptyState title="Secure Chat is not enabled" description={canManage ? "Ask your platform contact to enable FEATURE_SECURE_CHAT for this organization, or enable it from Settings." : "Your organization has not turned on Secure Chat yet."} />;
  if (status === "error") return <EmptyState title="Secure Chat could not start" description={error} />;
  if (status === "elsewhere") return <EmptyState title="Secure Chat is open in another window" description="Only one window can run Secure Chat at a time, so its encrypted conversations stay consistent. Use it here and the other window will stop." ctaLabel="Use Secure Chat in this window" onCta={takeOver} />;
  if (status === "switching") return <p className={`text-sm ${muted}`}>Switching Secure Chat to this window… the other window finishes its current update first, which can take a few seconds.</p>;
  if (status === "starting" || !client) return <p className={`text-sm ${muted}`}>Setting up end-to-end encryption on this device…</p>;

  const visible = conversations.filter((c) => !c.archived && (c.status === "active" || c.status === "pending"));
  const myRole = detail?.view?.me?.role; const canManageConv = myRole === "owner" || myRole === "admin" || (open?.kind === "org" && canManage);
  const unreadTotal = visible.reduce((n, c) => n + (c.unread || 0), 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-[11px]" aria-label="Connection and window">
        <span data-testid="chat-online" className={`px-2 py-0.5 rounded-full border ${netOnline ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/50 text-amber-300"}`}>{netOnline ? "Online" : "Offline: messages are saved on this device and send when you reconnect"}</span>
        {isDesktopApp() && <button className={btn} onClick={() => popOutChat()}>Open Secure Chat in its own window</button>}
      </div>
    <div className="grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_280px] gap-3 min-h-[70vh]">
      {/* left */}
      <div className={`${card} p-3 flex flex-col`}>
        <div className="flex gap-2 mb-2"><button className={accentBtn} onClick={() => setShowNew(true)}>New chat</button><button className={btn} onClick={() => setShowContacts(true)}>Contacts</button></div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search messages on this device" aria-label="Search messages" className="w-full mb-2 bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-3 py-2 text-sm" />
        {hits.length > 0 && <div className="mb-2 max-h-40 overflow-auto text-xs">{hits.map((h) => <button key={h.serverId} onClick={() => { setSel(h.conversationId); setSearch(""); }} className="block w-full text-left p-1.5 hover:bg-[var(--inaya-overlay-10)] rounded"><span className={muted}>{h.from} · {dayOf(h.at)}</span><br />{h.text.slice(0, 80)}</button>)}</div>}
        <div className="flex-1 overflow-auto -mx-1" role="list" aria-label="Conversations">
          {visible.length === 0 && <p className={`text-xs ${muted} p-2`}>No conversations yet. Start one with New chat.</p>}
          {visible.map((c) => (
            <button key={c.id} role="listitem" onClick={() => setSel(c.id)} className={`w-full text-left flex gap-2 items-center px-2 py-2 rounded-lg ${sel === c.id ? "bg-[#00f2fe]/10" : "hover:bg-[var(--inaya-overlay-5)]"}`}>
              <Avatar email={titleFor(c, titles, email, peers)} />
              <span className="min-w-0 flex-1"><span className="flex justify-between gap-2"><b className="truncate text-sm">{titleFor(c, titles, email, peers)}</b><span className={`text-[10px] ${muted}`}>{last[c.id] ? timeOf(last[c.id].at) : ""}</span></span>
                <span className={`block truncate text-xs ${muted}`}>{c.status === "pending" ? "Waiting for your device to join…" : last[c.id] ? last[c.id].text || "Attachment" : "Encrypted conversation"}</span></span>
              {c.muted && <span title="Muted" className={`text-[10px] ${muted}`}>muted</span>}
              {c.unread > 0 && <span aria-label={`${c.unread} unread`} className="min-w-[18px] h-[18px] px-1 rounded-full bg-[#00f2fe] text-black text-[10px] font-bold flex items-center justify-center">{c.unread}</span>}
            </button>))}
        </div>
        <p className={`text-[10px] ${muted} mt-2`}>{unreadTotal ? `${unreadTotal} unread · ` : ""}{isDesktopApp() ? "This app is one device." : "This browser is one device."} Chats on other devices are separate and new devices see only new messages.</p>
      </div>

      {/* center */}
      <div className={`${card} flex flex-col min-h-[70vh] min-w-0`}>
        {!open ? <div className="m-auto text-center p-8"><p className="text-sm font-bold">Select a conversation</p><p className={`text-xs ${muted} mt-1`}>End-to-end encrypted. Messages are encrypted on your device before transmission.</p></div> : (<>
          <div className="px-4 py-3 border-b border-[var(--inaya-overlay-10)]">
            <div className="flex justify-between items-center gap-3"><div className="min-w-0"><h3 className="font-bold truncate">{titleFor({ ...open, participants: detail?.view?.participants || open.participants }, titles, email, peers)}</h3>
              <p className={`text-[11px] ${muted} truncate`}>{members.map((p) => p.email).join(", ")}</p></div>
              <span className={`text-[11px] ${muted} text-right hidden lg:block shrink-0`}>End-to-end encrypted conversation<br />Messages are encrypted on your device before transmission.</span></div>
            <p className={`text-[11px] ${muted} lg:hidden mt-1`}>End-to-end encrypted. Messages are encrypted on your device before transmission.</p>
            <button className={`${btn} mt-2 xl:hidden`} onClick={() => setShowInfo((v) => !v)} aria-expanded={showInfo}>{showInfo ? "Hide details" : "People and details"}</button>
            {detail?.plan?.noDevices?.length > 0 && <p className="text-[11px] text-amber-300 mt-1">Waiting for {detail.plan.noDevices.join(", ")} to open Secure Chat once. They have no device set up yet.</p>}
          </div>
          <div className="flex-1 overflow-auto p-4 space-y-3" aria-live="polite">
            {msgs.length === 0 && <p className={`text-xs ${muted} text-center`}>No messages yet. {open.status === "pending" ? "This conversation will open when your device joins." : ""}</p>}
            {msgs.map((m, i) => { const mine = m.from === email; const showDay = i === 0 || dayOf(msgs[i - 1].at) !== dayOf(m.at); return (
              <div key={m.serverId || m.clientMsgId}>
                {showDay && <p className={`text-center text-[10px] ${muted} my-2`}>{dayOf(m.at)}</p>}
                <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${mine ? "bg-[#00f2fe]/15 border border-[#00f2fe]/30" : "bg-[var(--inaya-overlay-10)]"}`}>
                    {!mine && <p className={`text-[10px] ${muted} mb-0.5`}>{m.from}</p>}
                    {m.deleted ? <i className={muted}>Message deleted</i> : <>
                      {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
                      <div className="space-y-2 mt-1">{(m.attachments || []).map((a, j) => <AttachmentView key={j} client={client} convId={sel} att={a} embedDisabled={!!m.embedDisabled} />)}</div></>}
                    <p className={`text-[10px] ${muted} mt-1 text-right`}>{timeOf(m.at)}{m.editedAt ? " · edited" : ""}{mine ? ` · ${receipts.filter((r) => r.email !== email && r.readSeq >= m.seq).length ? "seen" : "sent"}` : ""}
                      {mine && !m.deleted && (m.attachments || []).some((a) => a.kind === "blob" && /^image\//.test(a.type || "")) && <> · <button className="underline" onClick={async () => { try { await chat.run((c) => c.setEmbed(sel, m.serverId, !m.embedDisabled)); setMsgs(await client.messages(sel)); } catch (e) { setSendErr(e.message); } }}>{m.embedDisabled ? "show previews" : "hide previews"}</button></>}
                      {mine && !m.deleted && <> · <button className="underline" onClick={async () => { const t = window.prompt("Edit message", m.text); if (t != null && t !== m.text) { try { await chat.run((c) => c.editMessage(sel, m.serverId, t)); setMsgs(await client.messages(sel)); } catch (e) { setSendErr(e.message); } } }}>edit</button> · <button className="underline" onClick={async () => { if (window.confirm("Delete this message for everyone?")) { try { await chat.run((c) => c.deleteMessage(sel, m.serverId)); setMsgs(await client.messages(sel)); } catch (e) { setSendErr(e.message); } } }}>delete</button></>}</p>
                  </div></div></div>); })}
            <div ref={endRef} />
          </div>
          <div className="px-4 pb-1 h-5 text-[11px]" aria-live="polite">{typing.length > 0 && <span className={muted}>{typing.map((e) => e.split("@")[0]).join(", ")} {typing.length > 1 ? "are" : "is"} typing…</span>}</div>
          {sendErr && <p className="text-amber-300 text-xs px-4 pb-1" role="alert">{sendErr}</p>}
          {docRefs.length > 0 && <div className="px-4 pb-1 flex flex-wrap gap-1">{docRefs.map((d, i) => <span key={d.documentId} className="text-xs bg-[var(--inaya-overlay-10)] rounded px-2 py-1">Document: {d.name} <button aria-label={`Remove ${d.name}`} onClick={() => setDocRefs((x) => x.filter((_, j) => j !== i))}>×</button></span>)}</div>}
          {noteRef && <div className="px-4 pb-1"><span className="text-xs bg-[var(--inaya-overlay-10)] rounded px-2 py-1">Note: {noteRef.title} <button aria-label="Remove note" onClick={() => setNoteRef(null)}>×</button></span></div>}
          {files.length > 0 && <div className="px-4 pb-1 flex flex-wrap gap-1">{files.map((f, i) => <span key={i} className="text-xs bg-[var(--inaya-overlay-10)] rounded px-2 py-1">{f.name} ({sizeOf(f.size)}) <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>×</button></span>)}</div>}
          <div className="p-3 border-t border-[var(--inaya-overlay-10)] flex gap-2 items-end">
            <button className={btn} type="button" title="Attach a reference to one of your Secure Notes" onClick={() => setPickNote(true)}>Note</button>
            <button className={btn} type="button" title="Attach a reference to one of your Inaya documents" onClick={() => setPickDoc(true)}>Document</button>
            <label className={`${btn} cursor-pointer`} title="Attach a file (encrypted on this device, up to 25 MB)">Attach<input type="file" multiple className="hidden" onChange={(e) => { const picked = Array.from(e.target.files || []); setFiles((x) => [...x, ...picked].slice(0, 5)); e.target.value = ""; }} /></label>
            <textarea value={text} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} rows={1} placeholder="Write an encrypted message" aria-label="Message" className="flex-1 resize-none bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-3 py-2 text-sm max-h-32" />
            <button className={accentBtn} onClick={send} disabled={sending || (!text.trim() && !files.length && !noteRef && !docRefs.length)}>{sending ? "Sending…" : "Send"}</button>
          </div></>)}
      </div>

      {/* right */}
      {open && (
        <div className={`${card} p-3 ${showInfo ? "block" : "hidden"} xl:block overflow-auto`}>
          <h4 className="text-xs font-bold uppercase mb-2">People ({members.length})</h4>
          {members.map((p) => (
            <div key={p.email} className="text-sm mb-2">
              <div className="flex items-center gap-2"><Avatar email={p.email} online={prefs.appearOffline && p.email === email ? false : online[p.email]} /><span className="truncate flex-1">{p.email}{p.role === "owner" ? " (owner)" : p.role === "admin" ? " (admin)" : ""}{p.status === "pending" ? " · joining" : ""}</span>
                {canManageConv && p.email !== email && open.kind !== "direct" && <button className={btn} onClick={async () => { if (window.confirm(`Remove ${p.email}? They will not be able to read new messages.`)) { try { await chat.run((c) => c.removeParticipant(sel, p.email)); } catch (e) { setSendErr(e.message); } } }}>Remove</button>}</div>
              <p className={`text-[10px] ${muted} ml-10 break-all`} title="Compare this safety number with the person over a trusted channel to confirm no one is impersonating them.">Safety number: {client.safetyNumber(detail.roster, p.email) || "no device yet"}</p>
            </div>))}
          {canManageConv && open.kind !== "direct" && (<div className="mt-3"><input value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="Add person by email" className="w-full bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-2 py-1.5 text-xs" /><button className={`${accentBtn} mt-1`} disabled={!addEmail} onClick={async () => { try { await chat.run((c) => c.addParticipants(sel, [addEmail.trim()])); setAddEmail(""); } catch (e) { setSendErr(e.message); } }}>Add (no history)</button>
            <input value={renaming} onChange={(e) => setRenaming(e.target.value)} placeholder="Rename conversation" maxLength={120} className="w-full mt-3 bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-2 py-1.5 text-xs" /><button className={`${btn} mt-1`} disabled={!renaming} onClick={async () => { try { await chat.run((c) => c.rename(sel, renaming.trim())); setRenaming(""); } catch (e) { setSendErr(e.message); } }}>Rename</button></div>)}
          <h4 className="text-xs font-bold uppercase mt-5 mb-2">This conversation</h4>
          <div className="flex flex-col gap-2">
            <button className={btn} onClick={() => chat.run(() => client.api.patchConversation(sel, { muted: !open.muted }))}>{open.muted ? "Unmute" : "Mute"}</button>
            <button className={btn} onClick={() => chat.run(() => client.api.patchConversation(sel, { archived: true })).then(() => setSel(null))}>Archive</button>
            {open.kind !== "direct" && <button className={btn} onClick={async () => { if (window.confirm("Leave this conversation?")) { await chat.run((c) => c.leave(sel)); setSel(null); } }}>Leave</button>}
            <button className={btn} onClick={async () => { if (window.confirm(canManageConv || open.kind === "direct" ? "Delete this conversation for everyone? Stored encrypted messages are erased." : "Remove this conversation from your list?")) { await chat.run(() => client.api.deleteConversation(sel)); setSel(null); } }}>{canManageConv || open.kind === "direct" ? "Delete for everyone" : "Delete for me"}</button>
          </div>
          {canManage && (
            <>
              <h4 className="text-xs font-bold uppercase mt-5 mb-2">Organization chat policy</h4>
              {!orgSettings && <button className={btn} onClick={async () => { try { setOrgSettings(await client.api.chatSettings()); } catch (e) { setSendErr(e.message); } }}>Show settings</button>}
              {orgSettings && <label className="text-xs block mb-2">When someone signs out of the app
                <select aria-label="Sign-out policy" value={orgSettings.signOutPolicy || "keep"} onChange={async (e) => { try { setOrgSettings(await client.api.setChatSettings({ signOutPolicy: e.target.value })); } catch (er) { setSendErr(er.message); } }} className="block w-full mt-1 bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg px-2 py-1">
                  <option value="keep">Keep chat data on the device</option><option value="clear">Erase message history on the device</option><option value="revoke">Revoke the device and erase everything</option>
                </select></label>}
              {orgSettings && [["allowExternal", "Allow people outside the organization"], ["allowEditing", "Allow editing messages"], ["allowDeleting", "Allow deleting messages"]].map(([k, label]) => (
                <label key={k} className="text-xs flex items-center gap-2 mb-1"><input type="checkbox" checked={!!orgSettings[k]} onChange={async (e) => { try { setOrgSettings(await client.api.setChatSettings({ [k]: e.target.checked })); } catch (er) { setSendErr(er.message); } }} />{label}</label>))}
            </>)}
          <h4 className="text-xs font-bold uppercase mt-5 mb-2">This device</h4>
          <p className={`text-[11px] ${muted} mb-2`}>Local storage used by Inaya here{usage != null ? `: about ${(usage / 1048576).toFixed(1)} MB (everything Inaya stores on this device, not only chat)` : ""}.</p>
          <div className="flex flex-col gap-2 mb-2">
            <button className={btn} onClick={async () => { if (window.confirm("Erase the message history stored on this device? Messages sent to you earlier cannot be fetched again. The device stays signed in to Secure Chat.")) { const r = await client.clearCache(); setSendErr(""); setSel(null); window.alert(`Erased ${r.erased} stored item(s). New messages will appear as they arrive.`); window.location.reload(); } }}>Erase message history on this device</button>
            <button className={btn} onClick={async () => { if (window.confirm("Remove this device from Secure Chat? Its keys and all chat data here are erased and it can no longer read anything. Opening Secure Chat again sets up a new device that sees only new messages.")) { try { await client.api.revokeDevice(client.device.deviceId); } catch { /* already revoked */ } await client.wipeLocal(); window.location.reload(); } }}>Remove this device from Secure Chat</button>
          </div>
          <h4 className="text-xs font-bold uppercase mt-5 mb-2">Privacy</h4>
          <label className="text-xs flex items-center gap-2"><input type="checkbox" checked={!!prefs.appearOffline} onChange={async (e) => setPrefs(await client.api.setPrefs({ appearOffline: e.target.checked }))} />Appear offline</label>
          <p className={`text-[10px] ${muted} mt-4`}>The server stores only encrypted messages and who/when. Notifications never include message text. Device: {client.device.deviceId.slice(0, 8)}…</p>
          {chat.securityEvents.length > 0 && <div className="mt-3 text-[10px] text-amber-300">{chat.securityEvents.slice(-3).map((e, i) => <p key={i}>Security notice: {e.type.replace(/_/g, " ").toLowerCase()}</p>)}</div>}
        </div>)}

      {pickDoc && <DocPicker orgId={orgId} onClose={() => setPickDoc(false)} onPick={(d) => { setDocRefs((x) => (x.some((y) => y.documentId === d.documentId) ? x : [...x, d].slice(0, 5))); setPickDoc(false); }} />}
      {pickNote && <NotePicker orgId={orgId} email={email} onClose={() => setPickNote(false)} onPick={(n) => { setNoteRef(n); setPickNote(false); }} />}
      {showNew && <NewChat client={client} me={email} onClose={() => setShowNew(false)} onCreate={async ({ kind, emails, name }) => { const r = await chat.run(async (c) => { const x = await c.createConversation({ kind, emails }); if (name && kind === "group") await c.rename(x.conversationId, name); return x; }); setSel(r.conversationId); }} />}
      {showContacts && <ContactsPanel client={client} onClose={() => setShowContacts(false)} />}
    </div>
    </div>
  );
}
