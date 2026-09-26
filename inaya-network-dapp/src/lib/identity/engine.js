// src/lib/identity/engine.js
//
// SOW §11-§14, §37, §45-§47: the joiner / mover / leaver engine.
//
// One entry point, processEvent(), used by every source (signed webhook, SCIM, service-credential API, bulk job, reconciliation):
//
//   receive -> tenant check -> idempotency (one row per provider+eventId) -> per-identity lock -> resolve identity
//   -> ordering (stale events are recorded and ignored) -> classify -> PLAN (pure description of every change)
//   -> [dry run stops here] -> execute the plan -> verify -> audit + evidence + notify.
//
// The dry run and the live path share the same planner and the same operation list, so a dry run shows exactly what a live
// run would do. A dry run writes nothing.
//
// Ordering guarantees (SOW §45/§46): every external identity carries a watermark. An event that is not newer than it is STALE:
// recorded, never applied. A disable is applied to the identity record FIRST (before any revocation step) so that even if
// revocation is only partial, a later stale "enable" or "update" cannot restore access. An enable after a revocation never
// restores access by itself: policy.restoreOnEnable decides (manual_review by default).

import { emitIdentityEvent } from "./outbound.js";
import { toObjectId, getOrgCollections } from "../orgs.js";
import { getOrgPlan, getOrgUsage } from "../orgPlans.js";
import { getIdentityCollections, ensureIdentityIndexes } from "./db.js";
import { fail, nowIso, normEmail, isNewer, IdentityError, classifyError, RETRYABLE, SOURCE_OF_KIND } from "./common.js";
import { lifecycleClassOfType } from "./normalize.js";
import { resolveIdentity, evaluateDesired } from "./mapping.js";
import { addGrant, revokeGrants, listGrants, diffGrants, materialize, captureExisting } from "./grants.js";
import { revokeAccess } from "./revocation.js";
import { proposePrivilegedGrant } from "./approvals.js";
import { audit, link, notifyManagers } from "./record.js";

// --------------------------------------------------------------------------------------------- locks
async function withLock(key, fn, { ttlMs = 60000, waitMs = 4000 } = {}) {
  const { identityLocks } = await getIdentityCollections();
  const t0 = Date.now(); let held = false;
  while (!held) {
    try { await identityLocks.insertOne({ key, at: nowIso(), expiresAt: new Date(Date.now() + ttlMs) }); held = true; }
    catch (err) {
      if (err?.code !== 11000) throw err;
      await identityLocks.deleteOne({ key, expiresAt: { $lt: new Date() } }); // a crashed holder never blocks forever
      if (Date.now() - t0 > waitMs) throw new IdentityError("Another change for this identity is still being applied.", "TRANSIENT", { busy: true });
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  try { return await fn(); } finally { await identityLocks.deleteOne({ key }).catch(() => {}); }
}

// ------------------------------------------------------------------------------ external identity record
const isDisabledSubject = (s) => s.accountEnabled === false || ["TERMINATED", "DISABLED", "INACTIVE"].includes(s.employmentStatus);

function extFields(provider, ev) {
  const s = ev.subject;
  return { orgId: provider.orgId, providerId: provider._id, kind: provider.kind, tenantId: provider.providerTenantId, externalObjectId: s.externalId, upn: s.upn || null, employeeId: s.employeeId || null, email: s.email || null, displayName: s.displayName || null, department: s.department || null, jobTitle: s.jobTitle || null, managerExternalId: s.managerExternalId || null, groups: s.groups || [], employeeType: s.employeeType || null, contractEndDate: s.contractEndDate || null, attributes: s.attributes || {}, accountEnabled: s.accountEnabled !== false, employmentStatus: s.employmentStatus || null };
}

async function saveExternal({ provider, ev, existing, inayaEmail, lifecycleState, membershipId = null }) {
  const { identityExternalUsers } = await getIdentityCollections();
  const f = extFields(provider, ev);
  const now = nowIso();
  const set = { ...f, sourceUpdatedAt: ev.occurredAt, watermark: { time: ev.time, sequence: ev.sequence }, lastEventId: ev.eventId, lastSeenAt: now, updatedAt: now, lifecycleState, mappingStatus: "LINKED", ...(inayaEmail ? { inayaEmail } : {}), ...(membershipId ? { membershipId: String(membershipId) } : {}) };
  if (lifecycleState === "DISABLED" || lifecycleState === "REVOKED") set.disabledAtTime = existing?.disabledAtTime && existing.lifecycleState !== "ACTIVE" ? existing.disabledAtTime : ev.time;
  if (existing) { await identityExternalUsers.updateOne({ _id: existing._id }, { $set: set, $inc: { mappingVersion: 0 } }); return { ...existing, ...set }; }
  const doc = { ...set, createdAt: now, mappingVersion: 1 };
  try { doc._id = (await identityExternalUsers.insertOne(doc)).insertedId; }
  catch (err) { if (err?.code === 11000) { const e = await identityExternalUsers.findOne({ providerId: provider._id, externalObjectId: f.externalObjectId }); return e; } throw err; }
  return doc;
}

// ------------------------------------------------------------------------------------------- planning
/**
 * Pure-read planner: everything a live run would change, as an ordered operation list. No writes.
 * Returns { klass, ops, warnings, identity, desired, skipped? }.
 */
export async function buildPlan({ provider, ev, resolution, klass }) {
  const orgId = provider.orgId; const s = ev.subject;
  const { orgMembers } = await getOrgCollections();
  const email = normEmail(resolution.ext?.inayaEmail || s.email || s.upn);
  const membership = resolution.membership || (email ? await orgMembers.findOne({ orgId, email }) : null);
  const ops = []; const warnings = [];
  const plan = { klass, email, identity: { via: resolution.via || "new", externalId: s.externalId, membershipExists: !!membership, membershipStatus: membership?.status || null }, ops, warnings };

  if (klass === "STATUS_CHANGE") { ops.push({ op: "UPDATE_IDENTITY_RECORD", detail: "Attributes recorded; no access change." }); return plan; }

  if (klass === "LEAVER" || klass === "INCIDENT_RESTRICT") {
    if (!membership) { ops.push({ op: "UPDATE_IDENTITY_RECORD", detail: "No Inaya membership exists for this person; nothing to revoke." }); return plan; }
    ops.push({ op: "UPDATE_IDENTITY_RECORD", detail: "Mark the identity disabled first, so a stale event can never restore it." });
    ops.push({ op: klass === "LEAVER" ? "REVOKE_ACCESS" : "RESTRICT_ACCESS", email, steps: klass === "LEAVER" ? ["FREEZE", "SESSIONS", "CREDENTIALS", "PERMISSIONS", "SHARING", "BREAK_GLASS"] : ["FREEZE", "SESSIONS"] });
    return plan;
  }

  if (klass === "RESTORE") {
    const mode = provider.policy.restoreOnEnable;
    ops.push({ op: mode === "auto" ? "RESTORE_ACCESS" : mode === "never" ? "IGNORE" : "QUEUE_RESTORE_REVIEW", email, detail: mode === "auto" ? "Policy restores access automatically." : mode === "never" ? "Policy never restores access from an enable event." : "A person must approve restoring access." });
    return plan;
  }

  // JOINER / MOVER: desired access from policy
  const dis = isDisabledSubject(s);
  const desired = await evaluateDesired({ orgId, provider, subject: s });
  plan.desired = desired.grants; plan.matchedMappings = desired.matched;
  for (const u of desired.unresolved) warnings.push(`Not applied: ${u.kind} "${u.value}" — ${u.reason}`);
  if (!email) { warnings.push("The event carries no email address, so no Inaya membership can be created or linked."); return plan; }
  if (dis) return plan;

  if (!membership) ops.push({ op: "CREATE_MEMBERSHIP", email, role: "member", status: "active" });
  else if (resolution.status === "LINKABLE") ops.push({ op: "LINK_MEMBERSHIP", email, via: resolution.via });
  else if (membership.status !== "active") { ops.push({ op: "QUEUE_RESTORE_REVIEW", email, detail: `The membership is ${membership.status}; restoring it needs a person to approve.` }); return plan; }

  const source = SOURCE_OF_KIND[provider.kind];
  const current = membership ? (await listGrants({ orgId, email })).filter((g) => g.source === source && g.sourceRef === String(provider._id)) : [];
  const d = diffGrants(current, desired.grants);
  for (const g of d.add) ops.push({ op: g.privileged && provider.policy.requireApprovalForPrivileged ? "PROPOSE_PRIVILEGED_GRANT" : "GRANT", kind: g.kind, value: g.value, label: g.label, mappingId: g.mappingId });
  for (const g of d.remove) if (provider.policy.removeObsoleteOnMove) ops.push({ op: "REVOKE_GRANT", kind: g.kind, value: g.value, label: g.label });
  return plan;
}

// ------------------------------------------------------------------------------------------ execution
async function checkSeat(provider) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: provider.orgId });
  const plan = getOrgPlan(org);
  if (plan.maxUsers !== Infinity) { const { activeUsers } = await getOrgUsage(provider.orgId); if (activeUsers >= plan.maxUsers) throw new IdentityError(`The ${plan.name} plan allows ${plan.maxUsers} users; upgrade to provision more.`, "VALIDATION", { reasonCode: "PLAN_LIMIT" }); }
}

async function executePlan({ provider, ev, resolution, plan, run, actor }) {
  const orgId = provider.orgId; const email = plan.email; const out = { performed: [], pendingApproval: [], verification: [] };
  const { orgMembers } = await getOrgCollections();
  const source = SOURCE_OF_KIND[provider.kind]; const ref = String(provider._id);
  let ext = resolution.ext || null; let membership = null;
  const isDisabling = plan.klass === "LEAVER" || plan.klass === "INCIDENT_RESTRICT";

  for (const op of plan.ops) {
    switch (op.op) {
      case "CREATE_MEMBERSHIP": {
        await checkSeat(provider);
        try { await orgMembers.insertOne({ orgId, email, role: "member", departmentIds: [], status: "active", invitedAt: nowIso(), joinedAt: nowIso(), provisionedBy: `identity:${provider.kind}`, identityManagedAt: nowIso(), ...(ev.subject.employeeType === "contractor" ? { temporary: true } : {}) }); }
        catch (err) { if (err?.code !== 11000) throw err; }
        membership = await orgMembers.findOne({ orgId, email });
        out.performed.push({ op: op.op, email }); break;
      }
      case "LINK_MEMBERSHIP": { membership = await orgMembers.findOne({ orgId, email }); out.performed.push({ op: op.op, email, via: op.via }); break; }
      case "UPDATE_IDENTITY_RECORD": {
        ext = await saveExternal({ provider, ev, existing: ext, inayaEmail: email || null, lifecycleState: isDisabling ? "DISABLED" : ext?.lifecycleState || "ACTIVE" });
        out.performed.push({ op: op.op }); break;
      }
      case "REVOKE_ACCESS": case "RESTRICT_ACCESS": {
        const r = await revokeAccess({ orgId, email, trigger: ev.type, reason: `${ev.type} from ${provider.kind}`, actor, policy: provider.policy, mode: op.op === "RESTRICT_ACCESS" ? "restrict" : "full", runId: run._id, correlationId: ev.correlationId, externalId: ev.subject.externalId });
        if (r.error) throw new IdentityError(r.error, "PERMANENT", { reasonCode: r.reasonCode });
        out.revocation = r.revocation; out.performed.push({ op: op.op, state: r.revocation.state });
        if (r.revocation.state === "REVOCATION_COMPLETE" && ext) { const { identityExternalUsers } = await getIdentityCollections(); await identityExternalUsers.updateOne({ _id: ext._id }, { $set: { lifecycleState: op.op === "REVOKE_ACCESS" ? "REVOKED" : "DISABLED" } }); }
        break;
      }
      case "GRANT": case "PROPOSE_PRIVILEGED_GRANT": {
        if (!membership) membership = await orgMembers.findOne({ orgId, email });
        if (!membership) throw new IdentityError("No membership to grant access to.", "MAPPING");
        await captureExisting({ orgId, membership });
        const priv = op.op === "PROPOSE_PRIVILEGED_GRANT";
        const { grant } = await addGrant({ orgId, email, kind: op.kind, value: op.value, label: op.label, source, sourceRef: ref, reason: `Mapping ${op.mappingId}`, actor: `identity:${provider.kind}`, status: priv ? "PENDING_APPROVAL" : "ACTIVE", expiresAt: ev.subject.employeeType === "contractor" && ev.subject.contractEndDate ? ev.subject.contractEndDate : null });
        if (priv && !grant.requestId) { const p = await proposePrivilegedGrant({ orgId, email, grant, runId: run._id, providerId: provider._id, actorLabel: `identity:${provider.kind}` }); if (p.error) throw new IdentityError(p.error, "VALIDATION"); out.pendingApproval.push({ kind: op.kind, value: op.value, requestId: p.requestId }); }
        else if (priv) out.pendingApproval.push({ kind: op.kind, value: op.value, requestId: grant.requestId });
        out.performed.push({ op: op.op, kind: op.kind, value: op.value }); break;
      }
      case "REVOKE_GRANT": {
        await revokeGrants({ orgId, email, filter: { kind: op.kind, value: op.value, source, sourceRef: ref }, reason: "no longer justified by the source directory" });
        out.performed.push({ op: op.op, kind: op.kind, value: op.value }); break;
      }
      case "QUEUE_RESTORE_REVIEW": {
        ext = await saveExternal({ provider, ev, existing: ext, inayaEmail: email || null, lifecycleState: "PENDING_REVIEW" });
        out.awaitingReview = true; out.performed.push({ op: op.op, email }); break;
      }
      case "RESTORE_ACCESS": { const r = await restoreAccess({ orgId, email, actor: `identity:${provider.kind}`, reason: "Enable event; policy restoreOnEnable=auto", provider, ev }); if (r.error) throw new IdentityError(r.error, "PERMANENT"); out.performed.push({ op: op.op }); out.restore = r; break; }
      case "IGNORE": out.performed.push({ op: "IGNORE" }); break;
      default: break;
    }
  }

  // link the identity record and derive access
  const wantsAccess = ["JOINER", "MOVER"].includes(plan.klass) && email && (membership || plan.identity.membershipExists) && !plan.ops.some((o) => o.op === "QUEUE_RESTORE_REVIEW");
  if (wantsAccess) {
    membership = membership || await orgMembers.findOne({ orgId, email });
    ext = await saveExternal({ provider, ev, existing: ext, inayaEmail: email, lifecycleState: "ACTIVE", membershipId: membership?._id });
    if (membership) await captureExisting({ orgId, membership }); // what the person already had is preserved before access is derived
    const m = await materialize({ orgId, email });
    out.materialized = m;
    // verification: the membership must reflect every ACTIVE, non-privileged desired grant
    const eff = m.effective;
    for (const g of plan.desired || []) {
      if (plan.ops.some((o) => o.op === "PROPOSE_PRIVILEGED_GRANT" && o.kind === g.kind && o.value === g.value)) continue;
      const ok = g.kind === "department" ? eff?.departmentIds?.includes(g.value) : g.kind === "project" ? eff?.projectIds?.includes(g.value) : g.kind === "role" ? (g.value === "member" || eff?.role === g.value) : eff?.[g.kind] === g.value || (eff?.[g.kind] && eff[g.kind] === "manager");
      out.verification.push({ check: `${g.kind}:${g.value}`, ok: m.skipped === "owner" ? true : !!ok });
    }
  } else if (plan.klass === "STATUS_CHANGE" && !ext) {
    ext = await saveExternal({ provider, ev, existing: null, inayaEmail: email || null, lifecycleState: isDisabledSubject(ev.subject) ? "DISABLED" : "ACTIVE" });
  } else if (plan.klass === "STATUS_CHANGE") ext = await saveExternal({ provider, ev, existing: ext, inayaEmail: ext.inayaEmail || email || null, lifecycleState: ext.lifecycleState });
  out.ext = ext;
  return out;
}

// --------------------------------------------------------------------------------------- restore access
/**
 * Restores a revoked or restricted membership. Restricted (incident containment) -> active again with everything intact.
 * Revoked -> active, with access RE-DERIVED from the source directory's current state and policy (never from the old snapshot),
 * privileged grants still needing approval. A human (or policy restoreOnEnable=auto) triggers this; a stale event never does.
 */
export async function restoreAccess({ orgId, email: rawEmail, actor, reason = null, provider = null, ev = null }) {
  const email = normEmail(rawEmail);
  const { orgMembers } = await getOrgCollections();
  const { identityExternalUsers } = await getIdentityCollections();
  const oid = toObjectId(orgId);
  const m = await orgMembers.findOne({ orgId: oid, email });
  if (!m) return fail("That person has no membership to restore.", 404);
  if (m.status === "active") return { restored: false, noop: true, reason: "The membership is already active." };
  if (!["revoked", "restricted"].includes(m.status)) return fail(`A ${m.status} membership is restored through the normal invite flow.`, 409);
  const ext = await identityExternalUsers.findOne({ orgId: oid, inayaEmail: email });
  if (m.status === "revoked" && ext && ext.accountEnabled === false) return fail("The person is still disabled in the source directory. Enable them there first.", 409, { reasonCode: "STILL_DISABLED_AT_SOURCE" });
  if (m.status === "revoked") {
    const { orgs } = await getOrgCollections();
    const plan = getOrgPlan(await orgs.findOne({ _id: oid }));
    if (plan.maxUsers !== Infinity) { const { activeUsers } = await getOrgUsage(orgId); if (activeUsers >= plan.maxUsers) return fail(`The ${plan.name} plan allows ${plan.maxUsers} users; upgrade to restore this person.`, 403, { reasonCode: "PLAN_LIMIT" }); }
  }
  const wasRestricted = m.status === "restricted";
  await orgMembers.updateOne({ _id: m._id }, { $set: { status: "active", identityRestoredAt: nowIso(), identityRestoredBy: actor }, $unset: { identityFrozenAt: "", identityFrozenReason: "", identityFrozenBy: "" } });
  const out = { restored: true, from: m.status, actor, reason };
  if (!wasRestricted) {
    // re-derive from the source directory (default grants at minimum) instead of resurrecting the old snapshot
    const prov = provider || (ext ? await (await getIdentityCollections()).identityProviders.findOne({ _id: ext.providerId }) : null);
    await captureExisting({ orgId, membership: await orgMembers.findOne({ _id: m._id }) });
    if (prov && ext) {
      const desired = await evaluateDesired({ orgId, provider: prov, subject: { ...ext, accountEnabled: true, employmentStatus: ext.employmentStatus === "TERMINATED" ? null : ext.employmentStatus } });
      const pending = [];
      for (const g of desired.grants) {
        const priv = g.privileged && prov.policy.requireApprovalForPrivileged;
        const { grant } = await addGrant({ orgId, email, kind: g.kind, value: g.value, label: g.label, source: SOURCE_OF_KIND[prov.kind], sourceRef: String(prov._id), reason: "Restored: re-derived from the source directory", actor, status: priv ? "PENDING_APPROVAL" : "ACTIVE" });
        if (priv && !grant.requestId) { const p = await proposePrivilegedGrant({ orgId, email, grant, runId: ext._id, providerId: prov._id, actorLabel: actor }); if (!p.error) pending.push({ kind: g.kind, value: g.value, requestId: p.requestId }); }
      }
      out.pendingApproval = pending; out.rederived = desired.grants.length;
      await identityExternalUsers.updateOne({ _id: ext._id }, { $set: { lifecycleState: "ACTIVE", accountEnabled: true } });
    }
    out.materialized = await materialize({ orgId, email });
  }
  await audit({ orgId, action: "IDENTITY_ACCESS_RESTORED", actorEmail: actor, previousState: m.status, newState: "active", metadata: { email, reason, from: m.status } });
  return out;
}

// -------------------------------------------------------------------------------------------- the entry
const FINAL = ["PROCESSED", "STALE", "REJECTED", "UNRESOLVED", "FAILED"];

/**
 * Applies (or, with dryRun, plans) one normalized identity event for a provider. Returns
 *   { status: PROCESSED|DUPLICATE|STALE|REJECTED|UNRESOLVED|PENDING|FAILED|DRY_RUN, runId?, run?, plan? }.
 */
export async function processEvent({ provider, event, dryRun = false, actor = null, origin = "webhook", retry = false }) {
  await ensureIdentityIndexes();
  const { identityEvents, identityRuns, identityExternalUsers } = await getIdentityCollections();
  const orgId = provider.orgId; const actorLabel = actor || `identity:${provider.kind}`;
  const rejected = async (reason, reasonCode) => {
    await audit({ orgId, action: "IDENTITY_EVENT_REJECTED", actorEmail: actorLabel, metadata: { eventId: event.eventId, type: event.type, reasonCode, reason } });
    if (!dryRun) await identityEvents.updateOne({ providerId: provider._id, eventId: event.eventId }, { $set: { status: "REJECTED", reasonCode, processedAt: nowIso() } }).catch(() => {});
    return { status: "REJECTED", reasonCode, reason };
  };

  if (provider.status !== "ACTIVE") return { status: "REJECTED", reasonCode: "PROVIDER_DISABLED", reason: "The provider is disabled." };
  if (!dryRun && !retry) {
    try { await identityEvents.insertOne({ providerId: provider._id, orgId, eventId: event.eventId, type: event.type, tenantId: event.tenantId, externalId: event.subject.externalId, occurredAt: event.occurredAt, correlationId: event.correlationId, origin, status: "RECEIVED", receivedAt: nowIso(), event }); }
    catch (err) {
      if (err?.code !== 11000) throw err;
      const prev = await identityEvents.findOne({ providerId: provider._id, eventId: event.eventId });
      // a duplicate never mutates again; an event parked as PENDING is retried by the worker, not by the sender
      return { status: "DUPLICATE", previous: prev?.status || null, runId: prev?.runId || null };
    }
  }
  if (String(event.tenantId) !== String(provider.providerTenantId)) return rejected("The event names a tenant this provider is not bound to.", "TENANT_MISMATCH");

  const finish = async (status, extra = {}) => {
    if (!dryRun) await identityEvents.updateOne({ providerId: provider._id, eventId: event.eventId }, { $set: { status: FINAL.includes(status) ? status : "PENDING", processedAt: nowIso(), ...(extra.runId ? { runId: String(extra.runId) } : {}), ...(extra.reason ? { reason: extra.reason } : {}) } });
    return { status, ...extra };
  };

  let result;
  try {
    result = await withLock(`${provider._id}:${event.subject.externalId}`, async () => {
      const resolution = await resolveIdentity({ provider, subject: event.subject });
      if (resolution.status === "AMBIGUOUS" || resolution.status === "CONFLICT") {
        if (!dryRun) { await audit({ orgId, action: "IDENTITY_UNRESOLVED", actorEmail: actorLabel, metadata: { eventId: event.eventId, externalId: event.subject.externalId, status: resolution.status, reason: resolution.reason } }); await notifyManagers({ orgId, title: `Identity ${resolution.status.toLowerCase()}: ${event.subject.upn || event.subject.email || event.subject.externalId}`, body: resolution.reason, dedupeKey: `identity:unresolved:${provider._id}:${event.eventId}`, severity: "warning" }); }
        return finish("UNRESOLVED", { reason: resolution.reason, resolution: resolution.status });
      }
      const ext = resolution.ext || null;
      const disabling = isDisabledSubject(event.subject) || ["user.disabled", "user.deleted", "hr.leaver", "psa.offboarding", "security.restrict"].includes(event.type);
      // ordering: never apply an event that is not newer than what we have already applied for this identity
      if (ext && !isNewer({ time: event.time, sequence: event.sequence }, ext.watermark, { disabling })) {
        if (!dryRun) await audit({ orgId, action: "IDENTITY_EVENT_STALE", actorEmail: actorLabel, metadata: { eventId: event.eventId, type: event.type, externalId: event.subject.externalId } });
        return finish("STALE", { reason: "An equal or newer event for this identity was already applied." });
      }
      // a re-enable that is not newer than the disable is stale even if the watermark moved on for another reason
      if (ext && !disabling && ["DISABLED", "REVOKED"].includes(ext.lifecycleState) && ext.disabledAtTime != null && event.time <= ext.disabledAtTime) return finish("STALE", { reason: "This event predates the disable that is already in force." });

      // classify
      let klass = lifecycleClassOfType(event.type);
      const blocked = (ext && ["DISABLED", "REVOKED", "PENDING_REVIEW"].includes(ext.lifecycleState)) || (resolution.membership && ["revoked", "restricted"].includes(resolution.membership.status));
      if (disabling && klass !== "INCIDENT_RESTRICT") klass = "LEAVER";
      else if (klass === "INCIDENT_RESTRICT" || klass === "STATUS_CHANGE") { /* keep */ }
      else if (blocked) klass = "RESTORE"; // any non-disabling event about a disabled identity is a request to restore, never a silent re-grant
      else if (klass === "RESTORE") klass = "MOVER"; // an enable for an identity that is already active
      else if (klass === "JOINER" && ext) klass = "MOVER"; // creating twice never creates a second person
      else if (klass === "MOVER" && !ext && !resolution.membership) klass = "JOINER";

      const plan = await buildPlan({ provider, ev: event, resolution, klass });
      if (dryRun) return { status: "DRY_RUN", plan, liveMutation: false };

      const run = { orgId, type: klass, providerId: String(provider._id), providerKind: provider.kind, externalId: event.subject.externalId, email: plan.email || null, eventId: event.eventId, eventType: event.type, correlationId: event.correlationId, origin, state: "RUNNING", plan, actor: actorLabel, createdAt: nowIso(), attempts: 1, mode: "live" };
      run._id = (await identityRuns.insertOne(run)).insertedId;
      await identityEvents.updateOne({ providerId: provider._id, eventId: event.eventId }, { $set: { runId: String(run._id) } });
      await audit({ orgId, runId: run._id, action: "IDENTITY_LIFECYCLE_STARTED", actorEmail: actorLabel, newState: "RUNNING", metadata: { type: klass, eventId: event.eventId, provider: provider.kind, externalId: event.subject.externalId } });
      link({ orgId, runId: run._id, type: "SOURCED_FROM", targetType: "IDENTITY_EVENT", targetId: run._id, note: `${event.type} from ${provider.kind} tenant ${provider.providerTenantId} (event ${event.eventId})` });
      for (const m of plan.matchedMappings || []) if (m !== "default") link({ orgId, runId: run._id, type: "CHECKED_BY", targetType: "IDENTITY_POLICY", targetId: m, note: "mapping policy matched" });

      let state = "COMPLETED"; let failure = null; let out = null;
      try { out = await executePlan({ provider, ev: event, resolution, plan, run, actor: actorLabel }); }
      catch (err) { failure = { class: classifyError(err), message: String(err.message).slice(0, 300), reasonCode: err.reasonCode || null }; state = "FAILED"; }
      if (out) {
        if (out.revocation && out.revocation.state !== "REVOCATION_COMPLETE") state = out.revocation.state === "REVOCATION_PARTIAL" ? "PARTIAL" : "FAILED";
        else if (out.verification.some((v) => !v.ok)) state = "PARTIAL";
        else if (out.awaitingReview) state = "AWAITING_REVIEW";
        else if (out.pendingApproval.length && !out.performed.length) state = "AWAITING_APPROVAL";
      }
      const nextRetryAt = state === "PARTIAL" && out?.revocation ? new Date(Date.now() + 2 * 60000).toISOString() : failure && RETRYABLE.has(failure.class) ? new Date(Date.now() + 2 * 60000).toISOString() : null;
      await identityRuns.updateOne({ _id: run._id }, { $set: { state, result: out ? { performed: out.performed, pendingApproval: out.pendingApproval, verification: out.verification, revocation: out.revocation || null } : null, failure, completedAt: state === "PARTIAL" || state === "FAILED" ? null : nowIso(), nextRetryAt } });
      await audit({ orgId, runId: run._id, action: state === "COMPLETED" ? "IDENTITY_LIFECYCLE_COMPLETED" : "IDENTITY_LIFECYCLE_" + state, actorEmail: actorLabel, previousState: "RUNNING", newState: state, metadata: { type: klass, email: plan.email, verification: (out?.verification || []).length, failure: failure?.class || null } });
      for (const p of out?.performed || []) if (p.op === "REVOKE_ACCESS" || p.op === "RESTRICT_ACCESS") link({ orgId, runId: run._id, type: "EXECUTED_AS", targetType: "IDENTITY_REVOCATION", targetId: out.revocation?.revocationId || run._id, note: `${p.op}: ${p.state}` }); else if (["GRANT", "REVOKE_GRANT", "CREATE_MEMBERSHIP", "LINK_MEMBERSHIP"].includes(p.op)) link({ orgId, runId: run._id, type: "EXECUTED_AS", targetType: "IDENTITY_PERMISSION_CHANGE", targetId: run._id, note: `${p.op} ${p.kind || ""} ${p.value || ""}`.trim() });
      for (const p of out?.pendingApproval || []) link({ orgId, runId: run._id, type: "REQUIRES", targetType: "AI_ACTION_REQUEST", targetId: p.requestId, note: `approval required for ${p.kind}:${p.value}` });
      link({ orgId, runId: run._id, type: "PROVEN_BY", targetType: "IDENTITY_VERIFICATION", targetId: run._id, note: state === "COMPLETED" ? "verification passed" : `verification: ${state}` });
      if (provider.policy.notify || state !== "COMPLETED") {
        const who = plan.email || event.subject.upn || event.subject.externalId;
        await notifyManagers({ orgId, runId: run._id, severity: state === "COMPLETED" ? "info" : "critical", title: `${klass} ${state.toLowerCase().replace("_", " ")}: ${who}`, body: failure ? `${failure.class}: ${failure.message}` : `Source: ${provider.kind}. Event ${event.eventId}.`, dedupeKey: `identity:run:${run._id}:${state}` });
      }
      await (await getIdentityCollections()).identityProviders.updateOne({ _id: provider._id }, { $set: { lastEventAt: nowIso(), lastError: failure ? failure.message : null } });
      return finish(failure ? "FAILED" : "PROCESSED", { runId: run._id, state, run: { runId: String(run._id), type: klass, state }, failure });
    });
  } catch (err) {
    if (err?.busy) { if (!dryRun) await identityEvents.updateOne({ providerId: provider._id, eventId: event.eventId }, { $set: { status: "PENDING", lastError: "busy", parkedAt: nowIso() } }); return { status: "PENDING", reason: "Another change for this identity is still being applied; it will be retried." }; }
    const klass = classifyError(err);
    await audit({ orgId, action: "IDENTITY_EVENT_FAILED", actorEmail: actorLabel, metadata: { eventId: event.eventId, class: klass, message: String(err.message).slice(0, 200) } });
    await emitIdentityEvent({ orgId, type: "sync.failed", tenant: provider.providerTenantId, subject: { externalId: event.subject.externalId }, correlationId: event.correlationId, data: { eventId: event.eventId, class: klass, retryable: RETRYABLE.has(klass) } });
    if (!dryRun) await identityEvents.updateOne({ providerId: provider._id, eventId: event.eventId }, { $set: { status: RETRYABLE.has(klass) ? "PENDING" : "FAILED", lastError: String(err.message).slice(0, 200), failureClass: klass } });
    return { status: "FAILED", failure: { class: klass, message: String(err.message).slice(0, 300) } };
  }
  void identityExternalUsers;
  return result;
}
