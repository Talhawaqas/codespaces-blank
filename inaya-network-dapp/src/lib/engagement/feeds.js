// src/lib/engagement/feeds.js
//
// Appointment Calendar SOW — Google Calendar / Outlook sync without any
// third-party app verification or paid API (founder decision 2026-11-13):
//
//  OUT: each staff member gets a private calendar address (ICS feed) for their
//       Inaya appointments. They paste it once into Google Calendar ("From URL")
//       or Outlook ("Subscribe from web"); the calendar app keeps it updated.
//  IN:  they paste their own calendar's secret iCal address; we read busy times
//       from it (never titles or attendees) every ~15 minutes, so the booking
//       page doesn't offer a slot when they're busy elsewhere.
//
// Feed tokens are stored hashed. Import URLs are secrets and are stored encrypted.

import { randomBytes } from "node:crypto";
import { toObjectId } from "../orgs.js";
import { ssrfSafeFetch } from "../ssrfSafeFetch.js";
import { escapeIcsText, fold, stamp } from "../ics.js";
import { engagementCollections, ensureEngagementIndexes, nowIso, normEmail, fail, canActForStaff } from "./store.js";
import { seal, openSafe } from "./crypto.js";
import { busyFromIcs } from "./icsBusy.js";
import { hashToken, getCalendarSettings } from "./appointments.js";
import { appUrl } from "./messages.js";

const IMPORT_WINDOW_DAYS = 90;
const SYNC_EVERY_MS = 15 * 60000;

async function upsertAvailability(orgId, email, set, unset = null) {
  const { calendar } = await engagementCollections();
  await calendar.updateOne({ orgId: toObjectId(orgId), kind: "availability", staffEmail: email },
    { $set: { ...set, updatedAt: nowIso() }, ...(unset ? { $unset: unset } : {}), $setOnInsert: { orgId: toObjectId(orgId), kind: "availability", staffEmail: email, createdAt: nowIso(), timeZone: "UTC" } }, { upsert: true });
}

// ---------------------------------------------------------------- feed out

/** Creates (or replaces, which revokes the old address) the private feed address. Shown once. */
export async function enableFeed({ orgId, membership, staffEmail }) {
  await ensureEngagementIndexes();
  const email = normEmail(staffEmail || membership.email);
  if (!canActForStaff(membership, email)) return fail("You can only manage your own calendar address.", 403);
  const token = randomBytes(24).toString("base64url");
  await upsertAvailability(orgId, email, { feedTokenHash: hashToken(token), feedCreatedAt: nowIso() });
  const httpsUrl = `${appUrl()}/api/calendar/feed/${token}`;
  return { feedUrl: httpsUrl, webcalUrl: httpsUrl.replace(/^https?:/, "webcal:"), note: "Keep this address private: anyone with it can see your appointment times." };
}

export async function disableFeed({ orgId, membership, staffEmail }) {
  const email = normEmail(staffEmail || membership.email);
  if (!canActForStaff(membership, email)) return fail("You can only manage your own calendar address.", 403);
  await upsertAvailability(orgId, email, {}, { feedTokenHash: "", feedCreatedAt: "" });
  return { ok: true };
}

/** The ICS body for a feed token, or null. Covers 30 days back to 180 days ahead. */
export async function feedIcs(token) {
  if (!token || String(token).length < 20) return null;
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  const avail = await calendar.findOne({ kind: "availability", feedTokenHash: hashToken(token) });
  if (!avail) return null;
  const settings = await getCalendarSettings(avail.orgId);
  const rows = await calendar.find({
    orgId: avail.orgId, kind: "appointment", staffEmail: avail.staffEmail, status: { $in: ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED"] },
    start: { $gt: new Date(Date.now() - 30 * 86400000), $lt: new Date(Date.now() + 180 * 86400000) },
  }).sort({ start: 1 }).limit(2000).toArray();
  const now = new Date();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Inaya Network//Appointments//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(`${settings.businessName} appointments`)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  for (const a of rows) {
    const where = a.location?.joinLink || a.location?.detail || "";
    const desc = [`Customer: ${a.customer?.name || ""} <${a.customer?.email || ""}>`, a.customerNote ? `Note: ${a.customerNote}` : "", `Open: ${appUrl()}/business?view=appointments&appointment=${a._id}`].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:${a.icsUid || `${a._id}@inayanetwork.com`}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(a.start)}`, `DTEND:${stamp(a.end)}`,
      `SUMMARY:${escapeIcsText(`${a.status === "PENDING" ? "[Pending] " : ""}${a.typeName}: ${a.customer?.name || ""}`)}`, `DESCRIPTION:${escapeIcsText(desc)}`,
      ...(where ? [`LOCATION:${escapeIcsText(where)}`] : []), `STATUS:${a.status === "CANCELLED" ? "CANCELLED" : a.status === "PENDING" ? "TENTATIVE" : "CONFIRMED"}`,
      `SEQUENCE:${a.sequence || 0}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ import in

function normalizeImportUrl(raw) {
  let u = String(raw || "").trim();
  if (/^webcals?:\/\//i.test(u)) u = u.replace(/^webcals?:/i, "https:");
  if (!/^https:\/\/\S+$/i.test(u)) return null;
  return u.length <= 2000 ? u : null;
}

async function fetchIcs(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await ssrfSafeFetch(current, { headers: { Accept: "text/calendar, text/plain;q=0.8", "User-Agent": "InayaCalendarSync/1.0" }, timeoutMs: 20000, maxBytes: 4 * 1024 * 1024 });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.location;
      if (!loc) throw new Error(`The calendar address redirected without a destination (HTTP ${res.status}).`);
      current = new URL(loc, current).toString(); // re-validated by ssrfSafeFetch on the next hop
      continue;
    }
    if (!res.ok) throw new Error(res.status === 404 ? "The calendar address wasn't found (it may have been reset)." : `The calendar address returned HTTP ${res.status}.`);
    return res.text();
  }
  throw new Error("The calendar address redirected too many times.");
}

async function syncOne(doc, now = new Date()) {
  const url = openSafe(doc.importUrlSealed);
  if (!url) return { error: "The saved calendar address can't be read; connect it again." };
  const { calendar } = await engagementCollections();
  try {
    const text = await fetchIcs(url);
    const r = busyFromIcs(text, { windowStart: now, windowEnd: new Date(now.getTime() + IMPORT_WINDOW_DAYS * 86400000), defaultTimeZone: doc.timeZone || "UTC" });
    await calendar.updateOne({ _id: doc._id }, { $set: { importedBusy: r.busy.slice(0, 3000), importedAt: nowIso(), importError: null, importEvents: r.events } });
    return { busyBlocks: r.busy.length, events: r.events };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    await calendar.updateOne({ _id: doc._id }, { $set: { importError: msg, importedAt: nowIso() } });
    return { error: msg };
  }
}

/** Saves the user's secret iCal address after a successful test read. */
export async function connectImport({ orgId, membership, staffEmail, url }) {
  await ensureEngagementIndexes();
  const email = normEmail(staffEmail || membership.email);
  if (!canActForStaff(membership, email)) return fail("You can only connect your own calendar.", 403);
  const u = normalizeImportUrl(url);
  if (!u) return fail("Paste the calendar's secret address. It starts with https:// or webcal:// and usually ends in .ics.");
  let test;
  try {
    const text = await fetchIcs(u);
    test = busyFromIcs(text, { windowStart: new Date(), windowEnd: new Date(Date.now() + IMPORT_WINDOW_DAYS * 86400000) });
  } catch (e) {
    return fail(`We couldn't read that calendar: ${String(e?.message || e).slice(0, 200)}`);
  }
  await upsertAvailability(orgId, email, { importUrlSealed: seal(u), importedBusy: test.busy.slice(0, 3000), importedAt: nowIso(), importError: null, importEvents: test.events });
  return { connected: true, busyBlocks: test.busy.length, events: test.events };
}

export async function disconnectImport({ orgId, membership, staffEmail }) {
  const email = normEmail(staffEmail || membership.email);
  if (!canActForStaff(membership, email)) return fail("You can only disconnect your own calendar.", 403);
  await upsertAvailability(orgId, email, { importedBusy: [] }, { importUrlSealed: "", importedAt: "", importError: "", importEvents: "" });
  return { connected: false };
}

export async function syncImportNow({ orgId, membership, staffEmail }) {
  const email = normEmail(staffEmail || membership.email);
  if (!canActForStaff(membership, email)) return fail("You can only sync your own calendar.", 403);
  const { calendar } = await engagementCollections();
  const doc = await calendar.findOne({ orgId: toObjectId(orgId), kind: "availability", staffEmail: email, importUrlSealed: { $type: "string" } });
  if (!doc) return fail("No calendar is connected.", 404);
  return syncOne(doc);
}

/** Cron: refresh imports older than 15 minutes. */
export async function syncDueImports({ limit = 40, now = new Date() } = {}) {
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  const cutoff = new Date(now.getTime() - SYNC_EVERY_MS).toISOString();
  const due = await calendar.find({ kind: "availability", importUrlSealed: { $type: "string" }, $or: [{ importedAt: { $lt: cutoff } }, { importedAt: null }] }).limit(limit).toArray();
  let ok = 0, failed = 0;
  for (const d of due) { const r = await syncOne(d, now); if (r.error) failed++; else ok++; }
  return { checked: due.length, ok, failed };
}
