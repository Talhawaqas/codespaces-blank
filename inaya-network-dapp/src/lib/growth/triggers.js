// src/lib/growth/triggers.js -- Inaya Commerce Phase 4 (Master SOW 8.11): triggered marketing, on top of the existing Email
// Campaigns module (templates, personalization, approval, sending, delivery/bounce handling, unsubscribe and suppression).
//
// A trigger enrols people into an APPROVED email sequence when something happens:
//   FIRST_PURCHASE (welcome) | POST_PURCHASE (review request, N days after a purchase) | REPEAT_REMINDER (N days since the
//   last purchase, for repeat customers) | REPLENISHMENT (N days after buying a chosen product/category) | WIN_BACK
//   (no purchase for N days) | BIRTHDAY (birthday on file + consent) | TIER_CHANGE (loyalty tier went up) |
//   MEMBERSHIP_EXPIRING (14 days before the end) | ABANDONED_CART (only once Online Commerce is live: Phase 5)
// Safeguards, all enforced here before anyone is enrolled:
//   - consent: marketing triggers only reach people who opted in (or are existing customers when the company allows the
//     soft opt-in for its own customers); suppressed / unsubscribed / bounced addresses never
//   - frequency cap: at most N triggered enrolments per person per 7 days (company setting)
//   - quiet hours: enrolments due inside the company's quiet hours wait until they end (company time zone)
//   - once per event: each person/event pair enrols once (idempotent), so re-runs never double-send
//   - test environments: the sender never calls the provider on the test database (engagement/sender.js)
// Channels: EMAIL now. SMS / WhatsApp need an approved provider and policy (owner decision: email only for now) -- the
// channel exists in settings and refuses with a clear reason instead of pretending to send.
// Revenue attribution: till sales by a person within 7 days after they clicked a campaign or sequence email.
// Storage: calendar_records kinds g_trigger (definitions) and g_trigger_fire (one per person+event, for idempotency).
import { getOrgCollections, toObjectId } from "../orgs.js";
import { ccol, ensureCommerceIndexes, fail, clean, nowIso, oid, sid, commerceAccess, audit, fromMinor, getSettings } from "../commerce/store.js";
import { engagementCollections } from "../engagement/store.js";
import { consentedAmong, suppressedAmong } from "../engagement/suppression.js";
import { enrollMany } from "../engagement/sequences.js";

export const KINDS = { trigger: "g_trigger", fire: "g_trigger_fire", settings: "g_automation_settings" };
export const TRIGGER_TYPES = ["FIRST_PURCHASE", "POST_PURCHASE", "REPEAT_REMINDER", "REPLENISHMENT", "WIN_BACK", "BIRTHDAY", "TIER_CHANGE", "MEMBERSHIP_EXPIRING", "ABANDONED_CART"];
export const DEFAULT_AUTOMATION = { frequencyCapPer7Days: 2, quietHours: { from: "21:00", to: "08:00" }, softOptInForCustomers: false, channels: { EMAIL: true, SMS: false, WHATSAPP: false } };
const DAY = 86400000;

export async function getAutomationSettings(orgId) { const c = await ccol(); const s = await c.findOne({ orgId: oid(orgId), kind: KINDS.settings }); return { ...DEFAULT_AUTOMATION, ...(s?.settings || {}) }; }
export async function updateAutomationSettings({ orgId, membership, actorEmail, input }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const out = {};
  if (input.frequencyCapPer7Days !== undefined) { const n = Number(input.frequencyCapPer7Days); if (!(Number.isInteger(n) && n >= 1 && n <= 20)) return fail("Frequency cap 1-20 per 7 days."); out.frequencyCapPer7Days = n; }
  if (input.quietHours !== undefined) { const q = input.quietHours; if (q !== null && !(/^\d{2}:\d{2}$/.test(q.from || "") && /^\d{2}:\d{2}$/.test(q.to || ""))) return fail("Quiet hours are HH:MM to HH:MM."); out.quietHours = q; }
  if (input.softOptInForCustomers !== undefined) out.softOptInForCustomers = input.softOptInForCustomers === true;
  if (input.channels !== undefined) { if (input.channels.SMS || input.channels.WHATSAPP) return fail("SMS and WhatsApp need an approved provider and policy first. Only email is available.", 409, "CHANNEL_NOT_APPROVED"); out.channels = { EMAIL: true, SMS: false, WHATSAPP: false }; }
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  await c.updateOne({ orgId: oid(orgId), kind: KINDS.settings }, { $set: Object.fromEntries(Object.entries(out).map(([k, v]) => [`settings.${k}`, v])), $setOnInsert: { orgId: oid(orgId), kind: KINDS.settings, createdAt: now } }, { upsert: true });
  await audit({ orgId, actorEmail, recordType: "AUTOMATION_SETTINGS", recordId: orgId, action: "AUTOMATION_SETTINGS_CHANGED", newState: out });
  return { settings: await getAutomationSettings(orgId) };
}

export async function saveTrigger({ orgId, membership, actorEmail, id, input }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  if (!TRIGGER_TYPES.includes(input.type)) return fail(`type must be one of ${TRIGGER_TYPES.join(", ")}.`);
  if (input.type === "ABANDONED_CART") return fail("Abandoned-cart reminders start when Online Commerce (Phase 5) is live.", 409, "NEEDS_ONLINE_STORE");
  const { marketing } = await engagementCollections();
  const seq = await marketing.findOne({ _id: toObjectId(input.sequenceId), orgId: toObjectId(orgId), kind: "sequence", archived: { $ne: true } }); if (!seq) return fail("Choose an email sequence (Email Campaigns → Sequences).", 404);
  const days = input.days === undefined || input.days === null || input.days === "" ? null : Number(input.days);
  if (["POST_PURCHASE", "REPEAT_REMINDER", "REPLENISHMENT", "WIN_BACK"].includes(input.type) && !(Number.isInteger(days) && days >= 1 && days <= 730)) return fail("Choose after how many days (1-730).");
  const doc = { name: clean(input.name, 80) || input.type, type: input.type, sequenceId: seq._id, days, productIds: Array.isArray(input.productIds) ? input.productIds.map(String).slice(0, 50) : [], categories: Array.isArray(input.categories) ? input.categories.map((x) => clean(x, 80)).filter(Boolean) : [], active: input.active !== false, channel: "EMAIL" };
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  if (id) { await c.updateOne({ _id: oid(id), orgId: oid(orgId), kind: KINDS.trigger }, { $set: { ...doc, updatedAt: now, updatedBy: actorEmail } }); return { id }; }
  const r = await c.insertOne({ orgId: oid(orgId), kind: KINDS.trigger, ...doc, createdAt: now, createdBy: actorEmail });
  await audit({ orgId, actorEmail, recordType: "AUTOMATION", recordId: r.insertedId, action: "TRIGGER_CREATED", newState: { ...doc, sequenceId: sid(seq._id) } });
  return { id: sid(r.insertedId), sequenceStatus: seq.status };
}
export async function listTriggers({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: KINDS.trigger }).sort({ createdAt: -1 }).toArray();
  return { triggers: await Promise.all(rows.map(async (t) => ({ id: sid(t._id), name: t.name, type: t.type, sequenceId: sid(t.sequenceId), days: t.days, productIds: t.productIds, categories: t.categories, active: t.active, fired: await c.countDocuments({ orgId: oid(orgId), kind: KINDS.fire, triggerId: t._id }) }))) };
}

const hm = (d, tz) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value])); return `${p.hour}:${p.minute}`; };
export function inQuietHours(q, tz, when = new Date()) { if (!q) return false; const t = hm(when, tz); return q.from <= q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to; }

/** Who each trigger would reach now (contacts with an email), before safeguards. */
async function candidates(orgId, t) {
  const { crmContacts, salesOrders } = await getOrgCollections(); const o = toObjectId(orgId); const now = Date.now();
  const base = { orgId: o, deletedAt: null, mergedInto: { $exists: false }, email: { $type: "string", $ne: "" } };
  const proj = { projection: { email: 1, name: 1, company: 1, commerce: 1, birthday: 1, loyalty: 1 } };
  const iso = (ms) => new Date(ms).toISOString();
  switch (t.type) {
    case "FIRST_PURCHASE": return (await crmContacts.find({ ...base, "commerce.purchaseCount": 1, "commerce.firstPurchaseAt": { $gte: iso(now - 2 * DAY) } }, proj).toArray()).map((c) => ({ c, event: `first:${c.commerce.firstPurchaseAt}` }));
    case "POST_PURCHASE": return (await crmContacts.find({ ...base, "commerce.lastPurchaseAt": { $gte: iso(now - (t.days + 1) * DAY), $lt: iso(now - t.days * DAY) } }, proj).toArray()).map((c) => ({ c, event: `post:${c.commerce.lastPurchaseAt}` }));
    case "REPEAT_REMINDER": return (await crmContacts.find({ ...base, "commerce.purchaseCount": { $gte: 2 }, "commerce.lastPurchaseAt": { $gte: iso(now - (t.days + 1) * DAY), $lt: iso(now - t.days * DAY) } }, proj).toArray()).map((c) => ({ c, event: `repeat:${c.commerce.lastPurchaseAt}` }));
    case "WIN_BACK": return (await crmContacts.find({ ...base, "commerce.lastPurchaseAt": { $gte: iso(now - (t.days + 1) * DAY), $lt: iso(now - t.days * DAY) } }, proj).toArray()).map((c) => ({ c, event: `winback:${c.commerce.lastPurchaseAt}` }));
    case "BIRTHDAY": { const md = new Date().toISOString().slice(5, 10); return (await crmContacts.find({ ...base, birthday: md }, proj).toArray()).map((c) => ({ c, event: `birthday:${new Date().getFullYear()}` })); }
    case "TIER_CHANGE": { const { getLoyaltySettings } = await import("./loyalty.js"); const baseTier = (await getLoyaltySettings(orgId)).tiers[0]?.name; return (await crmContacts.find({ ...base, "loyalty.tier": { $exists: true, $ne: baseTier } }, proj).toArray()).map((c) => ({ c, event: `tier:${c.loyalty.tier}` })); }
    case "MEMBERSHIP_EXPIRING": {
      const cc = await ccol(); const soon = await cc.find({ orgId: o, kind: "g_member", status: "ACTIVE", endsAt: { $gt: iso(now), $lte: iso(now + 14 * DAY) } }).toArray();
      const people = await crmContacts.find({ ...base, _id: { $in: soon.map((m) => m.customerId) } }, proj).toArray();
      return people.map((c) => ({ c, event: `member-ending:${soon.find((m) => String(m.customerId) === String(c._id)).endsAt}` }));
    }
    case "REPLENISHMENT": {
      const q = { orgId: o, channel: "POS", status: { $ne: "VOIDED" }, contactId: { $ne: null }, completedAt: { $gte: iso(now - (t.days + 1) * DAY), $lt: iso(now - t.days * DAY) } };
      const ors = []; if (t.productIds?.length) ors.push({ "lines.productId": { $in: t.productIds.map(toObjectId) } }); if (t.categories?.length) ors.push({ "lines.category": { $in: t.categories } }); if (ors.length) q.$or = ors;
      const sales = await salesOrders.find(q, { projection: { contactId: 1, saleNumber: 1 } }).toArray();
      const people = await crmContacts.find({ ...base, _id: { $in: [...new Set(sales.map((s) => String(s.contactId)))].map(toObjectId) } }, proj).toArray();
      return people.map((c) => ({ c, event: `replenish:${sales.find((s) => String(s.contactId) === String(c._id)).saleNumber}` }));
    }
    default: return [];
  }
}

/** Nightly (and on demand): evaluate active triggers, apply every safeguard, enrol the rest. */
export async function runTriggers({ orgId, now = new Date(), dryRun = false }) {
  const c = await ccol(); const o = oid(orgId); const auto = await getAutomationSettings(orgId); const settings = await getSettings(orgId);
  const quiet = inQuietHours(auto.quietHours, settings.timezone, now);
  const out = [];
  for (const t of await c.find({ orgId: o, kind: KINDS.trigger, active: true }).toArray()) {
    const res = { trigger: t.name, type: t.type, candidates: 0, enrolled: 0, skipped: { noConsent: 0, suppressed: 0, frequencyCap: 0, alreadyDone: 0 }, deferredForQuietHours: false };
    if (quiet) { res.deferredForQuietHours = true; out.push(res); continue; }
    const list = await candidates(orgId, t); res.candidates = list.length; if (!list.length) { out.push(res); continue; }
    const emails = list.map((x) => String(x.c.email).toLowerCase());
    const suppressed = new Set(await suppressedAmong(orgId, emails)); const consented = new Set(await consentedAmong(orgId, emails));
    const ok = [];
    for (const x of list) {
      const e = String(x.c.email).toLowerCase();
      if (suppressed.has(e)) { res.skipped.suppressed++; continue; }
      if (!consented.has(e) && !(auto.softOptInForCustomers && x.c.commerce?.purchaseCount > 0)) { res.skipped.noConsent++; continue; }
      if (await c.findOne({ orgId: o, kind: KINDS.fire, triggerId: t._id, contactId: x.c._id, event: x.event })) { res.skipped.alreadyDone++; continue; }
      const recent = await c.countDocuments({ orgId: o, kind: KINDS.fire, contactId: x.c._id, at: { $gte: new Date(now.getTime() - 7 * DAY).toISOString() } });
      if (recent >= auto.frequencyCapPer7Days) { res.skipped.frequencyCap++; continue; }
      ok.push(x);
    }
    if (!dryRun && ok.length) {
      for (const x of ok) await c.updateOne({ orgId: o, kind: KINDS.fire, triggerId: t._id, contactId: x.c._id, event: x.event }, { $setOnInsert: { orgId: o, kind: KINDS.fire, triggerId: t._id, contactId: x.c._id, event: x.event, at: now.toISOString() } }, { upsert: true });
      const r = await enrollMany({ orgId, sequenceId: sid(t.sequenceId), people: ok.map((x) => ({ email: x.c.email, name: x.c.name, company: x.c.company, contactId: x.c._id })), source: `trigger:${t.type}` });
      res.enrolled = r.enrolled || 0; res.sequenceStatus = r.sequenceStatus;
    } else res.wouldEnrol = ok.length;
    out.push(res);
  }
  return { ranAt: now.toISOString(), quietHours: quiet, triggers: out };
}

/** Till revenue attributed to marketing email: a sale by the same person within 7 days after they clicked. */
export async function attribution({ orgId, membership, days = 90 }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const { marketing } = await engagementCollections(); const { crmContacts, salesOrders } = await getOrgCollections(); const o = toObjectId(orgId);
  const since = new Date(Date.now() - days * DAY).toISOString();
  const clicks = await marketing.find({ orgId: o, kind: "send", clickedAt: { $gte: since } }, { projection: { email: 1, clickedAt: 1, campaignId: 1, sequenceId: 1 } }).limit(20000).toArray();
  const byEmail = new Map(); for (const k of clicks) byEmail.set(k.email, [...(byEmail.get(k.email) || []), k]);
  const contacts = await crmContacts.find({ orgId: o, email: { $in: [...byEmail.keys()] } }, { projection: { email: 1 } }).toArray();
  const per = new Map(); let total = 0;
  for (const ct of contacts) {
    const ks = byEmail.get(String(ct.email).toLowerCase()) || []; if (!ks.length) continue;
    const sales = await salesOrders.find({ orgId: o, contactId: ct._id, channel: "POS", status: { $ne: "VOIDED" }, completedAt: { $gte: since } }, { projection: { completedAt: 1, totals: 1, refundedMinor: 1 } }).toArray();
    for (const s of sales) {
      const k = ks.filter((x) => x.clickedAt <= s.completedAt && Date.parse(s.completedAt) - Date.parse(x.clickedAt) <= 7 * DAY).sort((a, b) => b.clickedAt.localeCompare(a.clickedAt))[0]; if (!k) continue;
      const key = sid(k.campaignId || k.sequenceId) || "unknown"; const v = s.totals.totalMinor - (s.refundedMinor || 0);
      const a = per.get(key) || { id: key, sales: 0, revenueMinor: 0 }; a.sales++; a.revenueMinor += v; per.set(key, a); total += v;
    }
  }
  return { windowDays: days, rule: "Last click within 7 days before a till sale by the same person.", total: fromMinor(total), byCampaign: [...per.values()].map((a) => ({ id: a.id, sales: a.sales, revenue: fromMinor(a.revenueMinor) })).sort((x, y) => y.revenue - x.revenue) };
}
