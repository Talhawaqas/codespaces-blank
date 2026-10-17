// test/crm-activity.test.mjs
//
// Business Workspace gap closure, Batch 2 — CRM depth: explainable lead
// score, activity timeline, email from CRM and calendar invites
// (src/lib/crm-activity.js, src/lib/ics.js). Email goes to a fake sender.
//
// Run with: node --env-file=.env.local --test test/crm-activity.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { computeLeadScore, scoreContact, logActivity, listActivities, sendContactEmail, scheduleMeeting } from "../src/lib/crm-activity.js";
import { buildInvite, escapeIcsText } from "../src/lib/ics.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const ACTOR = `test-crm-${RUN_ID}@example.com`;
const NOW = Date.UTC(2026, 9, 17);
let c;
const cleanup = { orgIds: [] };

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); });
after(async () => {
  const f = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([c.crmContacts, c.crmDeals, c.crmActivities, c.orgActivity, c.auditChainEntries, c.auditChainHeads].map((x) => x.deleteMany(f)));
  await c.orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await (await mongoClientPromise).close();
});

function fakeSender() {
  const sent = [];
  const fn = async (m) => { sent.push(m); return { sent: true }; };
  fn.sent = sent;
  return fn;
}

async function makeContact(extra = {}) {
  const org = await c.orgs.insertOne({ name: `crm-${RUN_ID}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(org.insertedId);
  const doc = { orgId: org.insertedId, departmentId: org.insertedId, type: "LEAD", name: "Dana Ortiz", email: "dana@example.com", phone: "+1 555 0100", company: "Ortiz Labs", deletedAt: null, ...extra };
  const r = await c.crmContacts.insertOne(doc);
  return { orgId: org.insertedId.toString(), contact: { ...doc, _id: r.insertedId } };
}

test("computeLeadScore: fixed rules, every point explained, capped at 100", () => {
  const empty = computeLeadScore({ contact: {}, now: NOW });
  assert.equal(empty.score, 0);
  assert.equal(empty.band, "COLD");

  const hot = computeLeadScore({
    contact: { email: "a@b.co", phone: "1", company: "X" },
    deals: [{ status: "NEGOTIATION", value: 60000 }, { status: "WON", value: 5000 }, { status: "LOST", value: 1e6 }],
    activityDates: [NOW - 1 * 864e5, NOW - 2 * 864e5, NOW - 3 * 864e5],
    now: NOW,
  });
  assert.equal(hot.score, 100);
  assert.equal(hot.band, "HOT");
  assert.equal(hot.reasons.reduce((s, r) => s + r.points, 0), 100, "the reasons add up to the score");
  assert.ok(hot.reasons.some((r) => /NEGOTIATION/.test(r.label)));

  const warm = computeLeadScore({ contact: { email: "a@b.co", company: "X" }, deals: [{ status: "QUALIFIED", value: 2000 }], activityDates: [NOW - 30 * 864e5], now: NOW });
  assert.equal(warm.score, 10 + 10 + 15 + 5 + 5);
  assert.deepEqual(computeLeadScore({ contact: { email: "a@b.co" }, now: NOW }), computeLeadScore({ contact: { email: "a@b.co" }, now: NOW }), "deterministic");
});

test("activities: notes and calls are validated, listed newest first, and feed the score", async () => {
  const { orgId, contact } = await makeContact();
  assert.equal((await logActivity({ orgId, contact, type: "NOTE", body: "", actorEmail: ACTOR })).status, 400);
  assert.equal((await logActivity({ orgId, contact, type: "SMOKE_SIGNAL", subject: "x", actorEmail: ACTOR })).status, 400);
  await logActivity({ orgId, contact, type: "NOTE", body: "Interested in the enterprise plan.", at: "2026-10-10T09:00:00Z", actorEmail: ACTOR });
  await logActivity({ orgId, contact, type: "CALL", subject: "Discovery call", durationMinutes: 25, actorEmail: ACTOR });
  const list = await listActivities(orgId, contact._id.toString());
  assert.deepEqual(list.map((a) => a.type), ["CALL", "NOTE"]);
  const score = await scoreContact(orgId, contact);
  assert.ok(score.reasons.some((r) => /interaction/.test(r.label)));
});

test("sendContactEmail: sends via the mail sender and logs the outcome, including a failed delivery", async () => {
  const { orgId, contact } = await makeContact();
  const sender = fakeSender();
  const ok = await sendContactEmail({ orgId, contact, subject: "Proposal", body: "Hi Dana,\nAttached is <b>our</b> proposal.", actorEmail: ACTOR, sender });
  assert.equal(ok.sent, true);
  assert.equal(sender.sent[0].to, "dana@example.com");
  assert.equal(sender.sent[0].replyTo, ACTOR);
  assert.ok(sender.sent[0].html.includes("&lt;b&gt;"), "body is HTML-escaped");
  const down = await sendContactEmail({ orgId, contact, subject: "x", body: "y", actorEmail: ACTOR, sender: async () => ({ sent: false, reason: "not_configured" }) });
  assert.equal(down.sent, false);
  assert.equal(down.activity.delivery, "NOT_SENT");
  const noEmail = await makeContact({ email: null });
  assert.equal((await sendContactEmail({ orgId: noEmail.orgId, contact: noEmail.contact, subject: "x", body: "y", actorEmail: ACTOR, sender })).status, 400);
});

test("scheduleMeeting: emails a valid RFC 5545 invite to the contact and attendees and logs it", async () => {
  const { orgId, contact } = await makeContact();
  const sender = fakeSender();
  const r = await scheduleMeeting({ orgId, contact, start: "2026-11-03T15:00:00Z", durationMinutes: 45, subject: "Demo; pricing, Q&A", location: "Video call", attendeeEmails: ["Sam@Example.com"], actorEmail: ACTOR, sender });
  assert.equal(sender.sent.length, 2);
  assert.deepEqual(sender.sent.map((m) => m.to), ["dana@example.com", "sam@example.com"]);
  const att = sender.sent[0].attachments[0];
  assert.equal(att.filename, "invite.ics");
  const ics = Buffer.from(att.content, "base64").toString("utf8");
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /METHOD:REQUEST/);
  assert.match(ics, /DTSTART:20261103T150000Z/);
  assert.match(ics, /DTEND:20261103T154500Z/);
  assert.match(ics, /SUMMARY:Demo\\; pricing\\, Q&A/);
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines are folded at 75 octets");
  assert.equal(r.activity.type, "MEETING");
  assert.equal(r.activity.at, "2026-11-03T15:00:00.000Z");
  assert.equal((await scheduleMeeting({ orgId, contact, start: "nope", subject: "x", actorEmail: ACTOR, sender })).status, 400);
  assert.equal((await scheduleMeeting({ orgId, contact, start: "2026-11-03T15:00:00Z", subject: "x", attendeeEmails: ["bad"], actorEmail: ACTOR, sender })).status, 400);
});

test("ics: escaping and folding of long multi-byte text", () => {
  assert.equal(escapeIcsText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  const ics = buildInvite({ uid: "x@y", start: "2026-01-01T00:00:00Z", summary: "é".repeat(120), now: new Date("2026-01-01T00:00:00Z") });
  const unfolded = ics.replace(/\r\n /g, "");
  assert.ok(unfolded.includes(`SUMMARY:${"é".repeat(120)}`), "folding never splits a character");
});
