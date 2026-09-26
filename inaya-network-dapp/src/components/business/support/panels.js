"use client";

// Support console panels: knowledge base, ideas, analytics, email intake (quarantine), incidents.

import { useState } from "react";
import EmptyState from "../../EmptyState";
import { useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, fmtTime } from "../nas/ui";
import { q, post } from "./helpers";

const area = "mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-sm";

// ------------------------------------------------------------------------------------- knowledge
export function KnowledgePanel({ orgId, has }) {
  const [status, setStatus] = useState("");
  const list = useLoad(`/api/orgs/support/kb?${q(orgId, status ? `&status=${status}` : "")}`);
  const gaps = useLoad(has("manage_kb") ? `/api/orgs/support/kb/gaps?${q(orgId)}` : null);
  const [editing, setEditing] = useState(null);
  if (editing) return <ArticleEditor orgId={orgId} id={editing === "new" ? null : editing} has={has} onClose={() => { setEditing(null); list.reload(); }} />;
  return (
    <div className="space-y-4">
      <Card title="Knowledge base" right={<>{has("manage_kb") && <Btn small onClick={() => setEditing("new")}>New article</Btn>}<Btn small onClick={list.reload} busy={list.loading}>Refresh</Btn></>}>
        <div className="w-56"><Select id="kb-status" label="Show" value={status} onChange={setStatus} options={[{ value: "", label: "All" }, "DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"]} /></div>
        <Err error={list.error} />
        {!list.data?.articles?.length ? <EmptyState title="No articles yet" description="Write the answers customers ask for most. Published articles are searched by the portal and used by the AI assistant, with citations." /> : (
          <Table columns={[
            { key: "title", label: "Title", render: (a) => <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={() => setEditing(a.id)}>{a.title}{a.aiDrafted ? " (AI draft)" : ""}</button> },
            { key: "status", label: "Status", render: (a) => <Pill value={a.status === "PUBLISHED" ? "OK" : a.status === "IN_REVIEW" ? "PENDING" : "NORMAL"} label={a.status} /> },
            { key: "audience", label: "Audience" }, { key: "category", label: "Category" },
            { key: "views", label: "Views" },
            { key: "helpful", label: "Helpful", render: (a) => `${a.helpful} / ${a.helpful + a.notHelpful}` },
            { key: "updatedAt", label: "Updated", render: (a) => fmtTime(a.updatedAt) },
          ]} rows={list.data.articles} />
        )}
      </Card>
      {gaps.data && (
        <Card title="Gaps: what customers ask that no article answers">
          {gaps.data.gaps?.length ? <ul className="space-y-1 text-sm">{gaps.data.gaps.map((g, i) => <li key={i}>{g.topic} — {g.ticketCount} similar tickets, no matching article ({g.sampleTickets.join(", ")})</li>)}</ul> : <Note>No gaps found in the last 30 days (or not enough data yet).</Note>}
        </Card>
      )}
    </div>
  );
}

function ArticleEditor({ orgId, id, has, onClose }) {
  const one = useLoad(id ? `/api/orgs/support/kb/${id}?${q(orgId)}` : null);
  const [f, setF] = useState(null);
  const a = one.data?.article;
  const form = f || (a ? { title: a.title, body: a.body, summary: a.summary || "", category: a.category, audience: a.audience, tags: (a.tags || []).join(", ") } : { title: "", body: "", summary: "", category: "General", audience: "CUSTOMERS", tags: "" });
  const set = (k) => (v) => setF({ ...form, [k]: v });
  const act = useAction(async (r) => { if (r?.article && !id) onClose(); else { setF(null); one.reload(); } });
  const payload = { ...form, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) };
  const [note, setNote] = useState("");
  return (
    <div className="space-y-4">
      <Btn small onClick={onClose}>← Articles</Btn>
      <Card title={id ? `Edit: ${a?.title || ""}` : "New article"}>
        <Err error={one.error || act.error} />
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="sm:col-span-2"><Input id="kb-title" label="Title" value={form.title} onChange={set("title")} /></div>
          <Input id="kb-cat" label="Category" value={form.category} onChange={set("category")} />
          <Select id="kb-aud" label="Who can read it" value={form.audience} onChange={set("audience")} options={[{ value: "PUBLIC", label: "Anyone (public)" }, { value: "CUSTOMERS", label: "Signed-in customers" }, { value: "INTERNAL", label: "Agents only" }]} />
          <div className="sm:col-span-2"><Input id="kb-sum" label="Summary" value={form.summary} onChange={set("summary")} /></div>
          <label className="block text-xs sm:col-span-2"><span className="text-[var(--inaya-text-muted)]">Article (plain text)</span><textarea id="kb-body" rows={12} value={form.body} onChange={(e) => set("body")(e.target.value)} className={area} /></label>
          <div className="sm:col-span-2"><Input id="kb-tags" label="Tags (comma separated)" value={form.tags} onChange={set("tags")} /></div>
        </div>
        {has("manage_kb") && <div className="flex flex-wrap gap-2">
          <Btn busy={act.busy} onClick={() => act.run(() => (id ? post(orgId, `kb/${id}`, payload, "PUT") : post(orgId, "kb", payload)))}>Save draft</Btn>
          {id && <Btn busy={act.busy} onClick={() => act.run(() => post(orgId, `kb/${id}/submit`))}>Submit for review</Btn>}
        </div>}
        {id && a && <Note>Status: {a.status}{a.liveVersion ? ` · live version ${a.liveVersion}` : ""} · latest draft version {a.latestVersion}. Editing a published article starts a new draft; customers keep seeing the live version until someone approves the new one.</Note>}
      </Card>
      {id && a && has("manage_kb") && ["IN_REVIEW", "DRAFT"].includes(one.data.versions?.[0]?.status) && (
        <Card title="Review">
          <Input id="kb-note" label="Note (used if you send it back)" value={note} onChange={setNote} />
          <div className="flex gap-2"><Btn busy={act.busy} onClick={() => act.run(() => post(orgId, `kb/${id}/review`, { decision: "approve" }))}>Approve and publish</Btn><Btn busy={act.busy} onClick={() => act.run(() => post(orgId, `kb/${id}/review`, { decision: "reject", note }))}>Send back</Btn></div>
          <Note>You cannot approve an article you wrote unless you are an organization owner or admin.</Note>
        </Card>
      )}
      {id && has("manage_kb") && <Btn small danger onClick={() => act.run(() => post(orgId, `kb/${id}/archive`, { restore: a?.status === "ARCHIVED" }), a?.status === "ARCHIVED" ? "Restore this article?" : "Archive this article? Customers will no longer see it.")}>{a?.status === "ARCHIVED" ? "Restore" : "Archive"}</Btn>}
      {one.data?.versions?.length > 0 && <Card title="Versions"><ul className="space-y-1 text-xs">{one.data.versions.map((v) => <li key={v.version}>v{v.version} · {v.status} · {v.author}{v.reviewer ? ` · reviewed by ${v.reviewer}` : ""} · {fmtTime(v.publishedAt || v.createdAt)}</li>)}</ul></Card>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------- ideas
export function IdeasPanel({ orgId, has }) {
  const [status, setStatus] = useState("");
  const list = useLoad(has("manage_ideas") ? `/api/orgs/support/ideas?${q(orgId, status ? `&status=${status}` : "")}` : null);
  const act = useAction(list.reload);
  const [note, setNote] = useState({});
  if (!has("manage_ideas")) return <EmptyState title="No access" description="Managing ideas needs the manager support role." />;
  const STATES = ["SUBMITTED", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS", "SHIPPED", "DECLINED", "DUPLICATE"];
  return (
    <Card title="Customer ideas" right={<Btn small onClick={list.reload} busy={list.loading}>Refresh</Btn>}>
      <div className="w-56"><Select id="idea-status" label="Show" value={status} onChange={setStatus} options={[{ value: "", label: "All" }, ...STATES]} /></div>
      <Note>An idea is a suggestion, not a commitment. Changing its status notifies the customer; the note you add is shown to them.</Note>
      <Err error={list.error || act.error} />
      {!list.data?.ideas?.length ? <EmptyState title="No ideas yet" description="Ideas submitted from the portal appear here." /> : (
        <ul className="space-y-3">{list.data.ideas.map((i) => (
          <li key={i.id} className="rounded border border-white/10 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><strong>{i.number} · {i.title}</strong><Pill value={i.status === "SHIPPED" ? "OK" : i.status === "DECLINED" ? "FAILED" : "PENDING"} label={i.status} />{i.communityVisible && <span className="text-xs">public · {i.votes} votes</span>}</div>
            <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--inaya-text-muted)]">{i.description}</p>
            <p className="text-xs text-[var(--inaya-text-muted)]">From {i.submitter?.name || i.submitter?.email} · {fmtTime(i.createdAt)}</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="w-44"><Select id={`idea-s-${i.id}`} label="Status" value={i.status} onChange={(v) => act.run(() => post(orgId, `ideas/${i.id}`, { status: v, publicNote: note[i.id] || null, duplicateOfId: v === "DUPLICATE" ? (window.prompt("Idea id this duplicates (from the list)?") || undefined) : undefined }, "PUT"))} options={STATES} /></div>
              <div className="min-w-[14rem] flex-1"><Input id={`idea-n-${i.id}`} label="Note shown to the customer" value={note[i.id] ?? i.publicNote ?? ""} onChange={(v) => setNote({ ...note, [i.id]: v })} /></div>
            </div>
          </li>))}</ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------------- analytics
const Stat = ({ label, value, sub }) => (
  <div className="rounded border border-white/10 p-3"><div className="text-xs text-[var(--inaya-text-muted)]">{label}</div><div className="text-xl font-semibold">{value ?? "No data"}</div>{sub && <div className="text-[11px] text-[var(--inaya-text-muted)]">{sub}</div>}</div>
);
const mins = (m) => (m == null ? null : m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);

export function AnalyticsPanel({ orgId }) {
  const [days, setDays] = useState("30");
  const r = useLoad(`/api/orgs/support/analytics?${q(orgId, `&days=${days}`)}`);
  const a = r.data?.analytics;
  return (
    <div className="space-y-4">
      <div className="w-44"><Select id="an-days" label="Period" value={days} onChange={setDays} options={[{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }]} /></div>
      <Err error={r.error} />
      {a && (<>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Tickets created" value={a.volume.created} sub={`${a.volume.openNow} open right now`} />
          <Stat label="First reply (median)" value={mins(a.times.firstResponseMinutes.median)} sub={`${a.times.firstResponseMinutes.sample} tickets · business hours`} />
          <Stat label="Resolution (median)" value={mins(a.times.resolutionMinutes.median)} sub={`${a.times.resolutionMinutes.sample} tickets · business hours`} />
          <Stat label="Customer satisfaction" value={a.csat.average == null ? null : `${a.csat.average} / 5`} sub={a.csat.responses ? `${a.csat.responses} ratings · ${a.csat.satisfiedPct}% satisfied` : a.csat.note} />
          <Stat label="First reply on time" value={a.sla.firstResponseMet.pct == null ? null : `${a.sla.firstResponseMet.pct}%`} sub={`${a.sla.firstResponseMet.met} of ${a.sla.firstResponseMet.of}`} />
          <Stat label="Resolved on time" value={a.sla.resolutionMet.pct == null ? null : `${a.sla.resolutionMet.pct}%`} sub={`${a.sla.resolutionMet.met} of ${a.sla.resolutionMet.of}`} />
          <Stat label="Reopened" value={a.volume.reopenRatePct == null ? null : `${a.volume.reopenRatePct}%`} sub={`${a.volume.reopened} tickets`} />
          <Stat label="Backlog change" value={a.volume.backlogGrowth > 0 ? `+${a.volume.backlogGrowth}` : String(a.volume.backlogGrowth)} sub="created minus solved" />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="By category"><Table columns={[{ key: "key", label: "Category" }, { key: "count", label: "Tickets" }]} rows={a.byCategory} /></Card>
          <Card title="By channel"><Table columns={[{ key: "key", label: "Channel" }, { key: "count", label: "Tickets" }]} rows={a.byChannel} /></Card>
          <Card title="Agents"><Table columns={[{ key: "agent", label: "Agent" }, { key: "assigned", label: "Assigned" }, { key: "solved", label: "Solved" }]} rows={a.agents} /></Card>
          <Card title="AI assistant">
            <ul className="space-y-1 text-sm"><li>Tickets triaged by AI: {a.ai.ticketsTriaged} of {a.ai.ticketsWithTriage}</li><li>Chat answered from articles: {a.ai.chat.answered}</li><li>Chat could not answer: {a.ai.chat.unanswered}</li><li>Handed to a person: {a.ai.chat.handedOff}</li><li>Resolved without a ticket: {a.ai.chat.resolvedWithoutTicketPct == null ? "no data" : `${a.ai.chat.resolvedWithoutTicketPct}%`}</li></ul>
          </Card>
          <Card title="Knowledge base">
            <p className="text-sm">{a.knowledge.searches} searches. Searches with no result:</p>
            {a.knowledge.zeroResultSearches.length ? <ul className="text-xs">{a.knowledge.zeroResultSearches.map((z) => <li key={z.query}>“{z.query}” × {z.count}</li>)}</ul> : <Note>None.</Note>}
          </Card>
        </div>
        <Note>Every figure is computed from stored tickets, SLA clocks, ratings and recorded events. “No data” means nothing was recorded, not zero.</Note>
      </>)}
    </div>
  );
}

// --------------------------------------------------------------------------------------- inbound
export function InboundPanel({ orgId, has }) {
  const list = useLoad(has("admin_settings") ? `/api/orgs/support/inbound?${q(orgId)}` : null);
  const act = useAction(list.reload);
  if (!has("admin_settings")) return <EmptyState title="No access" description="Email intake review needs the manager support role." />;
  return (
    <Card title="Emails held for review" right={<Btn small onClick={list.reload} busy={list.loading}>Refresh</Btn>}>
      <Note>Mail that could not be safely matched to a customer or ticket is held here instead of being added to a conversation. Accepting creates a new ticket (or adds to the ticket you name).</Note>
      <Err error={list.error || act.error} />
      {!list.data?.items?.length ? <EmptyState title="Nothing waiting" description="No inbound email is held for review." /> : (
        <ul className="space-y-3">{list.data.items.map((m) => (
          <li key={m.id} className="rounded border border-white/10 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><strong>{m.subject || "(no subject)"}</strong><Pill value="ATTENTION" label={String(m.reason).replace(/_/g, " ")} /></div>
            <p className="text-xs text-[var(--inaya-text-muted)]">From {m.from} · {fmtTime(m.createdAt)}</p>
            <p className="mt-1 whitespace-pre-wrap text-xs">{m.preview}</p>
            <div className="mt-2 flex gap-2"><Btn small busy={act.busy} onClick={() => act.run(() => post(orgId, `inbound/${m.id}/accept`, {}))}>Accept as new ticket</Btn><Btn small danger busy={act.busy} onClick={() => act.run(() => post(orgId, `inbound/${m.id}/dismiss`, {}), "Dismiss this email? It will not become a ticket.")}>Dismiss</Btn></div>
          </li>))}</ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------------- incidents
export function IncidentsPanel({ orgId, has }) {
  const list = useLoad(`/api/orgs/support/incidents?${q(orgId)}`);
  const act = useAction(async () => { setF({ title: "", message: "" }); await list.reload(); });
  const [f, setF] = useState({ title: "", message: "" });
  const [upd, setUpd] = useState({});
  return (
    <div className="space-y-4">
      {has("admin_settings") && (
        <Card title="Announce an incident">
          <Note>Shown to customers at the top of the portal until you mark it resolved.</Note>
          <Input id="inc-title" label="Title" value={f.title} onChange={(v) => setF({ ...f, title: v })} placeholder="Uploads are slower than usual" />
          <label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">What customers should know</span><textarea id="inc-msg" rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} className={area} /></label>
          <Btn busy={act.busy} disabled={f.title.length < 4 || !f.message} onClick={() => act.run(() => post(orgId, "incidents", f))}>Publish incident</Btn>
          <Err error={act.error} />
        </Card>
      )}
      <Card title="Incidents">
        {!list.data?.incidents?.length ? <EmptyState title="No incidents" description="Nothing has been announced." /> : (
          <ul className="space-y-3">{list.data.incidents.map((i) => (
            <li key={i.id} className="rounded border border-white/10 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><strong>{i.title}</strong><Pill value={i.status === "RESOLVED" ? "OK" : "WARNING"} label={i.status} /><span className="text-xs text-[var(--inaya-text-muted)]">since {fmtTime(i.startedAt)}</span></div>
              <ul className="mt-1 space-y-0.5 text-xs text-[var(--inaya-text-muted)]">{i.updates.map((u, k) => <li key={k}>{fmtTime(u.at)} · {u.status}: {u.message}</li>)}</ul>
              {has("admin_settings") && i.status !== "RESOLVED" && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="w-44"><Select id={`inc-s-${i.id}`} label="New status" value={upd[i.id]?.status || "IDENTIFIED"} onChange={(v) => setUpd({ ...upd, [i.id]: { ...upd[i.id], status: v } })} options={["INVESTIGATING", "IDENTIFIED", "MONITORING", "RESOLVED"]} /></div>
                  <div className="min-w-[14rem] flex-1"><Input id={`inc-m-${i.id}`} label="Update" value={upd[i.id]?.message || ""} onChange={(v) => setUpd({ ...upd, [i.id]: { ...upd[i.id], message: v } })} /></div>
                  <Btn small busy={act.busy} disabled={!upd[i.id]?.message} onClick={() => act.run(() => post(orgId, `incidents/${i.id}`, { status: upd[i.id]?.status || "IDENTIFIED", message: upd[i.id].message }, "PUT"))}>Post update</Btn>
                </div>)}
            </li>))}</ul>
        )}
      </Card>
    </div>
  );
}
