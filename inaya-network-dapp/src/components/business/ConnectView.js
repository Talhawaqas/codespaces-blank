"use client";

// src/components/business/ConnectView.js -- Inaya Connect (WhatsApp Business & AI gateway): shared inbox, documents
// received on WhatsApp, the company's number connection, assistant settings, usage and activity, and staff phone linking.
// Every action is re-checked on the server (src/lib/connect/*); hiding a button here is only a convenience.

import { useState, useEffect, useCallback } from "react";
import { useErpSection } from "./erp/ErpNavContext";

const f = "w-full min-h-[38px] bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-lg px-2.5 text-sm text-[var(--inaya-text-primary)]";
const pb = "min-h-[38px] px-3 rounded-lg text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-40";
const gb = "min-h-[38px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] disabled:opacity-40";
const db = "min-h-[38px] px-3 rounded-lg text-sm font-semibold border border-red-400 text-red-600 bg-[var(--inaya-surface)] disabled:opacity-40";
const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl p-3";
const mu = "text-[var(--inaya-text-muted)]";
const chip = "inline-block text-xs px-2 py-0.5 rounded-md border border-[var(--inaya-border)]";
const th = "text-left text-xs font-semibold text-[var(--inaya-text-secondary)] px-2 py-1.5 border-b border-[var(--inaya-border)]";
const td = "px-2 py-1.5 text-sm border-b border-[var(--inaya-border)] align-top";
const dt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "–");
const human = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (x) => x.toUpperCase());
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function mkApi(orgId) {
  return async (path, { method = "GET", body, query } = {}) => {
    const qs = new URLSearchParams({ orgId, ...(query || {}) }).toString();
    const r = await fetch(`/api/orgs/connect/${path}?${qs}`, { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(method !== "GET" ? { body: JSON.stringify(body || {}) } : {}) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { code: d.code }); return d;
  };
}
const Msg = ({ ok, err }) => <>{ok && <p className="text-sm text-emerald-600">{ok}</p>}{err && <p className="text-sm text-red-500" role="alert">{err}</p>}</>;
const H = ({ children }) => <h3 className="font-bold text-sm text-[var(--inaya-text-primary)] mb-2">{children}</h3>;
const L = ({ t, children }) => <label className="block text-xs font-semibold text-[var(--inaya-text-secondary)] space-y-1"><span>{t}</span>{children}</label>;
function useAction() {
  const [ok, setOk] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const run = async (fn, msg) => { setOk(""); setErr(""); setBusy(true); try { const r = await fn(); if (msg) setOk(typeof msg === "function" ? msg(r) : msg); return r; } catch (e) { setErr(e.message); return { __error: e }; } finally { setBusy(false); } };
  return { ok, err, busy, run };
}

export default function ConnectView({ orgId }) {
  const api = useCallback(mkApi(orgId), [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [me, setMe] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { api("me").then(setMe).catch((e) => setErr(e.message)); }, [api]);
  if (err) return <p className="text-sm text-red-500 p-4">{err}</p>;
  if (!me) return <p className={`text-sm p-4 ${mu}`}>Loading…</p>;
  if (!me.entitled) return <div className={`${card} m-4`}><H>Inaya Connect</H><p className="text-sm">Connect your WhatsApp Business number to Inaya: a shared inbox, a business assistant for your team, a customer assistant and documents sent on WhatsApp. It is part of the Business and Enterprise plans. Ask Inaya to switch it on.</p></div>;
  return <ConnectScreen api={api} me={me} orgId={orgId} />;
}

// Rendered only once the role is known, so the tab list (and the task panel) is right from the first paint.
function ConnectScreen({ api, me, orgId }) {
  const tabs = [me.agent && ["inbox", "Inbox"], ["docs", me.agent ? "Documents" : "My files"], ["mine", "My WhatsApp"], me.admin && ["connection", "Connection"], me.admin && ["settings", "Settings"], me.agent && ["usage", "Usage & activity"]].filter(Boolean);
  const [tab, setTab] = useErpSection(me.admin && me.connected !== "ACTIVE" ? "connection" : tabs[0][0], tabs);
  return (
    <div className="p-3 md:p-4 space-y-3 text-[var(--inaya-text-primary)]">
      <div className="flex flex-wrap gap-2" role="tablist" data-erp-tabs>{tabs.map(([k, t]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? pb : gb} onClick={() => setTab(k)}>{t}</button>)}</div>
      {tab === "inbox" && <Inbox api={api} me={me} />}
      {tab === "docs" && <Docs api={api} orgId={orgId} agent={me.agent} />}
      {tab === "mine" && <Mine api={api} me={me} />}
      {tab === "connection" && <Connection api={api} />}
      {tab === "settings" && <Settings api={api} />}
      {tab === "usage" && <Usage api={api} me={me} />}
    </div>
  );
}

// ------------------------------------------------------------------ inbox
function Inbox({ api, me }) {
  const [list, setList] = useState([]); const [status, setStatus] = useState("OPEN"); const [mine, setMine] = useState(false); const [q, setQ] = useState("");
  const [sel, setSel] = useState(null); const [conv, setConv] = useState(null); const [text, setText] = useState(""); const [note, setNote] = useState(""); const [assignee, setAssignee] = useState("");
  const a = useAction();
  const load = useCallback(() => api("conversations", { query: { status, ...(mine ? { mine: "1" } : {}), ...(q ? { q } : {}) } }).then((r) => setList(r.conversations)).catch(() => {}), [api, status, mine, q]);
  const open = useCallback((id) => api(`conversations/${id}`).then((r) => { setConv(r); setAssignee(r.conversation.assignee || ""); }).catch(() => {}), [api]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (!sel) return undefined; open(sel); const t = setInterval(() => open(sel), 10000); return () => clearInterval(t); }, [sel, open]);
  const act = async (action, body, msg) => { const r = await a.run(() => api(`conversations/${sel}/${action}`, { method: "POST", body }), msg); if (!r?.__error) { open(sel); load(); } return r; };
  const c = conv?.conversation;
  return (
    <div className="grid md:grid-cols-[320px_1fr] gap-3">
      <div className={`${card} space-y-2`}>
        <div className="flex gap-2"><select className={f} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="OPEN">Open</option><option value="CLOSED">Closed</option><option value="ALL">All</option></select><label className="flex items-center gap-1 text-xs whitespace-nowrap"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />Mine</label></div>
        <input className={f} placeholder="Search name or last digits" value={q} onChange={(e) => setQ(e.target.value)} />
        {!list.length && <p className={`text-sm ${mu}`}>No conversations yet. Messages to your WhatsApp number appear here.</p>}
        <ul className="space-y-1 max-h-[60vh] overflow-auto">{list.map((x) => (
          <li key={x.id}><button className={`w-full text-left rounded-lg p-2 border ${sel === x.id ? "border-[var(--inaya-accent)]" : "border-transparent"} hover:bg-[var(--inaya-surface-hover,transparent)]`} onClick={() => setSel(x.id)}>
            <div className="flex justify-between gap-2"><span className="font-semibold text-sm truncate">{x.name || x.number}</span>{x.unread > 0 && <span className={`${chip} font-bold`}>{x.unread}</span>}</div>
            <div className={`text-xs ${mu} flex gap-2 flex-wrap`}><span>{x.number}</span><span>{x.mode === "HUMAN" ? "Person" : "AI"}</span><span>{x.audience}</span>{x.assignee && <span>→ {x.assignee}</span>}</div>
            <div className={`text-xs ${mu}`}>{dt(x.lastMessageAt)}</div>
          </button></li>))}</ul>
      </div>
      <div className={`${card} space-y-2 min-w-0`}>
        {!c && <p className={`text-sm ${mu}`}>Choose a conversation.</p>}
        {c && <>
          <div className="flex flex-wrap justify-between gap-2 items-start">
            <div><div className="font-bold">{c.name || c.number}</div><div className={`text-xs ${mu}`}>{c.number} · {c.audience} · {c.verified ? "verified" : "not verified"} · {c.mode === "HUMAN" ? "a person is handling this" : "AI is answering"}{c.handoverReason ? ` · hand-over: ${human(c.handoverReason)}` : ""}</div></div>
            <div className="flex flex-wrap gap-2">
              {c.mode === "AI" ? <button className={gb} disabled={a.busy} onClick={() => act("takeover", {}, "You've taken over. The AI won't reply until you resume it.")}>Take over</button> : <button className={gb} disabled={a.busy} onClick={() => act("resume_ai", {}, "AI resumed.")}>Resume AI</button>}
              {c.ticketId ? <span className={chip}>Ticket created</span> : <button className={gb} disabled={a.busy} onClick={() => act("ticket", {}, (r) => `Support ticket ${r.ticketNumber || ""} created.`)}>Create ticket</button>}
              {c.status === "OPEN" ? <button className={gb} disabled={a.busy} onClick={() => act("close", {}, "Closed.")}>Close</button> : <button className={gb} disabled={a.busy} onClick={() => act("reopen", {}, "Reopened.")}>Reopen</button>}
            </div>
          </div>
          <div className="space-y-1.5 max-h-[50vh] overflow-auto border-y border-[var(--inaya-border)] py-2">
            {conv.messages.map((m) => (
              <div key={m.id} className={`flex ${m.direction === "in" ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm whitespace-pre-wrap break-words ${m.note ? "bg-amber-50 text-amber-900 border border-amber-300" : m.direction === "in" ? "bg-[var(--inaya-bg,transparent)] border border-[var(--inaya-border)]" : "bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]"}`}>
                  {m.note && <div className="text-[10px] font-bold uppercase">Internal note · {m.by}</div>}
                  {m.text || (m.media ? `[${m.type}${m.media.filename ? `: ${m.media.filename}` : ""}]` : `[${m.type}]`)}
                  <div className="text-[10px] opacity-75 mt-0.5">{dt(m.at)}{m.direction === "out" && ` · ${m.ai ? "AI" : m.by || ""} · ${m.status || ""}`}{m.error ? ` · ${m.error}` : ""}</div>
                </div>
              </div>))}
          </div>
          {!conv.windowOpen && <p className="text-xs text-amber-600">More than 24 hours since this customer last wrote. WhatsApp only allows approved template messages until they write again.</p>}
          <div className="flex gap-2"><textarea className={`${f} min-h-[60px]`} placeholder="Reply on WhatsApp (this pauses the AI for this chat)" value={text} onChange={(e) => setText(e.target.value)} maxLength={4096} /><button className={pb} disabled={a.busy || !text.trim() || !conv.windowOpen} onClick={async () => { const r = await act("reply", { text }, "Sent."); if (!r?.__error) setText(""); }}>Send</button></div>
          <div className="grid sm:grid-cols-2 gap-2">
            <div className="flex gap-2"><input className={f} placeholder="Internal note (not sent)" value={note} onChange={(e) => setNote(e.target.value)} /><button className={gb} disabled={a.busy || !note.trim()} onClick={async () => { const r = await act("note", { note }, "Note added."); if (!r?.__error) setNote(""); }}>Add</button></div>
            <div className="flex gap-2"><input className={f} placeholder="Assign to (email)" value={assignee} onChange={(e) => setAssignee(e.target.value)} /><button className={gb} disabled={a.busy} onClick={() => act("assign", { assignee }, "Assigned.")}>Assign</button></div>
          </div>
          <Msg ok={a.ok} err={a.err} />
        </>}
      </div>
      {void me}
    </div>
  );
}

// ------------------------------------------------------------------ documents
function Docs({ api, orgId, agent }) {
  const [status, setStatus] = useState("ALL"); const [rows, setRows] = useState([]); const [notes, setNotes] = useState({}); const a = useAction();
  const load = useCallback(() => api("documents", { query: { status } }).then((r) => setRows(r.documents)).catch(() => {}), [api, status]);
  useEffect(() => { load(); }, [load]);
  const decide = async (id, action) => { const r = await a.run(() => api(`documents/${id}`, { method: "POST", body: { action, note: notes[id] || "" } }), action === "bookkeeper" ? "Sent to AI Bookkeeper for review." : action === "filed" ? "Marked as filed." : "Rejected."); if (!r?.__error) load(); };
  return (
    <div className={`${card} space-y-2`}>
      <div className="flex flex-wrap gap-2 items-center justify-between"><H>Documents received on WhatsApp</H><select className={`${f} max-w-[200px]`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">{["ALL", "SAVED", "ROUTED", "REVIEW", "FILED", "QUARANTINED", "REJECTED"].filter((s) => agent || s !== "QUARANTINED").map((s) => <option key={s} value={s}>{human(s)}</option>)}</select></div>
      <p className={`text-xs ${mu}`}>Bills from linked staff or allow-listed suppliers go straight to AI Bookkeeper as drafts for review. Other files are saved in the dated Inaya Connect folder and the sender gets an email with the link. Files from unknown senders, and files that fail the safety checks, are quarantined and never opened.</p>
      <Msg ok={a.ok} err={a.err} />
      <div className="overflow-x-auto"><table className="w-full"><thead><tr><th className={th}>Ref</th><th className={th}>File</th><th className={th}>From</th><th className={th}>Received</th><th className={th}>Status</th><th className={th}></th></tr></thead><tbody>
        {!rows.length && <tr><td className={td} colSpan={6}><span className={mu}>Nothing here.</span></td></tr>}
        {rows.map((x) => (
          <tr key={x.id}><td className={td}>{x.ref || "–"}</td>
            <td className={td}>{x.filename && x.status !== "QUARANTINED" ? <a className="underline" href={`/api/orgs/connect/documents/${x.id}/file?orgId=${orgId}`} target="_blank" rel="noreferrer">{x.filename}</a> : x.filename || "–"}{x.caption && <div className={`text-xs ${mu}`}>{x.caption}</div>}{x.folder && <div className={`text-xs ${mu}`}>Folder: {x.folder}</div>}{x.suggested && <div className="text-xs">Suggested: {human(x.suggested)}</div>}</td>
            <td className={td}>{x.from}<div className={`text-xs ${mu}`}>{x.senderEmail || x.senderType}</div></td>
            <td className={td}>{dt(x.at)}</td><td className={td}><span className={chip}>{human(x.status)}</span>{x.reason && <div className={`text-xs ${mu}`}>{human(x.reason)}</div>}</td>
            <td className={td}>{agent && ["REVIEW", "SAVED"].includes(x.status) && <div className="space-y-1 min-w-[200px]"><input className={f} placeholder="Note (where filed)" value={notes[x.id] || ""} onChange={(e) => setNotes({ ...notes, [x.id]: e.target.value })} /><div className="flex flex-wrap gap-1"><button className={gb} disabled={a.busy} onClick={() => decide(x.id, "bookkeeper")}>To Bookkeeper</button><button className={gb} disabled={a.busy} onClick={() => decide(x.id, "filed")}>Filed</button><button className={db} disabled={a.busy} onClick={() => decide(x.id, "reject")}>Reject</button></div></div>}</td></tr>))}
      </tbody></table></div>
    </div>
  );
}

// ------------------------------------------------------------------ my WhatsApp (staff linking)
function Mine({ api, me }) {
  const [code, setCode] = useState(null); const [links, setLinks] = useState(null); const a = useAction();
  const loadLinks = useCallback(() => { if (me.admin) api("links").then((r) => setLinks(r.links)).catch(() => {}); }, [api, me.admin]);
  useEffect(() => { loadLinks(); }, [loadLinks]);
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div className={`${card} space-y-2`}>
        <H>Use the business assistant on WhatsApp</H>
        <p className="text-sm">Link your own phone, then ask on WhatsApp things like &quot;How much did we sell today?&quot;, &quot;Stock of item X at my branch&quot; or &quot;Status of WO-00012&quot;. Answers follow your permissions and branches. This channel is read-only: approvals, payments and changes stay in Inaya.</p>
        <button className={pb} disabled={a.busy} onClick={async () => { const r = await a.run(() => api("links", { method: "POST" })); if (!r?.__error) setCode(r); }}>Get my link code</button>
        {code && <div className="rounded-lg border border-[var(--inaya-border)] p-2 text-sm"><div className="text-2xl font-bold tracking-widest">{code.code}</div><p>{code.instructions}</p></div>}
        <button className={gb} disabled={a.busy} onClick={() => a.run(() => api("links/remove", { method: "POST", body: { email: me.email } }), "Your phone is unlinked.")}>Unlink my phone</button>
        <Msg ok={a.ok} err={a.err} />
      </div>
      {me.admin && <div className={`${card} space-y-2`}>
        <H>Linked staff phones</H>
        {!links?.length && <p className={`text-sm ${mu}`}>No one has linked a phone yet.</p>}
        <ul className="space-y-1">{(links || []).map((l) => <li key={l.email} className="flex justify-between gap-2 text-sm"><span>{l.email} · {l.number}</span><button className={db} onClick={async () => { const r = await a.run(() => api("links/remove", { method: "POST", body: { email: l.email } }), "Unlinked."); if (!r?.__error) loadLinks(); }}>Unlink</button></li>)}</ul>
      </div>}
    </div>
  );
}

// ------------------------------------------------------------------ connection
function Connection({ api }) {
  const [st, setSt] = useState(null); const [form, setForm] = useState({ phoneNumberId: "", wabaId: "", accessToken: "", appSecret: "" }); const [hook, setHook] = useState(null);
  const [to, setTo] = useState(""); const [newToken, setNewToken] = useState(""); const [reason, setReason] = useState(""); const a = useAction();
  const load = useCallback(() => api("connection").then(setSt).catch(() => {}), [api]);
  useEffect(() => { load(); }, [load]);
  const conn = st?.connection;
  const Hook = () => hook && <div className="rounded-lg border border-amber-400 p-2 text-sm space-y-1"><div className="font-bold">Enter these in your Meta app: WhatsApp › Configuration › Webhook › Edit</div><div>Callback URL: <code className="break-all">{hook.callbackUrl}</code></div><div>Verify token: <code className="break-all">{hook.verifyToken}</code></div><div className={mu}>Then click &quot;Manage&quot; under Webhook fields and subscribe to <b>messages</b>. The verify token is shown only once.</div></div>;
  if (!st) return <p className={`text-sm ${mu}`}>Loading…</p>;
  if (!conn) return (
    <div className={`${card} space-y-2 max-w-2xl`}>
      <H>Connect your WhatsApp Business number</H>
      <p className="text-sm">From your Meta app (developers.facebook.com › your app › WhatsApp › API Setup): the Phone number ID and WhatsApp Business Account ID. The App secret is under App settings › Basic. Use a permanent System User token from Meta Business Settings (temporary tokens expire in 24 hours). Inaya checks the token with Meta and stores the secrets encrypted; they are never shown again.</p>
      <div className="grid sm:grid-cols-2 gap-2">
        <L t="Phone number ID"><input className={f} value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value.trim() })} inputMode="numeric" /></L>
        <L t="WhatsApp Business Account ID"><input className={f} value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value.trim() })} inputMode="numeric" /></L>
        <L t="App secret"><input className={f} type="password" autoComplete="off" value={form.appSecret} onChange={(e) => setForm({ ...form, appSecret: e.target.value })} /></L>
        <L t="Access token (System User)"><input className={f} type="password" autoComplete="off" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} /></L>
      </div>
      <button className={pb} disabled={a.busy || !form.phoneNumberId || !form.wabaId || !form.accessToken || !form.appSecret} onClick={async () => { const r = await a.run(() => api("connection", { method: "POST", body: form }), "Connected. Now set up the webhook in Meta."); if (!r?.__error) { setHook(r.webhook); setForm({ phoneNumberId: "", wabaId: "", accessToken: "", appSecret: "" }); load(); } }}>Connect</button>
      <Msg ok={a.ok} err={a.err} /><Hook />
    </div>
  );
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div className={`${card} space-y-1 text-sm`}>
        <H>Your number</H>
        <div className="text-lg font-bold">{conn.displayNumber || conn.phoneNumberId}</div>
        <div>{conn.verifiedName || ""}</div>
        <div>Status: <span className={chip}>{conn.status === "ACTIVE" ? "Active" : conn.status === "PENDING_WEBHOOK" ? "Waiting for the Meta webhook" : human(conn.status)}</span>{conn.quality && <span className={`${chip} ml-1`}>Quality {human(conn.quality)}</span>}</div>
        <div className={mu}>Phone number ID {conn.phoneNumberId} · WABA {conn.wabaId}</div>
        <div className={mu}>Connected {dt(conn.connectedAt)} by {conn.connectedBy}</div>
        <div className={mu}>Last message in {dt(conn.lastInboundAt)} · out {dt(conn.lastOutboundAt)}</div>
        {conn.lastError && <p className="text-red-500">Last error: {conn.lastError.message}</p>}
        <div className={mu}>Webhook URL: <code className="break-all">{st.webhookUrl}</code></div>
        <div>Linked to Meta app: <span className={chip}>{conn.wabaSubscribed ? "Yes" : "No"}</span> <button className={conn.wabaSubscribed ? gb : pb} disabled={a.busy} onClick={async () => { const r = await a.run(() => api("connection/link-app", { method: "POST" }), "Linked. Meta will now deliver incoming messages."); if (!r?.__error) load(); }}>Link to Meta</button></div>
        <button className={gb} disabled={a.busy} onClick={async () => { const r = await a.run(() => api("connection/rotate-verify-token", { method: "POST" }), "New verify token created."); if (!r?.__error) setHook(r.webhook); }}>New verify token</button>
        <Hook />
      </div>
      <div className="space-y-3">
        <div className={`${card} space-y-2`}><H>Send a test message</H><p className={`text-xs ${mu}`}>While your Meta app is in development, the number must be added as a recipient in Meta (API Setup › To).</p><div className="flex gap-2"><input className={f} placeholder="Number with country code" value={to} onChange={(e) => setTo(e.target.value)} inputMode="tel" /><button className={gb} disabled={a.busy || !to} onClick={() => a.run(() => api("connection/test", { method: "POST", body: { to } }), (r) => `Sent. ${r.note || ""}`)}>Send</button></div></div>
        <div className={`${card} space-y-2`}><H>Replace the access token</H><div className="flex gap-2"><input className={f} type="password" autoComplete="off" placeholder="New System User token" value={newToken} onChange={(e) => setNewToken(e.target.value)} /><button className={gb} disabled={a.busy || !newToken} onClick={async () => { const r = await a.run(() => api("connection/credentials", { method: "POST", body: { accessToken: newToken } }), "Token updated."); if (!r?.__error) { setNewToken(""); load(); } }}>Save</button></div></div>
        <div className={`${card} space-y-2`}><H>Disconnect</H><p className={`text-xs ${mu}`}>Stops sending and receiving immediately and deletes the stored secrets. Message history is kept.</p><input className={f} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /><button className={db} disabled={a.busy} onClick={async () => { if (!window.confirm("Disconnect this WhatsApp number from Inaya?")) return; const r = await a.run(() => api("connection/disconnect", { method: "POST", body: { reason } }), "Disconnected."); if (!r?.__error) load(); }}>Disconnect</button></div>
        <Msg ok={a.ok} err={a.err} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ settings
function Settings({ api }) {
  const [s, setS] = useState(null); const a = useAction();
  useEffect(() => { api("settings").then((r) => setS(r.settings)).catch(() => {}); }, [api]);
  if (!s) return <p className={`text-sm ${mu}`}>Loading…</p>;
  const setDay = (d, v) => { const spans = v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.split("-").map((y) => y.trim())); setS({ ...s, hours: { ...s.hours, weekly: { ...s.hours.weekly, [d]: spans } } }); };
  const Tog = ({ k, t, d }) => <label className="flex gap-2 items-start text-sm"><input type="checkbox" className="mt-1" checked={!!s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} /><span><b>{t}</b><span className={`block text-xs ${mu}`}>{d}</span></span></label>;
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div className={`${card} space-y-2`}>
        <H>Assistants</H>
        <Tog k="businessAssistant" t="Business assistant for staff" d="Linked staff can ask about sales, stock, jobs and schedules. Read-only, within their permissions." />
        <Tog k="customerAssistant" t="Customer assistant" d="Answers customers from your help articles, and their own orders, repairs, appointments and invoices after an email code. Off: every customer message goes to the inbox." />
        <Tog k="documentIntake" t="Documents on WhatsApp" d="Accept bills and files from linked staff and allow-listed suppliers." />
        <L t="Greeting ({company} is replaced)"><textarea className={f} value={s.greeting} onChange={(e) => setS({ ...s, greeting: e.target.value })} maxLength={500} /></L>
        <L t="After-hours reply"><textarea className={f} value={s.afterHours} onChange={(e) => setS({ ...s, afterHours: e.target.value })} maxLength={500} /></L>
        <L t="Supplier numbers allowed to send bills (country code, comma separated)"><textarea className={f} value={(s.allowedSupplierNumbers || []).join(", ")} onChange={(e) => setS({ ...s, allowedSupplierNumbers: e.target.value.split(/[\s,]+/).filter(Boolean) })} /></L>
      </div>
      <div className={`${card} space-y-2`}>
        <H>Business hours</H>
        <L t="Timezone"><input className={f} value={s.hours.timezone} onChange={(e) => setS({ ...s, hours: { ...s.hours, timezone: e.target.value } })} /></L>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!s.hours.alwaysOpen} onChange={(e) => setS({ ...s, hours: { ...s.hours, alwaysOpen: e.target.checked } })} />Always open</label>
        {DAYS.map((d, i) => <L key={d} t={`${d} (e.g. 09:00-13:00, 14:00-18:00; empty = closed)`}><input className={f} defaultValue={(s.hours.weekly?.[i] || []).map((x) => x.join("-")).join(", ")} onBlur={(e) => setDay(String(i), e.target.value)} /></L>)}
        <H>Limits</H>
        <div className="grid grid-cols-2 gap-2">
          <L t="Messages sent per month"><input className={f} type="number" min={1} value={s.limits.monthlyOutbound} onChange={(e) => setS({ ...s, limits: { ...s.limits, monthlyOutbound: e.target.value } })} /></L>
          <L t="Messages per sender per hour"><input className={f} type="number" min={1} value={s.limits.perSenderPerHour} onChange={(e) => setS({ ...s, limits: { ...s.limits, perSenderPerHour: e.target.value } })} /></L>
          <L t="Estimate per billable message"><input className={f} type="number" step="0.0001" min={0} value={s.pricing?.perMessageEstimate ?? 0} onChange={(e) => setS({ ...s, pricing: { ...s.pricing, perMessageEstimate: e.target.value } })} /></L>
          <L t="Currency"><input className={f} value={s.pricing?.currency || "USD"} maxLength={3} onChange={(e) => setS({ ...s, pricing: { ...s.pricing, currency: e.target.value } })} /></L>
        </div>
        <button className={pb} disabled={a.busy} onClick={() => a.run(async () => { const r = await api("settings", { method: "POST", body: { businessAssistant: s.businessAssistant, customerAssistant: s.customerAssistant, documentIntake: s.documentIntake, greeting: s.greeting, afterHours: s.afterHours, allowedSupplierNumbers: s.allowedSupplierNumbers, hours: s.hours, limits: { monthlyOutbound: Number(s.limits.monthlyOutbound), perSenderPerHour: Number(s.limits.perSenderPerHour) }, pricing: { currency: s.pricing?.currency || "USD", perMessageEstimate: Number(s.pricing?.perMessageEstimate || 0) } } }); setS(r.settings); return r; }, "Saved.")}>Save settings</button>
        <Msg ok={a.ok} err={a.err} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ usage + activity
function Usage({ api, me }) {
  const [u, setU] = useState(null); const [ev, setEv] = useState(null);
  useEffect(() => { api("usage").then(setU).catch(() => {}); if (me.admin) api("events").then((r) => setEv(r.events)).catch(() => {}); }, [api, me.admin]);
  return (
    <div className="space-y-3">
      {u && <div className={`${card} space-y-1`}><H>This month ({u.month})</H>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">{[["Received", u.inbound], ["Sent", `${u.outbound} / ${u.limit}`], ["Billable (Meta)", u.billable], ["Estimate", `${u.estimate.currency} ${u.estimate.amount}`]].map(([k, v]) => <div key={k} className="rounded-lg border border-[var(--inaya-border)] p-2"><div className={`text-xs ${mu}`}>{k}</div><div className="font-bold text-lg">{v}</div></div>)}</div>
        <p className={`text-xs ${mu}`}>{u.estimate.note}</p></div>}
      {me.admin && <div className={`${card}`}><H>Activity</H><div className="overflow-x-auto"><table className="w-full"><thead><tr><th className={th}>When</th><th className={th}>Event</th><th className={th}>Outcome</th><th className={th}>Contact</th><th className={th}>Detail</th></tr></thead><tbody>
        {!ev?.length && <tr><td className={td} colSpan={5}><span className={mu}>No activity yet.</span></td></tr>}
        {(ev || []).map((e) => <tr key={e.id}><td className={td}>{dt(e.at)}</td><td className={td}>{human(e.type)}</td><td className={td}>{human(e.outcome)}</td><td className={td}>{e.contact || "–"}</td><td className={`${td} text-xs`}>{Object.entries(e.detail || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</td></tr>)}
      </tbody></table></div></div>}
    </div>
  );
}
