"use client";

// src/components/portal/PortalApp.js
//
// The customer portal (Customer Portal SOW §29-§31). A separate, customer-facing surface: plain language, no
// internal terms, keyboard and screen-reader friendly, responsive. Every call goes to /api/portal/:slug/* and the
// server decides what this customer may see; nothing here is trusted for access control.

import { useState, useEffect, useCallback, useRef } from "react";
import { uploadFile } from "../support/chunkedUpload";

const CSS = `
.pt{--bg:#f6f7f9;--card:#fff;--ink:#14181f;--mut:#5b6472;--line:#dfe3ea;--acc:#1f4fd8;--acc-ink:#fff;--ok:#12703a;--warn:#8a5a00;--bad:#a4262c;--soft:#eef2fb;
 background:var(--bg);color:var(--ink);min-height:100vh;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){.pt{--bg:#0f1218;--card:#181c24;--ink:#e8ebf0;--mut:#9aa4b2;--line:#2a303b;--acc:#6f96ff;--acc-ink:#0b1020;--ok:#5dd39e;--warn:#f0b84d;--bad:#ff8b8b;--soft:#1c2333}}
.pt *{box-sizing:border-box}
.pt a{color:var(--acc)}
.pt-wrap{max-width:60rem;margin:0 auto;padding:0 16px 48px}
.pt-top{background:var(--card);border-bottom:1px solid var(--line)}
.pt-top .pt-wrap{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding-block:10px}
.pt-brand{font-weight:700;font-size:17px;margin-right:auto}
.pt-nav{display:flex;flex-wrap:wrap;gap:4px}
.pt-nav button{background:none;border:0;padding:7px 10px;border-radius:8px;color:var(--mut);font:inherit;cursor:pointer}
.pt-nav button[aria-current=page]{background:var(--soft);color:var(--acc);font-weight:600}
.pt :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.pt h1{font-size:24px;margin:24px 0 8px}.pt h2{font-size:18px;margin:0 0 8px}.pt h3{font-size:15px;margin:0}
.pt-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.pt-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.pt-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr))}
.pt-stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}.pt-stat b{display:block;font-size:22px}
.pt label{display:block;font-size:13px;color:var(--mut);margin:10px 0 4px}
.pt input,.pt select,.pt textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
.pt textarea{min-height:110px;resize:vertical}
.pt-btn{display:inline-block;padding:9px 16px;border-radius:8px;border:1px solid var(--acc);background:var(--acc);color:var(--acc-ink);font:inherit;font-weight:600;cursor:pointer}
.pt-btn.sec{background:none;color:var(--acc)}.pt-btn.bad{border-color:var(--bad);color:var(--bad);background:none}
.pt-btn:disabled{opacity:.55;cursor:default}
.pt-tag{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;background:var(--soft);color:var(--acc)}
.pt-tag.ok{color:var(--ok)}.pt-tag.warn{color:var(--warn)}.pt-tag.bad{color:var(--bad)}
.pt-list{list-style:none;margin:0;padding:0}.pt-list li{border-top:1px solid var(--line);padding:12px 0}.pt-list li:first-child{border-top:0}
.pt-link{background:none;border:0;padding:0;color:var(--acc);font:inherit;font-weight:600;text-align:left;cursor:pointer;text-decoration:underline}
.pt-msg{border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.pt-msg.me{background:var(--soft)}
.pt-muted{color:var(--mut);font-size:13px}
.pt-err{color:var(--bad);margin:8px 0}.pt-ok{color:var(--ok);margin:8px 0}
.pt-banner{border:1px solid var(--warn);border-radius:12px;padding:12px 16px;margin:14px 0;background:var(--card)}
.pt-chat{max-height:26rem;overflow:auto}
.pt-table{width:100%;border-collapse:collapse}.pt-table th,.pt-table td{text-align:left;padding:8px 6px;border-top:1px solid var(--line);font-size:14px}
.pt-table-wrap{overflow-x:auto}
@media (max-width:560px){.pt-btn{width:100%}}
`;

const LABEL = { OPEN: "Open", IN_PROGRESS: "In progress", WAITING_FOR_YOU: "Waiting for your reply", SOLVED: "Solved", CLOSED: "Closed", CANCELLED: "Cancelled" };
const tone = (s) => (["SOLVED", "CLOSED"].includes(s) ? "ok" : s === "WAITING_FOR_YOU" ? "warn" : "");
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "");

export default function PortalApp({ slug }) {
  const call = useCallback(async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`/api/portal/${slug}/${path}`, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Portal-Request": "1" }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Something went wrong (${res.status}).`); e.status = res.status; e.data = data; throw e; }
    return data;
  }, [slug]);
  const upload = useCallback(async (file, params) => {
    const q = new URLSearchParams(params); const target = {}; for (const [k, v] of q.entries()) target[k] = v;
    return uploadFile({ file, initUrl: `/api/portal/${slug}/uploads`, chunkUrl: (id, i) => `/api/portal/${slug}/uploads/${id}?index=${i}`, completeUrl: (id) => `/api/portal/${slug}/uploads/${id}`, headers: { "X-Portal-Request": "1" }, target });
  }, [slug]);

  const [cfg, setCfg] = useState(null);
  const [cfgErr, setCfgErr] = useState("");
  const [user, setUser] = useState(null);
  const [view, setView] = useState("home");
  const [ticketId, setTicketId] = useState(null);
  const [prefill, setPrefill] = useState(null);
  const [unread, setUnread] = useState(0);
  const [booting, setBooting] = useState(true);

  const boot = useCallback(async () => {
    try {
      const c = await call("config"); setCfg(c);
      if (c.signedIn) { const m = await call("me"); setUser(m.user); call("notifications").then((n) => setUnread(n.unread || 0)).catch(() => {}); } else setUser(null);
    } catch (e) { setCfgErr(e.status === 404 ? "This support portal does not exist or is not switched on." : e.message); }
    finally { setBooting(false); }
  }, [call]);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const token = p.get("token");
    (async () => {
      if (token) {
        try { await call("auth/verify", { method: "POST", body: { token } }); } catch (e) { sessionStorage.setItem("pt-login-error", e.message); }
        window.history.replaceState({}, "", `/portal/${slug}`);
      }
      await boot();
      const t = p.get("ticket"); if (t) { setTicketId(t); setView("ticket"); }
    })();
  }, [boot, call, slug]);

  const go = (v, extra) => { setView(v); setTicketId(v === "ticket" ? extra : null); if (v === "new") setPrefill(extra || null); window.scrollTo?.(0, 0); };

  if (booting) return <div className="pt"><style dangerouslySetInnerHTML={{ __html: CSS }} /><div className="pt-wrap"><p role="status" className="pt-muted" style={{ paddingTop: 40 }}>Loading…</p></div></div>;
  if (cfgErr) return <div className="pt"><style dangerouslySetInnerHTML={{ __html: CSS }} /><div className="pt-wrap"><h1>Support portal</h1><p className="pt-err" role="alert">{cfgErr}</p></div></div>;

  const nav = [["home", "Home"], ["tickets", "My requests"], ["new", "New request"], ...(cfg.features.kb ? [["kb", "Help articles"]] : []), ...(cfg.features.chat ? [["chat", "Ask the assistant"]] : []), ...(cfg.features.ideas ? [["ideas", "Ideas"]] : []), ["invoices", "Invoices"], ["notifications", `Notifications${unread ? ` (${unread})` : ""}`], ["account", "Account"]];
  return (
    <div className="pt">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header className="pt-top"><div className="pt-wrap">
        <span className="pt-brand">{cfg.name}</span>
        {user ? <nav aria-label="Portal" className="pt-nav">{nav.map(([id, label]) => <button key={id} type="button" aria-current={view === id || (view === "ticket" && id === "tickets") ? "page" : undefined} onClick={() => go(id)}>{label}</button>)}</nav>
          : <nav aria-label="Portal" className="pt-nav">{cfg.features.kb && <button type="button" aria-current={view === "kb" ? "page" : undefined} onClick={() => go("kb")}>Help articles</button>}<button type="button" aria-current={view === "home" ? "page" : undefined} onClick={() => go("home")}>Sign in</button></nav>}
      </div></header>
      <main className="pt-wrap" id="main">
        {(cfg.incidents || []).map((i) => <div key={i.id} className="pt-banner" role="status"><strong>{i.title}</strong> <span className="pt-tag warn">{i.status.replace(/_/g, " ").toLowerCase()}</span><p style={{ margin: "6px 0 0" }}>{i.updates?.length ? i.updates[i.updates.length - 1].message : i.message}</p></div>)}
        {!user && view !== "kb" && <SignIn call={call} cfg={cfg} />}
        {!user && view !== "kb" && cfg.features.kb && <p className="pt-muted" style={{ textAlign: "center" }}>Looking for an answer first? <button type="button" className="pt-link" onClick={() => go("kb")}>Browse the help articles</button> (no sign-in needed).</p>}
        {!user && view === "kb" && <Kb call={call} user={null} onSignIn={() => go("home")} />}
        {user && view === "home" && <Home call={call} cfg={cfg} user={user} go={go} />}
        {user && view === "tickets" && <Tickets call={call} go={go} />}
        {user && view === "ticket" && <Ticket call={call} upload={upload} id={ticketId} cfg={cfg} go={go} />}
        {user && view === "new" && <NewRequest call={call} upload={upload} cfg={cfg} prefill={prefill} go={go} />}
        {user && view === "kb" && <Kb call={call} user={user} />}
        {user && view === "chat" && <Chat call={call} go={go} />}
        {user && view === "ideas" && <Ideas call={call} upload={upload} cfg={cfg} />}
        {user && view === "invoices" && <Invoices call={call} go={go} />}
        {user && view === "notifications" && <Notifications call={call} go={go} onRead={() => setUnread(0)} />}
        {user && view === "account" && <Account call={call} user={user} setUser={setUser} onOut={async () => { await call("auth/logout", { method: "POST" }); setUser(null); setView("home"); boot(); }} />}
      </main>
    </div>
  );
}

// -------------------------------------------------------------------------------------- pieces
const useAsync = () => {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [ok, setOk] = useState("");
  const run = async (fn) => { setBusy(true); setErr(""); setOk(""); try { return await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return { busy, err, ok, setOk, setErr, run };
};
const Msg = ({ a }) => <>{a.err && <p className="pt-err" role="alert">{a.err}</p>}{a.ok && <p className="pt-ok" role="status">{a.ok}</p>}</>;

function SignIn({ call, cfg }) {
  const [email, setEmail] = useState(""); const a = useAsync(); const [sent, setSent] = useState("");
  const [pre] = useState(() => (typeof window !== "undefined" ? sessionStorage.getItem("pt-login-error") : ""));
  const [ssoErr] = useState(() => { if (typeof window === "undefined") return ""; const c = new URLSearchParams(window.location.search).get("sso_error"); return c ? ({ denied: "Sign-in was cancelled.", not_allowed: "That account is not allowed to use this portal.", failed: "We could not verify your sign-in. Please try again.", unavailable: "Single sign-on is not available right now. You can use an email link instead.", rate_limited: "Too many attempts. Please wait a little." })[c] || "Sign-in did not complete." : ""; });
  useEffect(() => { sessionStorage.removeItem("pt-login-error"); if (ssoErr) window.history.replaceState({}, "", window.location.pathname); }, [ssoErr]);
  return (
    <div className="pt-card" style={{ maxWidth: "30rem", margin: "32px auto" }}>
      <h1 style={{ marginTop: 0 }}>Sign in to get help</h1>
      <p className="pt-muted">{cfg.welcomeText} Sign in to raise a request, follow your existing ones and see your invoices.</p>
      {cfg.sso?.enabled && <p><a className="pt-btn" style={{ textDecoration: "none", textAlign: "center", display: "block" }} href={`/api/portal/${window.location.pathname.split("/")[2]}/sso/start`}>Sign in with {cfg.sso.label}</a></p>}
      <p className="pt-muted">{cfg.sso?.enabled ? "Or get a one-time link by email (no password needed):" : "Enter your email and we will send you a one-time sign-in link. No password needed."}</p>
      {(pre || ssoErr) && <p className="pt-err" role="alert">{ssoErr || pre}</p>}
      {sent ? <p className="pt-ok" role="status">{sent}</p> : (
        <form onSubmit={(e) => { e.preventDefault(); a.run(async () => setSent((await call("auth/request", { method: "POST", body: { email } })).message)); }}>
          <label htmlFor="pt-email">Email address</label>
          <input id="pt-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <p style={{ marginTop: 14 }}><button className="pt-btn" disabled={a.busy || !email}>{a.busy ? "Sending…" : "Email me a sign-in link"}</button></p>
          <Msg a={a} />
        </form>)}
      {cfg.signup === "contacts_only" && <p className="pt-muted">Only people already known to this company can sign in.</p>}
    </div>
  );
}

function Home({ call, cfg, user, go }) {
  const [d, setD] = useState(null); const [term, setTerm] = useState("");
  useEffect(() => { call("tickets?limit=5").then(setD).catch(() => setD({ tickets: [], counts: {} })); }, [call]);
  return (
    <>
      <h1>Hello{user.name ? `, ${user.name.split(" ")[0]}` : ""}</h1>
      <p className="pt-muted">{cfg.welcomeText}</p>
      {cfg.features.kb && <form className="pt-card" onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem("pt-kb-q", term); go("kb"); }} role="search">
        <label htmlFor="pt-home-search" style={{ marginTop: 0 }}>Search help articles</label>
        <div className="pt-row"><input id="pt-home-search" style={{ flex: 1, minWidth: "12rem" }} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="How do I…" /><button className="pt-btn">Search</button></div></form>}
      <div className="pt-grid"><div className="pt-stat"><b>{d?.counts?.open ?? "–"}</b>Open requests</div><div className="pt-stat"><b>{d?.counts?.waiting ?? "–"}</b>Waiting for your reply</div><div className="pt-stat"><b>{d?.counts?.solvedThisMonth ?? "–"}</b>Solved this month</div></div>
      <div className="pt-row" style={{ margin: "16px 0" }}><button className="pt-btn" onClick={() => go("new")}>New request</button>{cfg.features.chat && <button className="pt-btn sec" onClick={() => go("chat")}>Ask the assistant</button>}</div>
      <div className="pt-card"><h2>Recent requests</h2>
        {!d ? <p className="pt-muted">Loading…</p> : !d.tickets.length ? <p className="pt-muted">You have no requests yet.</p> : <ul className="pt-list">{d.tickets.map((t) => <li key={t.id}><button className="pt-link" onClick={() => go("ticket", t.id)}>{t.number} · {t.subject}</button> <span className={`pt-tag ${tone(t.status)}`}>{LABEL[t.status] || t.status}</span><div className="pt-muted">Updated {fmt(t.updatedAt)}</div></li>)}</ul>}
      </div>
    </>
  );
}

function Tickets({ call, go }) {
  const [filter, setFilter] = useState(""); const [d, setD] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { setD(null); call(`tickets${filter ? `?status=${filter}` : ""}`).then(setD).catch((e) => setErr(e.message)); }, [call, filter]);
  return (
    <>
      <h1>My requests</h1>
      <div className="pt-row" role="group" aria-label="Filter">{[["", "All"], ["open", "Open"], ["resolved", "Solved"]].map(([v, l]) => <button key={v} className={`pt-btn ${filter === v ? "" : "sec"}`} aria-pressed={filter === v} onClick={() => setFilter(v)} style={{ width: "auto" }}>{l}</button>)}</div>
      {err && <p className="pt-err" role="alert">{err}</p>}
      <div className="pt-card">{!d ? <p className="pt-muted">Loading…</p> : !d.tickets.length ? <p className="pt-muted">No requests here.</p> : <ul className="pt-list">{d.tickets.map((t) => (
        <li key={t.id}><button className="pt-link" onClick={() => go("ticket", t.id)}>{t.number} · {t.subject}</button> <span className={`pt-tag ${tone(t.status)}`}>{LABEL[t.status] || t.status}</span>{t.sharedWithMe && <span className="pt-tag"> shared with you</span>}
          <div className="pt-muted">Updated {fmt(t.updatedAt)}{t.latestReply ? ` · Last message from ${t.latestReply.from}: “${t.latestReply.preview}”` : ""}</div></li>))}</ul>}</div>
    </>
  );
}

function Ticket({ call, upload, id, cfg, go }) {
  const [t, setT] = useState(null); const [err, setErr] = useState("");
  const [text, setText] = useState(""); const [file, setFile] = useState(null); const a = useAsync(); const fileRef = useRef(null);
  const [share, setShare] = useState(""); const [score, setScore] = useState(0); const [comment, setComment] = useState("");
  const load = useCallback(() => call(`tickets/${id}`).then((r) => setT(r.ticket)).catch((e) => setErr(e.message)), [call, id]);
  useEffect(() => { load(); }, [load]);
  if (err) return <><button className="pt-btn sec" onClick={() => go("tickets")}>← My requests</button><p className="pt-err" role="alert">{err}</p></>;
  if (!t) return <p className="pt-muted" role="status">Loading…</p>;
  const send = () => a.run(async () => {
    const r = await call(`tickets/${id}/reply`, { method: "POST", body: { body: text } });
    if (file) { try { await upload(file, `ticketId=${id}&messageId=${r.message.id}`); } catch (e) { a.setErr(`Your message was sent, but the attachment failed: ${e.message}`); } }
    setText(""); setFile(null); if (fileRef.current) fileRef.current.value = ""; await load();
  });
  return (
    <>
      <p><button className="pt-btn sec" style={{ width: "auto" }} onClick={() => go("tickets")}>← My requests</button></p>
      <h1 style={{ marginTop: 8 }}>{t.subject}</h1>
      <p><span className="pt-muted">{t.number} · opened {fmt(t.createdAt)} </span><span className={`pt-tag ${tone(t.status)}`}>{LABEL[t.status] || t.status}</span></p>
      {t.mergedInto && <p className="pt-muted">This request was combined with {t.mergedInto}.</p>}
      <div className="pt-card" aria-label="Conversation">
        {t.messages.map((m) => (
          <div key={m.id} className={`pt-msg ${m.from === "you" ? "me" : ""}`}><div className="pt-muted"><strong>{m.from === "you" ? "You" : m.authorName || (m.from === "support" ? "Support team" : m.from)}</strong> · {fmt(m.at)}</div>{m.body}
            {t.attachments.filter((x) => x.messageId === m.id).map((x) => <div key={x.id}><a href={`/api/portal/${cfg.slug || window.location.pathname.split("/")[2]}/attachments/${x.id}`}>📎 {x.filename}</a></div>)}</div>))}
      </div>
      {t.canReply ? (
        <div className="pt-card"><h2>Add a reply</h2>
          <label htmlFor="pt-reply">Your message</label><textarea id="pt-reply" value={text} onChange={(e) => setText(e.target.value)} />
          <label htmlFor="pt-file">Attach a file (optional, up to {Math.round(cfg.maxAttachmentBytes / 1048576)} MB)</label><input id="pt-file" ref={fileRef} type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <p><button className="pt-btn" disabled={a.busy || !text.trim()} onClick={send}>{a.busy ? "Sending…" : "Send reply"}</button></p><Msg a={a} />
        </div>) : t.status === "CLOSED" && <p className="pt-muted">This request is closed. If you still need help, please start a new request and mention {t.number}.</p>}
      <div className="pt-row">
        {["OPEN", "IN_PROGRESS", "WAITING_FOR_YOU"].includes(t.status) && t.canReply && <button className="pt-btn sec" style={{ width: "auto" }} disabled={a.busy} onClick={() => a.run(async () => { await call(`tickets/${id}/solve`, { method: "POST" }); await load(); })}>This is resolved</button>}
        {t.canReopen && <button className="pt-btn sec" style={{ width: "auto" }} disabled={a.busy} onClick={() => a.run(async () => { await call(`tickets/${id}/reopen`, { method: "POST", body: {} }); await load(); })}>Reopen this request</button>}
      </div>
      {t.canRate && (
        <div className="pt-card"><h2>How did we do?</h2>
          <div className="pt-row" role="group" aria-label="Rating out of 5">{[1, 2, 3, 4, 5].map((n) => <button key={n} className={`pt-btn ${score === n ? "" : "sec"}`} style={{ width: "auto" }} aria-pressed={score === n} onClick={() => setScore(n)}>{n}</button>)}</div>
          <label htmlFor="pt-csat">Anything you'd like to add? (optional)</label><input id="pt-csat" value={comment} onChange={(e) => setComment(e.target.value)} />
          <p><button className="pt-btn" disabled={!score || a.busy} onClick={() => a.run(async () => { await call(`tickets/${id}/csat`, { method: "POST", body: { score, comment } }); a.setOk("Thank you for your feedback."); await load(); })}>Send feedback</button></p></div>)}
      {t.satisfaction && <p className="pt-muted">You rated this {t.satisfaction.score} out of 5. Thank you.</p>}
      {t.collaborators && (
        <div className="pt-card"><h2>Share this request</h2><p className="pt-muted">Colleagues from your company can follow and reply. Only people already known to us can be added.</p>
          <ul className="pt-list">{t.collaborators.map((c) => <li key={c.email}>{c.email}{c.canReply ? " (can reply)" : " (view only)"} <button className="pt-link" onClick={() => a.run(async () => { await call(`tickets/${id}/collaborators?email=${encodeURIComponent(c.email)}`, { method: "DELETE" }); await load(); })}>Remove</button></li>)}</ul>
          <label htmlFor="pt-share">Colleague's email</label><div className="pt-row"><input id="pt-share" style={{ flex: 1, minWidth: "12rem" }} type="email" value={share} onChange={(e) => setShare(e.target.value)} /><button className="pt-btn sec" style={{ width: "auto" }} disabled={!share || a.busy} onClick={() => a.run(async () => { await call(`tickets/${id}/collaborators`, { method: "POST", body: { email: share, canReply: true } }); setShare(""); await load(); })}>Share</button></div></div>)}
    </>
  );
}

function NewRequest({ call, upload, cfg, prefill, go }) {
  const [f, setF] = useState({ type: cfg.ticketTypes[0] || "Other", subject: prefill?.subject || "", description: prefill?.description || "", linkedInvoiceNumber: prefill?.invoice || "" });
  const [file, setFile] = useState(null); const [sug, setSug] = useState([]); const a = useAsync(); const key = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [inv, setInv] = useState([]);
  useEffect(() => { call("invoices").then((r) => setInv(r.invoices || [])).catch(() => {}); }, [call]);
  useEffect(() => { if (f.subject.length < 5 || !cfg.features.kb) { setSug([]); return; } const h = setTimeout(() => call(`suggest?q=${encodeURIComponent(f.subject)}`).then((r) => setSug(r.results || [])).catch(() => {}), 500); return () => clearTimeout(h); }, [f.subject, call, cfg.features.kb]);
  const submit = () => a.run(async () => {
    const r = await call("tickets", { method: "POST", body: { ...f, linkedInvoiceNumber: f.linkedInvoiceNumber || undefined, idempotencyKey: key.current } });
    if (file) { try { await upload(file, `ticketId=${r.ticket.id}`); } catch (e) { sessionStorage.setItem("pt-note", `Your request was created, but the attachment failed: ${e.message}`); } }
    go("ticket", r.ticket.id);
  });
  return (
    <>
      <h1>New request</h1>
      <div className="pt-card">
        <label htmlFor="pt-type">What is it about?</label><select id="pt-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{cfg.ticketTypes.map((x) => <option key={x}>{x}</option>)}</select>
        <label htmlFor="pt-subj">Subject</label><input id="pt-subj" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={200} />
        {sug.length > 0 && <div className="pt-muted" role="status" style={{ marginTop: 8 }}>These articles may already answer your question: {sug.map((s, i) => <span key={s.slug}>{i ? ", " : ""}<a href={`/portal/${window.location.pathname.split("/")[2]}?article=${s.slug}`} target="_blank" rel="noreferrer">{s.title}</a></span>)}</div>}
        <label htmlFor="pt-desc">Describe what happened</label><textarea id="pt-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        {inv.length > 0 && <><label htmlFor="pt-inv">Related invoice (optional)</label><select id="pt-inv" value={f.linkedInvoiceNumber} onChange={(e) => setF({ ...f, linkedInvoiceNumber: e.target.value })}><option value="">None</option>{inv.map((i) => <option key={i.id} value={i.invoiceNumber}>{i.invoiceNumber} · {i.currency} {i.total} · {i.status}</option>)}</select></>}
        <label htmlFor="pt-nfile">Attach a file (optional)</label><input id="pt-nfile" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <p className="pt-muted">We decide how urgent a request is from what it is about, so you don't need to pick a priority. If it is an emergency, say so in the description.</p>
        <p><button className="pt-btn" disabled={a.busy || f.subject.trim().length < 3 || !f.description.trim()} onClick={submit}>{a.busy ? "Sending…" : "Send request"}</button></p><Msg a={a} />
      </div>
    </>
  );
}

function Kb({ call, user, onSignIn }) {
  const [term, setTerm] = useState(() => (typeof window !== "undefined" ? sessionStorage.getItem("pt-kb-q") || "" : ""));
  const [res, setRes] = useState(null); const [cats, setCats] = useState([]); const [art, setArt] = useState(null); const [err, setErr] = useState(""); const [voted, setVoted] = useState("");
  const search = useCallback((t) => call(`kb/search?q=${encodeURIComponent(t)}`).then((r) => setRes(r.results)).catch((e) => setErr(e.message)), [call]);
  useEffect(() => { sessionStorage.removeItem("pt-kb-q"); call("kb/categories").then((r) => setCats(r.categories || [])).catch(() => {}); search(term); const a = new URLSearchParams(window.location.search).get("article"); if (a) open(a); /* eslint-disable-next-line */ }, []);
  const open = (slug) => { setVoted(""); call(`kb/articles/${slug}`).then((r) => setArt(r.article)).catch((e) => setErr(e.message)); };
  if (art) return (
    <>
      <p><button className="pt-btn sec" style={{ width: "auto" }} onClick={() => setArt(null)}>← Help articles</button></p>
      <article className="pt-card"><h1 style={{ marginTop: 0 }}>{art.title}</h1><p className="pt-muted">Updated {fmt(art.updatedAt)}</p><div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{art.body}</div>
        {user ? (voted ? <p className="pt-ok" role="status">{voted}</p> : <div className="pt-row" style={{ marginTop: 16 }}><span>Was this helpful?</span><button className="pt-btn sec" style={{ width: "auto" }} onClick={() => call(`kb/articles/${art.slug}/feedback`, { method: "POST", body: { helpful: true } }).then(() => setVoted("Thanks for letting us know.")).catch((e) => setErr(e.message))}>Yes</button><button className="pt-btn sec" style={{ width: "auto" }} onClick={() => call(`kb/articles/${art.slug}/feedback`, { method: "POST", body: { helpful: false } }).then(() => setVoted("Thanks. We'll use this to improve the article.")).catch((e) => setErr(e.message))}>No</button></div>) : <p className="pt-muted" style={{ marginTop: 16 }}><button className="pt-link" onClick={onSignIn}>Sign in</button> to leave feedback or contact support.</p>}
        {err && <p className="pt-err" role="alert">{err}</p>}</article>
    </>);
  return (
    <>
      <h1>Help articles</h1>
      <form className="pt-card" role="search" onSubmit={(e) => { e.preventDefault(); search(term); }}><label htmlFor="pt-kbq" style={{ marginTop: 0 }}>Search</label><div className="pt-row"><input id="pt-kbq" style={{ flex: 1, minWidth: "12rem" }} value={term} onChange={(e) => setTerm(e.target.value)} /><button className="pt-btn">Search</button></div></form>
      {err && <p className="pt-err" role="alert">{err}</p>}
      {res && (res.length ? <div className="pt-card"><ul className="pt-list">{res.map((r) => <li key={r.slug}><button className="pt-link" onClick={() => open(r.slug)}>{r.title}</button><div className="pt-muted">{r.snippet || r.summary}</div></li>)}</ul></div> : <p className="pt-muted">No articles matched “{term}”. {user ? "You can send us a request instead." : "Sign in to send us a request."}</p>)}
      {!term && cats.length > 0 && <p className="pt-muted">Topics: {cats.map((c) => c.name).join(" · ")}</p>}
    </>
  );
}

function Chat({ call, go }) {
  const [sid, setSid] = useState(null); const [msgs, setMsgs] = useState([]); const [text, setText] = useState(""); const a = useAsync(); const [handed, setHanded] = useState(null); const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [msgs]);
  const send = () => a.run(async () => { const t = text; setText(""); setMsgs((m) => [...m, { role: "customer", text: t }]); try { const r = await call("chat", { method: "POST", body: { sessionId: sid, message: t } }); setSid(r.session.sessionId); setMsgs(r.session.messages); } catch (e) { setMsgs((m) => m.slice(0, -1)); setText(t); throw e; } });
  const last = msgs[msgs.length - 1];
  return (
    <>
      <h1>Ask the assistant</h1>
      <p className="pt-muted">The assistant answers from our help articles and shows which ones it used. It cannot look at your account or change anything. If it can't help, you can send the conversation to our team.</p>
      <div className="pt-card"><div className="pt-chat" role="log" aria-live="polite" aria-label="Conversation">
        {!msgs.length && <p className="pt-muted">Ask a question to get started.</p>}
        {msgs.map((m, i) => <div key={i} className={`pt-msg ${m.role === "customer" ? "me" : ""}`}><div className="pt-muted"><strong>{m.role === "customer" ? "You" : "Assistant"}</strong></div>{m.text}{m.citations?.length > 0 && <div className="pt-muted">Sources: {m.citations.map((c) => c.title).join(", ")}</div>}</div>)}<div ref={end} /></div>
        {handed ? <p className="pt-ok" role="status">Sent to our team as {handed}. You can follow it in My requests.</p> : (<>
          <label htmlFor="pt-chat-in">Your question</label><textarea id="pt-chat-in" style={{ minHeight: 70 }} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) send(); }} />
          <div className="pt-row" style={{ marginTop: 10 }}><button className="pt-btn" disabled={a.busy || !text.trim()} onClick={send}>{a.busy ? "Thinking…" : "Send"}</button>
            {sid && msgs.length > 0 && <button className={`pt-btn ${last?.handoffOffered ? "" : "sec"}`} disabled={a.busy} onClick={() => a.run(async () => { const r = await call(`chat/${sid}/handoff`, { method: "POST", body: {} }); setHanded(r.number); })}>Send this to our support team</button>}</div></>)}
        <Msg a={a} /></div>
    </>
  );
}

function Ideas({ call, upload, cfg }) {
  const [scope, setScope] = useState("mine"); const [d, setD] = useState(null); const [f, setF] = useState({ title: "", description: "", expectedBenefit: "", communityVisible: false }); const [sim, setSim] = useState([]); const [file, setFile] = useState(null); const a = useAsync();
  const load = useCallback(() => call(`ideas?scope=${scope}`).then(setD).catch(() => setD({ ideas: [] })), [call, scope]);
  useEffect(() => { load(); }, [load]);
  const check = () => a.run(async () => { const r = await call("ideas/check", { method: "POST", body: f }); setSim(r.similar); if (!r.similar.length) await submit(); });
  const submit = async (associateWithId) => { const r = await call("ideas", { method: "POST", body: { ...f, ...(associateWithId ? { associateWithId } : {}) } }); if (file && r.idea && !r.associated) await upload(file, `ideaId=${r.idea.id}`).catch(() => {}); setF({ title: "", description: "", expectedBenefit: "", communityVisible: false }); setFile(null); setSim([]); a.setOk("Thank you. Your idea was received. Submitting an idea doesn't promise it will be built, but we read every one."); await load(); };
  return (
    <>
      <h1>Ideas</h1>
      <div className="pt-card"><h2>Suggest an improvement</h2>
        <label htmlFor="pi-t">Title</label><input id="pi-t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <label htmlFor="pi-d">What would you like, and why?</label><textarea id="pi-d" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <label htmlFor="pi-b">How would it help you? (optional)</label><input id="pi-b" value={f.expectedBenefit} onChange={(e) => setF({ ...f, expectedBenefit: e.target.value })} />
        <label htmlFor="pi-f">Attach an example (optional)</label><input id="pi-f" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        {cfg.features.votingEnabled && <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}><input style={{ width: "auto" }} type="checkbox" checked={f.communityVisible} onChange={(e) => setF({ ...f, communityVisible: e.target.checked })} />Let other customers see and vote on this idea (your name is never shown). Leave unticked to keep it private.</label>}
        {sim.length > 0 && <div className="pt-banner" role="status"><strong>Similar ideas already exist</strong><ul className="pt-list">{sim.map((s) => <li key={s.id}>{s.number}: {s.title} {s.mine ? "(yours)" : ""} <button className="pt-link" onClick={() => a.run(() => submit(s.id))}>{s.mine ? "Add my details there" : "Support this one instead"}</button></li>)}</ul><button className="pt-btn sec" style={{ width: "auto" }} onClick={() => a.run(() => submit())}>Mine is different — submit it</button></div>}
        <p><button className="pt-btn" disabled={a.busy || f.title.trim().length < 4 || f.description.trim().length < 10} onClick={check}>Submit idea</button></p><Msg a={a} /></div>
      <div className="pt-row" role="group" aria-label="Show">{[["mine", "My ideas"], ...(cfg.features.votingEnabled ? [["community", "Community ideas"]] : [])].map(([v, l]) => <button key={v} className={`pt-btn ${scope === v ? "" : "sec"}`} style={{ width: "auto" }} aria-pressed={scope === v} onClick={() => setScope(v)}>{l}</button>)}</div>
      <div className="pt-card">{!d ? <p className="pt-muted">Loading…</p> : !d.ideas.length ? <p className="pt-muted">Nothing here yet.</p> : <ul className="pt-list">{d.ideas.map((i) => <li key={i.id}><strong>{i.title}</strong> <span className={`pt-tag ${i.status === "SHIPPED" ? "ok" : i.status === "DECLINED" ? "bad" : ""}`}>{i.status.replace(/_/g, " ").toLowerCase()}</span><div className="pt-muted">{i.number} · {i.votes} vote{i.votes === 1 ? "" : "s"}{i.publicNote ? ` · ${i.publicNote}` : ""}</div>
        {scope === "community" && <button className="pt-btn sec" style={{ width: "auto", marginTop: 6 }} onClick={() => a.run(async () => { await call(`ideas/${i.id}/vote`, { method: i.voted ? "DELETE" : "POST" }); await load(); })}>{i.voted ? "Remove my vote" : "Vote"}</button>}</li>)}</ul>}</div>
    </>
  );
}

function Invoices({ call, go }) {
  const [d, setD] = useState(null);
  useEffect(() => { call("invoices").then(setD).catch(() => setD({ invoices: [] })); }, [call]);
  return (
    <>
      <h1>Invoices</h1>
      <div className="pt-card">{!d ? <p className="pt-muted">Loading…</p> : !d.invoices.length ? <p className="pt-muted">{d.note || "No invoices found on your account."}</p> : (
        <div className="pt-table-wrap"><table className="pt-table"><caption className="pt-muted" style={{ textAlign: "left" }}>Read-only. Invoices come from the company's billing records.</caption><thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th>Amount</th><th>Status</th><th><span className="pt-muted">Help</span></th></tr></thead>
          <tbody>{d.invoices.map((i) => <tr key={i.id}><td>{i.invoiceNumber}</td><td>{new Date(i.issueDate).toLocaleDateString()}</td><td>{new Date(i.dueDate).toLocaleDateString()}</td><td>{i.currency} {i.total}</td><td><span className={`pt-tag ${i.status === "PAID" ? "ok" : i.status === "OVERDUE" ? "bad" : ""}`}>{i.status.toLowerCase()}</span></td><td><button className="pt-link" onClick={() => go("new", { subject: `Question about invoice ${i.invoiceNumber}`, invoice: i.invoiceNumber, description: "" })}>Ask about this invoice</button></td></tr>)}</tbody></table></div>)}</div>
    </>
  );
}

function Notifications({ call, go, onRead }) {
  const [d, setD] = useState(null);
  useEffect(() => { call("notifications").then((r) => { setD(r); if (r.unread) call("notifications/read", { method: "POST" }).then(onRead).catch(() => {}); }).catch(() => setD({ notifications: [] })); /* eslint-disable-next-line */ }, [call]);
  return (
    <>
      <h1>Notifications</h1>
      <div className="pt-card">{!d ? <p className="pt-muted">Loading…</p> : !d.notifications.length ? <p className="pt-muted">Nothing yet.</p> : <ul className="pt-list">{d.notifications.map((n) => <li key={n.id}>{n.ticketId ? <button className="pt-link" onClick={() => go("ticket", n.ticketId)}>{n.title}</button> : <strong>{n.title}</strong>}<div className="pt-muted">{fmt(n.createdAt)}{n.body ? ` · ${n.body}` : ""}</div></li>)}</ul>}</div>
    </>
  );
}

function Account({ call, user, setUser, onOut }) {
  const [name, setName] = useState(user.name || ""); const [tz, setTz] = useState(user.timezone || ""); const [prefs, setPrefs] = useState({ ticketUpdates: true, productAnnouncements: false, ideaUpdates: true, kbSubscriptions: false, ...(user.prefs || {}) }); const a = useAsync();
  const P = ([k, l]) => <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ink)" }}><input style={{ width: "auto" }} type="checkbox" checked={!!prefs[k]} onChange={(e) => setPrefs({ ...prefs, [k]: e.target.checked })} />{l}</label>;
  return (
    <>
      <h1>Account</h1>
      <div className="pt-card">
        <p className="pt-muted">Signed in as {user.email}</p>
        <label htmlFor="pa-n">Your name</label><input id="pa-n" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="pa-tz">Time zone (e.g. Europe/London)</label><input id="pa-tz" value={tz} onChange={(e) => setTz(e.target.value)} />
        <h2 style={{ marginTop: 18 }}>Email me about</h2>
        {[["ticketUpdates", "Updates on my requests"], ["ideaUpdates", "Changes to my ideas"], ["productAnnouncements", "Product announcements"], ["kbSubscriptions", "New help articles"]].map(P)}
        <p className="pt-muted">Sign-in and security emails are always sent.</p>
        <p><button className="pt-btn" disabled={a.busy} onClick={() => a.run(async () => { const r = await call("me", { method: "PUT", body: { name, timezone: tz || undefined, prefs } }); setUser(r.user); a.setOk("Saved."); })}>Save</button></p><Msg a={a} />
      </div>
      <button className="pt-btn bad" style={{ width: "auto" }} onClick={onOut}>Sign out</button>
    </>
  );
}
