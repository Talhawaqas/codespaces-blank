// src/lib/engagement/sequences.js
//
// Mass Marketing Email SOW — automated follow-up sequences: a series of
// emails sent on a delay after someone is enrolled (by a workflow, after a
// completed appointment, after an enquiry, or after a campaign). People are
// taken out automatically when they unsubscribe, bounce, complain, or (if
// the sequence says so) book an appointment. Sequences go through the same
// approval workflow as campaigns before they can send.

import { ObjectId } from "mongodb";
import { toObjectId } from "../orgs.js";
import { createNotification } from "../notifications.js";
import { engagementCollections, ensureEngagementIndexes, oid, nowIso, normEmail, isEmail, fail, clean, canEditCampaigns, canApproveCampaigns, canViewCampaigns, listOrgMembers, engagementAccess } from "./store.js";
import { validateBlocks } from "./templates.js";
import { getMarketingSettings, isSuppressed } from "./suppression.js";
import { senderStatus, monthlyUsage, sendOne } from "./sender.js";

const MAX_STEPS = 10;

function sequenceView(s) {
  const { orgId, kind, ...rest } = s;
  return { ...rest, id: String(s._id), stats: { enrolled: 0, sent: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, ...(s.stats || {}) } };
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return { error: "Add at least one email to the sequence." };
  if (steps.length > MAX_STEPS) return { error: `${MAX_STEPS} emails at most.` };
  const out = [];
  for (const [i, s] of steps.entries()) {
    const delayHours = Number(s.delayHours ?? 24);
    if (!Number.isInteger(delayHours) || delayHours < 0 || delayHours > 24 * 90) return { error: `Email ${i + 1}: the wait must be 0-2160 hours (90 days).` };
    const subject = clean(s.subject, 200);
    if (!subject) return { error: `Email ${i + 1} needs a subject.` };
    const v = validateBlocks(s.blocks);
    if (v.error) return { error: `Email ${i + 1}: ${v.error}` };
    out.push({ id: s.id && /^[a-z0-9-]{1,20}$/i.test(s.id) ? s.id : new ObjectId().toHexString().slice(-8), delayHours, subject, preheader: clean(s.preheader, 200), blocks: v.blocks });
  }
  return { steps: out };
}

export async function listSequences({ orgId, membership }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role to see sequences.", 403);
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  return { sequences: (await marketing.find({ orgId: toObjectId(orgId), kind: "sequence", archived: { $ne: true } }).sort({ updatedAt: -1 }).limit(100).toArray()).map(sequenceView) };
}

export async function saveSequence({ orgId, membership, actorEmail, sequenceId, name, steps, exitOnBooking, archived }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role to edit sequences.", 403);
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  if (sequenceId && archived !== undefined) {
    const r = oid(sequenceId) && await marketing.updateOne({ _id: oid(sequenceId), orgId: toObjectId(orgId), kind: "sequence" }, { $set: { archived: archived === true, status: "PAUSED", updatedAt: nowIso() } });
    return r?.matchedCount ? { ok: true } : fail("Sequence not found.", 404);
  }
  const n = clean(name, 100); if (!n) return fail("Name the sequence.");
  const v = validateSteps(steps); if (v.error) return fail(v.error);
  const doc = { name: n, steps: v.steps, exitOnBooking: exitOnBooking !== false, updatedAt: nowIso(), updatedBy: actorEmail };
  if (sequenceId) {
    const existing = oid(sequenceId) && await marketing.findOne({ _id: oid(sequenceId), orgId: toObjectId(orgId), kind: "sequence" });
    if (!existing) return fail("Sequence not found.", 404);
    // Content changed: it must be approved again before it sends; people already enrolled wait meanwhile.
    await marketing.updateOne({ _id: existing._id }, { $set: { ...doc, status: "DRAFT", approval: null } });
    return { sequence: sequenceView(await marketing.findOne({ _id: existing._id })) };
  }
  const full = { orgId: toObjectId(orgId), kind: "sequence", ...doc, status: "DRAFT", approval: null, stats: {}, archived: false, createdBy: actorEmail, createdAt: nowIso() };
  const r = await marketing.insertOne(full);
  return { sequence: sequenceView({ ...full, _id: r.insertedId }) };
}

/** DRAFT -> PENDING_APPROVAL (or ACTIVE when approval is switched off). */
export async function submitSequence({ orgId, membership, actorEmail, sequenceId }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role.", 403);
  const { marketing } = await engagementCollections();
  const s = oid(sequenceId) && await marketing.findOne({ _id: oid(sequenceId), orgId: toObjectId(orgId), kind: "sequence" });
  if (!s) return fail("Sequence not found.", 404);
  if (!["DRAFT", "PAUSED"].includes(s.status)) return fail("Only a draft or paused sequence can be submitted.", 409);
  const settings = await getMarketingSettings(orgId);
  if (!settings.fromName || !settings.postalAddress) return fail("Set the sender name and postal address in email settings first.", 409);
  if (!settings.requireApproval || (s.status === "PAUSED" && s.approval?.approved)) {
    await marketing.updateOne({ _id: s._id }, { $set: { status: "ACTIVE", approval: s.approval?.approved ? s.approval : { requestedBy: actorEmail, decidedBy: actorEmail, approved: true, decidedAt: nowIso(), note: "Approval switched off for this company." }, updatedAt: nowIso() } });
    return { sequence: sequenceView(await marketing.findOne({ _id: s._id })) };
  }
  await marketing.updateOne({ _id: s._id }, { $set: { status: "PENDING_APPROVAL", approval: { requestedBy: actorEmail, requestedAt: nowIso() }, updatedAt: nowIso() } });
  const approvers = (await listOrgMembers(orgId)).filter((m) => normEmail(m.email) !== normEmail(actorEmail) && (m.role === "owner" || m.role === "admin" || ["manager", "approver"].includes(m.marketingRole)));
  for (const m of approvers.slice(0, 20)) await createNotification({ scope: "org", orgId: toObjectId(orgId), targetEmail: m.email, category: "approval", severity: "info", type: "sequence.approval_requested", title: `Approve follow-up sequence: ${s.name}`, body: `${s.steps.length} emails, submitted by ${actorEmail}.`, sourceModule: "campaigns", sourceId: String(s._id), actionUrl: `/business?view=campaigns&tab=sequences`, metadata: {}, dedupeKey: `sequence:approve:${s._id}:${m.email}:${Date.now()}` }).catch(() => {});
  return { sequence: sequenceView(await marketing.findOne({ _id: s._id })) };
}

export async function decideSequence({ orgId, membership, actorEmail, sequenceId, approve, note }) {
  if (!canApproveCampaigns(membership)) return fail("You need the marketing approver or manager role.", 403);
  const { marketing } = await engagementCollections();
  const s = oid(sequenceId) && await marketing.findOne({ _id: oid(sequenceId), orgId: toObjectId(orgId), kind: "sequence" });
  if (!s) return fail("Sequence not found.", 404);
  if (s.status !== "PENDING_APPROVAL") return fail("This sequence isn't waiting for approval.", 409);
  if (normEmail(s.approval?.requestedBy) === normEmail(actorEmail)) return fail("Someone other than the person who submitted it must approve it.", 403);
  const approval = { ...s.approval, decidedBy: actorEmail, decidedAt: nowIso(), approved: approve === true, note: clean(note, 1000) };
  await marketing.updateOne({ _id: s._id }, { $set: { status: approve === true ? "ACTIVE" : "DRAFT", approval, updatedAt: nowIso() } });
  return { sequence: sequenceView(await marketing.findOne({ _id: s._id })) };
}

export async function pauseSequence({ orgId, membership, sequenceId }) {
  if (!canEditCampaigns(membership) && !canApproveCampaigns(membership)) return fail("You need a marketing role.", 403);
  const { marketing } = await engagementCollections();
  const r = oid(sequenceId) && await marketing.updateOne({ _id: oid(sequenceId), orgId: toObjectId(orgId), kind: "sequence", status: "ACTIVE" }, { $set: { status: "PAUSED", updatedAt: nowIso() } });
  return r?.modifiedCount ? { ok: true } : fail("Only an active sequence can be paused.", 409);
}

/** Enrols people. Already-active enrolments in the same sequence and suppressed addresses are skipped. */
export async function enrollMany({ orgId, sequenceId, people, source }) {
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  const seq = await marketing.findOne({ _id: toObjectId(sequenceId), orgId: toObjectId(orgId), kind: "sequence" });
  if (!seq || seq.archived) return fail("Sequence not found.", 404);
  const now = Date.now();
  let enrolled = 0, skipped = 0;
  for (const p of (people || []).slice(0, 20000)) {
    const email = normEmail(p.email);
    if (!isEmail(email) || await isSuppressed(orgId, email)) { skipped++; continue; }
    const r = await marketing.updateOne(
      { orgId: toObjectId(orgId), kind: "enrollment", sequenceId: seq._id, email, status: "ACTIVE" },
      { $setOnInsert: { orgId: toObjectId(orgId), kind: "enrollment", sequenceId: seq._id, email, name: clean(p.name, 120), company: clean(p.company, 120), contactId: p.contactId || null, status: "ACTIVE", step: 0, nextAt: new Date(now + (seq.steps[0]?.delayHours || 0) * 3600000), enrolledAt: new Date(now).toISOString(), source: clean(source, 200), createdAt: nowIso() } },
      { upsert: true },
    );
    if (r.upsertedCount) enrolled++; else skipped++;
  }
  if (enrolled) await marketing.updateOne({ _id: seq._id }, { $inc: { "stats.enrolled": enrolled } });
  return { enrolled, skipped, sequenceStatus: seq.status };
}

export async function enrollContact({ orgId, membership, sequenceId, email, name, company, contactId, source }) {
  if (membership && !canEditCampaigns(membership)) return fail("You need the marketing editor or manager role to enrol people.", 403);
  return enrollMany({ orgId, sequenceId, people: [{ email, name, company, contactId }], source: source || "manual" });
}

export async function listEnrollments({ orgId, membership, sequenceId, status }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role.", 403);
  const { marketing } = await engagementCollections();
  const rows = await marketing.find({ orgId: toObjectId(orgId), kind: "enrollment", ...(sequenceId && oid(sequenceId) ? { sequenceId: oid(sequenceId) } : {}), ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(300).toArray();
  return { enrollments: rows.map((e) => ({ id: String(e._id), sequenceId: String(e.sequenceId), email: e.email, name: e.name, status: e.status, step: e.step, nextAt: e.nextAt, enrolledAt: e.enrolledAt, stoppedReason: e.stoppedReason || null })) };
}

export async function stopEnrollment({ orgId, membership, enrollmentId }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role.", 403);
  const { marketing } = await engagementCollections();
  const r = oid(enrollmentId) && await marketing.updateOne({ _id: oid(enrollmentId), orgId: toObjectId(orgId), kind: "enrollment", status: "ACTIVE" }, { $set: { status: "STOPPED", stoppedReason: "manual", updatedAt: nowIso() } });
  return r?.modifiedCount ? { ok: true } : fail("No active enrolment found.", 404);
}

/** Cron: send due sequence emails. Only ACTIVE (approved) sequences send; others hold their people. */
export async function processDueEnrollments({ now = new Date(), limit = 200, fetchImpl = fetch } = {}) {
  await ensureEngagementIndexes();
  const stats = { checked: 0, sent: 0, exited: 0, completed: 0, held: 0, failed: 0 };
  if (!senderStatus().configured) return { ...stats, blocked: senderStatus().message };
  const { marketing, calendar } = await engagementCollections();
  const due = await marketing.find({ kind: "enrollment", status: "ACTIVE", nextAt: { $lte: now } }).sort({ nextAt: 1 }).limit(limit).toArray();
  const seqCache = new Map(); const settingsCache = new Map(); const gateCache = new Map(); const usageCache = new Map();
  for (const e of due) {
    stats.checked++;
    const sk = String(e.sequenceId);
    if (!seqCache.has(sk)) seqCache.set(sk, await marketing.findOne({ _id: e.sequenceId, kind: "sequence" }));
    const seq = seqCache.get(sk);
    const orgKey = String(e.orgId);
    if (!gateCache.has(orgKey)) gateCache.set(orgKey, !(await engagementAccess(orgKey, "campaigns")));
    if (!seq || seq.archived) { await marketing.updateOne({ _id: e._id }, { $set: { status: "STOPPED", stoppedReason: "sequence removed" } }); continue; }
    if (seq.status !== "ACTIVE" || !gateCache.get(orgKey)) { stats.held++; continue; }
    if (await isSuppressed(e.orgId, e.email)) { await marketing.updateOne({ _id: e._id }, { $set: { status: "UNSUBSCRIBED", stoppedReason: "suppressed" } }); stats.exited++; continue; }
    if (seq.exitOnBooking) {
      const booked = await calendar.findOne({ orgId: e.orgId, kind: "appointment", "customer.email": e.email, status: { $ne: "CANCELLED" }, createdAt: { $gt: e.enrolledAt } }, { projection: { _id: 1 } });
      if (booked) { await marketing.updateOne({ _id: e._id }, { $set: { status: "EXITED", stoppedReason: "booked an appointment" } }); stats.exited++; continue; }
    }
    if (!usageCache.has(orgKey)) usageCache.set(orgKey, (await monthlyUsage(orgKey, now)).remaining);
    if (usageCache.get(orgKey) <= 0) { stats.held++; continue; }
    const step = seq.steps[e.step];
    if (!step) { await marketing.updateOne({ _id: e._id }, { $set: { status: "COMPLETED", completedAt: nowIso() } }); stats.completed++; continue; }
    // claim this step
    const claim = await marketing.updateOne({ _id: e._id, status: "ACTIVE", step: e.step, nextAt: e.nextAt }, { $set: { nextAt: new Date(now.getTime() + 3600000) } });
    if (!claim.modifiedCount) continue;
    if (!settingsCache.has(orgKey)) settingsCache.set(orgKey, await getMarketingSettings(orgKey));
    const send = { _id: new ObjectId(), orgId: e.orgId, kind: "send", sequenceId: seq._id, enrollmentId: e._id, step: e.step, email: e.email, name: e.name, company: e.company, contactId: e.contactId, status: "queued", attempts: 1, openedAt: null, clickedAt: null, opens: 0, clicks: 0, createdAt: nowIso() };
    await marketing.insertOne(send);
    const r = await sendOne({ send, content: step, settings: settingsCache.get(orgKey), fetchImpl });
    if (r.error) {
      await marketing.updateOne({ _id: send._id }, { $set: { status: "failed", lastError: r.error } });
      stats.failed++;
      continue; // retried after the 1-hour claim lapses
    }
    usageCache.set(orgKey, usageCache.get(orgKey) - 1);
    await marketing.updateOne({ _id: send._id }, { $set: { status: "sent", providerId: r.providerId, sentAt: nowIso() } });
    await marketing.updateOne({ _id: seq._id }, { $inc: { "stats.sent": 1 } });
    const nextStep = seq.steps[e.step + 1];
    await marketing.updateOne({ _id: e._id }, nextStep
      ? { $set: { step: e.step + 1, nextAt: new Date(now.getTime() + nextStep.delayHours * 3600000), lastSentAt: nowIso() } }
      : { $set: { step: e.step + 1, status: "COMPLETED", completedAt: nowIso(), lastSentAt: nowIso() } });
    stats.sent++;
    if (!nextStep) stats.completed++;
  }
  return stats;
}
