"use client";

// Identity & Access console, part 2: reviews, temporary access, orphans, jobs, MSP, credentials, outbound events.

import { useState } from "react";
import { useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, Result, fmtTime } from "../nas/ui";
import { get, send, tone } from "./helpers";
import { Secret } from "./panels";

const SCOPES = ["identity:read", "identity:audit", "identity:provision", "identity:revoke", "identity:reconcile", "identity:mapping", "identity:scim"];
const OUTBOUND = ["access.revoked", "sync.failed", "sync.drift_detected", "credential.revoked", "organization.mapping_changed"];

// ------------------------------------------------------------------------------------------------------------------------------ reviews
export function ReviewsPanel({ orgId, canManage }) {
  const l = useLoad(`/api/integrations/identity/reviews?orgId=${encodeURIComponent(orgId)}`);
  const [open, setOpen] = useState(null); const [det, setDet] = useState(null); const [f, setF] = useState({ name: "", role: "", dueInDays: "14" });
  const act = useAction(async () => { await l.reload(); if (open) setDet(await get(orgId, `reviews/${open}`)); });
  const view = async (id) => { setOpen(id); setDet(await get(orgId, `reviews/${id}`)); };
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <Table rows={l.data?.reviews} empty="No access review campaigns yet." columns={[
        { label: "Campaign", key: "name" }, { label: "Status", render: (r) => <Pill value={tone(r.status === "OPEN" ? (r.overdue ? "FAILED" : "OPEN") : "CLOSED")} label={r.overdue ? "OVERDUE" : r.status} /> },
        { label: "Due", render: (r) => fmtTime(r.dueAt) }, { label: "Decided", render: (r) => `${r.decided} / ${r.items}` },
        { label: "", render: (r) => <Btn small onClick={() => (open === r.reviewId ? setOpen(null) : view(r.reviewId))}>{open === r.reviewId ? "Hide" : "Open"}</Btn> }]} />
      {open && det?.items && (
        <Card title={det.review.name}>
          <Table rows={det.items} empty="No one in scope." columns={[
            { label: "Person", key: "email" }, { label: "Role", key: "role" },
            { label: "Access and where it comes from", render: (i) => <ul className="text-xs space-y-0.5">{i.grants.map((g) => <li key={g.id}>{g.kind}: {g.label || g.value} <span className="text-[var(--inaya-text-muted)]">({g.source}{g.until ? `, until ${fmtTime(g.until)}` : ""})</span></li>)}</ul> },
            { label: "Decision", render: (i) => i.decision ? <Pill value={i.decision === "REVOKE" ? "CRITICAL" : "OK"} label={`${i.decision} by ${i.decidedBy}`} /> : canManage ? (
              <span className="flex gap-1">
                <Btn small onClick={() => act.run(() => send(orgId, `reviews/${open}/items/${i.itemId}`, { decision: "APPROVE" }))}>Approve</Btn>
                <Btn small danger onClick={() => act.run(() => send(orgId, `reviews/${open}/items/${i.itemId}`, { decision: "REVOKE", note: "Revoked in access review" }), `Remove all access for ${i.email}?`)}>Revoke</Btn>
              </span>) : <Pill value="PENDING" /> }]} />
          <Note>Use the People tab to modify individual grants; a review decision is audited and recorded as a run.</Note>
        </Card>
      )}
      {canManage && (
        <Card title="Start a campaign">
          <div className="grid gap-3 md:grid-cols-3">
            <Input label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
            <Select label="Scope" value={f.role} onChange={(v) => setF({ ...f, role: v })} options={[{ value: "", label: "Everyone (except owners)" }, { value: "member", label: "Members" }, { value: "admin", label: "Admins" }]} />
            <Input label="Due in days" value={f.dueInDays} onChange={(v) => setF({ ...f, dueInDays: v })} />
          </div>
          <Btn busy={act.busy} disabled={f.name.length < 3} onClick={() => act.run(() => send(orgId, "reviews", { name: f.name, scope: f.role ? { role: f.role } : {}, dueInDays: Number(f.dueInDays) || 14 }))}>Start review</Btn>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ temporary
export function TemporaryPanel({ orgId, canManage }) {
  const l = useLoad(`/api/integrations/identity/temporary?orgId=${encodeURIComponent(orgId)}`);
  const [f, setF] = useState({ email: "", type: "CONTRACTOR", kind: "department", value: "", purpose: "", expiresAt: "", createMembership: true });
  const act = useAction(l.reload);
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <Table rows={l.data?.temporary} empty="No active temporary access." columns={[
        { label: "Person", key: "email" }, { label: "Access", render: (g) => `${g.kind}: ${g.label || g.value}` }, { label: "Purpose", key: "purpose" }, { label: "Sponsor", key: "owner" }, { label: "Expires", render: (g) => fmtTime(g.expiresAt) },
        { label: "", render: (g) => canManage ? <Btn small danger onClick={() => act.run(() => send(orgId, `temporary/${g.grantSetId}/revoke`), "End this temporary access now?")}>End now</Btn> : null }]} />
      {canManage && (
        <Card title="Grant temporary or contractor access">
          <div className="grid gap-3 md:grid-cols-3">
            <Input label="Person (email)" value={f.email} onChange={(v) => setF({ ...f, email: v })} />
            <Select label="Type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={["CONTRACTOR", "AUDITOR", "CONSULTANT", "MSP_TECHNICIAN", "PROJECT", "OTHER"]} />
            <Select label="Access to" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={["department", "project"]} />
            <Input label={`${f.kind} id`} value={f.value} onChange={(v) => setF({ ...f, value: v })} />
            <Input label="Purpose" value={f.purpose} onChange={(v) => setF({ ...f, purpose: v })} />
            <Input label="Expires (ISO date, at most one year)" value={f.expiresAt} onChange={(v) => setF({ ...f, expiresAt: v })} />
          </div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.createMembership} onChange={(e) => setF({ ...f, createMembership: e.target.checked })} />Create a temporary membership if the person is not a member (revoked completely at expiry)</label>
          <Btn busy={act.busy} disabled={!f.email || !f.value || !f.purpose || !f.expiresAt} onClick={() => act.run(() => send(orgId, "temporary", { email: f.email, type: f.type, grants: [{ kind: f.kind, value: f.value }], purpose: f.purpose, owner: "", expiresAt: new Date(f.expiresAt).toISOString(), createMembership: f.createMembership }))}>Grant</Btn>
          <Note>You are recorded as the sponsor. Privileged access cannot be time-boxed here.</Note>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ orphans
export function OrphansPanel({ orgId, canManage }) {
  const l = useLoad(`/api/integrations/identity/orphans?orgId=${encodeURIComponent(orgId)}`);
  const [owner, setOwner] = useState({}); const [mgr, setMgr] = useState("");
  const act = useAction(l.reload);
  const analysis = useAction();
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <div className="flex gap-2"><Btn busy={act.busy} onClick={() => act.run(() => send(orgId, "orphans/detect"))}>Scan now</Btn></div>
      <Table rows={l.data?.remediations} empty="No orphaned work found. (Scans run hourly and after a revocation.)" columns={[
        { label: "What", render: (r) => `${r.kind.replace(/_/g, " ").toLowerCase()}: ${r.title}` }, { label: "Former owner", key: "formerOwner" }, { label: "Detail", key: "detail" },
        { label: "New owner", render: (r) => canManage ? <span className="flex gap-1"><input aria-label="New owner email" className="w-44 rounded border border-white/10 bg-transparent px-2 py-1 text-xs" value={owner[r.remediationId] || ""} onChange={(e) => setOwner({ ...owner, [r.remediationId]: e.target.value })} placeholder="email of an active member" /><Btn small disabled={!owner[r.remediationId]} onClick={() => act.run(() => send(orgId, `orphans/${r.remediationId}/resolve`, { newOwner: owner[r.remediationId], note: "Reassigned in Identity & Access" }))}>Reassign</Btn></span> : null }]} />
      <Note>Nothing is ever reassigned automatically: someone chooses the new owner, and the decision is audited.</Note>
      <Card title="Manager replacement analysis">
        <div className="flex items-end gap-2"><Input label="Manager (email)" value={mgr} onChange={setMgr} /><Btn busy={analysis.busy} disabled={!mgr} onClick={() => analysis.run(() => get(orgId, "orphans/manager-analysis", `&email=${encodeURIComponent(mgr)}`))}>Analyze</Btn></div>
        <Err error={analysis.error} /><Result result={analysis.result} />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ jobs
export function JobsPanel({ orgId, canManage }) {
  const l = useLoad(`/api/integrations/identity/jobs?orgId=${encodeURIComponent(orgId)}`);
  const [f, setF] = useState({ kind: "DISABLE", emails: "", dryRun: true, note: "" });
  const act = useAction(l.reload);
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <Table rows={l.data?.jobs} empty="No bulk jobs." columns={[
        { label: "When", render: (j) => fmtTime(j.createdAt) }, { label: "Kind", render: (j) => `${j.kind}${j.dryRun ? " (dry run)" : ""}` }, { label: "State", render: (j) => <Pill value={tone(j.status)} label={j.status} /> },
        { label: "Items", render: (j) => `${j.totals.completed} done · ${j.totals.failed} failed · ${j.totals.items} total` },
        { label: "", render: (j) => canManage && ["QUEUED", "RUNNING"].includes(j.status) ? <span className="flex gap-1"><Btn small onClick={() => act.run(() => send(orgId, "jobs/process"))}>Process now</Btn><Btn small danger onClick={() => act.run(() => send(orgId, `jobs/${j.jobId}/cancel`))}>Cancel</Btn></span> : null }]} />
      {canManage && (
        <Card title="Bulk operation">
          <div className="grid gap-3 md:grid-cols-3"><Select label="Operation" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ value: "DISABLE", label: "Revoke access" }, { value: "RESTRICT", label: "Restrict access" }, { value: "RESTORE", label: "Restore access" }]} /><Input label="Note" value={f.note} onChange={(v) => setF({ ...f, note: v })} />
            <label className="flex items-center gap-2 pt-5 text-xs"><input type="checkbox" checked={f.dryRun} onChange={(e) => setF({ ...f, dryRun: e.target.checked })} />Dry run (change nothing)</label></div>
          <label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">One email per line (up to 5000)</span><textarea className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-xs font-mono" rows={5} value={f.emails} onChange={(e) => setF({ ...f, emails: e.target.value })} /></label>
          <Btn busy={act.busy} disabled={!f.emails.trim()} onClick={() => act.run(() => send(orgId, "jobs", { kind: f.kind, items: f.emails.split(/\s+/).filter(Boolean).map((email) => ({ email })), dryRun: f.dryRun, note: f.note }))}>Create job</Btn>
          <Note>Each person is processed on their own: one failure never stops the rest, and a job can be resumed.</Note>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ MSP
export function MspPanel({ orgId, canManage }) {
  const l = useLoad(`/api/integrations/identity/msp/links?orgId=${encodeURIComponent(orgId)}`);
  const a = useLoad(canManage ? `/api/integrations/identity/msp/assignments?orgId=${encodeURIComponent(orgId)}` : null);
  const [code, setCode] = useState(null); const [inv, setInv] = useState(""); const [t, setT] = useState({ email: "", role: "MSP_READ_ONLY_AUDITOR", customer: "" });
  const act = useAction(async () => { await l.reload(); await a.reload(); });
  const ROLES = ["MSP_SUPER_ADMIN", "MSP_CUSTOMER_ADMIN", "MSP_AUTOMATION_OPERATOR", "MSP_READ_ONLY_AUDITOR"];
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} /><Secret title="Invite code for your MSP" value={code} note="Give it to your MSP. Shown once; valid 7 days; usable once." />
      <Table rows={l.data?.links} empty="No MSP or customer links." columns={[
        { label: "MSP", render: (k) => k.mspName || k.mspOrgId }, { label: "Customer", render: (k) => k.customerName || k.customerOrgId }, { label: "Status", render: (k) => <Pill value={k.status === "ACTIVE" ? "OK" : "DISABLED"} label={k.status} /> },
        { label: "Since", render: (k) => fmtTime(k.createdAt) }, { label: "", render: (k) => canManage && k.status === "ACTIVE" ? <Btn small danger onClick={() => act.run(() => send(orgId, `msp/links/${k.customerOrgId}`, { mspOrgId: k.mspOrgId, customerOrgId: k.customerOrgId }, "DELETE"), "End this link? The MSP loses access to this customer immediately.")}>End link</Btn> : null }]} />
      {canManage && (
        <>
          <Card title="Let an MSP manage this organization"><Btn busy={act.busy} onClick={() => act.run(async () => { const r = await send(orgId, "msp/invites"); setCode(r.inviteCode); return r; })}>Create invite code</Btn>
            <Note>Customers accept the link; an MSP can never add itself. Ending the link cuts access at once.</Note></Card>
          <Card title="Accept a customer's invite (you are the MSP)"><div className="flex items-end gap-2"><Input label="Invite code" value={inv} onChange={setInv} /><Btn busy={act.busy} disabled={!inv} onClick={() => act.run(async () => { const r = await send(orgId, "msp/accept", { token: inv }); setInv(""); return r; })}>Accept</Btn></div></Card>
          <Card title="Delegated technician roles (you are the MSP)">
            <Table rows={a.data?.assignments} empty="No technicians assigned." columns={[{ label: "Technician", key: "email" }, { label: "Role", key: "role" }, { label: "Customers", render: (x) => x.customerOrgIds === "*" ? "all linked" : x.customerOrgIds.length }]} />
            <div className="grid gap-3 md:grid-cols-3"><Input label="Technician (email)" value={t.email} onChange={(v) => setT({ ...t, email: v })} /><Select label="Role" value={t.role} onChange={(v) => setT({ ...t, role: v })} options={ROLES} /><Input label="Customer organization id" value={t.customer} onChange={(v) => setT({ ...t, customer: v })} /></div>
            <Btn busy={act.busy} disabled={!t.email} onClick={() => act.run(() => send(orgId, "msp/assignments", { email: t.email, role: t.role, customerOrgIds: t.customer ? [t.customer] : [] }))}>Assign</Btn>
          </Card>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ credentials + outbound
export function CredentialsPanel({ orgId, canManage }) {
  const l = useLoad(canManage ? `/api/integrations/identity/credentials?orgId=${encodeURIComponent(orgId)}` : null);
  const pr = useLoad(canManage ? `/api/integrations/identity/providers?orgId=${encodeURIComponent(orgId)}` : null);
  const [f, setF] = useState({ label: "", scopes: ["identity:read"], providerId: "", expiresInDays: "90" }); const [token, setToken] = useState(null);
  const act = useAction(l.reload);
  if (!canManage) return <Note>Only an owner or admin can manage service credentials.</Note>;
  const toggle = (s) => setF({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] });
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} /><Secret title="Service credential" value={token} note="Use it as a Bearer token. Shown once; it cannot be recovered." />
      <Table rows={l.data?.credentials} empty="No service credentials." columns={[
        { label: "Label", key: "label" }, { label: "Prefix", render: (c) => <code className="text-xs">{c.prefix}…</code> }, { label: "Scopes", render: (c) => c.scopes.join(", ") }, { label: "Expires", render: (c) => fmtTime(c.expiresAt) }, { label: "Last used", render: (c) => fmtTime(c.lastUsedAt) },
        { label: "Status", render: (c) => <Pill value={c.revokedAt ? "DISABLED" : "OK"} label={c.revokedAt ? "revoked" : "active"} /> },
        { label: "", render: (c) => !c.revokedAt ? <span className="flex gap-1"><Btn small onClick={() => act.run(async () => { const r = await send(orgId, `credentials/${c.credentialId}/rotate`); setToken(r.token); return r; }, "Rotate? The old token stops working immediately.")}>Rotate</Btn><Btn small danger onClick={() => act.run(() => send(orgId, `credentials/${c.credentialId}/revoke`), "Revoke this credential now?")}>Revoke</Btn></span> : null }]} />
      <Card title="Create a credential (for Rewst, an RMM, a script or a SCIM client)">
        <div className="grid gap-3 md:grid-cols-3">
          <Input label="Label" value={f.label} onChange={(v) => setF({ ...f, label: v })} />
          <Select label="Bound provider (required for SCIM)" value={f.providerId} onChange={(v) => setF({ ...f, providerId: v })} options={[{ value: "", label: "(none)" }, ...(pr.data?.providers || []).map((p) => ({ value: p.providerId, label: p.name }))]} />
          <Input label="Expires in days (max 365)" value={f.expiresInDays} onChange={(v) => setF({ ...f, expiresInDays: v })} />
        </div>
        <div className="flex flex-wrap gap-3">{SCOPES.map((s) => <label key={s} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.scopes.includes(s)} onChange={() => toggle(s)} />{s}</label>)}</div>
        <Btn busy={act.busy} disabled={!f.scopes.length} onClick={() => act.run(async () => { const r = await send(orgId, "credentials", { label: f.label, scopes: f.scopes, providerId: f.providerId || null, expiresInDays: Number(f.expiresInDays) || 90 }); setToken(r.token); return r; })}>Create credential</Btn>
        <Note>Least privilege: give only the scopes the automation needs. A credential is bound to this organization only.</Note>
      </Card>
    </div>
  );
}

export function EventsPanel({ orgId, canManage }) {
  const w = useLoad(`/api/integrations/identity/outbound/webhooks?orgId=${encodeURIComponent(orgId)}`);
  const d = useLoad(`/api/integrations/identity/outbound/deliveries?orgId=${encodeURIComponent(orgId)}`);
  const [f, setF] = useState({ url: "", events: ["access.revoked"] }); const [secret, setSecret] = useState(null);
  const act = useAction(async () => { await w.reload(); await d.reload(); });
  const toggle = (s) => setF({ ...f, events: f.events.includes(s) ? f.events.filter((x) => x !== s) : [...f.events, s] });
  return (
    <div className="space-y-4">
      <Err error={w.error || act.error} /><Secret title="Signing secret for this webhook" value={secret} />
      <Table rows={w.data?.webhooks} empty="No outbound webhook. Inaya will not send identity events anywhere until you add one." columns={[
        { label: "URL", key: "url" }, { label: "Events", render: (x) => x.events.join(", ") }, { label: "Last delivery", render: (x) => fmtTime(x.lastDeliveryAt) }, { label: "Failures", key: "consecutiveFailures" },
        { label: "", render: (x) => canManage ? <Btn small danger onClick={() => act.run(() => send(orgId, `outbound/webhooks/${x.webhookId}`, {}, "DELETE"))}>Remove</Btn> : null }]} />
      <Card title="Recent deliveries" right={canManage ? <Btn small onClick={() => act.run(() => send(orgId, "outbound/deliver"))}>Deliver now</Btn> : null}>
        <Table rows={d.data?.deliveries} empty="Nothing delivered yet." columns={[{ label: "Event", key: "event" }, { label: "Status", render: (x) => <Pill value={tone(x.status)} label={x.status} /> }, { label: "Attempts", key: "attempts" }, { label: "Error", render: (x) => x.lastError || "" }]} />
      </Card>
      {canManage && (
        <Card title="Send identity events to your automation (for example a Rewst trigger)">
          <Input label="HTTPS URL" value={f.url} onChange={(v) => setF({ ...f, url: v })} />
          <div className="flex flex-wrap gap-3">{OUTBOUND.map((s) => <label key={s} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.events.includes(s)} onChange={() => toggle(s)} />{s}</label>)}</div>
          <Btn busy={act.busy} disabled={!f.url || !f.events.length} onClick={() => act.run(async () => { const r = await send(orgId, "outbound/webhooks", f); setSecret(r.secret); return r; })}>Add webhook</Btn>
          <Note>Signed with X-Inaya-Timestamp and X-Inaya-Signature (HMAC-SHA256 of timestamp.body). Private, local and metadata addresses are refused.</Note>
        </Card>
      )}
    </div>
  );
}
