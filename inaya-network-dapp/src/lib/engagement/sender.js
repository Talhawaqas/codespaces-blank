// src/lib/engagement/sender.js
//
// Mass Marketing Email SOW — delivery and tracking.
//
// Sending: Resend's batch endpoint (100 per call) from a SEPARATE marketing
// sending domain (founder decision 2026-11-13), so bulk mail reputation can
// never affect sign-in, booking or support email. Configure:
//   MARKETING_EMAIL_FROM          address on the marketing subdomain, e.g. news@mail.inayanetwork.com
//   RESEND_MARKETING_API_KEY      optional; a separate Resend key (falls back to RESEND_API_KEY)
//   RESEND_MARKETING_WEBHOOK_SECRET  signing secret of the marketing webhook (falls back to RESEND_WEBHOOK_SECRET)
// SPF/DKIM/DMARC for that subdomain are the DNS records Resend shows when the domain is added.
//
// Every email gets: per-recipient merge fields, a one-click unsubscribe
// (List-Unsubscribe + List-Unsubscribe-Post, RFC 8058) and a footer link,
// the sender's postal address, an open pixel and signed click links.
// Sends run from /api/cron/engagement in bounded chunks; each recipient has
// one send record, so a retry never emails anyone twice.

import { ObjectId } from "mongodb";
import { toObjectId } from "../orgs.js";
import { engagementCollections, ensureEngagementIndexes, engagementAccess, orgPlanKey, MARKETING_MONTHLY_LIMITS, nowIso, normEmail } from "./store.js";
import { renderEmail, mergeText } from "./templates.js";
import { getMarketingSettings, signToken, verifyToken, signClick, verifyClick, suppress, suppressedAmong } from "./suppression.js";
import { resolveAudience } from "./segments.js";
import { appUrl } from "./messages.js";

const BATCH = 100;
const marketingKey = () => process.env.RESEND_MARKETING_API_KEY || process.env.RESEND_API_KEY;
const marketingFrom = () => process.env.MARKETING_EMAIL_FROM || "";

export function senderStatus() {
  if (!marketingKey()) return { configured: false, message: "Email sending isn't connected yet (Resend API key missing)." };
  const from = marketingFrom();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) return { configured: false, message: "The marketing sending address isn't set up yet (MARKETING_EMAIL_FROM on the marketing subdomain)." };
  return { configured: true, fromAddress: from, domain: from.split("@")[1] };
}

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export async function monthlyUsage(orgId, now = new Date()) {
  const { marketing } = await engagementCollections();
  const used = await marketing.countDocuments({ orgId: toObjectId(orgId), kind: "send", createdAt: { $gte: monthStart(now) }, status: { $ne: "cancelled" } });
  const limit = MARKETING_MONTHLY_LIMITS[await orgPlanKey(orgId)] ?? MARKETING_MONTHLY_LIMITS.business;
  return { used, limit, remaining: Math.max(0, limit - used), resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() };
}

export function sampleVars(settings) {
  return { first_name: "Sara", name: "Sara Khan", email: "sara@example.com", company: "Example Ltd", business_name: settings.fromName || "Your business", booking_url: settings.bookingPageSlug ? `${appUrl()}/book/${settings.bookingPageSlug}` : appUrl() };
}

export function recipientVars(send, settings) {
  const name = String(send.name || "").trim();
  return {
    first_name: name.split(/\s+/)[0] || "", name, email: send.email, company: send.company || "",
    business_name: settings.fromName || "", booking_url: settings.bookingPageSlug ? `${appUrl()}/book/${settings.bookingPageSlug}` : appUrl(),
    unsubscribe_url: `${appUrl()}/u/${signToken("u", String(send._id))}`,
  };
}

/** Builds the provider payload for one send record. */
export function buildMessage({ send, content, settings }) {
  const id = String(send._id);
  const vars = recipientVars(send, settings);
  const unsubPage = vars.unsubscribe_url;
  const oneClick = `${appUrl()}/api/m/unsubscribe/${signToken("u", id)}`;
  const clickToken = signToken("c", id);
  const linkWrap = (url) => (/^https:\/\//i.test(url) ? `${appUrl()}/api/m/c/${clickToken}?u=${encodeURIComponent(url)}&s=${signClick(id, url)}` : url);
  const r = renderEmail({ blocks: content.blocks, vars, preheader: content.preheader, brandColor: settings.brandColor, linkWrap, openPixelUrl: `${appUrl()}/api/m/o/${signToken("o", id)}`, footer: { businessName: settings.fromName, postalAddress: settings.postalAddress, reason: settings.audienceReason, unsubscribeUrl: unsubPage } });
  return {
    from: `${String(settings.fromName || "").replace(/[<>"]/g, "")} <${marketingFrom()}>`,
    to: [send.email], subject: mergeText(content.subject, vars), html: r.html, text: r.text,
    ...(settings.replyTo ? { reply_to: settings.replyTo } : {}),
    headers: { "List-Unsubscribe": `<${oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-Entity-Ref-ID": id },
    tags: [{ name: "inaya_send", value: id }],
  };
}

async function resendBatch(messages, fetchImpl = fetch) {
  const res = await fetchImpl("https://api.resend.com/emails/batch", { method: "POST", headers: { Authorization: `Bearer ${marketingKey()}`, "Content-Type": "application/json" }, body: JSON.stringify(messages) });
  if (!res.ok) return { error: `provider_${res.status}`, retry: res.status === 429 || res.status >= 500 };
  const body = await res.json().catch(() => ({}));
  const ids = (body?.data || []).map((d) => d?.id || null);
  return { ids };
}

// --------------------------------------------------------------- campaigns

async function startDueRuns(now, stats) {
  const { marketing } = await engagementCollections();
  const due = await marketing.find({ kind: "campaign", status: "SCHEDULED", nextRunAt: { $lte: now.toISOString() } }).limit(5).toArray();
  for (const c of due) {
    const orgId = String(c.orgId);
    const gate = await engagementAccess(orgId, "campaigns");
    if (gate) { await marketing.updateOne({ _id: c._id }, { $set: { lastError: gate.error } }); continue; }
    const sender = senderStatus();
    if (!sender.configured) { await marketing.updateOne({ _id: c._id }, { $set: { lastError: sender.message } }); stats.blocked++; continue; }
    const runId = new ObjectId();
    const claim = await marketing.updateOne({ _id: c._id, status: "SCHEDULED", nextRunAt: c.nextRunAt }, { $set: { status: "SENDING", currentRunId: runId, lastError: null, updatedAt: nowIso() } });
    if (!claim.modifiedCount) continue;
    const audience = await resolveAudience(orgId, c.audience?.rules || {});
    const usage = await monthlyUsage(orgId, now);
    const list = audience.recipients.slice(0, usage.remaining);
    const limited = list.length < audience.recipients.length;
    const docs = list.map((r) => ({ orgId: c.orgId, kind: "send", campaignId: c._id, runId, email: r.email, name: r.name, company: r.company, contactId: r.contactId || null, status: "queued", attempts: 0, openedAt: null, clickedAt: null, opens: 0, clicks: 0, createdAt: nowIso() }));
    for (let i = 0; i < docs.length; i += 1000) await marketing.insertMany(docs.slice(i, i + 1000), { ordered: false });
    await marketing.updateOne({ _id: c._id }, { $inc: { "stats.recipients": docs.length }, $push: { runs: { id: String(runId), startedAt: nowIso(), recipients: docs.length, limited, skippedOverLimit: audience.recipients.length - list.length } }, ...(limited ? { $set: { lastError: `Monthly email limit reached: ${audience.recipients.length - list.length} recipients were not sent this run.` } } : {}) });
    stats.runsStarted++;
  }
}

async function deliverQueued(now, stats, maxEmails, fetchImpl) {
  const { marketing } = await engagementCollections();
  const queued = await marketing.find({ kind: "send", status: "queued", campaignId: { $ne: null } }).sort({ createdAt: 1 }).limit(maxEmails).toArray();
  const byCampaign = new Map();
  for (const s of queued) { const k = String(s.campaignId); if (!byCampaign.has(k)) byCampaign.set(k, []); byCampaign.get(k).push(s); }
  for (const [cid, sends] of byCampaign) {
    const c = await marketing.findOne({ _id: toObjectId(cid), kind: "campaign" });
    if (!c || c.status !== "SENDING") { await marketing.updateMany({ _id: { $in: sends.map((s) => s._id) } }, { $set: { status: "cancelled" } }); continue; }
    const settings = await getMarketingSettings(c.orgId);
    // Re-check suppression at the moment of sending (someone may have unsubscribed from another email meanwhile).
    const blocked = await suppressedAmong(c.orgId, sends.map((s) => s.email));
    const skip = sends.filter((s) => blocked.has(normEmail(s.email)));
    if (skip.length) await marketing.updateMany({ _id: { $in: skip.map((s) => s._id) } }, { $set: { status: "suppressed" } });
    const go = sends.filter((s) => !blocked.has(normEmail(s.email)));
    for (let i = 0; i < go.length; i += BATCH) {
      const chunk = go.slice(i, i + BATCH);
      const r = await resendBatch(chunk.map((send) => buildMessage({ send, content: c, settings })), fetchImpl);
      if (r.error) {
        await marketing.updateMany({ _id: { $in: chunk.map((s) => s._id) } }, { $inc: { attempts: 1 }, $set: { lastError: r.error } });
        await marketing.updateMany({ _id: { $in: chunk.map((s) => s._id) }, attempts: { $gte: 3 } }, { $set: { status: "failed" } });
        const failedNow = await marketing.countDocuments({ _id: { $in: chunk.map((s) => s._id) }, status: "failed" });
        if (failedNow) await marketing.updateOne({ _id: c._id }, { $inc: { "stats.failed": failedNow } });
        stats.errors++;
        if (r.retry) return; // provider throttling: stop this run, the next cron run continues
        continue;
      }
      const sentAt = nowIso();
      await marketing.bulkWrite(chunk.map((s, j) => ({ updateOne: { filter: { _id: s._id, status: "queued" }, update: { $set: { status: "sent", providerId: r.ids[j] || null, sentAt } } } })), { ordered: false });
      await marketing.updateOne({ _id: c._id }, { $inc: { "stats.sent": chunk.length } });
      stats.sent += chunk.length;
    }
  }
}

async function finishRuns(now, stats) {
  const { marketing } = await engagementCollections();
  const sending = await marketing.find({ kind: "campaign", status: "SENDING" }).limit(20).toArray();
  for (const c of sending) {
    const left = await marketing.countDocuments({ orgId: c.orgId, kind: "send", campaignId: c._id, runId: c.currentRunId, status: "queued" });
    if (left) continue;
    const { nextRunAfter } = await import("./campaigns.js");
    const rec = c.schedule?.recurrence;
    const next = rec ? nextRunAfter(rec, c.nextRunAt || now) : null;
    const runsDone = (rec?.runsDone || 0) + 1;
    const set = next
      ? { status: "SCHEDULED", nextRunAt: next.toISOString(), "schedule.recurrence.runsDone": runsDone, updatedAt: nowIso() }
      : { status: "SENT", sentAt: nowIso(), nextRunAt: null, ...(rec ? { "schedule.recurrence.runsDone": runsDone } : {}), updatedAt: nowIso() };
    const r = await marketing.updateOne({ _id: c._id, status: "SENDING", currentRunId: c.currentRunId }, { $set: set });
    if (!r.modifiedCount) continue;
    stats.runsFinished++;
    if (c.followUpSequenceId) {
      const { enrollMany } = await import("./sequences.js");
      const recips = await marketing.find({ orgId: c.orgId, kind: "send", campaignId: c._id, runId: c.currentRunId, status: { $in: ["sent", "delivered"] } }).project({ email: 1, name: 1, company: 1, contactId: 1 }).toArray();
      await enrollMany({ orgId: String(c.orgId), sequenceId: c.followUpSequenceId, people: recips, source: `campaign ${c.name}` }).catch((e) => console.warn("follow-up enrolment failed:", e?.message));
    }
    import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId: String(c.orgId), type: "event", key: "campaign.sent", eventId: `campaign.sent:${c._id}:${c.currentRunId}`, payload: { campaign: { id: String(c._id), name: c.name, recipients: c.stats?.recipients || 0 } } })).catch(() => {});
  }
}

/** Cron entry point. */
export async function processCampaigns({ now = new Date(), maxEmails = 900, fetchImpl = fetch } = {}) {
  await ensureEngagementIndexes();
  const stats = { runsStarted: 0, sent: 0, runsFinished: 0, errors: 0, blocked: 0 };
  await startDueRuns(now, stats);
  await deliverQueued(now, stats, maxEmails, fetchImpl);
  await finishRuns(now, stats);
  return stats;
}

/** Sends one email for a send record immediately (sequences). */
export async function sendOne({ send, content, settings, fetchImpl = fetch }) {
  const r = await resendBatch([buildMessage({ send, content, settings })], fetchImpl);
  return r.error ? { error: r.error, retry: r.retry } : { providerId: r.ids[0] || null };
}

// ----------------------------------------------------------------- tracking

async function bumpParent(send, field) {
  const { marketing } = await engagementCollections();
  if (send.campaignId) await marketing.updateOne({ _id: send.campaignId, kind: "campaign" }, { $inc: { [`stats.${field}`]: 1 } });
  if (send.sequenceId) await marketing.updateOne({ _id: send.sequenceId, kind: "sequence" }, { $inc: { [`stats.${field}`]: 1 } });
}

export async function trackOpen(token) {
  const id = verifyToken("o", token);
  if (!id) return false;
  const { marketing } = await engagementCollections();
  const _id = toObjectId(id);
  const first = await marketing.findOneAndUpdate({ _id, kind: "send", openedAt: null }, { $set: { openedAt: nowIso() }, $inc: { opens: 1 } });
  const doc = first?.value !== undefined ? first.value : first;
  if (doc) await bumpParent(doc, "opened");
  else await marketing.updateOne({ _id, kind: "send" }, { $inc: { opens: 1 } });
  return true;
}

/** Returns the destination URL to redirect to, or null for a tampered link. */
export async function trackClick(token, url, sig) {
  const id = verifyToken("c", token);
  if (!id || !/^https:\/\//i.test(String(url || "")) || !verifyClick(id, url, sig)) return null;
  const { marketing } = await engagementCollections();
  const _id = toObjectId(id);
  const at = nowIso();
  await marketing.updateOne({ _id, kind: "send" }, { $inc: { clicks: 1 }, $push: { clickLog: { $each: [{ url: String(url).slice(0, 1000), at }], $slice: -50 } } });
  const firstClick = await marketing.findOneAndUpdate({ _id, kind: "send", clickedAt: null }, { $set: { clickedAt: at } });
  const doc = firstClick?.value !== undefined ? firstClick.value : firstClick;
  if (doc) {
    await bumpParent(doc, "clicked");
    // A click proves an open even when images were blocked.
    const opened = await marketing.updateOne({ _id, openedAt: null }, { $set: { openedAt: at } });
    if (opened.modifiedCount) await bumpParent(doc, "opened");
    import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId: String(doc.orgId), type: "event", key: "marketing.clicked", eventId: `click:${id}`, payload: { email: doc.email, campaignId: doc.campaignId ? String(doc.campaignId) : null, sequenceId: doc.sequenceId ? String(doc.sequenceId) : null, url } })).catch(() => {});
  }
  return url;
}

/** Resend webhook events for marketing sends: delivered, bounced, complained (+ delayed). */
export async function handleProviderEvent(event) {
  const type = event?.type; const providerId = event?.data?.email_id;
  if (!type || !providerId) return { ignored: true };
  const { marketing } = await engagementCollections();
  const send = await marketing.findOne({ kind: "send", providerId });
  if (!send) return { ignored: true };
  if (type === "email.delivered") {
    const r = await marketing.updateOne({ _id: send._id, status: "sent" }, { $set: { status: "delivered", deliveredAt: nowIso() } });
    if (r.modifiedCount) await bumpParent(send, "delivered");
  } else if (type === "email.bounced") {
    const r = await marketing.updateOne({ _id: send._id, status: { $in: ["sent", "delivered"] } }, { $set: { status: "bounced", bounce: { type: event.data?.bounce?.type || null, message: String(event.data?.bounce?.message || "").slice(0, 300) }, bouncedAt: nowIso() } });
    if (r.modifiedCount) {
      await bumpParent(send, "bounced");
      // Soft (transient) bounces don't suppress; permanent ones do.
      const transient = /transient|temporary|soft/i.test(String(event.data?.bounce?.type || ""));
      if (!transient) await suppress({ orgId: send.orgId, email: send.email, reason: "bounced", source: "provider", campaignId: send.campaignId });
    }
  } else if (type === "email.complained") {
    const r = await marketing.updateOne({ _id: send._id, complainedAt: { $exists: false } }, { $set: { complainedAt: nowIso() } });
    if (r.modifiedCount) { await bumpParent(send, "complained"); await suppress({ orgId: send.orgId, email: send.email, reason: "complained", source: "provider", campaignId: send.campaignId }); }
  } else if (type === "email.delivery_delayed") {
    await marketing.updateOne({ _id: send._id }, { $set: { delayedAt: nowIso() } });
  } else {
    return { ignored: true };
  }
  return { ok: true };
}
