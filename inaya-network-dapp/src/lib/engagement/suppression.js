// src/lib/engagement/suppression.js
//
// Mass Marketing Email SOW — unsubscribe and suppression management, consent
// records, signed tracking/unsubscribe tokens, and the org's marketing
// sender settings.
//
// Suppressed addresses (unsubscribed, hard-bounced, spam complaint, added by
// hand) are never sent marketing email again by this org; transactional
// booking emails are unaffected. Tokens are `${sendId}.${hmac}`, so the
// unsubscribe/open/click links can't be forged or enumerated and need no
// extra lookup index.

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { toObjectId } from "../orgs.js";
import { engagementCollections, ensureEngagementIndexes, nowIso, normEmail, isEmail, fail, clean, canManageMarketing, canViewCampaigns, oid } from "./store.js";

export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "complained", "manual"];

let linkKey = null;
function key() {
  if (linkKey) return linkKey;
  const root = process.env.MARKETING_LINK_SECRET || process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!root) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured.");
  return (linkKey = Buffer.from(hkdfSync("sha256", Buffer.from(root, "utf8"), Buffer.from("inaya-marketing-links"), Buffer.from("v1"), 32)));
}
const mac = (purpose, value) => createHmac("sha256", key()).update(`${purpose}:${value}`).digest("base64url").slice(0, 22);

/** Signed token for a send record (purpose: "u" unsubscribe, "o" open, "c" click). */
export function signToken(purpose, sendId) { return `${sendId}.${mac(purpose, String(sendId))}`; }

export function verifyToken(purpose, token) {
  const [id, sig] = String(token || "").split(".");
  if (!id || !sig || !/^[0-9a-f]{24}$/.test(id)) return null;
  const want = Buffer.from(mac(purpose, id)); const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

/** Click links carry the destination and a signature binding it to the send, so they can't be used as an open redirect. */
export function signClick(sendId, url) { return mac("c-url", `${sendId}|${url}`); }
export function verifyClick(sendId, url, sig) {
  const want = Buffer.from(signClick(sendId, url)); const got = Buffer.from(String(sig || ""));
  return want.length === got.length && timingSafeEqual(want, got);
}

export function _resetLinkKey() { linkKey = null; }

// ----------------------------------------------------------------- settings

export const MARKETING_DEFAULTS = { fromName: "", replyTo: "", postalAddress: "", requireApproval: true, brandColor: "#0b6e75", bookingPageSlug: "", audienceReason: "You're receiving this because you're a customer or contact of ours." };

export async function getMarketingSettings(orgId) {
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  const doc = await marketing.findOne({ orgId: toObjectId(orgId), kind: "settings" });
  const { _id, orgId: _o, kind, ...rest } = doc || {};
  return { ...MARKETING_DEFAULTS, ...rest };
}

export async function updateMarketingSettings({ orgId, membership, actorEmail, updates = {} }) {
  if (!canManageMarketing(membership)) return fail("Only a marketing manager, admin or owner can change email settings.", 403);
  const set = {};
  if (updates.fromName !== undefined) set.fromName = clean(updates.fromName, 80).replace(/[<>"]/g, "");
  if (updates.replyTo !== undefined) { const e = normEmail(updates.replyTo); if (e && !isEmail(e)) return fail("Reply-to must be an email address."); set.replyTo = e; }
  if (updates.postalAddress !== undefined) set.postalAddress = clean(updates.postalAddress, 300);
  if (updates.requireApproval !== undefined) set.requireApproval = updates.requireApproval !== false;
  if (updates.brandColor !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(updates.brandColor)) return fail("Brand colour must be a hex colour like #0b6e75."); set.brandColor = updates.brandColor; }
  if (updates.bookingPageSlug !== undefined) set.bookingPageSlug = clean(updates.bookingPageSlug, 48).toLowerCase();
  if (updates.audienceReason !== undefined) set.audienceReason = clean(updates.audienceReason, 300);
  const { marketing } = await engagementCollections();
  await marketing.updateOne({ orgId: toObjectId(orgId), kind: "settings" }, { $set: { ...set, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { orgId: toObjectId(orgId), kind: "settings", createdAt: nowIso() } }, { upsert: true });
  return { settings: await getMarketingSettings(orgId) };
}

// -------------------------------------------------------------- suppression

export async function isSuppressed(orgId, email) {
  const { marketing } = await engagementCollections();
  return !!(await marketing.findOne({ orgId: toObjectId(orgId), kind: "suppression", email: normEmail(email) }, { projection: { _id: 1 } }));
}

/** The set of suppressed emails among `emails` (one query). */
export async function suppressedAmong(orgId, emails) {
  const { marketing } = await engagementCollections();
  const rows = await marketing.find({ orgId: toObjectId(orgId), kind: "suppression", email: { $in: emails.map(normEmail) } }).project({ email: 1 }).toArray();
  return new Set(rows.map((r) => r.email));
}

export async function suppress({ orgId, email, reason, source = null, campaignId = null, actorEmail = null }) {
  const e = normEmail(email);
  if (!isEmail(e)) return fail("Not an email address.");
  if (!SUPPRESSION_REASONS.includes(reason)) return fail("Unknown reason.");
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  try {
    await marketing.updateOne({ orgId: toObjectId(orgId), kind: "suppression", email: e }, { $setOnInsert: { orgId: toObjectId(orgId), kind: "suppression", email: e, reason, source, campaignId: campaignId ? oid(campaignId) : null, addedBy: actorEmail, createdAt: nowIso() } }, { upsert: true });
  } catch (err) { if (err?.code !== 11000) throw err; }
  // Stop any running follow-up sequences for this address.
  await marketing.updateMany({ orgId: toObjectId(orgId), kind: "enrollment", email: e, status: "ACTIVE" }, { $set: { status: reason === "unsubscribed" ? "UNSUBSCRIBED" : "STOPPED", stoppedReason: reason, updatedAt: nowIso() } });
  return { ok: true, email: e, reason };
}

export async function unsuppress({ orgId, membership, email }) {
  if (!canManageMarketing(membership)) return fail("Only a marketing manager, admin or owner can remove an address from the suppression list.", 403);
  const { marketing } = await engagementCollections();
  const row = await marketing.findOne({ orgId: toObjectId(orgId), kind: "suppression", email: normEmail(email) });
  if (!row) return fail("That address isn't suppressed.", 404);
  if (row.reason === "unsubscribed" || row.reason === "complained") return fail("This person unsubscribed or reported spam. Only they can opt back in (for example through your booking or enquiry form).", 409);
  await marketing.deleteOne({ _id: row._id });
  return { ok: true };
}

export async function listSuppressions({ orgId, membership, q, limit = 200 }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role to see this list.", 403);
  const { marketing } = await engagementCollections();
  const filter = { orgId: toObjectId(orgId), kind: "suppression", ...(q ? { email: { $regex: String(q).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } } : {}) };
  const [rows, total] = await Promise.all([marketing.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 1000)).toArray(), marketing.countDocuments({ orgId: toObjectId(orgId), kind: "suppression" })]);
  return { suppressions: rows.map((r) => ({ email: r.email, reason: r.reason, source: r.source, createdAt: r.createdAt })), total };
}

/** Bulk import of an existing unsubscribe list (CSV pasted as text: one email per line or comma-separated). */
export async function importSuppressions({ orgId, membership, actorEmail, text }) {
  if (!canManageMarketing(membership)) return fail("Only a marketing manager, admin or owner can import a suppression list.", 403);
  const emails = [...new Set(String(text || "").split(/[\s,;]+/).map(normEmail).filter(isEmail))].slice(0, 20000);
  if (!emails.length) return fail("No email addresses found.");
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  const ops = emails.map((e) => ({ updateOne: { filter: { orgId: toObjectId(orgId), kind: "suppression", email: e }, update: { $setOnInsert: { orgId: toObjectId(orgId), kind: "suppression", email: e, reason: "manual", source: "import", addedBy: actorEmail, createdAt: nowIso() } }, upsert: true } }));
  let added = 0;
  for (let i = 0; i < ops.length; i += 1000) { const r = await marketing.bulkWrite(ops.slice(i, i + 1000), { ordered: false }); added += r.upsertedCount || 0; }
  return { added, alreadyListed: emails.length - added };
}

// ------------------------------------------------------------------ consent

export async function recordConsent({ orgId, email, source }) {
  const e = normEmail(email);
  if (!isEmail(e)) return;
  const { marketing } = await engagementCollections();
  await marketing.updateOne({ orgId: toObjectId(orgId), kind: "consent", email: e }, { $set: { source: clean(source, 200), updatedAt: nowIso() }, $setOnInsert: { orgId: toObjectId(orgId), kind: "consent", email: e, createdAt: nowIso() } }, { upsert: true });
  // Explicit opt-in lifts a previous unsubscribe (the person asked again).
  await marketing.deleteOne({ orgId: toObjectId(orgId), kind: "suppression", email: e, reason: "unsubscribed" });
}

export async function consentedAmong(orgId, emails) {
  const { marketing } = await engagementCollections();
  const rows = await marketing.find({ orgId: toObjectId(orgId), kind: "consent", email: { $in: emails.map(normEmail) } }).project({ email: 1 }).toArray();
  return new Set(rows.map((r) => r.email));
}

// ------------------------------------------------------------- unsubscribe

/** The send record behind an unsubscribe token, with org and campaign names for the page. */
export async function unsubscribeInfo(token) {
  const id = verifyToken("u", token);
  if (!id) return fail("This unsubscribe link isn't valid.", 404);
  const { marketing } = await engagementCollections();
  const send = await marketing.findOne({ _id: oid(id), kind: { $in: ["send", "enrollment_send"] } });
  if (!send) return fail("This unsubscribe link isn't valid.", 404);
  const settings = await getMarketingSettings(send.orgId);
  const { getOrgCollections } = await import("../orgs.js");
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: send.orgId }, { projection: { name: 1 } });
  return { send, businessName: settings.fromName || org?.name || "this sender", alreadyUnsubscribed: await isSuppressed(send.orgId, send.email) };
}

export async function unsubscribeByToken(token, { source = "link" } = {}) {
  const info = await unsubscribeInfo(token);
  if (info.error) return info;
  const { send } = info;
  if (!info.alreadyUnsubscribed) {
    await suppress({ orgId: send.orgId, email: send.email, reason: "unsubscribed", source, campaignId: send.campaignId || null });
    const { marketing } = await engagementCollections();
    await marketing.updateOne({ _id: send._id }, { $set: { unsubscribedAt: nowIso() } });
    if (send.campaignId) await marketing.updateOne({ _id: send.campaignId, kind: "campaign" }, { $inc: { "stats.unsubscribed": 1 } });
    import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId: String(send.orgId), type: "event", key: "marketing.unsubscribed", eventId: `unsub:${send._id}`, payload: { email: send.email, campaignId: send.campaignId ? String(send.campaignId) : null } })).catch(() => {});
  }
  return { ok: true, email: send.email, businessName: info.businessName };
}
