// src/lib/ops/scheduler.js -- Manage Orders SOW section 8: technician profiles, eligibility, assignment, scheduling,
// the dispatch board and the technician assignment chart.
//
// Reuse: technicians are org members (opsRole technician/manager); shifts, availability and attendance come from
// workforce/time.js (`w_shift`, `w_avail`, `w_punch`); approved leave from HR `leave_requests`; branches from
// workforce/scope.js. Only skills, certifications and eligible categories are new (kind ops_tech).
// Hard rules: the technician must be an active member allowed in the job's branch. Soft rules (skills, expired
// certifications, leave, shift, overlapping bookings) block unless an authorised person gives an override reason, which
// is stored on the assignment and audited. A per-technician lock stops two dispatchers double-booking at the same time.
import { getOrgCollections } from "../orgs.js";
import { K as WK } from "../workforce/time.js";
import { canManageFinance } from "../orgGates.js";
import { ccol, oid, sid, clean, fail, nowIso, K, opsAccess, can, opsRoleOf, memberLocations, allowedLocation, denyLocation, scopeFilter, audit, notifyMember, isDate, iso } from "./core.js";
import { loadJob, viewFor, ensureOpsIndexes, TERMINAL } from "./jobs.js";

const ASSIGNABLE = { WO: ["READY", "SCHEDULED", "ASSIGNED", "IN_PROGRESS", "ON_HOLD", "AWAITING_PARTS"], RO: ["APPROVED", "READY", "SCHEDULED", "IN_REPAIR", "AWAITING_PARTS"] };
const BUSY = ["ASSIGNED", "SCHEDULED", "IN_PROGRESS", "IN_REPAIR", "AWAITING_PARTS", "ON_HOLD", "READY", "APPROVED"];
const overlaps = (a1, a2, b1, b2) => a1 && a2 && b1 && b2 && new Date(a1) < new Date(b2) && new Date(b1) < new Date(a2);

// ------------------------------------------------------------------ technician profiles
const techView = (t, m) => ({ email: t?.email || m?.email, name: m?.name || m?.displayName || null, opsRole: m ? opsRoleOf(m) : null, skills: t?.skills || [], certifications: t?.certifications || [], categories: t?.categories || [], active: t ? t.active !== false : true, maxConcurrent: t?.maxConcurrent || 1, costRate: t?.costRate ?? null, branches: m ? memberLocations(m) : null });
export async function listTechnicians({ orgId, membership }) {
  const d = await opsAccess({ orgId, membership, need: "view_all" }); if (d) return d;
  const { orgMembers } = await getOrgCollections(); const c = await ccol();
  const members = await orgMembers.find({ orgId: oid(orgId), status: "active", $or: [{ opsRole: { $in: ["technician", "manager"] } }, { role: { $in: ["owner", "admin"] } }] }).toArray();
  const profiles = new Map((await c.find({ orgId: oid(orgId), kind: K.tech }).toArray()).map((t) => [t.email, t]));
  const showCost = canManageFinance(membership);
  return { technicians: members.map((m) => { const v = techView(profiles.get(m.email), m); if (!showCost) delete v.costRate; return v; }) };
}
export async function saveTechnician({ orgId, membership, actorEmail, email, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "settings" }); if (d) return d; await ensureOpsIndexes();
  const e = clean(email, 200).toLowerCase(); const { orgMembers } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: oid(orgId), email: e, status: "active" }); if (!m) return fail("That person is not an active member of this company.", 404);
  const set = { updatedAt: nowIso(), updatedBy: actorEmail };
  if (input.skills !== undefined) set.skills = (Array.isArray(input.skills) ? input.skills : String(input.skills).split(",")).map((s) => clean(s, 40).toLowerCase()).filter(Boolean).slice(0, 30);
  if (input.categories !== undefined) set.categories = (Array.isArray(input.categories) ? input.categories : String(input.categories).split(",")).map((s) => clean(s, 60)).filter(Boolean).slice(0, 30);
  if (input.certifications !== undefined) { if (!Array.isArray(input.certifications) || input.certifications.length > 20) return fail("Up to 20 certifications."); set.certifications = input.certifications.map((x) => ({ name: clean(x.name, 80), expires: iso(x.expires) })).filter((x) => x.name); }
  if (input.active !== undefined) set.active = !!input.active;
  if (input.maxConcurrent !== undefined) { const n = Number(input.maxConcurrent); if (!(Number.isInteger(n) && n >= 1 && n <= 5)) return fail("maxConcurrent must be 1–5."); set.maxConcurrent = n; }
  if (input.costRate !== undefined) { if (!canManageFinance(membership)) return fail("Only a finance manager can set labour cost rates.", 403); const n = input.costRate === null || input.costRate === "" ? null : Number(input.costRate); if (n !== null && !(n >= 0 && n < 1e7)) return fail("Cost rate must be a number."); set.costRate = n; }
  const c = await ccol();
  await c.updateOne({ orgId: oid(orgId), kind: K.tech, email: e }, { $set: set, $setOnInsert: { orgId: oid(orgId), kind: K.tech, opsDoc: true, opsKey: `tech:${e}`, email: e, createdAt: nowIso() } }, { upsert: true });
  await audit({ orgId, actorEmail, recordType: "TECHNICIAN", recordId: orgId, action: "OPS_TECHNICIAN_UPDATED", metadata: { email: e, fields: Object.keys(set).filter((k) => !["updatedAt", "updatedBy"].includes(k)) } });
  return { technician: techView({ ...(await c.findOne({ orgId: oid(orgId), kind: K.tech, email: e })) }, m) };
}
/** Owner/admin sets someone's Manage Orders role (opsRole on the member record, like commerceRole / supportRole). */
export async function setOpsRole({ orgId, membership, actorEmail, email, opsRole }) {
  const d = await opsAccess({ orgId, membership, need: "settings" }); if (d) return d;
  if (!["owner", "admin"].includes(membership.role)) return fail("Only an owner or admin can change roles.", 403);
  if (opsRole !== null && !["manager", "dispatcher", "advisor", "technician", "storekeeper"].includes(opsRole)) return fail("Unknown role.");
  const { orgMembers } = await getOrgCollections(); const e = clean(email, 200).toLowerCase();
  const m = await orgMembers.findOne({ orgId: oid(orgId), email: e, status: "active" }); if (!m) return fail("Member not found.", 404);
  await orgMembers.updateOne({ _id: m._id }, opsRole ? { $set: { opsRole } } : { $unset: { opsRole: "" } });
  await audit({ orgId, actorEmail, recordType: "ORG_MEMBER", recordId: orgId, action: "OPS_ROLE_CHANGED", previousState: m.opsRole || null, newState: opsRole, metadata: { email: e } });
  return { ok: true, email: e, opsRole };
}

// ------------------------------------------------------------------ eligibility
async function leaveOverlap(orgId, email, start, end) {
  if (!start || !end) return null;
  const { employees, leaveRequests } = await getOrgCollections();
  const emp = await employees.findOne({ orgId: oid(orgId), memberEmail: email, deletedAt: null }, { projection: { _id: 1 } }); if (!emp) return null;
  const day = (v) => String(v).slice(0, 10);
  return leaveRequests.findOne({ orgId: oid(orgId), employeeId: emp._id, status: "APPROVED", startDate: { $lte: day(end) }, endDate: { $gte: day(start) } }, { projection: { startDate: 1, endDate: 1 } });
}
/** Problems with putting `email` on `job` in [start, end]. hard = never overridable. */
export async function eligibility({ orgId, job, email, start, end, member, profile }) {
  const problems = [];
  if (!member || member.status !== "active") return [{ code: "NOT_MEMBER", hard: true, message: "Not an active member of this company." }];
  const role = opsRoleOf(member); if (!["technician", "manager"].includes(role)) problems.push({ code: "NOT_TECHNICIAN", hard: true, message: "This person doesn't have the technician role." });
  if (profile && profile.active === false) problems.push({ code: "INACTIVE", hard: true, message: "This technician is marked inactive." });
  const br = memberLocations(member); if (br && !br.includes(sid(job.warehouseId))) problems.push({ code: "BRANCH", hard: true, message: "This technician isn't assigned to the job's branch." });
  const missing = (job.skills || []).filter((s) => !(profile?.skills || []).includes(s)); if (missing.length) problems.push({ code: "SKILLS", message: `Missing skills: ${missing.join(", ")}.` });
  if (profile?.categories?.length && job.category && !profile.categories.includes(job.category)) problems.push({ code: "CATEGORY", message: `Not listed for "${job.category}" jobs.` });
  const expired = (profile?.certifications || []).filter((x) => x.expires && new Date(x.expires) < new Date()); if (expired.length) problems.push({ code: "CERT_EXPIRED", message: `Expired certification: ${expired.map((x) => x.name).join(", ")}.` });
  const lv = await leaveOverlap(orgId, email, start, end); if (lv) problems.push({ code: "LEAVE", message: `On approved leave ${lv.startDate} to ${lv.endDate}.` });
  if (start && end) {
    const c = await ccol();
    const shifts = await c.find({ orgId: oid(orgId), kind: WK.shift, email, status: { $in: ["PUBLISHED", "ACKNOWLEDGED"] }, start: { $lt: iso(end) }, end: { $gt: iso(start) } }).limit(5).toArray();
    const anyShiftThatDay = await c.countDocuments({ orgId: oid(orgId), kind: WK.shift, email, status: { $in: ["PUBLISHED", "ACKNOWLEDGED"] }, start: { $gte: `${iso(start).slice(0, 10)}T00:00:00.000Z`, $lt: `${iso(start).slice(0, 10)}T23:59:59.999Z` } });
    if (anyShiftThatDay && !shifts.some((s) => new Date(s.start) <= new Date(start) && new Date(s.end) >= new Date(end))) problems.push({ code: "OUTSIDE_SHIFT", message: "The slot is outside this technician's published shift." });
    const others = await c.find({ orgId: oid(orgId), kind: K.job, _id: { $ne: job._id }, assigneeEmails: email, status: { $in: BUSY } }, { projection: { number: 1, assignments: 1 } }).toArray();
    const clash = others.filter((o) => (o.assignments || []).some((a) => a.active && a.email === email && overlaps(a.start, a.end, start, end)));
    const max = profile?.maxConcurrent || 1;
    if (clash.length >= max) problems.push({ code: "OVERLAP", message: `Already booked then on ${clash.map((x) => x.number).join(", ")}.` });
  }
  return problems;
}
async function withTechLock(orgId, email, fn) {
  const c = await ccol(); const key = `lock:tech:${email}`; const until = new Date(Date.now() + 15000).toISOString(); const now = nowIso();
  let got = null;
  try { got = await c.findOneAndUpdate({ orgId: oid(orgId), opsKey: key, $or: [{ lockedUntil: { $lt: now } }, { lockedUntil: null }] }, { $set: { lockedUntil: until } }, { returnDocument: "after" }); }
  catch (e) { if (e?.code !== 11000) throw e; }
  if (!got) {
    try { await c.insertOne({ orgId: oid(orgId), kind: "ops_lock", opsDoc: true, opsKey: key, lockedUntil: until }); got = true; }
    catch (e) { if (e?.code === 11000) return fail("Someone else is changing this technician's schedule right now. Try again in a moment.", 409, "BUSY"); throw e; }
  }
  try { return await fn(); } finally { await c.updateOne({ orgId: oid(orgId), opsKey: key }, { $set: { lockedUntil: null } }); }
}

// ------------------------------------------------------------------ assign / unassign / schedule
export async function assignTechnician({ orgId, membership, actorEmail, jobId, email, lead = true, start, end, override }) {
  const d = await opsAccess({ orgId, membership, need: "schedule" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  if (!ASSIGNABLE[j.type].includes(j.status)) return fail(j.type === "RO" && ["DRAFT", "RECEIVED", "INSPECTION", "DIAGNOSIS", "ESTIMATE_PREPARED", "AWAITING_APPROVAL"].includes(j.status) ? "A repair can be scheduled only after the customer approves the estimate." : `This order is ${j.status.toLowerCase()} and can't be assigned.`, 409);
  if (j.type === "RO" && j.pendingChangeOrder) return fail("A change order is waiting for the customer's approval.", 409);
  const e = clean(email, 200).toLowerCase(); if (!e) return fail("Choose a technician.");
  if (e === actorEmail && opsRoleOf(membership) !== "manager") return fail("You can't assign a job to yourself.", 403, "SELF_ASSIGN");
  if (!isDate(start) || !isDate(end)) return fail("Start and end must be dates.");
  const s = iso(start || j.plannedStart); const en = iso(end || j.plannedEnd || (s && j.estMinutes ? new Date(new Date(s).getTime() + j.estMinutes * 60000) : null));
  if (s && en && new Date(en) <= new Date(s)) return fail("The end must be after the start.");
  const { orgMembers } = await getOrgCollections(); const c = await ccol();
  const member = await orgMembers.findOne({ orgId: oid(orgId), email: e }); const profile = await c.findOne({ orgId: oid(orgId), kind: K.tech, email: e });
  return withTechLock(orgId, e, async () => {
    const problems = await eligibility({ orgId, job: j, email: e, start: s, end: en, member, profile });
    const hard = problems.filter((p) => p.hard); if (hard.length) return fail(hard.map((p) => p.message).join(" "), 409, "INELIGIBLE");
    const why = clean(override, 500);
    if (problems.length && (why.length < 3 || !can(membership, "approve") && !can(membership, "schedule"))) return { error: problems.map((p) => p.message).join(" "), status: 409, code: "NEEDS_OVERRIDE", problems };
    const now = nowIso(); const wasLead = (j.assignments || []).find((a) => a.active && a.lead);
    const set = { updatedAt: now, lastActivityAt: now };
    const nextStatus = j.type === "WO" ? (["READY", "SCHEDULED"].includes(j.status) ? "ASSIGNED" : j.status) : (["APPROVED", "READY"].includes(j.status) ? "SCHEDULED" : j.status);
    set.status = nextStatus; if (lead || !wasLead) { set.plannedStart = s; set.plannedEnd = en; }
    const assignment = { email: e, lead: !!(lead || !wasLead), start: s, end: en, active: true, by: actorEmail, at: now, override: problems.length ? { reason: why, problems: problems.map((p) => p.code) } : null };
    const main = await c.updateOne({ _id: j._id, status: j.status }, { $set: set, $push: { assignments: assignment, history: { from: j.status, to: nextStatus, action: "assign", by: actorEmail, at: now, email: e, override: assignment.override } }, $addToSet: { assigneeEmails: e } });
    if (!main.matchedCount) return fail("The order changed at the same time. Reload and try again.", 409);
    // Earlier assignment of the same person ends (history kept); a new lead demotes the previous lead.
    await c.updateOne({ _id: j._id }, { $set: { "assignments.$[a].active": false, "assignments.$[a].endedAt": now, "assignments.$[a].endedBy": actorEmail } }, { arrayFilters: [{ "a.email": e, "a.active": true, "a.at": { $ne: now } }] });
    if (assignment.lead) await c.updateOne({ _id: j._id }, { $set: { "assignments.$[a].lead": false } }, { arrayFilters: [{ "a.active": true, "a.lead": true, "a.email": { $ne: e } }] });
    if (!(j.workers || []).some((w) => w.email === e)) await c.updateOne({ _id: j._id, "workers.email": { $ne: e } }, { $push: { workers: { email: e, state: "NOT_STARTED", ack: false, since: now, minutes: 0 } } });
    await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: "OPS_TECHNICIAN_ASSIGNED", newState: nextStatus, metadata: { email: e, start: s, end: en, override: assignment.override } });
    await notifyMember({ orgId, email: e, title: `New job ${j.number}`, body: s ? `Scheduled ${new Date(s).toUTCString().slice(0, 22)}.` : "A job was assigned to you.", type: "ops_assigned", sourceId: j._id, dedupeKey: `ops:assign:${j._id}:${e}:${now}` });
    return { job: viewFor(membership, await c.findOne({ _id: j._id })), warnings: problems.map((p) => p.message) };
  });
}
export async function unassignTechnician({ orgId, membership, actorEmail, jobId, email, reason }) {
  const d = await opsAccess({ orgId, membership, need: "schedule" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  const e = clean(email, 200).toLowerCase(); const why = clean(reason, 500); if (why.length < 3) return fail("Give a reason for the change.");
  if (!(j.assignments || []).some((a) => a.active && a.email === e)) return fail("That technician isn't on this job.", 404);
  const w = (j.workers || []).find((x) => x.email === e); if (w?.state === "ACTIVE") return fail("The technician is working on this job right now. Ask them to pause first.", 409);
  const now = nowIso(); const c = await ccol();
  await c.updateOne({ _id: j._id }, { $set: { "assignments.$[a].active": false, "assignments.$[a].endedAt": now, "assignments.$[a].endedBy": actorEmail, "assignments.$[a].endReason": why, updatedAt: now }, $pull: { assigneeEmails: e }, $push: { history: { action: "unassign", by: actorEmail, at: now, email: e, reason: why } } }, { arrayFilters: [{ "a.email": e, "a.active": true }] });
  const fresh = await c.findOne({ _id: j._id });
  if (!(fresh.assigneeEmails || []).length && ["ASSIGNED", "SCHEDULED"].includes(fresh.status)) await c.updateOne({ _id: j._id, status: fresh.status }, { $set: { status: j.type === "WO" ? "READY" : "READY" }, $push: { history: { from: fresh.status, to: "READY", action: "unassigned_all", by: actorEmail, at: now } } });
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: "OPS_TECHNICIAN_UNASSIGNED", metadata: { email: e, reason: why } });
  await notifyMember({ orgId, email: e, title: `${j.number} reassigned`, body: "You were taken off this job.", type: "ops_unassigned", sourceId: j._id, dedupeKey: `ops:unassign:${j._id}:${e}:${now}` });
  return { job: viewFor(membership, await c.findOne({ _id: j._id })) };
}
/** Reschedule (move the time block). Each active technician's slot moves too, re-checked for conflicts. */
export async function rescheduleJob({ orgId, membership, actorEmail, jobId, start, end, reason, override }) {
  const d = await opsAccess({ orgId, membership, need: "schedule" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  if (TERMINAL.includes(j.status) || ["COMPLETED", "INVOICED"].includes(j.status)) return fail("A finished order can't be rescheduled.", 409);
  if (!isDate(start) || !isDate(end) || !start || !end || new Date(end) <= new Date(start)) return fail("Give a start and a later end.");
  const why = clean(reason, 500); if (j.plannedStart && why.length < 3) return fail("Give a reason for the change.");
  const s = iso(start); const en = iso(end); const c = await ccol(); const { orgMembers } = await getOrgCollections();
  const problems = [];
  for (const a of (j.assignments || []).filter((x) => x.active)) {
    const member = await orgMembers.findOne({ orgId: oid(orgId), email: a.email }); const profile = await c.findOne({ orgId: oid(orgId), kind: K.tech, email: a.email });
    for (const p of await eligibility({ orgId, job: j, email: a.email, start: s, end: en, member, profile })) problems.push({ ...p, email: a.email });
  }
  if (problems.some((p) => p.hard)) return fail(problems.filter((p) => p.hard).map((p) => `${p.email}: ${p.message}`).join(" "), 409, "INELIGIBLE");
  if (problems.length && clean(override, 500).length < 3) return { error: problems.map((p) => `${p.email}: ${p.message}`).join(" "), status: 409, code: "NEEDS_OVERRIDE", problems };
  const now = nowIso(); const status = j.type === "WO" && j.status === "READY" ? "SCHEDULED" : j.status;
  await c.updateOne({ _id: j._id }, { $set: { plannedStart: s, plannedEnd: en, status, "assignments.$[a].start": s, "assignments.$[a].end": en, updatedAt: now }, $push: { history: { action: "reschedule", from: j.plannedStart, to: s, by: actorEmail, at: now, reason: why || null, override: problems.length ? clean(override, 500) : null } } }, { arrayFilters: [{ "a.active": true }] });
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: "OPS_RESCHEDULED", metadata: { start: s, end: en, reason: why || null } });
  for (const a of (j.assignments || []).filter((x) => x.active)) await notifyMember({ orgId, email: a.email, title: `${j.number} rescheduled`, body: `New time ${new Date(s).toUTCString().slice(0, 22)}.`, type: "ops_rescheduled", sourceId: j._id, dedupeKey: `ops:resched:${j._id}:${a.email}:${now}` });
  return { job: viewFor(membership, await c.findOne({ _id: j._id })) };
}

// ------------------------------------------------------------------ board + chart
async function clockStates(orgId, emails) {
  const c = await ccol(); const out = new Map();
  const since = new Date(Date.now() - 36 * 3600000).toISOString();
  const punches = await c.find({ orgId: oid(orgId), kind: WK.punch, email: { $in: emails }, at: { $gte: since }, voided: { $ne: true } }).sort({ at: 1 }).toArray();
  for (const p of punches) out.set(p.email, { type: p.type, at: p.at, locationId: sid(p.locationId) });
  return new Map(emails.map((e) => { const p = out.get(e); return [e, { clock: p ? (p.type === "CLOCK_IN" || p.type === "BREAK_END" ? "WORKING" : p.type === "BREAK_START" ? "ON_BREAK" : "OFF") : "OFF", since: p?.at || null }]; }));
}
/** Chart state for one technician on one job (SOW 8.4). Never inferred from attendance alone. */
export function chartState(job, worker, clock, now = new Date()) {
  if (["COMPLETED", "CLOSED", "INVOICED", "READY_FOR_COLLECTION"].includes(job.status)) return "COMPLETED";
  if (job.status === "AWAITING_PARTS") return "AWAITING_PARTS";
  if (job.status === "AWAITING_APPROVAL" || job.pendingChangeOrder) return "AWAITING_CUSTOMER_APPROVAL";
  if (["AWAITING_INSPECTION", "QUALITY_CHECK"].includes(job.status) || worker?.state === "SUBMITTED") return "AWAITING_INSPECTION";
  if (worker?.state === "ACTIVE") return "IN_PROGRESS";
  if (worker?.state === "PAUSED") return "PAUSED";
  const a = (job.assignments || []).find((x) => x.active && x.email === worker?.email);
  if (!a || !a.start) return "NOT_SCHEDULED";
  if ((job.dueAt && new Date(job.dueAt) < now) || (a.end && new Date(a.end) < now)) return "OVERDUE";
  if (clock?.clock === "WORKING") return "CLOCKED_IN_NO_JOB";
  return "SCHEDULED_NOT_STARTED";
}
export async function board({ orgId, membership, from, to, warehouseId }) {
  const d = await opsAccess({ orgId, membership, need: "view_all" }); if (d) return d; await ensureOpsIndexes();
  if (warehouseId && !allowedLocation(membership, warehouseId)) return denyLocation();
  const start = from ? iso(from) : new Date(Date.now() - 86400000).toISOString(); const end = to ? iso(to) : new Date(Date.now() + 7 * 86400000).toISOString();
  const c = await ccol(); const base = { orgId: oid(orgId), kind: K.job, ...scopeFilter(membership, "warehouseId"), ...(warehouseId ? { warehouseId: oid(warehouseId) } : {}) };
  const open = await c.find({ ...base, status: { $nin: ["CLOSED", "CANCELLED", "INVOICED", "DRAFT"] } }).limit(1000).toArray();
  const techs = (await listTechnicians({ orgId, membership })).technicians || [];
  const emails = techs.map((t) => t.email); const clocks = await clockStates(orgId, emails); const now = new Date();
  const acts = await c.aggregate([{ $match: { orgId: oid(orgId), kind: K.act, jobId: { $in: open.map((j) => j._id) }, type: "START" } }, { $group: { _id: { jobId: "$jobId", email: "$email" }, first: { $min: "$at" } } }]).toArray();
  const firstStart = new Map(acts.map((a) => [`${sid(a._id.jobId)}:${a._id.email}`, a.first]));
  const lanes = techs.filter((t) => t.active !== false).map((t) => ({
    ...t, clock: clocks.get(t.email),
    jobs: open.filter((j) => (j.assignments || []).some((a) => a.active && a.email === t.email)).map((j) => {
      const a = j.assignments.find((x) => x.active && x.email === t.email); const w = (j.workers || []).find((x) => x.email === t.email);
      const actualStart = firstStart.get(`${sid(j._id)}:${t.email}`) || null;
      return { id: sid(j._id), number: j.number, type: j.type, title: j.title, status: j.status, priority: j.priority, warehouseId: sid(j.warehouseId), customer: j.customerName || null, scheduledStart: a.start, scheduledEnd: a.end, lead: a.lead, actualStart, workerState: w?.state || "NOT_STARTED", activeMinutes: w?.minutes || 0, estMinutes: j.estMinutes || null, lastActivityAt: j.lastActivityAt, state: chartState(j, { ...w, email: t.email }, clocks.get(t.email), now), inRange: !a.start || overlaps(a.start, a.end || a.start, start, end) };
    }),
  }));
  const unassigned = open.filter((j) => !(j.assigneeEmails || []).length && ASSIGNABLE[j.type].includes(j.status)).map((j) => ({ id: sid(j._id), number: j.number, type: j.type, title: j.title, status: j.status, priority: j.priority, dueAt: j.dueAt, skills: j.skills || [], estMinutes: j.estMinutes, warehouseId: sid(j.warehouseId) }));
  const overdue = open.filter((j) => j.dueAt && new Date(j.dueAt) < now && !["COMPLETED", "READY_FOR_COLLECTION"].includes(j.status)).map((j) => ({ id: sid(j._id), number: j.number, title: j.title, dueAt: j.dueAt, status: j.status }));
  const atRisk = open.filter((j) => j.dueAt && new Date(j.dueAt) >= now && new Date(j.dueAt) - now < 24 * 3600000 && !(j.workers || []).some((w) => ["ACTIVE", "SUBMITTED"].includes(w.state))).map((j) => ({ id: sid(j._id), number: j.number, title: j.title, dueAt: j.dueAt }));
  const stalled = open.filter((j) => ["IN_PROGRESS", "IN_REPAIR", "ASSIGNED", "SCHEDULED"].includes(j.status) && j.lastActivityAt && now - new Date(j.lastActivityAt) > 48 * 3600000).map((j) => ({ id: sid(j._id), number: j.number, title: j.title, lastActivityAt: j.lastActivityAt }));
  return { from: start, to: end, lanes, unassigned, overdue, atRisk, stalled, counts: { open: open.length, unassigned: unassigned.length, overdue: overdue.length, inProgress: open.filter((j) => (j.workers || []).some((w) => w.state === "ACTIVE")).length } };
}
/** Suggested technicians for a job: eligible first, then fewest open jobs (explainable; a person still decides). */
export async function suggestTechnicians({ orgId, membership, jobId }) {
  const d = await opsAccess({ orgId, membership, need: "schedule" }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  const { orgMembers } = await getOrgCollections(); const c = await ccol();
  const techs = (await listTechnicians({ orgId, membership })).technicians || [];
  const out = [];
  for (const t of techs) {
    const member = await orgMembers.findOne({ orgId: oid(orgId), email: t.email }); const profile = await c.findOne({ orgId: oid(orgId), kind: K.tech, email: t.email });
    const problems = await eligibility({ orgId, job: j, email: t.email, start: j.plannedStart, end: j.plannedEnd, member, profile });
    const load = await c.countDocuments({ orgId: oid(orgId), kind: K.job, assigneeEmails: t.email, status: { $in: BUSY } });
    out.push({ email: t.email, eligible: !problems.length, hardBlocked: problems.some((p) => p.hard), problems: problems.map((p) => p.message), openJobs: load });
  }
  out.sort((a, b) => (a.hardBlocked - b.hardBlocked) || (b.eligible - a.eligible) || (a.openJobs - b.openJobs));
  return { suggestions: out, basis: "Eligibility (branch, role, skills, certifications, leave, shift, existing bookings), then fewest open jobs." };
}
