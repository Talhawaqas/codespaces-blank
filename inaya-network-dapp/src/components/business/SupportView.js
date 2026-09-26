"use client";

// src/components/business/SupportView.js
//
// Customer Portal & Customer Service SOW: the agent console (Business Workspace > Customer Support).
// Real calls to /api/orgs/support/*; permissions are enforced by the server, the UI only hides what the server would
// refuse. Nothing is simulated in the browser.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import { api, useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, fmtTime } from "./nas/ui";
import { KnowledgePanel, IdeasPanel, AnalyticsPanel, InboundPanel, IncidentsPanel } from "./support/panels";
import { SettingsPanel } from "./support/settings";
import { PortalPanel } from "./support/setup";
import { q, post } from "./support/helpers";
import { uploadFile } from "../support/chunkedUpload";

const TABS = [["tickets", "Tickets"], ["portal", "Portal & sharing"], ["knowledge", "Knowledge base"], ["ideas", "Ideas"], ["analytics", "Analytics"], ["inbound", "Email intake"], ["incidents", "Incidents"], ["settings", "Settings"]];
const VIEWS = [["all_open", "All open"], ["unassigned", "Unassigned"], ["assigned_to_me", "Assigned to me"], ["my_team", "My team"], ["new", "New"], ["waiting_customer", "Waiting for customer"], ["escalated", "Escalated"], ["sla_at_risk", "SLA at risk"], ["sla_breached", "SLA breached"], ["high_priority", "High priority"], ["recently_solved", "Recently solved"], ["all", "Everything"]];
const SLA_TONE = { ON_TRACK: "OK", AT_RISK: "WARNING", BREACHED: "CRITICAL", PAUSED: "PENDING", COMPLETED: "COMPLETED" };
const PRIO_TONE = { URGENT: "CRITICAL", HIGH: "HIGH", NORMAL: "NORMAL", LOW: "PENDING" };

export default function SupportView({ orgId, canManage }) {
  const me = useLoad(`/api/orgs/support/me?${q(orgId)}`);
  const [tab, setTab] = useState("tickets");
  const [openId, setOpenId] = useState(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("ticket")));
  const perms = me.data?.permissions || [];
  const has = (p) => perms.includes(p);

  if (me.loading && !me.data) return <Note>Loading…</Note>;
  if (me.error) return <Err error={me.error} />;
  if (me.data && !me.data.isStaff && !has("admin_settings")) return <EmptyState title="No access to Customer Support" description="Ask an organization owner or admin to give you the agent or manager support role." />;

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Customer Support</h2>
        <p className="text-sm text-[var(--inaya-text-muted)]">Tickets from your customers, the knowledge base they read, and the portal they sign in to.
          {me.data?.portalEnabled && me.data?.portalSlug ? <> Your customer portal: <a className="underline" href={`/portal/${me.data.portalSlug}`} target="_blank" rel="noreferrer">/portal/{me.data.portalSlug} ↗</a> (see <button type="button" className="underline" onClick={() => setTab("portal")}>Portal &amp; sharing</button> to share it with customers).</> : <> The customer portal is not switched on yet: <button type="button" className="underline" onClick={() => setTab("portal")}>set it up</button>.</>}</p>
      </header>
      <nav aria-label="Support sections" className="flex flex-wrap gap-1">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => { setTab(id); setOpenId(null); }} aria-current={tab === id ? "page" : undefined}
            className={`rounded border px-3 py-1.5 text-xs font-medium ${tab === id ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </nav>
      {tab === "tickets" && (openId ? <TicketWorkspace orgId={orgId} ticketId={openId} has={has} me={me.data} onClose={() => setOpenId(null)} onOpen={setOpenId} /> : <TicketList orgId={orgId} has={has} onOpen={setOpenId} me={me.data} />)}
      {tab === "portal" && <PortalPanel orgId={orgId} has={has} goTab={(t) => { setTab(t); setOpenId(null); }} />}
      {tab === "knowledge" && <KnowledgePanel orgId={orgId} has={has} canManage={canManage} />}
      {tab === "ideas" && <IdeasPanel orgId={orgId} has={has} />}
      {tab === "analytics" && <AnalyticsPanel orgId={orgId} />}
      {tab === "inbound" && <InboundPanel orgId={orgId} has={has} />}
      {tab === "incidents" && <IncidentsPanel orgId={orgId} has={has} />}
      {tab === "settings" && <SettingsPanel orgId={orgId} has={has} onChanged={me.reload} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- list
function TicketList({ orgId, has, onOpen, me }) {
  const [view, setView] = useState("all_open");
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [queueId, setQueueId] = useState("");
  const queues = useLoad(`/api/orgs/support/queues?${q(orgId)}`);
  const list = useLoad(`/api/orgs/support/tickets?${q(orgId, `&view=${view}${term ? `&q=${encodeURIComponent(term)}` : ""}${queueId ? `&queueId=${queueId}` : ""}`)}`);
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-4">
      <Card title="Tickets" right={<><Btn small onClick={() => setCreating((v) => !v)}>{creating ? "Close" : "New ticket"}</Btn><a className="rounded border border-white/20 px-3 py-1 text-xs" href={`/api/orgs/support/export?${q(orgId)}&format=csv`}>Export CSV</a><Btn small onClick={list.reload} busy={list.loading}>Refresh</Btn></>}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem]"><Select id="sup-view" label="View" value={view} onChange={setView} options={VIEWS.map(([v, l]) => ({ value: v, label: l }))} /></div>
          <div className="min-w-[10rem]"><Select id="sup-queue" label="Queue" value={queueId} onChange={setQueueId} options={[{ value: "", label: "All queues" }, ...(queues.data?.queues || []).map((x) => ({ value: x.queueId, label: x.name }))]} /></div>
          <form className="flex min-w-[14rem] flex-1 items-end gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(search.trim()); }}>
            <div className="flex-1"><Input id="sup-search" label="Search" value={search} onChange={setSearch} placeholder="Ticket number, customer, words, invoice" /></div>
            <Btn small onClick={() => setTerm(search.trim())}>Search</Btn>
          </form>
        </div>
        <Err error={list.error} />
        {list.data && !list.data.tickets?.length ? <EmptyState title="No tickets here" description="Nothing matches this view." /> : (
          <Table columns={[
            { key: "number", label: "Ticket", render: (t) => <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={() => onOpen(t.id)}>{t.number}{t.unread ? " •" : ""}</button> },
            { key: "subject", label: "Subject", render: (t) => <span className="line-clamp-1">{t.subject}</span> },
            { key: "requester", label: "Customer", render: (t) => t.requester?.email || "" },
            { key: "status", label: "Status", render: (t) => <Pill value={t.status} /> },
            { key: "priority", label: "Priority", render: (t) => <Pill value={PRIO_TONE[t.priority] || "NORMAL"} label={t.priority} /> },
            { key: "sla", label: "SLA", render: (t) => (t.sla ? <Pill value={SLA_TONE[t.sla.state] || "OK"} label={t.sla.state} /> : "—") },
            { key: "assigneeEmail", label: "Agent", render: (t) => t.assigneeEmail || <span className="text-[var(--inaya-text-muted)]">Unassigned</span> },
            { key: "updatedAt", label: "Updated", render: (t) => fmtTime(t.updatedAt) },
          ]} rows={list.data?.tickets || []} />
        )}
        {list.data && <Note>{list.data.total} ticket{list.data.total === 1 ? "" : "s"} in this view.</Note>}
      </Card>
      {creating && <NewTicket orgId={orgId} me={me} queues={queues.data?.queues || []} onCreated={(t) => { setCreating(false); onOpen(t.id); }} />}
    </div>
  );
}

function NewTicket({ orgId, me, queues, onCreated }) {
  const [f, setF] = useState({ requesterEmail: "", subject: "", description: "", type: "Technical Support", queueId: "" });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const act = useAction((r) => r?.ticket && onCreated(r.ticket));
  return (
    <Card title="New ticket for a customer">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input id="nt-email" label="Customer email" value={f.requesterEmail} onChange={set("requesterEmail")} placeholder="customer@company.com" />
        <Select id="nt-type" label="Type" value={f.type} onChange={set("type")} options={me?.ticketTypes || ["Other"]} />
        <div className="sm:col-span-2"><Input id="nt-subject" label="Subject" value={f.subject} onChange={set("subject")} /></div>
        <label className="block text-xs sm:col-span-2"><span className="text-[var(--inaya-text-muted)]">Description</span>
          <textarea id="nt-desc" rows={4} value={f.description} onChange={(e) => set("description")(e.target.value)} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-sm" /></label>
        <Select id="nt-queue" label="Queue" value={f.queueId} onChange={set("queueId")} options={[{ value: "", label: "Route automatically" }, ...queues.map((x) => ({ value: x.queueId, label: x.name }))]} />
      </div>
      <Btn busy={act.busy} disabled={!f.requesterEmail || f.subject.length < 3 || !f.description} onClick={() => act.run(() => post(orgId, "tickets", { ...f, queueId: f.queueId || undefined }))}>Create ticket</Btn>
      <Err error={act.error} />
    </Card>
  );
}

// ------------------------------------------------------------------------------------ workspace
function TicketWorkspace({ orgId, ticketId, has, me, onClose, onOpen }) {
  const data = useLoad(`/api/orgs/support/tickets/${ticketId}?${q(orgId)}`);
  const queues = useLoad(`/api/orgs/support/queues?${q(orgId)}`);
  const agents = useLoad(has("assign_tickets") ? `/api/orgs/support/agents?${q(orgId)}` : null);
  const macros = useLoad(`/api/orgs/support/macros?${q(orgId)}`);
  const [mode, setMode] = useState("reply");
  const [text, setText] = useState("");
  const [setStatus, setSetStatus] = useState("");
  const [file, setFile] = useState(null);
  const [aiMeta, setAiMeta] = useState(null);
  const t = data.data?.ticket;
  useEffect(() => { if (t) post(orgId, `tickets/${ticketId}/read`).catch(() => {}); }, [ticketId, orgId, t?.id]);
  const act = useAction(data.reload);
  const run = (path, body, confirm) => act.run(() => post(orgId, `tickets/${ticketId}/${path}`, body), confirm);

  const send = () => act.run(async () => {
    const r = await post(orgId, `tickets/${ticketId}/${mode === "note" ? "note" : "reply"}`, { body: text, ...(mode === "reply" && setStatus ? { setStatus } : {}), ...(mode === "reply" && aiMeta ? { aiGenerated: true } : {}) });
    if (file && r.message?.id) {
      try { await uploadFile({ file, initUrl: `/api/orgs/support/uploads?${q(orgId)}`, chunkUrl: (id, i) => `/api/orgs/support/uploads/${id}?${q(orgId, `&index=${i}`)}`, completeUrl: (id) => `/api/orgs/support/uploads/${id}?${q(orgId)}`, target: { ticketId, messageId: r.message.id, internal: mode === "note" } }); }
      catch (e) { throw new Error(`The message was sent, but the attachment failed: ${e.message}`); }
    }
    setText(""); setFile(null); setAiMeta(null); setSetStatus("");
    return r;
  });
  const draft = () => act.run(async () => { const r = await post(orgId, `tickets/${ticketId}/ai-draft`); setText(r.draft.text); setAiMeta(r.draft); setMode("reply"); return r; });

  if (data.error) return <div className="space-y-2"><Btn small onClick={onClose}>← Back</Btn><Err error={data.error} /></div>;
  if (!t) return <Note>Loading ticket…</Note>;
  const d = data.data;
  const closed = ["CLOSED", "CANCELLED"].includes(t.status);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Btn small onClick={onClose}>← Tickets</Btn>
        <h3 className="text-base font-semibold">{t.number} · {t.subject}</h3>
        <Pill value={t.status} />
        <Pill value={PRIO_TONE[t.priority] || "NORMAL"} label={`${t.priority} priority`} />
        {t.sla && <Pill value={SLA_TONE[t.sla.state] || "OK"} label={`SLA ${t.sla.state.replace("_", " ")}`} />}
        <span className="text-xs text-[var(--inaya-text-muted)]">via {String(t.channel).replace("_", " ").toLowerCase()}</span>
      </div>
      <Err error={act.error} />
      {t.mergedInto && <Note tone="warn">This ticket was merged into another; the conversation continues there.</Note>}
      {t.chatHandoff && <Card title="Handed off from the AI assistant"><p className="whitespace-pre-wrap text-sm">{t.chatHandoff.summary}</p><Note>The full conversation is at the start of the description below.</Note></Card>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <Card title="Conversation">
            <ul className="space-y-3" aria-label="Messages">
              {d.messages.map((m) => (
                <li key={m.id} className={`rounded border p-3 text-sm ${m.visibility === "INTERNAL" ? "border-amber-400/40 bg-amber-400/5" : m.author?.type === "customer" || m.author?.type === "email" ? "border-white/10" : "border-[var(--inaya-accent)]/30"}`}>
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-[var(--inaya-text-muted)]">
                    <strong className="text-[var(--inaya-text)]">{m.author?.name || m.author?.email}</strong>
                    {m.visibility === "INTERNAL" && <Pill value="ATTENTION" label="Internal note — customer cannot see" />}
                    {m.aiGenerated && <span>AI-drafted, sent by a person</span>}
                    <span>{fmtTime(m.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  {(d.attachments || []).filter((a) => a.messageId === m.id).map((a) => <a key={a.id} className="mt-1 mr-2 inline-block text-xs underline" href={`/api/orgs/support/attachments/${a.id}?${q(orgId)}`}>📎 {a.filename}</a>)}
                </li>
              ))}
            </ul>
          </Card>
          {!closed && (has("reply_public") || has("create_notes")) && (
            <Card title={mode === "note" ? "Internal note" : "Reply to customer"} right={<>
              {has("reply_public") && <Btn small onClick={() => setMode("reply")}>Reply</Btn>}
              {has("create_notes") && <Btn small onClick={() => setMode("note")}>Note</Btn>}
            </>}>
              {mode === "note" && <Note tone="warn">Only your team sees internal notes. Use @colleague@company.com to notify someone.</Note>}
              <textarea id="tk-body" aria-label="Message" rows={5} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-sm" placeholder={mode === "note" ? "Add a private note…" : "Write your reply…"} />
              {aiMeta && <Note tone="warn">AI draft — check it before sending. {aiMeta.confirmBeforeSending?.length ? `Confirm first: ${aiMeta.confirmBeforeSending.join("; ")}. ` : ""}{aiMeta.sources?.length ? `Based on: ${aiMeta.sources.map((s) => s.title).join(", ")}.` : "No knowledge article was used."}</Note>}
              <div className="flex flex-wrap items-end gap-2">
                {mode === "reply" && <div className="w-48"><Select id="tk-setstatus" label="After sending" value={setStatus} onChange={setSetStatus} options={[{ value: "", label: "Keep status" }, { value: "WAITING_FOR_CUSTOMER", label: "Waiting for customer" }, { value: "IN_PROGRESS", label: "In progress" }, { value: "SOLVED", label: "Solved" }]} /></div>}
                {mode === "reply" && (macros.data?.macros?.length > 0) && <div className="w-48"><Select id="tk-macro" label="Macro" value="" onChange={(id) => id && act.run(async () => { const r = await post(orgId, `tickets/${ticketId}/macro`, { macroId: id }); setText((x) => (x ? `${x}\n\n` : "") + r.text); if (r.setStatus) setSetStatus(r.setStatus); })} options={[{ value: "", label: "Insert…" }, ...macros.data.macros.map((m) => ({ value: m.id, label: m.name }))]} /></div>}
                <label className="text-xs"><span className="text-[var(--inaya-text-muted)]">Attach</span><input id="tk-file" type="file" className="mt-1 block text-xs" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
                <Btn busy={act.busy} disabled={!text.trim()} onClick={send}>{mode === "note" ? "Add note" : "Send reply"}</Btn>
                {mode === "reply" && has("use_ai") && <Btn busy={act.busy} onClick={draft}>Draft with AI</Btn>}
              </div>
            </Card>
          )}
          <Card title="Activity"><ul className="space-y-1 text-xs text-[var(--inaya-text-muted)]">{d.events.slice().reverse().slice(0, 30).map((e, i) => <li key={i}>{fmtTime(e.at)} · {e.type.replace("ticket.", "").replace(/_/g, " ")}{e.actor ? ` · ${e.actor}` : ""}{e.data?.to ? ` → ${e.data.to}` : ""}</li>)}</ul></Card>
        </div>
        <aside className="space-y-4">
          <Card title="Details">
            <dl className="grid grid-cols-[6.5rem_1fr] gap-y-1 text-xs">
              <dt className="text-[var(--inaya-text-muted)]">Customer</dt><dd>{d.customer?.contact?.name || t.requester?.email}<br /><span className="text-[var(--inaya-text-muted)]">{t.requester?.email}</span></dd>
              {d.customer?.contact?.company && <><dt className="text-[var(--inaya-text-muted)]">Company</dt><dd>{d.customer.contact.company}</dd></>}
              {d.customer?.profile?.tier && <><dt className="text-[var(--inaya-text-muted)]">Tier</dt><dd>{d.customer.profile.tier}</dd></>}
              <dt className="text-[var(--inaya-text-muted)]">Type</dt><dd>{t.type} / {t.category}</dd>
              <dt className="text-[var(--inaya-text-muted)]">Created</dt><dd>{fmtTime(t.createdAt)}</dd>
              {t.sla && <><dt className="text-[var(--inaya-text-muted)]">SLA</dt><dd>{t.sla.policy}<br />First reply {t.sla.firstResponseDueAt ? `by ${fmtTime(t.sla.firstResponseDueAt)}` : t.firstResponseAt ? "done" : "clock paused"} · Resolve {t.sla.resolutionDueAt ? `by ${fmtTime(t.sla.resolutionDueAt)}` : t.sla.state === "COMPLETED" ? "done" : "clock paused"}<br /><span className="text-[var(--inaya-text-muted)]">{t.sla.firstPct}% / {t.sla.resolutionPct}% used{t.sla.state === "PAUSED" ? " · clock paused" : ""}</span></dd></>}
            </dl>
          </Card>
          <Card title="Manage">
            <div className="space-y-2">
              <Select id="tk-status" label="Status" value={t.status} onChange={(v) => run("status", { status: v })} options={["NEW", "OPEN", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "WAITING_FOR_THIRD_PARTY", "ESCALATED", "SOLVED", "CLOSED", "CANCELLED"]} />
              {has("assign_tickets") && <Select id="tk-assign" label="Assigned to" value={t.assigneeEmail || ""} onChange={(v) => run("assign", { assigneeEmail: v || null })} options={[{ value: "", label: "Unassigned" }, ...(agents.data?.agents || []).map((a) => ({ value: a.email, label: a.email }))]} />}
              {has("assign_tickets") && <Select id="tk-queue2" label="Queue" value={t.queueId || ""} onChange={(v) => v && run("assign", { queueId: v })} options={[{ value: "", label: "—" }, ...(queues.data?.queues || []).map((x) => ({ value: x.queueId, label: x.name }))]} />}
              {has("change_priority") && <Select id="tk-prio" label="Priority" value={t.priority} onChange={(v) => run("priority", { priority: v })} options={["LOW", "NORMAL", "HIGH", "URGENT"]} />}
              <div className="flex flex-wrap gap-1"><Btn small onClick={() => run("follow", { on: true })}>Follow</Btn>{t.status === "SOLVED" && <Btn small onClick={() => run("reopen", {})}>Reopen</Btn>}{has("use_ai") && <Btn small onClick={() => run("triage", {})}>Re-run AI triage</Btn>}{has("manage_kb") && <Btn small onClick={() => run("kb-draft", {}, "Ask AI to draft a knowledge article from this ticket? It stays a draft until a person publishes it.")}>Draft KB article</Btn>}</div>
              <TagEditor tags={t.tags || []} onChange={(add, remove) => run("tags", { add, remove })} />
            </div>
          </Card>
          {t.aiTriage && t.aiTriage.state !== "SKIPPED" && (
            <Card title="AI triage (advisory)">
              {t.aiTriage.state === "DONE" ? (<div className="space-y-1 text-xs"><p>{t.aiTriage.suggestion.summary}</p><p className="text-[var(--inaya-text-muted)]">Suggests {t.aiTriage.suggestion.category || "no category"} · {t.aiTriage.suggestion.priority} priority · sentiment {t.aiTriage.suggestion.sentiment} · confidence {Math.round(t.aiTriage.suggestion.confidence * 100)}%. Applied automatically: {Object.entries(t.aiTriage.applied || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing"}.</p></div>)
                : <Note tone="warn">{t.aiTriage.state === "PENDING" ? "AI triage has not completed yet; it will be retried automatically." : "AI triage was unavailable for this ticket. It was routed by your rules."}</Note>}
            </Card>
          )}
          {d.customer?.history?.length > 1 && <Card title="Customer history"><ul className="space-y-1 text-xs">{d.customer.history.filter((h) => h.id !== t.id).map((h) => <li key={h.id}><button type="button" className="underline" onClick={() => onOpen(h.id)}>{h.number}</button> {h.subject} <Pill value={h.status} /></li>)}</ul></Card>}
          {d.duplicates?.length > 0 && <Card title="Possible duplicates"><ul className="space-y-1 text-xs">{d.duplicates.map((x) => <li key={x.id}><button type="button" className="underline" onClick={() => onOpen(x.id)}>{x.number}</button> {x.subject} <span className="text-[var(--inaya-text-muted)]">({Math.round(x.score * 100)}% similar)</span>{has("merge_tickets") && <> <Btn small onClick={() => run("merge", { targetId: x.id }, `Merge ${t.number} into ${x.number}? Nothing is deleted; ${t.number} is closed and points to ${x.number}.`)}>Merge into it</Btn></>}</li>)}</ul></Card>}
          {d.related?.length > 0 && <Card title="Related tickets"><ul className="space-y-1 text-xs">{d.related.map((r) => r.ticket && <li key={r.relationId}>{r.type}: <button type="button" className="underline" onClick={() => onOpen(r.ticket.id)}>{r.ticket.number}</button> {r.ticket.subject}</li>)}</ul></Card>}
          {(d.customer?.invoices?.length > 0 || d.linkedInvoices?.length > 0) && <Card title="Invoices (from Finance)"><ul className="space-y-1 text-xs">{(d.linkedInvoices?.length ? d.linkedInvoices : d.customer.invoices).map((i) => <li key={i.id}>{i.invoiceNumber} · {i.currency} {i.total} <Pill value={i.status === "OVERDUE" ? "CRITICAL" : i.status === "PAID" ? "OK" : "PENDING"} label={i.status} /></li>)}</ul></Card>}
        </aside>
      </div>
    </div>
  );
}

function TagEditor({ tags, onChange }) {
  const [v, setV] = useState("");
  return (
    <div className="text-xs">
      <div className="mb-1 flex flex-wrap gap-1">{tags.map((tg) => <button key={tg} type="button" onClick={() => onChange([], [tg])} title="Remove tag" className="rounded border border-white/15 px-1.5 py-0.5">{tg} ×</button>)}</div>
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onChange([v.trim()], []); setV(""); } }} className="flex gap-1"><input aria-label="Add tag" value={v} onChange={(e) => setV(e.target.value)} placeholder="Add tag" className="w-full rounded border border-white/10 bg-transparent px-2 py-1" /><Btn small onClick={() => { if (v.trim()) { onChange([v.trim()], []); setV(""); } }}>Add</Btn></form>
    </div>
  );
}
