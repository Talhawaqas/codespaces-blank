// src/lib/support/queues.js
//
// SOW §8, §9.1, §50: queues, teams, agents, SLA policies, routing and assignment.
//
//   routeTicket()   picks the queue: active queues in `order`, the first whose rules match; otherwise the
//                   configured fallback queue, otherwise the default "General" queue (created on first use).
//   pickAssignee()  applies the queue's strategy: manual, round_robin (an atomic counter, so two tickets
//                   arriving together never get the same slot by accident), least_loaded, account_owner, skills.
//
// Agents and eligibility are validated against the organization's real membership, so a queue can never
// route work to someone who is not an active member with support access.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, normEmail, isEmail, PRIORITIES, OPEN_STATUSES, tokens } from "./common.js";
import { defaultPolicies, DEFAULT_ESCALATIONS } from "./sla.js";
import { supportPerms, SUPPORT_PERMISSIONS } from "./access.js";
import { getProfile } from "./customers.js";

const STRATEGIES = ["manual", "round_robin", "least_loaded", "account_owner", "skills"];

// ----------------------------------------------------------------------- defaults
export async function ensureDefaults(orgId) {
  await ensureSupportIndexes();
  const { supportQueues, supportSlaPolicies } = await getSupportCollections();
  const oid = toObjectId(orgId);
  if (!(await supportQueues.countDocuments({ orgId: oid }))) {
    try { await supportQueues.insertOne({ orgId: oid, name: "General", description: "Catch-all queue", teamId: null, eligibleAgents: [], order: 1000, active: true, match: {}, strategy: "manual", defaultSlaPolicyId: null, rrIndex: 0, isDefault: true, createdAt: nowIso(), updatedAt: nowIso() }); } catch { /* a concurrent request created it */ }
  }
  if (!(await supportSlaPolicies.countDocuments({ orgId: oid }))) {
    const now = nowIso();
    try { await supportSlaPolicies.insertMany(defaultPolicies().map((p) => ({ ...p, orgId: oid, createdAt: now, updatedAt: now }))); } catch { /* concurrent */ }
  }
}

const idOr = (v) => { try { return v ? toObjectId(v) : null; } catch { return null; } };

// ---------------------------------------------------------------------- queues
const view = (q) => ({ queueId: String(q._id), name: q.name, description: q.description || "", teamId: q.teamId ? String(q.teamId) : null, eligibleAgents: q.eligibleAgents || [], order: q.order, active: q.active !== false, match: q.match || {}, strategy: q.strategy, defaultSlaPolicyId: q.defaultSlaPolicyId ? String(q.defaultSlaPolicyId) : null, escalationQueueId: q.escalationQueueId ? String(q.escalationQueueId) : null, businessHours: q.businessHours || null, isDefault: !!q.isDefault });

export async function listQueues({ orgId, includeInactive = true }) {
  await ensureDefaults(orgId);
  const { supportQueues } = await getSupportCollections();
  const rows = await supportQueues.find({ orgId: toObjectId(orgId), ...(includeInactive ? {} : { active: { $ne: false } }) }).sort({ order: 1, name: 1 }).toArray();
  return { queues: rows.map(view) };
}

async function validAgents(orgId, emails) {
  const { orgMembers } = await getOrgCollections();
  const list = [...new Set((emails || []).map(normEmail))];
  if (list.length > 100 || list.some((e) => !isEmail(e))) return { error: "eligibleAgents must be up to 100 valid email addresses." };
  const members = await orgMembers.find({ orgId: toObjectId(orgId), email: { $in: list }, status: "active" }).toArray();
  const ok = new Set(members.filter((m) => supportPerms(m).has("view_tickets")).map((m) => m.email));
  const bad = list.filter((e) => !ok.has(e));
  return bad.length ? { error: `Not active members with support access: ${bad.join(", ")}.` } : { agents: list };
}

export async function upsertQueue({ orgId, queueId = null, body }) {
  await ensureDefaults(orgId);
  const { supportQueues } = await getSupportCollections();
  const oid = toObjectId(orgId);
  const b = body || {};
  if (!queueId && (!b.name || String(b.name).length > 60)) return fail("A queue name (up to 60 characters) is required.");
  const set = { updatedAt: nowIso() };
  if (b.name !== undefined) set.name = String(b.name).slice(0, 60);
  if (b.description !== undefined) set.description = String(b.description).slice(0, 300);
  if (b.order !== undefined) { if (!Number.isFinite(b.order)) return fail("order must be a number."); set.order = b.order; }
  if (b.active !== undefined) set.active = !!b.active;
  if (b.strategy !== undefined) { if (!STRATEGIES.includes(b.strategy)) return fail(`strategy must be one of ${STRATEGIES.join(", ")}.`); set.strategy = b.strategy; }
  if (b.teamId !== undefined) set.teamId = idOr(b.teamId);
  if (b.defaultSlaPolicyId !== undefined) set.defaultSlaPolicyId = idOr(b.defaultSlaPolicyId);
  if (b.escalationQueueId !== undefined) set.escalationQueueId = idOr(b.escalationQueueId);
  if (b.businessHours !== undefined) set.businessHours = b.businessHours;
  if (b.match !== undefined) {
    const m = b.match || {}; const clean = {};
    for (const k of ["types", "categories", "priorities", "channels", "tiers", "keywords"]) if (m[k] !== undefined) {
      if (!Array.isArray(m[k]) || m[k].length > 50 || m[k].some((x) => typeof x !== "string" || x.length > 60)) return fail(`match.${k} must be a list of short values.`);
      if (k === "priorities" && m[k].some((x) => !PRIORITIES.includes(x))) return fail("match.priorities must be LOW, NORMAL, HIGH or URGENT.");
      clean[k] = m[k];
    }
    set.match = clean;
  }
  if (b.eligibleAgents !== undefined) { const v = await validAgents(orgId, b.eligibleAgents); if (v.error) return fail(v.error); set.eligibleAgents = v.agents; }
  if (queueId) {
    const r = await supportQueues.findOneAndUpdate({ _id: toObjectId(queueId), orgId: oid }, { $set: set }, { returnDocument: "after" });
    return r ? { queue: view(r) } : fail("Queue not found.", 404);
  }
  const doc = { orgId: oid, name: set.name, description: set.description || "", teamId: set.teamId || null, eligibleAgents: set.eligibleAgents || [], order: set.order ?? 100, active: set.active ?? true, match: set.match || {}, strategy: set.strategy || "manual", defaultSlaPolicyId: set.defaultSlaPolicyId || null, escalationQueueId: set.escalationQueueId || null, businessHours: set.businessHours || null, rrIndex: 0, createdAt: nowIso(), updatedAt: nowIso() };
  const r = await supportQueues.insertOne(doc);
  return { queue: view({ ...doc, _id: r.insertedId }) };
}

// ----------------------------------------------------------------------- teams
export async function listTeams({ orgId }) {
  const { supportTeams } = await getSupportCollections();
  return { teams: (await supportTeams.find({ orgId: toObjectId(orgId) }).sort({ name: 1 }).toArray()).map((t) => ({ teamId: String(t._id), name: t.name, description: t.description || "", memberEmails: t.memberEmails || [], leadEmail: t.leadEmail || null })) };
}
export async function upsertTeam({ orgId, teamId = null, body }) {
  await ensureSupportIndexes();
  const { supportTeams } = await getSupportCollections();
  const b = body || {};
  if (!teamId && (!b.name || String(b.name).length > 60)) return fail("A team name (up to 60 characters) is required.");
  const set = { updatedAt: nowIso() };
  if (b.name !== undefined) set.name = String(b.name).slice(0, 60);
  if (b.description !== undefined) set.description = String(b.description).slice(0, 300);
  if (b.memberEmails !== undefined) { const v = await validAgents(orgId, b.memberEmails); if (v.error) return fail(v.error); set.memberEmails = v.agents; }
  if (b.leadEmail !== undefined) { if (b.leadEmail) { const v = await validAgents(orgId, [b.leadEmail]); if (v.error) return fail(v.error); set.leadEmail = v.agents[0]; } else set.leadEmail = null; }
  try {
    if (teamId) { const r = await supportTeams.findOneAndUpdate({ _id: toObjectId(teamId), orgId: toObjectId(orgId) }, { $set: set }, { returnDocument: "after" }); return r ? { team: { teamId: String(r._id), name: r.name, memberEmails: r.memberEmails || [], leadEmail: r.leadEmail || null } } : fail("Team not found.", 404); }
    const doc = { orgId: toObjectId(orgId), name: set.name, description: set.description || "", memberEmails: set.memberEmails || [], leadEmail: set.leadEmail || null, createdAt: nowIso(), updatedAt: nowIso() };
    const r = await supportTeams.insertOne(doc);
    return { team: { teamId: String(r.insertedId), name: doc.name, memberEmails: doc.memberEmails, leadEmail: doc.leadEmail } };
  } catch (err) { if (err?.code === 11000) return fail("A team with that name already exists.", 409); throw err; }
}

// ---------------------------------------------------------------------- agents
export async function listAgents({ orgId }) {
  const { orgMembers } = await getOrgCollections();
  const { supportAgents } = await getSupportCollections();
  const members = (await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).toArray()).filter((m) => supportPerms(m).has("view_tickets"));
  const profiles = new Map((await supportAgents.find({ orgId: toObjectId(orgId) }).toArray()).map((p) => [p.email, p]));
  return { agents: members.map((m) => ({ email: m.email, role: m.role, supportRole: m.supportRole || (canManageOrg(m) ? "manager (org owner/admin)" : null), permissions: [...supportPerms(m)], skills: profiles.get(m.email)?.skills || [], available: profiles.get(m.email)?.available !== false, maxOpen: profiles.get(m.email)?.maxOpen ?? null })) };
}

/** Grants or removes a member's support role and permission adjustments (manage_agents). */
export async function setMemberSupport({ orgId, email, supportRole, supportPermissions }) {
  const { orgMembers } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: toObjectId(orgId), email: normEmail(email), status: "active" });
  if (!m) return fail("That person is not an active member of this organization.", 404);
  const set = {}; const unset = {};
  if (supportRole !== undefined) { if (supportRole === null) unset.supportRole = ""; else if (["agent", "manager"].includes(supportRole)) set.supportRole = supportRole; else return fail("supportRole must be agent, manager or null."); }
  if (supportPermissions !== undefined) {
    if (!Array.isArray(supportPermissions) || supportPermissions.some((p) => typeof p !== "string" || !SUPPORT_PERMISSIONS.includes(p.replace(/^-/, "")))) return fail(`supportPermissions entries must be permission names (optionally prefixed with "-"): ${SUPPORT_PERMISSIONS.join(", ")}.`);
    set.supportPermissions = supportPermissions;
  }
  await orgMembers.updateOne({ _id: m._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  return { updated: true };
}

export async function setAgentProfile({ orgId, email, skills, available, maxOpen }) {
  await ensureSupportIndexes();
  const { supportAgents } = await getSupportCollections();
  const set = { updatedAt: nowIso() };
  if (skills !== undefined) { if (!Array.isArray(skills) || skills.length > 30 || skills.some((s) => typeof s !== "string" || s.length > 40)) return fail("skills must be a list of up to 30 short names."); set.skills = skills; }
  if (available !== undefined) set.available = !!available;
  if (maxOpen !== undefined) { if (maxOpen !== null && !(Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= 1000)) return fail("maxOpen must be 1–1000."); set.maxOpen = maxOpen; }
  await supportAgents.updateOne({ orgId: toObjectId(orgId), email: normEmail(email) }, { $set: set, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  return { updated: true };
}

// ------------------------------------------------------------------ SLA policies
const pview = (p) => ({ policyId: String(p._id), name: p.name, active: p.active !== false, isDefault: !!p.isDefault, match: p.match || {}, firstResponseMin: p.firstResponseMin, resolutionMin: p.resolutionMin, pauseStatuses: p.pauseStatuses || null, escalations: p.escalations || [], breachAction: p.breachAction || "escalate", escalationQueueId: p.escalationQueueId ? String(p.escalationQueueId) : null, businessHours: p.businessHours || null });
export async function listPolicies({ orgId }) {
  await ensureDefaults(orgId);
  const { supportSlaPolicies } = await getSupportCollections();
  return { policies: (await supportSlaPolicies.find({ orgId: toObjectId(orgId) }).sort({ createdAt: 1 }).toArray()).map(pview) };
}
export async function upsertPolicy({ orgId, policyId = null, body }) {
  await ensureDefaults(orgId);
  const { supportSlaPolicies } = await getSupportCollections();
  const b = body || {}; const set = { updatedAt: nowIso() };
  if (!policyId && !b.name) return fail("A policy name is required.");
  if (b.name !== undefined) set.name = String(b.name).slice(0, 60);
  for (const k of ["firstResponseMin", "resolutionMin"]) if (b[k] !== undefined) { if (!Number.isFinite(b[k]) || b[k] < 1 || b[k] > 525600) return fail(`${k} must be 1–525600 minutes.`); set[k] = b[k]; }
  if (b.active !== undefined) set.active = !!b.active;
  if (b.breachAction !== undefined) { if (!["escalate", "notify"].includes(b.breachAction)) return fail("breachAction must be escalate or notify."); set.breachAction = b.breachAction; }
  if (b.escalationQueueId !== undefined) set.escalationQueueId = idOr(b.escalationQueueId);
  if (b.businessHours !== undefined) set.businessHours = b.businessHours;
  if (b.pauseStatuses !== undefined) { if (!Array.isArray(b.pauseStatuses)) return fail("pauseStatuses must be a list."); set.pauseStatuses = b.pauseStatuses; }
  if (b.match !== undefined) {
    const m = b.match || {}; const clean = {};
    for (const k of ["types", "priorities", "tiers", "queueIds"]) if (m[k] !== undefined) { if (!Array.isArray(m[k]) || m[k].length > 50) return fail(`match.${k} must be a list.`); clean[k] = m[k]; }
    set.match = clean;
  }
  if (b.escalations !== undefined) {
    if (!Array.isArray(b.escalations) || b.escalations.length > 20) return fail("escalations must be a list of up to 20 rules.");
    for (const r of b.escalations) if (!(r.pct >= 1 && r.pct <= 200) || !["first_response", "resolution"].includes(r.target) || !["notify", "escalate"].includes(r.action || "notify")) return fail("Each escalation needs pct (1–200), target (first_response|resolution) and action (notify|escalate).");
    set.escalations = b.escalations.map((r) => ({ pct: r.pct, target: r.target, action: r.action || "notify", notify: Array.isArray(r.notify) ? r.notify.filter((x) => ["assignee", "team_lead", "managers"].includes(x)) : ["assignee"] }));
  }
  if (policyId) { const r = await supportSlaPolicies.findOneAndUpdate({ _id: toObjectId(policyId), orgId: toObjectId(orgId) }, { $set: set }, { returnDocument: "after" }); return r ? { policy: pview(r) } : fail("Policy not found.", 404); }
  const doc = { orgId: toObjectId(orgId), name: set.name, active: set.active ?? true, isDefault: false, match: set.match || {}, firstResponseMin: set.firstResponseMin || 240, resolutionMin: set.resolutionMin || 1440, escalations: set.escalations || DEFAULT_ESCALATIONS, breachAction: set.breachAction || "escalate", escalationQueueId: set.escalationQueueId || null, businessHours: set.businessHours || null, ...(set.pauseStatuses ? { pauseStatuses: set.pauseStatuses } : {}), createdAt: nowIso(), updatedAt: nowIso() };
  const r = await supportSlaPolicies.insertOne(doc);
  return { policy: pview({ ...doc, _id: r.insertedId }) };
}

// ------------------------------------------------------------------------ routing
function matches(match, t) {
  const m = match || {};
  const has = (list, v) => !Array.isArray(list) || !list.length || list.includes(v);
  if (!has(m.types, t.type) || !has(m.categories, t.category) || !has(m.priorities, t.priority) || !has(m.channels, t.channel) || !has(m.tiers, t.tier)) return false;
  if (Array.isArray(m.keywords) && m.keywords.length) { const words = tokens(`${t.subject || ""} ${t.text || ""}`); if (!m.keywords.some((k) => words.has(String(k).toLowerCase()))) return false; }
  return true;
}

/** The queue this ticket belongs in. Always returns a queue (the default queue is the final fallback). */
export async function routeTicket({ orgId, settings, ticket }) {
  await ensureDefaults(orgId);
  const { supportQueues } = await getSupportCollections();
  const queues = await supportQueues.find({ orgId: toObjectId(orgId), active: { $ne: false } }).sort({ order: 1, name: 1 }).toArray();
  const hit = queues.find((q) => !q.isDefault && matches(q.match, ticket)) || null;
  if (hit) return { queue: hit, reason: "rule" };
  const fb = settings?.fallbackQueueId ? queues.find((q) => String(q._id) === String(settings.fallbackQueueId)) : null;
  if (fb) return { queue: fb, reason: "fallback" };
  return { queue: queues.find((q) => q.isDefault) || queues[0], reason: "default" };
}

async function loadOf(orgId, emails) {
  const { supportTickets } = await getSupportCollections();
  const rows = await supportTickets.aggregate([{ $match: { orgId: toObjectId(orgId), assigneeEmail: { $in: emails }, status: { $in: OPEN_STATUSES } } }, { $group: { _id: "$assigneeEmail", n: { $sum: 1 } } }]).toArray();
  const m = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  return (e) => m[e] || 0;
}

/** Applies the queue's assignment strategy. Returns { assigneeEmail|null, strategy, reason }. */
export async function pickAssignee({ orgId, queue, ticket }) {
  const strategy = queue?.strategy || "manual";
  if (strategy === "manual" || !queue?.eligibleAgents?.length) return { assigneeEmail: null, strategy, reason: "manual" };
  const { orgMembers } = await getOrgCollections();
  const { supportAgents, supportQueues, supportTeams } = await getSupportCollections();
  const active = new Set((await orgMembers.find({ orgId: toObjectId(orgId), email: { $in: queue.eligibleAgents }, status: "active" }).project({ email: 1 }).toArray()).map((m) => m.email));
  const profiles = new Map((await supportAgents.find({ orgId: toObjectId(orgId), email: { $in: queue.eligibleAgents } }).toArray()).map((p) => [p.email, p]));
  let agents = queue.eligibleAgents.filter((e) => active.has(e) && profiles.get(e)?.available !== false);
  if (!agents.length) return { assigneeEmail: null, strategy, reason: "no_available_agent" };
  const load = await loadOf(orgId, agents);
  agents = agents.filter((e) => !profiles.get(e)?.maxOpen || load(e) < profiles.get(e).maxOpen);
  if (!agents.length) return { assigneeEmail: null, strategy, reason: "all_at_capacity" };
  if (strategy === "account_owner") {
    const owner = ticket.requester?.email ? (await getProfile(orgId, ticket.requester.email))?.accountOwnerEmail : null;
    if (owner && agents.includes(owner)) return { assigneeEmail: owner, strategy, reason: "account_owner" };
  }
  if (strategy === "skills" || strategy === "account_owner") {
    const want = [ticket.category, ticket.type].filter(Boolean).map((s) => String(s).toLowerCase());
    const skilled = agents.filter((e) => (profiles.get(e)?.skills || []).some((s) => want.includes(String(s).toLowerCase())));
    if (skilled.length) agents = skilled;
  }
  if (strategy === "round_robin") {
    const q = await supportQueues.findOneAndUpdate({ _id: queue._id }, { $inc: { rrIndex: 1 } }, { returnDocument: "after" });
    return { assigneeEmail: agents[(q.rrIndex - 1) % agents.length], strategy, reason: "round_robin" };
  }
  const best = agents.map((e) => [e, load(e)]).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
  return { assigneeEmail: best, strategy, reason: strategy === "least_loaded" ? "least_loaded" : "balanced" };
}

/** Where an escalation goes: the policy/queue escalation queue, else the team lead of the ticket's team. */
export async function escalationTarget({ orgId, ticket, policy, queue }) {
  const { supportQueues, supportTeams } = await getSupportCollections();
  const qid = policy?.escalationQueueId || queue?.escalationQueueId || null;
  const q = qid ? await supportQueues.findOne({ _id: qid, orgId: toObjectId(orgId), active: { $ne: false } }) : null;
  const teamId = ticket.teamId || queue?.teamId || null;
  const team = teamId ? await supportTeams.findOne({ _id: teamId, orgId: toObjectId(orgId) }) : null;
  return { queue: q, leadEmail: team?.leadEmail || null };
}
