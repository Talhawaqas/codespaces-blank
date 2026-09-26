"use client";

// Identity & Access console panels. Every control calls the real /api/integrations/identity/* API; the server enforces every rule and the UI only
// shows what came back. Nothing here computes a number itself: metrics, states and findings are read from durable rows.

import { useState } from "react";
import { useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, Result, fmtTime } from "../nas/ui";
import { get, send, tone, downloadText, SOURCE_TONE } from "./helpers";
import { PolicyEditor } from "./policy";

const KINDS = ["entra", "ad", "rmm", "hr", "psa", "scim", "generic"];
const area = "mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-xs font-mono";
const Stat = ({ label, value, sub }) => (
  <div className="rounded border border-white/10 p-3"><div className="text-xs text-[var(--inaya-text-muted)]">{label}</div><div className="text-xl font-semibold tabular-nums">{value ?? "—"}</div>{sub && <div className="text-[11px] text-[var(--inaya-text-muted)]">{sub}</div>}</div>
);
const Secret = ({ title, value, note }) => value ? (
  <div className="rounded border border-amber-400/40 p-3 text-xs space-y-1" role="status"><div className="font-semibold text-amber-400">{title}</div><code className="block break-all">{value}</code><div className="text-[var(--inaya-text-muted)]">{note || "Shown once. Save it now."}</div></div>
) : null;

// ------------------------------------------------------------------------------------------------------------------------------ overview
export function OverviewPanel({ orgId }) {
  const st = useLoad(`/api/integrations/identity/status?orgId=${encodeURIComponent(orgId)}`);
  const mt = useLoad(`/api/integrations/identity/metrics?orgId=${encodeURIComponent(orgId)}&windowDays=30`);
  if (st.error) return <Err error={st.error} />;
  if (!st.data || !mt.data) return <Note>Loading…</Note>;
  const m = mt.data; const s = st.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Identities linked" value={s.identities.active} sub={`${s.identities.disabledOrRevoked} disabled or revoked`} />
        <Stat label="Lifecycle runs (30 d)" value={m.lifecycle.total} sub={m.lifecycle.failureRate == null ? "no runs yet" : `${m.lifecycle.failureRate}% failed or partial`} />
        <Stat label="Unfinished revocations" value={s.revocations.unfinished} sub="pending, partial or failed" />
        <Stat label="Events waiting" value={s.events.pending} sub={`${s.events.failed} failed · ${s.events.stale} stale`} />
        <Stat label="Median revocation" value={m.revocation.medianMs == null ? "—" : `${(m.revocation.medianMs / 1000).toFixed(1)} s`} sub={`${m.revocation.complete} complete of ${m.revocation.total}`} />
        <Stat label="Open orphans" value={m.orphans.open} />
        <Stat label="Temporary access" value={m.temporaryAccess.active} sub={`${m.temporaryAccess.expiringWithin7Days} expire within 7 days`} />
        <Stat label="Access reviews open" value={m.reviews.open} sub={`${m.reviews.campaigns} campaigns`} />
      </div>
      <Card title="Providers">
        <Table rows={m.providers} empty="No identity provider connected yet. Add one under Providers." columns={[
          { label: "Provider", render: (p) => `${p.name} (${p.kind})` }, { label: "Status", render: (p) => <Pill value={p.status === "ACTIVE" ? "OK" : "DISABLED"} label={p.status} /> },
          { label: "Last event", render: (p) => fmtTime(p.lastEventAt) }, { label: "", render: (p) => p.stale ? <Pill value="WARNING" label="no events in 7 days" /> : null }]} />
      </Card>
      <Card title="Last drift report">{m.drift ? <Note>{fmtTime(m.drift.lastReportAt)} — {Object.entries(m.drift.summary).map(([k, v]) => `${k}: ${v}`).join(" · ")}</Note> : <Note>No reconciliation has run yet.</Note>}</Card>
      <Card title="Recent problems"><Table rows={m.recentProblems} empty="No failed or partial runs." columns={[{ label: "When", render: (r) => fmtTime(r.at) }, { label: "Type", key: "type" }, { label: "Person", key: "email" }, { label: "State", render: (r) => <Pill value={tone(r.state)} label={r.state} /> }, { label: "Why", render: (r) => r.failure || "" }]} /></Card>
      <Note>All figures are computed from recorded runs, events and revocations; nothing is estimated.</Note>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ providers
export function ProvidersPanel({ orgId, canManage }) {
  const l = useLoad(`/api/integrations/identity/providers?orgId=${encodeURIComponent(orgId)}`);
  const [f, setF] = useState({ kind: "entra", providerTenantId: "", name: "" });
  const [shown, setShown] = useState(null); const [edit, setEdit] = useState(null);
  const act = useAction(l.reload);
  const create = () => act.run(async () => { const r = await send(orgId, "providers", f); setShown(r.signingSecret); setF({ kind: "entra", providerTenantId: "", name: "" }); return r; });
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} /><Secret title="Signing secret (used to sign webhooks sent to Inaya)" value={shown} />
      <Table rows={l.data?.providers} empty="No provider yet." columns={[
        { label: "Name", render: (p) => `${p.name}` }, { label: "Kind", key: "kind" }, { label: "Tenant", render: (p) => <code className="text-xs">{p.providerTenantId}</code> },
        { label: "Status", render: (p) => <Pill value={p.status === "ACTIVE" ? "OK" : "DISABLED"} label={p.status} /> }, { label: "Last event", render: (p) => fmtTime(p.lastEventAt) }, { label: "Last sync", render: (p) => fmtTime(p.lastSyncAt) },
        { label: "Last error", render: (p) => p.lastError || "" },
        { label: "", render: (p) => canManage ? <span className="flex gap-1"><Btn small onClick={() => setEdit(edit === p.providerId ? null : p.providerId)}>Policy</Btn>
          <Btn small onClick={() => act.run(async () => { const r = await send(orgId, `providers/${p.providerId}/rotate-secret`); setShown(r.signingSecret); return r; }, "Rotate the signing secret? The old one stops working immediately.")}>Rotate secret</Btn>
          <Btn small danger onClick={() => act.run(() => send(orgId, `providers/${p.providerId}`, {}, "DELETE"), "Disable this provider? Events from it will be refused.")}>Disable</Btn></span> : null }]} />
      {edit && <PolicyEditor orgId={orgId} provider={l.data.providers.find((p) => p.providerId === edit)} onSaved={() => { setEdit(null); l.reload(); }} />}
      {canManage && (
        <Card title="Connect a provider">
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="Kind" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={KINDS} />
            <Input label="External tenant id (Entra tenant id, RMM customer id, ...)" value={f.providerTenantId} onChange={(v) => setF({ ...f, providerTenantId: v })} />
            <Input label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          </div>
          <Btn busy={act.busy} disabled={!f.providerTenantId} onClick={create}>Connect provider</Btn>
          <Note>A tenant can belong to exactly one organization. Webhook URL: <code>/api/integrations/identity/webhooks/&lt;provider id&gt;</code>, signed with the secret above (see the docs).</Note>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ mappings
export function MappingsPanel({ orgId, canManage }) {
  const l = useLoad(`/api/integrations/identity/mappings?orgId=${encodeURIComponent(orgId)}`);
  const pr = useLoad(`/api/integrations/identity/providers?orgId=${encodeURIComponent(orgId)}`);
  const [f, setF] = useState({ providerId: "", name: "", type: "group", value: "", attribute: "department", role: "", department: "", project: "", financeRole: "" });
  const act = useAction(l.reload);
  const add = () => act.run(async () => {
    const grants = [];
    if (f.role) grants.push({ kind: "role", value: f.role }); if (f.department) grants.push({ kind: "department", value: `dept:${f.department}` }); if (f.project) grants.push({ kind: "project", value: `project:${f.project}` }); if (f.financeRole) grants.push({ kind: "financeRole", value: f.financeRole });
    const match = f.type === "group" ? { type: "group", value: f.value } : { type: "attribute", attribute: f.attribute, value: f.value };
    const r = await send(orgId, "mappings", { providerId: f.providerId || null, name: f.name || undefined, match, grants }); setF({ ...f, value: "", name: "" }); return r;
  });
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <Table rows={l.data?.mappings} empty="No mapping yet: a joiner gets only the provider's default access." columns={[
        { label: "External", render: (m) => m.match.type === "group" ? `group ${m.match.value}` : `${m.match.attribute} = ${m.match.value}` },
        { label: "Grants", render: (m) => m.grants.map((g) => `${g.kind}: ${g.value}${g.privileged ? " (privileged)" : ""}`).join(", ") },
        { label: "Source", render: () => <Pill value="OK" label="directory" /> }, { label: "Version", key: "version" },
        { label: "Status", render: (m) => <Pill value={m.active ? "OK" : "DISABLED"} label={m.active ? "active" : "inactive"} /> },
        { label: "", render: (m) => canManage && m.active ? <Btn small danger onClick={() => act.run(() => send(orgId, `mappings/${m.mappingId}`, {}, "DELETE"), "Deactivate this mapping? People keep their current access until the next event or reconciliation.")}>Deactivate</Btn> : null }]} />
      {canManage && (
        <Card title="Add a mapping">
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="Provider" value={f.providerId} onChange={(v) => setF({ ...f, providerId: v })} options={[{ value: "", label: "All providers" }, ...(pr.data?.providers || []).map((p) => ({ value: p.providerId, label: p.name }))]} />
            <Select label="Match on" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={["group", "attribute"]} />
            {f.type === "attribute" && <Input label="Attribute (department, jobTitle, employeeType, ...)" value={f.attribute} onChange={(v) => setF({ ...f, attribute: v })} />}
            <Input label={f.type === "group" ? "Group name" : "Value"} value={f.value} onChange={(v) => setF({ ...f, value: v })} />
            <Select label="Inaya role" value={f.role} onChange={(v) => setF({ ...f, role: v })} options={[{ value: "", label: "(none)" }, "member", "admin"]} />
            <Input label="Department name" value={f.department} onChange={(v) => setF({ ...f, department: v })} />
            <Input label="Project name" value={f.project} onChange={(v) => setF({ ...f, project: v })} />
            <Select label="Finance role" value={f.financeRole} onChange={(v) => setF({ ...f, financeRole: v })} options={[{ value: "", label: "(none)" }, "viewer", "staff", "manager"]} />
          </div>
          <Btn busy={act.busy} disabled={!f.value} onClick={add}>Add mapping</Btn>
          <Note>Owner can never be granted from a directory. Admin is privileged: it waits for a human approval (Controlled Actions) before it applies.</Note>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ lifecycle
export function LifecyclePanel({ orgId, canManage }) {
  const [filter, setFilter] = useState({ type: "", state: "", email: "" });
  const qs = `${filter.type ? `&type=${filter.type}` : ""}${filter.state ? `&state=${filter.state}` : ""}${filter.email ? `&email=${encodeURIComponent(filter.email)}` : ""}`;
  const l = useLoad(`/api/integrations/identity/runs?orgId=${encodeURIComponent(orgId)}${qs}&limit=50`);
  const [open, setOpen] = useState(null); const [detail, setDetail] = useState(null);
  const act = useAction(l.reload);
  const show = async (id) => { setOpen(id); setDetail(null); try { const r = await get(orgId, "evidence", `&runId=${id}`); setDetail(r); } catch (e) { setDetail({ error: e.message }); } };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Select label="Type" value={filter.type} onChange={(v) => setFilter({ ...filter, type: v })} options={[{ value: "", label: "All" }, "JOINER", "MOVER", "LEAVER", "STATUS_CHANGE", "RESTORE", "RECONCILE", "MANUAL_REVOKE", "MANUAL_GRANT", "INCIDENT_RESTRICT", "TEMP_EXPIRY", "REVIEW_REVOKE", "ORPHAN_REMEDIATION"]} />
        <Select label="State" value={filter.state} onChange={(v) => setFilter({ ...filter, state: v })} options={[{ value: "", label: "All" }, "COMPLETED", "PARTIAL", "FAILED", "AWAITING_APPROVAL", "AWAITING_REVIEW", "STALE"]} />
        <Input label="Person (email)" value={filter.email} onChange={(v) => setFilter({ ...filter, email: v })} />
      </div>
      <Err error={l.error || act.error} />
      <Table rows={l.data?.runs} empty="No lifecycle runs recorded yet." columns={[
        { label: "When", render: (r) => fmtTime(r.createdAt) }, { label: "Type", key: "type" }, { label: "Person", key: "email" }, { label: "Source", render: (r) => r.providerKind || r.origin },
        { label: "State", render: (r) => <Pill value={tone(r.state)} label={r.state} /> }, { label: "Verification", render: (r) => r.summary ? <Pill value={r.summary.verification === "OK" ? "OK" : "CRITICAL"} label={r.summary.verification} /> : "" },
        { label: "", render: (r) => <span className="flex gap-1"><Btn small onClick={() => (open === r.runId ? setOpen(null) : show(r.runId))}>{open === r.runId ? "Hide" : "Details"}</Btn>{canManage && ["FAILED", "PARTIAL"].includes(r.state) && <Btn small onClick={() => act.run(() => send(orgId, `runs/${r.runId}/retry`))}>Retry</Btn>}</span> }]} />
      {open && (
        <Card title="Run detail and evidence">
          {!detail ? <Note>Loading…</Note> : detail.error ? <Err error={detail.error} /> : (
            <div className="space-y-2">
              <Note>Source event: {detail.run.eventId || "n/a"} · correlation {detail.run.correlationId || "n/a"} · actor {detail.run.actor}</Note>
              <Result result={{ plan: detail.run.plan, result: detail.run.result, failure: detail.run.failure }} />
              <Note>{detail.evidence ? "Evidence Graph record and Business Event Passport:" : detail.note}</Note>
              {detail.evidence && <Result result={{ event: detail.evidence.event || detail.evidence.passport?.event || null, relationships: (detail.evidence.relationships || detail.evidence.event?.relationships || []).map((r) => ({ type: r.type, target: r.targetType, note: r.note })), integrity: detail.evidence.integrity || detail.evidence.integrityHash || null }} />}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ revocation
export function RevocationPanel({ orgId, canManage }) {
  const [state, setState] = useState("");
  const l = useLoad(`/api/integrations/identity/revocations?orgId=${encodeURIComponent(orgId)}${state ? `&state=${state}` : ""}`);
  const [f, setF] = useState({ email: "", reason: "", mode: "full" });
  const act = useAction(l.reload);
  const [preview, setPreview] = useState(null);
  return (
    <div className="space-y-4">
      <Select label="Show" value={state} onChange={setState} options={[{ value: "", label: "All" }, "REVOCATION_PENDING", "REVOCATION_PARTIAL", "REVOCATION_COMPLETE", "REVOCATION_FAILED"]} />
      <Err error={l.error || act.error} />
      <Table rows={l.data?.revocations} empty="No revocations recorded." columns={[
        { label: "When", render: (r) => fmtTime(r.createdAt) }, { label: "Person", key: "email" }, { label: "Mode", key: "mode" }, { label: "Trigger", key: "trigger" },
        { label: "State", render: (r) => <Pill value={tone(r.state)} label={r.state.replace("REVOCATION_", "")} /> },
        { label: "Steps", render: (r) => <span className="flex flex-wrap gap-1">{Object.entries(r.steps).map(([k, v]) => <Pill key={k} value={tone(v.status)} label={`${k.toLowerCase()}: ${v.status.toLowerCase()}`} />)}</span> },
        { label: "", render: (r) => canManage && r.state !== "REVOCATION_COMPLETE" ? <Btn small onClick={() => act.run(() => send(orgId, "revocations/retry", { email: r.email }))}>Retry unfinished steps</Btn> : null }]} />
      {canManage && (
        <Card title="Revoke or restrict a person now">
          <div className="grid gap-3 md:grid-cols-3">
            <Input label="Person (email)" value={f.email} onChange={(v) => setF({ ...f, email: v })} />
            <Input label="Reason" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} />
            <Select label="Mode" value={f.mode} onChange={(v) => setF({ ...f, mode: v })} options={[{ value: "full", label: "Full revocation" }, { value: "restrict", label: "Restrict (incident containment; reversible)" }]} />
          </div>
          <div className="flex gap-2">
            <Btn busy={act.busy} disabled={!f.email} onClick={() => act.run(async () => setPreview(await send(orgId, `users/${encodeURIComponent(f.email)}/preview-removal`, {}, "POST")))}>Preview impact (Digital Twin)</Btn>
            <Btn danger busy={act.busy} disabled={!f.email || !f.reason} onClick={() => act.run(() => send(orgId, `users/${encodeURIComponent(f.email)}/revoke`, { reason: f.reason, mode: f.mode }), "Remove this person's access now?")}>{f.mode === "restrict" ? "Restrict" : "Revoke"}</Btn>
            <Btn busy={act.busy} disabled={!f.email} onClick={() => act.run(() => send(orgId, `users/${encodeURIComponent(f.email)}/restore`, { reason: f.reason || "Restored by an administrator" }), "Restore this person's access? Access is re-derived from the source, not from the old snapshot.")}>Restore</Btn>
          </div>
          {preview && <Card title="Impact preview (nothing was changed)"><Result result={preview} /></Card>}
          {act.result?.revocation && <Note>Result: {act.result.revocation.state}</Note>}
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ drift
export function DriftPanel({ orgId, canManage }) {
  const l = useLoad(`/api/integrations/identity/reconcile/reports?orgId=${encodeURIComponent(orgId)}`);
  const pr = useLoad(`/api/integrations/identity/providers?orgId=${encodeURIComponent(orgId)}`);
  const [providerId, setProviderId] = useState(""); const [text, setText] = useState(""); const [open, setOpen] = useState(null); const [rep, setRep] = useState(null);
  const act = useAction(l.reload);
  const provs = pr.data?.providers || [];
  const pid = providerId || provs[0]?.providerId || "";
  const run = () => act.run(async () => { const subjects = JSON.parse(text); return send(orgId, "reconcile", { providerId: pid, snapshotId: `ui-${Date.now()}`, users: subjects, last: true }); });
  const view = async (id) => { setOpen(id); const r = await get(orgId, `reconcile/reports/${id}`); setRep(r.report); };
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <Table rows={l.data?.reports} empty="No reconciliation has run yet." columns={[
        { label: "When", render: (r) => fmtTime(r.generatedAt) }, { label: "Source", key: "source" }, { label: "Directory users", key: "directoryUsers" },
        { label: "Match", render: (r) => r.summary.MATCH }, { label: "Drift", render: (r) => <Pill value={r.summary.DRIFT ? "WARNING" : "OK"} label={String(r.summary.DRIFT)} /> },
        { label: "Conflict", render: (r) => <Pill value={r.summary.CONFLICT ? "CRITICAL" : "OK"} label={String(r.summary.CONFLICT)} /> }, { label: "Unresolved", render: (r) => r.summary.UNRESOLVED },
        { label: "", render: (r) => <Btn small onClick={() => (open === r.reportId ? setOpen(null) : view(r.reportId))}>{open === r.reportId ? "Hide" : "Findings"}</Btn> }]} />
      {open && rep && (
        <Card title="Findings" right={canManage && rep.findings.some((f) => f.suggestedAction === "REVOKE") ? <Btn small danger onClick={() => act.run(() => send(orgId, "reconcile/remediate", { providerId: rep.providerId, reportId: rep.reportId, kinds: ["DISABLED_STILL_ACTIVE", "ABSENT_FROM_DIRECTORY"] }), "Revoke everyone who is disabled or gone at the source?")}>Revoke disabled-at-source</Btn> : null}>
          <Table rows={rep.findings.slice(0, 200)} empty="No findings." columns={[{ label: "Severity", render: (f) => <Pill value={tone(f.severity)} label={f.severity} /> }, { label: "Finding", key: "kind" }, { label: "Person", render: (f) => f.email || f.externalId }, { label: "Detail", key: "detail" }, { label: "Suggested", key: "suggestedAction" }]} />
          <Note>Reconciliation reports only. It never deletes anything, and never changes access unless you use the button above.</Note>
        </Card>
      )}
      {canManage && (
        <Card title="Reconcile with a directory export">
          <Select label="Provider" value={pid} onChange={setProviderId} options={provs.map((p) => ({ value: p.providerId, label: p.name }))} />
          <label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">Directory users (JSON array of {"{ externalId, upn, email, accountEnabled, groups, department }"}; up to 1000 here, use the API for more)</span>
            <textarea className={area} rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder='[{"externalId":"...","email":"a@corp.com","accountEnabled":true,"groups":["Finance"]}]' /></label>
          <div className="flex gap-2"><Btn busy={act.busy} disabled={!pid || !text} onClick={run}>Compare with Inaya</Btn>
            {provs.find((p) => p.providerId === pid)?.kind === "entra" && <Btn busy={act.busy} onClick={() => act.run(() => send(orgId, "reconcile", { providerId: pid, mode: "graph" }))}>Pull from Microsoft Graph</Btn>}</div>
          <Note>Graph pull needs the organization's own app registration configured on the provider (UNVERIFIED against a real tenant; see docs).</Note>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ dry run
export function DryRunPanel({ orgId }) {
  const pr = useLoad(`/api/integrations/identity/providers?orgId=${encodeURIComponent(orgId)}`);
  const provs = pr.data?.providers || [];
  const [providerId, setProviderId] = useState(""); const [type, setType] = useState("user.updated");
  const [text, setText] = useState('{\n  "externalId": "obj-123",\n  "upn": "new.person@corp.example",\n  "email": "new.person@corp.example",\n  "accountEnabled": true,\n  "groups": ["Finance"]\n}');
  const act = useAction();
  const pid = providerId || provs[0]?.providerId || "";
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Select label="Provider" value={pid} onChange={setProviderId} options={provs.map((p) => ({ value: p.providerId, label: p.name }))} />
        <Select label="Event type" value={type} onChange={setType} options={["user.created", "user.updated", "user.disabled", "user.enabled", "user.department_changed", "user.group_changed", "user.deleted", "hr.joiner", "hr.mover", "hr.leaver", "security.restrict"]} />
      </div>
      <label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">Person as the source system would describe them</span><textarea className={area} rows={9} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <Btn busy={act.busy} disabled={!pid} onClick={() => act.run(() => send(orgId, "dry-run", { providerId: pid, event: { type, subject: JSON.parse(text) } }))}>Run dry run</Btn>
      <Err error={act.error} />
      {act.result?.text && (<Card title="Result" right={<Btn small onClick={() => downloadText(`inaya-dry-run-${Date.now()}.txt`, act.result.text)}>Export</Btn>}><pre className="whitespace-pre-wrap text-xs">{act.result.text}</pre></Card>)}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ people (access explanation)
export function PeoplePanel({ orgId, canManage }) {
  const [email, setEmail] = useState("");
  const act = useAction();
  const [ov, setOv] = useState({ kind: "department", value: "", reason: "", expiresAt: "" });
  const u = act.result?.user;
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2"><Input label="Person (email)" value={email} onChange={setEmail} /><Btn busy={act.busy} disabled={!email} onClick={() => act.run(() => get(orgId, `users/${encodeURIComponent(email)}`))}>Explain access</Btn></div>
      <Err error={act.error} />
      {u && (
        <Card title={`${u.email} — ${u.membership.status}, role ${u.membership.role}`}>
          <Table rows={u.access.grants} empty="No grants recorded." columns={[
            { label: "Access", render: (g) => `${g.kind}: ${g.label || g.value}` }, { label: "Source", render: (g) => <Pill value={SOURCE_TONE[g.sourceLabel] || "OK"} label={g.sourceLabel} /> },
            { label: "Status", render: (g) => <Pill value={tone(g.status)} label={g.status} /> }, { label: "Since", render: (g) => fmtTime(g.since) }, { label: "Until", render: (g) => g.until ? fmtTime(g.until) : "no expiry" }, { label: "Why", render: (g) => g.reason || "" }]} />
          <Note>External baseline + Inaya local override = effective access. A directory change never removes an INAYA MANUAL OVERRIDE.</Note>
        </Card>
      )}
      {canManage && u && (
        <Card title="Manual override">
          <div className="grid gap-3 md:grid-cols-4">
            <Select label="Kind" value={ov.kind} onChange={(v) => setOv({ ...ov, kind: v })} options={["department", "project", "role", "financeRole", "hrRole", "supportRole", "storageRole", "escrowRole", "complianceRole"]} />
            <Input label={ov.kind === "department" || ov.kind === "project" ? "Id" : "Value"} value={ov.value} onChange={(v) => setOv({ ...ov, value: v })} />
            <Input label="Reason (required)" value={ov.reason} onChange={(v) => setOv({ ...ov, reason: v })} />
            <Input label="Expires (optional, ISO date)" value={ov.expiresAt} onChange={(v) => setOv({ ...ov, expiresAt: v })} />
          </div>
          <div className="flex gap-2">
            <Btn busy={act.busy} disabled={!ov.value || !ov.reason} onClick={() => act.run(async () => { const path = ov.kind === "department" ? "departments" : ov.kind === "project" ? "projects" : "roles"; const body = ov.kind === "department" ? { departmentId: ov.value } : ov.kind === "project" ? { projectId: ov.value } : { kind: ov.kind, role: ov.value }; await send(orgId, `users/${encodeURIComponent(u.email)}/${path}`, { ...body, reason: ov.reason, expiresAt: ov.expiresAt || null }); return get(orgId, `users/${encodeURIComponent(u.email)}`); })}>Grant</Btn>
            <Btn danger busy={act.busy} disabled={!ov.value || !ov.reason} onClick={() => act.run(async () => { const path = ov.kind === "department" ? "departments" : ov.kind === "project" ? "projects" : "roles"; const body = ov.kind === "department" ? { departmentId: ov.value } : ov.kind === "project" ? { projectId: ov.value } : { kind: ov.kind, role: ov.value }; await send(orgId, `users/${encodeURIComponent(u.email)}/${path}`, { ...body, reason: ov.reason }, "DELETE"); return get(orgId, `users/${encodeURIComponent(u.email)}`); })}>Remove</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

export { Stat, Secret, area };
