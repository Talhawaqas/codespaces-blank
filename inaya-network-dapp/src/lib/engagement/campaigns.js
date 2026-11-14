// src/lib/engagement/campaigns.js
//
// Mass Marketing Email SOW — campaigns: the 4-step builder's data (Design ->
// Audience -> Review -> Send), approval workflow, scheduling (one-off and
// recurring), test sends, cancellation and the analytics report.
//
//   DRAFT -> PENDING_APPROVAL -> SCHEDULED -> SENDING -> SENT
//            (rejected: back to DRAFT with the approver's note)
//   recurring: SENDING -> SCHEDULED (next run) ... until the end date
//   CANCELLED from DRAFT/PENDING_APPROVAL/SCHEDULED/SENDING
// Any edit after submission sends it back to DRAFT, so what gets sent is
// always exactly what was approved. Approver must be a different person
// from the submitter, unless the org has switched approval off.

import { toObjectId } from "../orgs.js";
import { sendEmail } from "../email.js";
import { createNotification } from "../notifications.js";
import { logOrgActivity } from "../org-activity-log.js";
import {
  engagementCollections, ensureEngagementIndexes, oid, nowIso, normEmail, isEmail, fail, clean,
  canEditCampaigns, canApproveCampaigns, canViewCampaigns, canManageMarketing, listOrgMembers,
} from "./store.js";
import { validateBlocks, renderEmail, resolveTemplate, mergeText, USE_CASES } from "./templates.js";
import { normalizeRules, describeRules, resolveAudience } from "./segments.js";
import { getMarketingSettings } from "./suppression.js";
import { senderStatus, monthlyUsage, sampleVars } from "./sender.js";

export const CAMPAIGN_STATUSES = ["DRAFT", "PENDING_APPROVAL", "SCHEDULED", "SENDING", "SENT", "CANCELLED"];
const EDITABLE = ["DRAFT", "PENDING_APPROVAL", "SCHEDULED"];
const EMPTY_STATS = { recipients: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, failed: 0 };

/** Next run for a recurring schedule, or null when the series is over. */
export function nextRunAfter(recurrence, after) {
  if (!recurrence) return null;
  const d = new Date(after);
  const interval = Math.max(1, Number(recurrence.interval) || 1);
  if (recurrence.freq === "daily") d.setUTCDate(d.getUTCDate() + interval);
  else if (recurrence.freq === "weekly") d.setUTCDate(d.getUTCDate() + 7 * interval);
  else if (recurrence.freq === "monthly") d.setUTCMonth(d.getUTCMonth() + interval);
  else return null;
  if (recurrence.until && d > new Date(recurrence.until)) return null;
  if (recurrence.maxRuns && (recurrence.runsDone || 0) + 1 >= recurrence.maxRuns) return null;
  return d;
}

export function normalizeSchedule(input) {
  if (!input) return { schedule: { sendAt: null, recurrence: null } };
  let sendAt = null;
  if (input.sendAt) {
    const d = new Date(input.sendAt);
    if (Number.isNaN(d.getTime())) return { error: "Choose a valid send time." };
    if (d < new Date(Date.now() - 60000)) return { error: "The send time is in the past." };
    if (d > new Date(Date.now() + 366 * 86400000)) return { error: "Schedule within the next 12 months." };
    sendAt = d.toISOString();
  }
  let recurrence = null;
  if (input.recurrence && input.recurrence.freq) {
    const r = input.recurrence;
    if (!["daily", "weekly", "monthly"].includes(r.freq)) return { error: "Repeat must be daily, weekly or monthly." };
    const interval = Number(r.interval || 1);
    if (!Number.isInteger(interval) || interval < 1 || interval > 12) return { error: "Repeat interval must be 1-12." };
    let until = null;
    if (r.until) { const u = new Date(r.until); if (Number.isNaN(u.getTime())) return { error: "Choose a valid end date for the repeat." }; until = u.toISOString(); }
    const maxRuns = r.maxRuns ? Number(r.maxRuns) : null;
    if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 365)) return { error: "Number of sends must be 1-365." };
    if (!until && !maxRuns) return { error: "A repeating campaign needs an end date or a number of sends." };
    recurrence = { freq: r.freq, interval, until, maxRuns, runsDone: 0 };
  }
  return { schedule: { sendAt, recurrence } };
}

export function campaignView(c, { full = false } = {}) {
  if (!c) return null;
  const s = { ...EMPTY_STATS, ...(c.stats || {}) };
  const base = s.delivered || Math.max(0, s.sent - s.bounced);
  const v = {
    id: String(c._id), name: c.name, useCase: c.useCase, status: c.status, subject: c.subject, preheader: c.preheader,
    audience: c.audience ? { ...c.audience, segmentId: c.audience.segmentId ? String(c.audience.segmentId) : null, description: describeRules(c.audience.rules || {}) } : null,
    schedule: c.schedule || null, nextRunAt: c.nextRunAt || null, createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
    approval: c.approval || null, stats: s, runs: (c.runs || []).slice(-24), lastError: c.lastError || null,
    rates: {
      open: base ? Math.round((s.opened / base) * 1000) / 10 : null,
      click: base ? Math.round((s.clicked / base) * 1000) / 10 : null,
      bounce: s.sent ? Math.round((s.bounced / s.sent) * 1000) / 10 : null,
      unsubscribe: base ? Math.round((s.unsubscribed / base) * 1000) / 10 : null,
    },
    followUpSequenceId: c.followUpSequenceId ? String(c.followUpSequenceId) : null,
  };
  if (full) v.blocks = c.blocks || [];
  return v;
}

async function load(orgId, campaignId) {
  const { marketing } = await engagementCollections();
  return oid(campaignId) ? marketing.findOne({ _id: oid(campaignId), orgId: toObjectId(orgId), kind: "campaign" }) : null;
}

export async function listCampaigns({ orgId, membership, status }) {
  if (!canViewCampaigns(membership)) return fail("Email campaigns are for people with a marketing role (editor, approver or manager), admins and owners.", 403);
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  const q = { orgId: toObjectId(orgId), kind: "campaign", ...(status ? { status: { $in: String(status).split(",") } } : {}) };
  return { campaigns: (await marketing.find(q).project({ blocks: 0 }).sort({ updatedAt: -1 }).limit(200).toArray()).map((c) => campaignView(c)) };
}

export async function getCampaign({ orgId, membership, campaignId }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role to see campaigns.", 403);
  const c = await load(orgId, campaignId);
  return c ? { campaign: campaignView(c, { full: true }) } : fail("Campaign not found.", 404);
}

export async function createCampaign({ orgId, membership, actorEmail, name, useCase, templateId }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role to create campaigns.", 403);
  await ensureEngagementIndexes();
  const n = clean(name, 120); if (!n) return fail("Name the campaign.");
  const tpl = templateId ? await resolveTemplate(orgId, templateId) : null;
  if (templateId && !tpl) return fail("Template not found.", 404);
  const doc = {
    orgId: toObjectId(orgId), kind: "campaign", name: n, useCase: USE_CASES[useCase] ? useCase : tpl?.useCase || "other", status: "DRAFT",
    subject: tpl?.subject || "", preheader: tpl?.preheader || "", blocks: tpl?.blocks || [{ type: "text", text: "Hi {{first_name|there}},\n\nWrite your message here." }],
    audience: null, schedule: { sendAt: null, recurrence: null }, stats: { ...EMPTY_STATS }, runs: [], approval: null, followUpSequenceId: null,
    createdBy: actorEmail, createdAt: nowIso(), updatedAt: nowIso(),
  };
  const { marketing } = await engagementCollections();
  const r = await marketing.insertOne(doc);
  return { campaign: campaignView({ ...doc, _id: r.insertedId }, { full: true }) };
}

/** Design / Audience / Schedule edits. Editing anything after submission returns it to DRAFT. */
export async function updateCampaign({ orgId, membership, actorEmail, campaignId, updates = {} }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role to edit campaigns.", 403);
  const c = await load(orgId, campaignId);
  if (!c) return fail("Campaign not found.", 404);
  if (!EDITABLE.includes(c.status)) return fail("A campaign that is sending, sent or cancelled can't be edited. Duplicate it instead.", 409);
  const set = { updatedAt: nowIso(), updatedBy: actorEmail };
  if (updates.name !== undefined) { set.name = clean(updates.name, 120); if (!set.name) return fail("Name the campaign."); }
  if (updates.useCase !== undefined) set.useCase = USE_CASES[updates.useCase] ? updates.useCase : "other";
  if (updates.subject !== undefined) set.subject = clean(updates.subject, 200);
  if (updates.preheader !== undefined) set.preheader = clean(updates.preheader, 200);
  if (updates.blocks !== undefined) { const v = validateBlocks(updates.blocks); if (v.error) return fail(v.error); set.blocks = v.blocks; }
  if (updates.audience !== undefined) {
    if (updates.audience === null) set.audience = null;
    else if (updates.audience.segmentId) {
      const { marketing } = await engagementCollections();
      const s = oid(updates.audience.segmentId) && await marketing.findOne({ _id: oid(updates.audience.segmentId), orgId: toObjectId(orgId), kind: "segment" });
      if (!s) return fail("Segment not found.", 404);
      set.audience = { segmentId: s._id, segmentName: s.name, rules: s.rules };
    } else {
      const v = normalizeRules(updates.audience.rules || {}); if (v.error) return fail(v.error);
      set.audience = { segmentId: null, segmentName: null, rules: v.rules };
    }
  }
  if (updates.schedule !== undefined) { const v = normalizeSchedule(updates.schedule); if (v.error) return fail(v.error); set.schedule = v.schedule; }
  if (updates.followUpSequenceId !== undefined) set.followUpSequenceId = updates.followUpSequenceId ? oid(updates.followUpSequenceId) : null;
  const meaningful = ["subject", "preheader", "blocks", "audience", "schedule", "followUpSequenceId"].some((k) => updates[k] !== undefined);
  if (meaningful && c.status !== "DRAFT") { set.status = "DRAFT"; set.approval = null; set.nextRunAt = null; }
  const { marketing } = await engagementCollections();
  await marketing.updateOne({ _id: c._id }, { $set: set });
  return { campaign: campaignView(await load(orgId, campaignId), { full: true }), returnedToDraft: set.status === "DRAFT" && c.status !== "DRAFT" };
}

/** Review step: everything that must be true before a campaign can go out. */
export async function reviewCampaign({ orgId, membership, campaignId }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role.", 403);
  const c = await load(orgId, campaignId);
  if (!c) return fail("Campaign not found.", 404);
  const settings = await getMarketingSettings(orgId);
  const issues = [];
  if (!c.subject) issues.push("Add a subject line.");
  if (!(c.blocks || []).length) issues.push("Add content to the email.");
  if (!c.audience) issues.push("Choose who receives it (Audience step).");
  if (!settings.fromName) issues.push("Set the sender name in email settings.");
  if (!settings.postalAddress) issues.push("Add your business postal address in email settings (anti-spam laws require it in every marketing email).");
  const sender = senderStatus();
  if (!sender.configured) issues.push(sender.message);
  let audienceCount = 0, suppressedCount = 0;
  if (c.audience) { const a = await resolveAudience(orgId, c.audience.rules || {}); audienceCount = a.recipients.length; suppressedCount = a.suppressedCount; if (!audienceCount) issues.push("The audience is empty."); }
  const usage = await monthlyUsage(orgId);
  if (audienceCount > usage.remaining) issues.push(`This would send ${audienceCount.toLocaleString()} emails but ${usage.remaining.toLocaleString()} are left of your ${usage.limit.toLocaleString()} this month.`);
  const preview = renderEmail({ blocks: c.blocks || [], vars: sampleVars(settings), preheader: c.preheader, brandColor: settings.brandColor, footer: { businessName: settings.fromName, postalAddress: settings.postalAddress, reason: settings.audienceReason, unsubscribeUrl: "#unsubscribe" } });
  return { ready: issues.length === 0, issues, audienceCount, suppressedCount, usage, requireApproval: settings.requireApproval, preview: { subject: mergeText(c.subject, sampleVars(settings)), rawSubject: c.subject, html: preview.html, text: preview.text }, campaign: campaignView(c) };
}

export async function submitCampaign({ orgId, membership, actorEmail, campaignId }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role.", 403);
  const c = await load(orgId, campaignId);
  if (!c) return fail("Campaign not found.", 404);
  if (c.status !== "DRAFT") return fail("Only a draft can be submitted.", 409);
  const review = await reviewCampaign({ orgId, membership, campaignId });
  if (review.error) return review;
  if (!review.ready) return fail(`Not ready to send: ${review.issues.join(" ")}`, 409);
  const settings = await getMarketingSettings(orgId);
  const { marketing } = await engagementCollections();
  if (!settings.requireApproval) return scheduleApproved({ orgId, c, actorEmail, approval: { requestedBy: actorEmail, requestedAt: nowIso(), decidedBy: actorEmail, decidedAt: nowIso(), approved: true, note: "Approval switched off for this company." } });
  const r = await marketing.updateOne({ _id: c._id, status: "DRAFT" }, { $set: { status: "PENDING_APPROVAL", approval: { requestedBy: actorEmail, requestedAt: nowIso() }, updatedAt: nowIso() } });
  if (!r.modifiedCount) return fail("The campaign changed just now. Refresh and try again.", 409);
  const approvers = (await listOrgMembers(orgId)).filter((m) => normEmail(m.email) !== normEmail(actorEmail) && (m.role === "owner" || m.role === "admin" || ["manager", "approver"].includes(m.marketingRole)));
  for (const m of approvers.slice(0, 20)) {
    await createNotification({ scope: "org", orgId: toObjectId(orgId), targetEmail: m.email, category: "approval", severity: "info", type: "campaign.approval_requested", title: `Approve email campaign: ${c.name}`, body: `${actorEmail} submitted "${c.subject}" to ${review.audienceCount.toLocaleString()} recipients.`, sourceModule: "campaigns", sourceId: String(c._id), actionUrl: `/business?view=campaigns&campaign=${c._id}`, metadata: {}, dedupeKey: `campaign:approve:${c._id}:${m.email}:${Date.now()}` }).catch(() => {});
  }
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "CAMPAIGN", recordId: c._id, actorEmail, action: "SUBMITTED_FOR_APPROVAL", previousState: "DRAFT", newState: "PENDING_APPROVAL", metadata: { audience: review.audienceCount } }).catch(() => {});
  return { campaign: campaignView(await load(orgId, campaignId)), approversNotified: approvers.length };
}

async function scheduleApproved({ orgId, c, actorEmail, approval }) {
  const { marketing } = await engagementCollections();
  const nextRunAt = c.schedule?.sendAt || nowIso();
  const r = await marketing.updateOne({ _id: c._id, status: { $in: ["DRAFT", "PENDING_APPROVAL"] } }, { $set: { status: "SCHEDULED", approval, nextRunAt, lastError: null, updatedAt: nowIso() } });
  if (!r.modifiedCount) return fail("The campaign changed just now. Refresh and try again.", 409);
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "CAMPAIGN", recordId: c._id, actorEmail, action: "SCHEDULED", previousState: c.status, newState: "SCHEDULED", metadata: { nextRunAt } }).catch(() => {});
  return { campaign: campaignView(await load(orgId, c._id)) };
}

export async function decideCampaign({ orgId, membership, actorEmail, campaignId, approve, note }) {
  if (!canApproveCampaigns(membership)) return fail("You need the marketing approver or manager role to approve campaigns.", 403);
  const c = await load(orgId, campaignId);
  if (!c) return fail("Campaign not found.", 404);
  if (c.status !== "PENDING_APPROVAL") return fail("This campaign isn't waiting for approval.", 409);
  if (normEmail(c.approval?.requestedBy) === normEmail(actorEmail)) return fail("Someone other than the person who submitted it must approve it.", 403);
  const approval = { ...c.approval, decidedBy: actorEmail, decidedAt: nowIso(), approved: approve === true, note: clean(note, 1000) };
  if (approve === true) {
    const r = await scheduleApproved({ orgId, c, actorEmail, approval });
    if (!r.error) await createNotification({ scope: "org", orgId: toObjectId(orgId), targetEmail: c.approval.requestedBy, category: "approval", severity: "info", type: "campaign.approved", title: `Approved: ${c.name}`, body: approval.note || "It will go out at the scheduled time.", sourceModule: "campaigns", sourceId: String(c._id), actionUrl: `/business?view=campaigns&campaign=${c._id}`, metadata: {}, dedupeKey: `campaign:approved:${c._id}:${approval.decidedAt}` }).catch(() => {});
    return r;
  }
  const { marketing } = await engagementCollections();
  await marketing.updateOne({ _id: c._id, status: "PENDING_APPROVAL" }, { $set: { status: "DRAFT", approval, updatedAt: nowIso() } });
  await createNotification({ scope: "org", orgId: toObjectId(orgId), targetEmail: c.approval.requestedBy, category: "approval", severity: "warning", type: "campaign.rejected", title: `Changes requested: ${c.name}`, body: approval.note || "The approver asked for changes.", sourceModule: "campaigns", sourceId: String(c._id), actionUrl: `/business?view=campaigns&campaign=${c._id}`, metadata: {}, dedupeKey: `campaign:rejected:${c._id}:${approval.decidedAt}` }).catch(() => {});
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "CAMPAIGN", recordId: c._id, actorEmail, action: "REJECTED", previousState: "PENDING_APPROVAL", newState: "DRAFT", metadata: { note: approval.note } }).catch(() => {});
  return { campaign: campaignView(await load(orgId, campaignId)) };
}

export async function cancelCampaign({ orgId, membership, actorEmail, campaignId }) {
  if (!canEditCampaigns(membership) && !canApproveCampaigns(membership)) return fail("You need a marketing role to cancel campaigns.", 403);
  const c = await load(orgId, campaignId);
  if (!c) return fail("Campaign not found.", 404);
  if (!["DRAFT", "PENDING_APPROVAL", "SCHEDULED", "SENDING"].includes(c.status)) return fail("This campaign can't be cancelled.", 409);
  const { marketing } = await engagementCollections();
  await marketing.updateOne({ _id: c._id }, { $set: { status: "CANCELLED", nextRunAt: null, cancelledBy: actorEmail, cancelledAt: nowIso(), updatedAt: nowIso() } });
  const stopped = c.status === "SENDING" ? (await marketing.updateMany({ orgId: c.orgId, kind: "send", campaignId: c._id, status: "queued" }, { $set: { status: "cancelled" } })).modifiedCount : 0;
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "CAMPAIGN", recordId: c._id, actorEmail, action: "CANCELLED", previousState: c.status, newState: "CANCELLED", metadata: { stoppedQueued: stopped } }).catch(() => {});
  return { campaign: campaignView(await load(orgId, campaignId)), stoppedQueued: stopped };
}

export async function duplicateCampaign({ orgId, membership, actorEmail, campaignId }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role.", 403);
  const c = await load(orgId, campaignId);
  if (!c) return fail("Campaign not found.", 404);
  const { _id, ...rest } = c;
  const doc = { ...rest, name: `${c.name} (copy)`.slice(0, 120), status: "DRAFT", approval: null, nextRunAt: null, stats: { ...EMPTY_STATS }, runs: [], lastError: null, schedule: { sendAt: null, recurrence: null }, createdBy: actorEmail, createdAt: nowIso(), updatedAt: nowIso(), currentRunId: null };
  const { marketing } = await engagementCollections();
  const r = await marketing.insertOne(doc);
  return { campaign: campaignView({ ...doc, _id: r.insertedId }, { full: true }) };
}

/** Test send to up to 5 company members. Not tracked, not counted, subject prefixed [TEST]. */
export async function testSendCampaign({ orgId, membership, actorEmail, campaignId, to }) {
  if (!canEditCampaigns(membership) && !canApproveCampaigns(membership)) return fail("You need a marketing role to send tests.", 403);
  const c = await load(orgId, campaignId);
  if (!c) return fail("Campaign not found.", 404);
  const list = [...new Set((Array.isArray(to) && to.length ? to : [actorEmail]).map(normEmail))].slice(0, 5);
  const members = new Set((await listOrgMembers(orgId)).map((m) => normEmail(m.email)));
  const outsiders = list.filter((e) => !isEmail(e) || !members.has(e));
  if (outsiders.length) return fail(`Test emails go to company members only: ${outsiders.join(", ")}.`);
  const settings = await getMarketingSettings(orgId);
  const vars = sampleVars(settings);
  const rendered = renderEmail({ blocks: c.blocks || [], vars, preheader: c.preheader, brandColor: settings.brandColor, footer: { businessName: settings.fromName, postalAddress: settings.postalAddress, reason: settings.audienceReason, unsubscribeUrl: "#unsubscribe-link-appears-here" } });
  const { mergeText } = await import("./templates.js");
  const results = [];
  for (const e of list) { const r = await sendEmail({ to: e, subject: `[TEST] ${mergeText(c.subject, vars)}`, html: rendered.html, text: rendered.text, replyTo: settings.replyTo || undefined }).catch(() => ({ sent: false })); results.push({ to: e, sent: r?.sent !== false, reason: r?.reason || null }); }
  return { results };
}

/** Analytics for one campaign: totals, rates, top links, opens/clicks over time. */
export async function campaignReport({ orgId, membership, campaignId }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role.", 403);
  const c = await load(orgId, campaignId);
  if (!c) return fail("Campaign not found.", 404);
  const { marketing } = await engagementCollections();
  const match = { orgId: c.orgId, kind: "send", campaignId: c._id };
  const [byStatus, links, opensByHour, clicksByHour] = await Promise.all([
    marketing.aggregate([{ $match: match }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    marketing.aggregate([{ $match: { ...match, "clickLog.0": { $exists: true } } }, { $unwind: "$clickLog" }, { $group: { _id: "$clickLog.url", clicks: { $sum: 1 }, people: { $addToSet: "$email" } } }, { $project: { clicks: 1, unique: { $size: "$people" } } }, { $sort: { unique: -1 } }, { $limit: 20 }]).toArray(),
    marketing.aggregate([{ $match: { ...match, openedAt: { $ne: null } } }, { $group: { _id: { $substr: ["$openedAt", 0, 13] }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 400 }]).toArray(),
    marketing.aggregate([{ $match: { ...match, clickedAt: { $ne: null } } }, { $group: { _id: { $substr: ["$clickedAt", 0, 13] }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 400 }]).toArray(),
  ]);
  return {
    campaign: campaignView(c),
    deliveryStatus: Object.fromEntries(byStatus.map((x) => [x._id, x.n])),
    links: links.map((l) => ({ url: l._id, clicks: l.clicks, unique: l.unique })),
    timeline: { opens: opensByHour.map((x) => ({ hour: `${x._id}:00Z`, n: x.n })), clicks: clicksByHour.map((x) => ({ hour: `${x._id}:00Z`, n: x.n })) },
    note: "Opens are counted from an image in the email. Some mail apps load images automatically (inflating opens) or block them (hiding opens); clicks are exact.",
  };
}

/** Overview across campaigns in the last N days vs the SOW targets (open >= 25%, CTR >= 5%). */
export async function marketingOverview({ orgId, membership, days = 30 }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role.", 403);
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 365) * 86400000).toISOString();
  const rows = await marketing.find({ orgId: toObjectId(orgId), kind: "campaign", updatedAt: { $gte: since }, "stats.sent": { $gt: 0 } }).project({ stats: 1, name: 1, status: 1, updatedAt: 1 }).toArray();
  const t = rows.reduce((s, c) => { for (const k of Object.keys(EMPTY_STATS)) s[k] += c.stats?.[k] || 0; return s; }, { ...EMPTY_STATS });
  const base = t.delivered || Math.max(0, t.sent - t.bounced);
  const usage = await monthlyUsage(orgId);
  const pending = await marketing.countDocuments({ orgId: toObjectId(orgId), kind: "campaign", status: "PENDING_APPROVAL" });
  const scheduled = await marketing.countDocuments({ orgId: toObjectId(orgId), kind: "campaign", status: "SCHEDULED" });
  const suppressed = await marketing.countDocuments({ orgId: toObjectId(orgId), kind: "suppression" });
  return {
    days: Number(days) || 30, campaigns: rows.length, totals: t,
    rates: { open: base ? Math.round((t.opened / base) * 1000) / 10 : null, click: base ? Math.round((t.clicked / base) * 1000) / 10 : null, bounce: t.sent ? Math.round((t.bounced / t.sent) * 1000) / 10 : null },
    targets: { open: 25, click: 5 }, usage, pendingApproval: pending, scheduled, suppressed,
    canManage: canManageMarketing(membership), canApprove: canApproveCampaigns(membership), canEdit: canEditCampaigns(membership),
  };
}
