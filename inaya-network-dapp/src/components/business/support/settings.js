"use client";

// Support console: Settings (portal, business hours, email intake, AI, queues, SLA policies, agents, macros,
// webhooks, API keys). Every control saves through /api/orgs/support/* and the server validates it.

import { useState } from "react";
import EmptyState from "../../EmptyState";
import { api, useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, Result, fmtTime } from "../nas/ui";
import { q, post } from "./helpers";

const SECTIONS = [["portal", "Portal & email"], ["security", "Sign-in & security"], ["hours", "Business hours"], ["queues", "Queues & teams"], ["sla", "SLA policies"], ["agents", "Agents"], ["macros", "Macros"], ["integrations", "Webhooks & API keys"]];
const area = "mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-sm font-mono";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function SettingsPanel({ orgId, has, onChanged }) {
  const [sec, setSec] = useState("portal");
  const canAdmin = has("admin_settings");
  return (
    <div className="space-y-4">
      <nav aria-label="Settings sections" className="flex flex-wrap gap-1">
        {SECTIONS.map(([id, label]) => <button key={id} type="button" onClick={() => setSec(id)} aria-current={sec === id ? "page" : undefined} className={`rounded border px-3 py-1 text-xs ${sec === id ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{label}</button>)}
      </nav>
      {sec === "portal" && (canAdmin ? <PortalSettings orgId={orgId} onChanged={onChanged} /> : <NoAccess />)}
      {sec === "security" && (canAdmin ? <SecuritySettings orgId={orgId} onChanged={onChanged} /> : <NoAccess />)}
      {sec === "hours" && (canAdmin ? <HoursSettings orgId={orgId} /> : <NoAccess />)}
      {sec === "queues" && <QueuesPanel orgId={orgId} has={has} />}
      {sec === "sla" && <SlaPanel orgId={orgId} has={has} />}
      {sec === "agents" && <AgentsPanel orgId={orgId} has={has} />}
      {sec === "macros" && <MacrosPanel orgId={orgId} has={has} />}
      {sec === "integrations" && (canAdmin ? <IntegrationsPanel orgId={orgId} /> : <NoAccess />)}
    </div>
  );
}
const NoAccess = () => <EmptyState title="No access" description="This section needs the manager support role." />;

function useSettings(orgId) {
  const s = useLoad(`/api/orgs/support/settings?${q(orgId)}`);
  return s;
}

function PortalSettings({ orgId, onChanged }) {
  const s = useSettings(orgId);
  const st = s.data?.settings;
  const [f, setF] = useState(null);
  const form = f || (st ? { portalEnabled: st.portalEnabled, portalSlug: st.portalSlug || "", portalName: st.portalName || "", welcomeText: st.welcomeText, signup: st.signup, supportAddress: st.email.supportAddress || "", requireAuthResults: st.email.requireAuthResults, unknownSenders: st.email.unknownSenders, triageEnabled: st.ai.triageEnabled, chatEnabled: st.ai.chatEnabled, minConfidence: st.ai.minConfidence, ideasEnabled: st.ideas.enabled, votingEnabled: st.ideas.votingEnabled, csatEnabled: st.csat.enabled, kbEnabled: st.kb.enabled, ticketPrefix: st.ticketPrefix, autoCloseSolvedAfterDays: st.autoCloseSolvedAfterDays } : null);
  const set = (k) => (v) => setF({ ...form, [k]: v });
  const act = useAction(async () => { setF(null); await s.reload(); onChanged?.(); });
  const sec = useAction(s.reload);
  if (!form) return <Note>Loading…</Note>;
  const save = () => act.run(() => post(orgId, "settings", { portalEnabled: form.portalEnabled, portalSlug: form.portalSlug || null, portalName: form.portalName || null, welcomeText: form.welcomeText, signup: form.signup, ticketPrefix: form.ticketPrefix, autoCloseSolvedAfterDays: Number(form.autoCloseSolvedAfterDays), email: { supportAddress: form.supportAddress || null, requireAuthResults: form.requireAuthResults, unknownSenders: form.unknownSenders }, ai: { triageEnabled: form.triageEnabled, chatEnabled: form.chatEnabled, minConfidence: Number(form.minConfidence) }, ideas: { enabled: form.ideasEnabled, votingEnabled: form.votingEnabled }, csat: { enabled: form.csatEnabled }, kb: { enabled: form.kbEnabled } }, "PUT"));
  const Check = ({ id, label, k }) => <label className="flex items-center gap-2 text-sm"><input id={id} type="checkbox" checked={!!form[k]} onChange={(e) => set(k)(e.target.checked)} />{label}</label>;
  return (
    <div className="space-y-4">
      <Card title="Customer portal">
        <Check id="ps-en" k="portalEnabled" label="Portal is switched on" />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input id="ps-slug" label="Portal address (inayanetwork.com/portal/…)" value={form.portalSlug} onChange={set("portalSlug")} placeholder="acme-support" />
          <Input id="ps-name" label="Portal name" value={form.portalName} onChange={set("portalName")} placeholder="Acme Support" />
          <div className="sm:col-span-2"><Input id="ps-welcome" label="Welcome text" value={form.welcomeText} onChange={set("welcomeText")} /></div>
          <Select id="ps-signup" label="Who can sign in" value={form.signup} onChange={set("signup")} options={[{ value: "contacts_only", label: "Only people in your CRM contacts" }, { value: "open", label: "Anyone with a working email (added to the CRM as a lead)" }]} />
          <Input id="ps-prefix" label="Ticket number prefix" value={form.ticketPrefix} onChange={set("ticketPrefix")} />
          <Input id="ps-close" label="Auto-close solved tickets after (days)" value={form.autoCloseSolvedAfterDays} onChange={set("autoCloseSolvedAfterDays")} type="number" />
        </div>
        <div className="flex flex-wrap gap-4"><Check id="ps-kb" k="kbEnabled" label="Knowledge base" /><Check id="ps-ideas" k="ideasEnabled" label="Submit an Idea" /><Check id="ps-vote" k="votingEnabled" label="Let customers vote on public ideas" /><Check id="ps-csat" k="csatEnabled" label="Ask for satisfaction ratings" /></div>
      </Card>
      <Card title="AI">
        <div className="flex flex-wrap gap-4"><Check id="ps-tri" k="triageEnabled" label="AI triage of new tickets (advisory)" /><Check id="ps-chat" k="chatEnabled" label="AI assistant in the portal (answers only from published articles)" /></div>
        <div className="w-64"><Input id="ps-conf" label="Confidence needed to apply AI category/queue (0–1)" value={form.minConfidence} onChange={set("minConfidence")} type="number" /></div>
        <Note>AI never closes a ticket, promises a refund or edits a customer's account. If the model is unavailable, tickets are still created and routed by your rules.</Note>
      </Card>
      <Card title="Email intake">
        <Input id="ps-addr" label="Support email address (used for reply threading)" value={form.supportAddress} onChange={set("supportAddress")} placeholder="support@yourcompany.com" />
        <div className="grid gap-2 sm:grid-cols-2"><Select id="ps-unk" label="Mail from unknown senders" value={form.unknownSenders} onChange={set("unknownSenders")} options={[{ value: "quarantine", label: "Hold for review (recommended)" }, { value: "create_unverified", label: "Create an unverified ticket" }]} />
          <label className="mt-5 flex items-center gap-2 text-sm"><input id="ps-auth" type="checkbox" checked={!!form.requireAuthResults} onChange={(e) => set("requireAuthResults")(e.target.checked)} />Require the sender to pass DKIM/DMARC</label></div>
        <div className="flex flex-wrap items-center gap-2"><Btn small busy={sec.busy} onClick={() => sec.run(() => post(orgId, "settings/inbound-secret"), st.email.inboundSecretSet ? "Create a new inbound secret? The old one stops working immediately." : undefined)}>{st.email.inboundSecretSet ? "Rotate inbound secret" : "Create inbound secret"}</Btn><span className="text-xs text-[var(--inaya-text-muted)]">Endpoint: POST /api/support/inbound-email/{form.portalSlug || "<portal address>"} · signed with HMAC-SHA256 (X-Inaya-Timestamp, X-Inaya-Signature)</span></div>
        <Err error={sec.error} />{sec.result?.inboundSecret && <Note tone="warn">Save this secret now, it is shown once: <code>{sec.result.inboundSecret}</code></Note>}
        <Note>Reply-by-email: if your platform operator has connected Resend inbound mail, customers can reply to the address shown under Portal &amp; sharing with nothing more to set up here. The signed endpoint above is for organizations that run their own mail relay.</Note>
      </Card>
      <div className="flex items-center gap-2"><Btn busy={act.busy} onClick={save}>Save settings</Btn>{f && <Btn small onClick={() => setF(null)}>Discard changes</Btn>}</div>
      <Err error={s.error || act.error} />
    </div>
  );
}

function HoursSettings({ orgId }) {
  const s = useSettings(orgId);
  const bh = s.data?.settings?.businessHours;
  const [f, setF] = useState(null);
  const form = f || (bh ? { timezone: bh.timezone, mode: bh.mode, weekly: Object.fromEntries(DAYS.map((_, i) => [i, bh.weekly?.[i]?.[0] ? { on: true, from: bh.weekly[i][0][0], to: bh.weekly[i][0][1] } : { on: false, from: "09:00", to: "17:00" }])), holidays: (bh.holidays || []).join(", ") } : null);
  const act = useAction(async () => { setF(null); await s.reload(); });
  if (!form) return <Note>Loading…</Note>;
  const setDay = (i, patch) => setF({ ...form, weekly: { ...form.weekly, [i]: { ...form.weekly[i], ...patch } } });
  const save = () => act.run(() => post(orgId, "settings", { businessHours: { timezone: form.timezone, mode: form.mode, weekly: Object.fromEntries(Object.entries(form.weekly).filter(([, d]) => d.on).map(([i, d]) => [i, [[d.from, d.to]]])), holidays: form.holidays.split(",").map((x) => x.trim()).filter(Boolean) } }, "PUT"));
  return (
    <Card title="Business hours">
      <Note>SLA clocks count only working time. Choose 24×7 if you support customers around the clock.</Note>
      <div className="grid gap-2 sm:grid-cols-2"><Input id="bh-tz" label="Time zone (e.g. Europe/London)" value={form.timezone} onChange={(v) => setF({ ...form, timezone: v })} /><Select id="bh-mode" label="Mode" value={form.mode} onChange={(v) => setF({ ...form, mode: v })} options={[{ value: "business", label: "Working hours" }, { value: "24x7", label: "24×7" }]} /></div>
      {form.mode === "business" && <ul className="space-y-1">{DAYS.map((d, i) => (
        <li key={d} className="flex flex-wrap items-center gap-2 text-sm"><label className="flex w-32 items-center gap-2"><input type="checkbox" checked={form.weekly[i].on} onChange={(e) => setDay(i, { on: e.target.checked })} />{d}</label>
          <input aria-label={`${d} from`} type="time" value={form.weekly[i].from} disabled={!form.weekly[i].on} onChange={(e) => setDay(i, { from: e.target.value })} className="rounded border border-white/10 bg-transparent px-2 py-1 text-xs" /> to <input aria-label={`${d} to`} type="time" value={form.weekly[i].to} disabled={!form.weekly[i].on} onChange={(e) => setDay(i, { to: e.target.value })} className="rounded border border-white/10 bg-transparent px-2 py-1 text-xs" /></li>))}</ul>}
      <Input id="bh-hol" label="Holidays (YYYY-MM-DD, comma separated)" value={form.holidays} onChange={(v) => setF({ ...form, holidays: v })} />
      <Btn busy={act.busy} onClick={save}>Save business hours</Btn><Err error={act.error || s.error} />
    </Card>
  );
}

function QueuesPanel({ orgId, has }) {
  const qs = useLoad(`/api/orgs/support/queues?${q(orgId)}`);
  const ts = useLoad(`/api/orgs/support/teams?${q(orgId)}`);
  const [nq, setNq] = useState({ name: "", strategy: "manual", keywords: "" });
  const [nt, setNt] = useState({ name: "", members: "" });
  const act = useAction(async () => { await qs.reload(); await ts.reload(); });
  const can = has("admin_queues");
  return (
    <div className="space-y-4">
      <Card title="Queues">
        <Note>New tickets are placed in the first queue (by order) whose rules match; the default queue catches everything else. Rules can match types, categories, priorities, channels, customer tiers and keywords.</Note>
        <Table columns={[{ key: "name", label: "Queue" }, { key: "strategy", label: "Assignment" }, { key: "match", label: "Rules", render: (x) => <code className="text-xs">{JSON.stringify(x.match)}</code> }, { key: "active", label: "Active", render: (x) => (x.active ? "Yes" : "No") }, { key: "a", label: "", render: (x) => can && !x.isDefault && <Btn small onClick={() => act.run(() => post(orgId, `queues/${x.queueId}`, { active: !x.active }, "PUT"))}>{x.active ? "Disable" : "Enable"}</Btn> }]} rows={qs.data?.queues || []} />
        {can && <div className="flex flex-wrap items-end gap-2"><div className="min-w-[10rem] flex-1"><Input id="nq-name" label="New queue" value={nq.name} onChange={(v) => setNq({ ...nq, name: v })} /></div><div className="w-44"><Select id="nq-strat" label="Assignment" value={nq.strategy} onChange={(v) => setNq({ ...nq, strategy: v })} options={["manual", "round_robin", "least_loaded", "account_owner", "skills"]} /></div><div className="min-w-[10rem] flex-1"><Input id="nq-kw" label="Keywords (optional)" value={nq.keywords} onChange={(v) => setNq({ ...nq, keywords: v })} placeholder="invoice, refund" /></div><Btn busy={act.busy} disabled={!nq.name} onClick={() => act.run(() => post(orgId, "queues", { name: nq.name, strategy: nq.strategy, match: nq.keywords ? { keywords: nq.keywords.split(",").map((k) => k.trim()).filter(Boolean) } : {} }).then((r) => { setNq({ name: "", strategy: "manual", keywords: "" }); return r; }))}>Add queue</Btn></div>}
        <Err error={qs.error || act.error} />
      </Card>
      <Card title="Teams">
        <Table columns={[{ key: "name", label: "Team" }, { key: "memberEmails", label: "Members", render: (t) => (t.memberEmails || []).join(", ") || "—" }, { key: "leadEmail", label: "Lead", render: (t) => t.leadEmail || "—" }]} rows={ts.data?.teams || []} />
        {can && <div className="flex flex-wrap items-end gap-2"><div className="min-w-[10rem]"><Input id="nt-name" label="New team" value={nt.name} onChange={(v) => setNt({ ...nt, name: v })} /></div><div className="min-w-[16rem] flex-1"><Input id="nt-mem" label="Members (emails, comma separated)" value={nt.members} onChange={(v) => setNt({ ...nt, members: v })} /></div><Btn busy={act.busy} disabled={!nt.name} onClick={() => act.run(() => post(orgId, "teams", { name: nt.name, memberEmails: nt.members.split(",").map((x) => x.trim()).filter(Boolean) }).then((r) => { setNt({ name: "", members: "" }); return r; }))}>Add team</Btn></div>}
      </Card>
    </div>
  );
}

function SlaPanel({ orgId, has }) {
  const ps = useLoad(`/api/orgs/support/sla-policies?${q(orgId)}`);
  const [np, setNp] = useState({ name: "", firstResponseMin: 60, resolutionMin: 480, priorities: "HIGH,URGENT" });
  const act = useAction(ps.reload);
  const can = has("admin_sla");
  const fmt = (m) => (m >= 1440 ? `${Math.round(m / 144) / 10} days` : m >= 60 ? `${Math.round(m / 6) / 10} h` : `${m} min`);
  return (
    <Card title="SLA policies">
      <Note>A policy sets how fast the first reply and the resolution are due, counted in your business hours. The first policy that matches a ticket's type, priority, customer tier or queue applies; escalation rules notify or escalate at set percentages of the time.</Note>
      <Table columns={[{ key: "name", label: "Policy" }, { key: "match", label: "Applies to", render: (p) => (Object.keys(p.match || {}).length ? <code className="text-xs">{JSON.stringify(p.match)}</code> : "Everything else") }, { key: "f", label: "First reply", render: (p) => fmt(p.firstResponseMin) }, { key: "r", label: "Resolution", render: (p) => fmt(p.resolutionMin) }, { key: "e", label: "Escalations", render: (p) => (p.escalations || []).map((e) => `${e.pct}% ${e.target === "first_response" ? "reply" : "resolve"}: ${e.action}`).join("; ") }]} rows={ps.data?.policies || []} />
      {can && <div className="flex flex-wrap items-end gap-2"><div className="min-w-[10rem]"><Input id="np-name" label="New policy" value={np.name} onChange={(v) => setNp({ ...np, name: v })} /></div><div className="w-32"><Input id="np-f" label="First reply (min)" type="number" value={np.firstResponseMin} onChange={(v) => setNp({ ...np, firstResponseMin: v })} /></div><div className="w-32"><Input id="np-r" label="Resolution (min)" type="number" value={np.resolutionMin} onChange={(v) => setNp({ ...np, resolutionMin: v })} /></div><div className="w-44"><Input id="np-p" label="Priorities" value={np.priorities} onChange={(v) => setNp({ ...np, priorities: v })} /></div><Btn busy={act.busy} disabled={!np.name} onClick={() => act.run(() => post(orgId, "sla-policies", { name: np.name, firstResponseMin: Number(np.firstResponseMin), resolutionMin: Number(np.resolutionMin), match: { priorities: np.priorities.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) } }))}>Add policy</Btn></div>}
      <Err error={ps.error || act.error} />
    </Card>
  );
}

function AgentsPanel({ orgId, has }) {
  const ag = useLoad(`/api/orgs/support/agents?${q(orgId)}`);
  const act = useAction(ag.reload);
  const [email, setEmail] = useState("");
  const can = has("manage_agents");
  return (
    <Card title="Support agents">
      <Note>Organization owners and admins already have full support access. Give other members a role here; they must already be members of this workspace.</Note>
      <Table columns={[{ key: "email", label: "Person" }, { key: "supportRole", label: "Support role", render: (a) => a.supportRole || "—" }, { key: "available", label: "Available", render: (a) => (a.available ? "Yes" : "No") }, { key: "act", label: "", render: (a) => can && a.role !== "owner" && a.role !== "admin" && <span className="flex gap-1"><Btn small onClick={() => act.run(() => post(orgId, `agents/${encodeURIComponent(a.email)}/role`, { supportRole: a.supportRole === "manager" ? "agent" : "manager" }, "PUT"))}>Make {a.supportRole === "manager" ? "agent" : "manager"}</Btn><Btn small danger onClick={() => act.run(() => post(orgId, `agents/${encodeURIComponent(a.email)}/role`, { supportRole: null }, "PUT"), `Remove ${a.email} from support?`)}>Remove</Btn></span> }]} rows={ag.data?.agents || []} />
      {can && <div className="flex flex-wrap items-end gap-2"><div className="min-w-[16rem] flex-1"><Input id="ag-email" label="Add a member as agent" value={email} onChange={setEmail} placeholder="colleague@company.com" /></div><Btn busy={act.busy} disabled={!email} onClick={() => act.run(() => post(orgId, `agents/${encodeURIComponent(email)}/role`, { supportRole: "agent" }, "PUT").then((r) => { setEmail(""); return r; }))}>Add agent</Btn></div>}
      <Err error={ag.error || act.error} />
    </Card>
  );
}

function MacrosPanel({ orgId, has }) {
  const ms = useLoad(`/api/orgs/support/macros?${q(orgId)}`);
  const [f, setF] = useState({ name: "", body: "" });
  const act = useAction(async () => { setF({ name: "", body: "" }); await ms.reload(); });
  const can = has("admin_queues");
  return (
    <Card title="Macros (canned replies)">
      <Note>Insert into a reply from the ticket. Available fields: {"{{customer.name}} {{ticket.number}} {{ticket.subject}} {{agent.name}}"}. A macro only fills the text box; a person still sends it.</Note>
      <Table columns={[{ key: "name", label: "Name" }, { key: "body", label: "Text", render: (m) => <span className="line-clamp-2 whitespace-pre-wrap">{m.body}</span> }, { key: "a", label: "", render: (m) => can && <Btn small danger onClick={() => act.run(() => post(orgId, `macros/${m.id}`, {}, "DELETE"), `Delete macro "${m.name}"?`)}>Delete</Btn> }]} rows={ms.data?.macros || []} />
      {can && <><Input id="mc-name" label="New macro name" value={f.name} onChange={(v) => setF({ ...f, name: v })} /><label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">Text</span><textarea id="mc-body" rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className={area} /></label><Btn busy={act.busy} disabled={!f.name || !f.body} onClick={() => act.run(() => post(orgId, "macros", f))}>Add macro</Btn></>}
      <Err error={ms.error || act.error} />
    </Card>
  );
}

function IntegrationsPanel({ orgId }) {
  const wh = useLoad(`/api/orgs/support/webhooks?${q(orgId)}`);
  const dl = useLoad(`/api/orgs/support/webhooks/deliveries?${q(orgId)}`);
  const keys = useLoad(`/api/orgs/support/api-keys?${q(orgId)}`);
  const scopes = useLoad(`/api/orgs/support/api-keys/scopes?${q(orgId)}`);
  const [w, setW] = useState({ url: "", events: "ticket.created, ticket.solved" });
  const [k, setK] = useState({ label: "", scopes: [], customerEmail: "", days: 365 });
  const aw = useAction(async () => { await wh.reload(); await dl.reload(); });
  const ak = useAction(keys.reload);
  return (
    <div className="space-y-4">
      <Card title="Outbound webhooks">
        <Note>Each event is sent as signed JSON (X-Inaya-Signature: HMAC-SHA256 with your webhook secret) and retried with backoff; failures are kept so you can redeliver them. Only https addresses on the public internet are accepted.</Note>
        <Table columns={[{ key: "url", label: "URL" }, { key: "events", label: "Events", render: (x) => (x.events || []).join(", ") }, { key: "active", label: "Active", render: (x) => <Pill value={x.active ? "OK" : "PENDING"} label={x.active ? "Active" : "Paused"} /> }, { key: "f", label: "Failures", render: (x) => x.consecutiveFailures }, { key: "a", label: "", render: (x) => <span className="flex gap-1"><Btn small onClick={() => aw.run(() => post(orgId, `webhooks/${x.webhookId}`, { active: !x.active }, "PUT"))}>{x.active ? "Pause" : "Resume"}</Btn><Btn small danger onClick={() => aw.run(() => post(orgId, `webhooks/${x.webhookId}`, {}, "DELETE"), "Delete this webhook?")}>Delete</Btn></span> }]} rows={wh.data?.webhooks || []} />
        <div className="flex flex-wrap items-end gap-2"><div className="min-w-[16rem] flex-1"><Input id="wh-url" label="URL" value={w.url} onChange={(v) => setW({ ...w, url: v })} placeholder="https://example.com/hooks/support" /></div><div className="min-w-[14rem] flex-1"><Input id="wh-ev" label="Events (comma separated, or *)" value={w.events} onChange={(v) => setW({ ...w, events: v })} /></div><Btn busy={aw.busy} disabled={!w.url} onClick={() => aw.run(() => post(orgId, "webhooks", { url: w.url, events: w.events.split(",").map((x) => x.trim()).filter(Boolean) }))}>Add webhook</Btn></div>
        <Err error={aw.error || wh.error} />{aw.result?.secret && <Note tone="warn">Signing secret, shown once: <code>{aw.result.secret}</code></Note>}
        {dl.data?.deliveries?.length > 0 && <Table columns={[{ key: "event", label: "Recent deliveries" }, { key: "status", label: "Status", render: (d) => <Pill value={d.status === "DELIVERED" ? "OK" : d.status === "DEAD" || d.status === "FAILED" ? "FAILED" : "PENDING"} label={d.status} /> }, { key: "attempts", label: "Attempts" }, { key: "lastError", label: "Last error", render: (d) => d.lastError || "" }, { key: "a", label: "", render: (d) => ["DEAD", "FAILED"].includes(d.status) && <Btn small onClick={() => aw.run(() => post(orgId, `webhooks/deliveries/${d.deliveryId}/redeliver`))}>Redeliver</Btn> }]} rows={dl.data.deliveries.slice(0, 15)} />}
      </Card>
      <Card title="API keys">
        <Note>For your own systems to create and read tickets through /api/public/v1/support. A key gets only the scopes you tick, expires, and can be tied to one customer (then it can never see anyone else's data). The key is shown once.</Note>
        <Table columns={[{ key: "label", label: "Label" }, { key: "prefix", label: "Key" }, { key: "scopes", label: "Scopes", render: (x) => (x.scopes || []).join(", ") }, { key: "customerEmail", label: "Bound to", render: (x) => x.customerEmail || "any customer (service key)" }, { key: "expiresAt", label: "Expires", render: (x) => fmtTime(x.expiresAt) }, { key: "st", label: "Status", render: (x) => <Pill value={x.revokedAt ? "FAILED" : "OK"} label={x.revokedAt ? "Revoked" : "Active"} /> }, { key: "a", label: "", render: (x) => !x.revokedAt && <Btn small danger onClick={() => ak.run(() => post(orgId, `api-keys/${x.apiKeyId}`, {}, "DELETE"), "Revoke this key? Systems using it stop working immediately.")}>Revoke</Btn> }]} rows={keys.data?.apiKeys || []} />
        <Input id="ak-label" label="Label" value={k.label} onChange={(v) => setK({ ...k, label: v })} placeholder="CRM integration" />
        <fieldset className="text-xs"><legend className="text-[var(--inaya-text-muted)]">Scopes</legend><div className="mt-1 flex flex-wrap gap-3">{(scopes.data?.scopes || []).map((s) => <label key={s} className="flex items-center gap-1"><input type="checkbox" checked={k.scopes.includes(s)} onChange={(e) => setK({ ...k, scopes: e.target.checked ? [...k.scopes, s] : k.scopes.filter((x) => x !== s) })} />{s}</label>)}</div></fieldset>
        <div className="grid gap-2 sm:grid-cols-2"><Input id="ak-cust" label="Bind to one customer (optional email)" value={k.customerEmail} onChange={(v) => setK({ ...k, customerEmail: v })} /><Input id="ak-days" label="Expires in (days)" type="number" value={k.days} onChange={(v) => setK({ ...k, days: v })} /></div>
        <Btn busy={ak.busy} disabled={!k.scopes.length} onClick={() => ak.run(() => post(orgId, "api-keys", { label: k.label, scopes: k.scopes, customerEmail: k.customerEmail || null, expiresInDays: Number(k.days) }))}>Create key</Btn>
        <Err error={ak.error || keys.error} />{ak.result?.rawKey && <Note tone="warn">Your new key, shown once: <code>{ak.result.rawKey}</code></Note>}
      </Card>
    </div>
  );
}

function SecuritySettings({ orgId, onChanged }) {
  const s = useSettings(orgId);
  const st = s.data?.settings;
  const [f, setF] = useState(null);
  const [secret, setSecret] = useState("");
  const form = f || (st ? { enabled: st.sso.enabled, issuer: st.sso.issuer || "", clientId: st.sso.clientId || "", label: st.sso.label || "Company sign-in", domains: (st.sso.allowedDomains || []).join(", "), requireVerifiedEmail: st.sso.requireVerifiedEmail !== false, scanMode: st.scan.mode, maxMb: Math.round(st.attachments.maxBytes / 1048576) } : null);
  const act = useAction(async () => { setF(null); await s.reload(); onChanged?.(); });
  const sec = useAction(async () => { setSecret(""); await s.reload(); });
  const test = useAction();
  if (!form) return <Note>Loading…</Note>;
  const set = (k) => (v) => setF({ ...form, [k]: v });
  const save = () => act.run(() => post(orgId, "settings", { sso: { enabled: form.enabled, issuer: form.issuer.trim(), clientId: form.clientId.trim(), label: form.label, allowedDomains: form.domains.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean), requireVerifiedEmail: form.requireVerifiedEmail }, scan: { mode: form.scanMode }, attachments: { maxBytes: Number(form.maxMb) * 1048576 } }, "PUT"));
  return (
    <div className="space-y-4">
      <Card title="Single sign-on for customers">
        <Note>Let customers sign in with their company account (Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak or any OpenID Connect provider) instead of an email link. They must still be your CRM contacts, or you must allow open sign-up: SSO proves who they are, it does not grant access.</Note>
        <label className="flex items-center gap-2 text-sm"><input id="sso-en" type="checkbox" checked={!!form.enabled} onChange={(e) => set("enabled")(e.target.checked)} />Offer single sign-on on the portal</label>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input id="sso-issuer" label="Issuer (https address of the provider)" value={form.issuer} onChange={set("issuer")} placeholder="https://accounts.google.com" />
          <Input id="sso-client" label="Client ID" value={form.clientId} onChange={set("clientId")} />
          <Input id="sso-label" label="Button text" value={form.label} onChange={set("label")} />
          <Input id="sso-domains" label="Only these email domains (optional, comma separated)" value={form.domains} onChange={set("domains")} placeholder="acme.com, acme.co.uk" />
        </div>
        <label className="flex items-center gap-2 text-sm"><input id="sso-ver" type="checkbox" checked={!!form.requireVerifiedEmail} onChange={(e) => set("requireVerifiedEmail")(e.target.checked)} />Require the provider to say the email address is verified (recommended)</label>
        <div className="flex flex-wrap items-end gap-2"><div className="min-w-[16rem] flex-1"><Input id="sso-secret" type="password" label={st.sso.clientSecretSet ? "Client secret (saved; enter a new one to replace it)" : "Client secret"} value={secret} onChange={setSecret} /></div><Btn busy={sec.busy} disabled={secret.length < 8} onClick={() => sec.run(() => post(orgId, "settings/sso-secret", { secret }))}>Save secret</Btn></div>
        <Note>The secret is stored encrypted and is never shown again.</Note>
        <Err error={sec.error} />
      </Card>
      <Card title="Files and virus scanning">
        <Input id="sec-max" label="Largest attachment (MB, up to 25)" type="number" value={form.maxMb} onChange={set("maxMb")} />
        <Select id="sec-scan" label="When no antivirus engine can be reached" value={form.scanMode} onChange={set("scanMode")} options={[{ value: "static", label: "Use the built-in inspection (archives, macros, PDF scripts, executables)" }, { value: "engine_required", label: "Refuse the file (strict: an antivirus engine is required)" }]} />
        <Note>Every file is always inspected by the built-in scanner. If the platform operator has connected an antivirus engine, it is used too. “Strict” makes a file wait until an engine can check it.</Note>
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <Btn busy={act.busy} onClick={save}>Save</Btn>
        {f && <Btn small onClick={() => setF(null)}>Discard changes</Btn>}
        <Btn small busy={test.busy} onClick={() => test.run(() => post(orgId, "settings/sso-test"))}>Test the provider connection</Btn>
      </div>
      <Err error={s.error || act.error || test.error} />
      {test.result?.ok && <Note tone="warn">Connected to {test.result.issuer} ({test.result.keys} signing keys). {test.result.clientSecretSet ? "" : "Save the client secret next. "}Register this redirect URI with your provider: <code>{test.result.redirectUri}</code></Note>}
    </div>
  );
}
