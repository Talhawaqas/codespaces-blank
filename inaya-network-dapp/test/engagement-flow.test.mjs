// test/engagement-flow.test.mjs
//
// Appointments & Campaigns SOW, end to end against the real database: a throwaway company (Business plan) with an owner,
// a staff member and an approver; availability -> type -> booking page -> public booking (+ double-booking refusal) ->
// customer reschedule/cancel tokens -> reminders -> completion logs the CRM meeting -> calendar feed -> dashboard;
// then marketing: settings -> segment -> campaign -> approval (four-eyes) -> delivery through a MOCKED provider ->
// delivered/bounce/complaint webhooks -> open/click tracking -> unsubscribe -> report; and a follow-up sequence.
// No real email or SMS is sent (Resend is mocked; RESEND_API_KEY is not set locally so transactional sends no-op).
// Everything created is removed by exact id / orgId at the end.
//
// Run with: node --env-file=.env.local --test-force-exit --test test/engagement-flow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";

process.env.MARKETING_EMAIL_FROM = "news@mail.test.invalid";
process.env.RESEND_MARKETING_API_KEY = "re_test_mock_only";
const realResendKey = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY; // transactional mail must no-op in this test

const { connectToDatabase } = await import("../src/lib/mongodb.js");
const A = await import("../src/lib/engagement/appointments.js");
const B = await import("../src/lib/engagement/booking.js");
const F = await import("../src/lib/engagement/feeds.js");
const R = await import("../src/lib/engagement/reminders.js");
const ST = await import("../src/lib/engagement/stats.js");
const S = await import("../src/lib/engagement/suppression.js");
const G = await import("../src/lib/engagement/segments.js");
const C = await import("../src/lib/engagement/campaigns.js");
const X = await import("../src/lib/engagement/sender.js");
const Q = await import("../src/lib/engagement/sequences.js");

const { db } = await connectToDatabase();
const orgId = new ObjectId(); const deptId = new ObjectId();
const tag = orgId.toHexString().slice(-6);
const owner = { orgId, email: `owner-${tag}@test.invalid`, role: "owner", status: "active", departmentIds: [deptId] };
const staff = { orgId, email: `staff-${tag}@test.invalid`, role: "member", status: "active", departmentIds: [deptId] };
const approver = { orgId, email: `approver-${tag}@test.invalid`, role: "member", status: "active", departmentIds: [], marketingRole: "approver" };
const customer = { name: "Sara Test", email: `customer-${tag}@test.invalid`, phone: "+92 300 1234567" };
const slug = `eng-test-${tag}`;
const mockFetch = async (_url, init) => { const msgs = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ data: msgs.map(() => ({ id: `mock-${new ObjectId().toHexString()}` })) }) }; };
const ctx = {};

test.before(async () => {
  await db.collection("orgs").insertOne({ _id: orgId, name: `Engagement Test ${tag}`, plan: "business", createdAt: new Date().toISOString() });
  await db.collection("departments").insertOne({ _id: deptId, orgId, name: "Sales", createdAt: new Date().toISOString() });
  await db.collection("org_members").insertMany([owner, staff, approver].map((m) => ({ ...m })));
});

test.after(async () => {
  const both = { $in: [orgId, String(orgId)] };
  await db.collection("calendar_records").deleteMany({ orgId });
  await db.collection("marketing_records").deleteMany({ orgId });
  await db.collection("crm_contacts").deleteMany({ orgId });
  await db.collection("crm_activities").deleteMany({ orgId });
  await db.collection("org_activity").deleteMany({ orgId });
  await db.collection("notifications").deleteMany({ orgId: both });
  await db.collection("org_members").deleteMany({ orgId });
  await db.collection("departments").deleteOne({ _id: deptId });
  await db.collection("orgs").deleteOne({ _id: orgId });
  if (realResendKey) process.env.RESEND_API_KEY = realResendKey;
});

test("plan gate: Business allowed, Starter refused, unknown org 404", async () => {
  const { engagementAccess } = await import("../src/lib/engagement/store.js");
  assert.equal(await engagementAccess(String(orgId)), null);
  await db.collection("orgs").updateOne({ _id: orgId }, { $set: { plan: "starter" } });
  assert.equal((await engagementAccess(String(orgId))).status, 402);
  await db.collection("orgs").updateOne({ _id: orgId }, { $set: { plan: "business" } });
  assert.equal((await engagementAccess(String(new ObjectId()))).status, 404);
});

test("availability, type, page", async () => {
  const weekly = { mon: [{ start: "09:00", end: "17:00" }], tue: [{ start: "09:00", end: "17:00" }], wed: [{ start: "09:00", end: "17:00" }], thu: [{ start: "09:00", end: "17:00" }], fri: [{ start: "09:00", end: "17:00" }], sat: [{ start: "09:00", end: "17:00" }], sun: [{ start: "09:00", end: "17:00" }] };
  const denied = await A.saveAvailability({ orgId: String(orgId), membership: staff, actorEmail: staff.email, staffEmail: owner.email, weekly });
  assert.equal(denied.status, 403, "staff can't edit someone else's hours");
  const av = await A.saveAvailability({ orgId: String(orgId), membership: staff, actorEmail: staff.email, timeZone: "Asia/Karachi", weekly });
  assert.equal(av.availability.timeZone, "Asia/Karachi");
  assert.equal((await A.createType({ orgId: String(orgId), membership: staff, actorEmail: staff.email, name: "x", staffEmails: [staff.email] })).status, 403, "only calendar managers create types");
  const t = await A.createType({ orgId: String(orgId), membership: owner, actorEmail: owner.email, name: "Consultation", useCase: "legal", durationMinutes: 30, minNoticeMinutes: 60, location: "phone", staffEmails: [staff.email], questions: [{ label: "What is it about?", required: true }] });
  assert.ok(t.type?.id, JSON.stringify(t));
  ctx.type = t.type;
  const p = await B.createPage({ orgId: String(orgId), membership: owner, actorEmail: owner.email, slug, title: "Book us", typeIds: [t.type.id] });
  assert.ok(p.page?.url.endsWith(`/book/${slug}`));
  assert.equal((await B.createPage({ orgId: String(orgId), membership: owner, actorEmail: owner.email, slug, title: "dup", typeIds: [t.type.id] })).status, 409);
});

test("public booking: slots, booking, double-booking refused, CRM lead created", async () => {
  const pub = await B.publicPage(slug);
  assert.equal(pub.types.length, 1);
  assert.ok(!JSON.stringify(pub).includes(staff.email), "staff emails never reach the public page");
  const s = await B.publicSlots(slug, { typeId: ctx.type.id, from: new Date().toISOString(), to: new Date(Date.now() + 7 * 86400000).toISOString() });
  assert.ok(s.slots.length > 5, JSON.stringify(s).slice(0, 200));
  ctx.slots = s.slots;
  const missing = await B.publicBook(slug, { typeId: ctx.type.id, start: s.slots[2], ...customer, timeZone: "Europe/London" });
  assert.match(missing.error || "", /Please answer/);
  const qid = pub.types[0].questions[0].id;
  const r = await B.publicBook(slug, { typeId: ctx.type.id, start: s.slots[2], ...customer, timeZone: "Europe/London", answers: [{ id: qid, value: "A contract" }], consentMarketing: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, "CONFIRMED");
  ctx.manageUrl = r.manageUrl; ctx.token = r.manageUrl.split("/").pop();
  const again = await B.publicBook(slug, { typeId: ctx.type.id, start: s.slots[2], name: "Other", email: `other-${tag}@test.invalid`, answers: [{ id: qid, value: "x" }] });
  assert.equal(again.status, 409, "the same slot can't be booked twice");
  const contact = await db.collection("crm_contacts").findOne({ orgId, email: customer.email });
  assert.equal(contact?.type, "LEAD");
  const appt = await db.collection("calendar_records").findOne({ orgId, kind: "appointment" });
  assert.ok(appt.customer.phoneSealed.startsWith("eng1:"), "phone stored encrypted");
  assert.ok(!JSON.stringify(appt).includes("300 1234567"));
  assert.ok(appt.reminders.some((x) => x.channel === "email"));
  ctx.apptId = String(appt._id);
  const page = await db.collection("calendar_records").findOne({ orgId, kind: "page" });
  assert.equal(page.stats.views, 1); assert.equal(page.stats.completions, 1);
});

test("customer self-service: reschedule rotates the link, other people's slots stay protected", async () => {
  const view = await A.customerView(ctx.token);
  assert.equal(view.appointment.id, ctx.apptId);
  assert.ok(!("notes" in view.appointment), "internal notes never shown to the customer");
  const slots = await A.customerSlots({ token: ctx.token, from: new Date().toISOString(), to: new Date(Date.now() + 7 * 86400000).toISOString() });
  const target = slots.slots.find((x) => x !== ctx.slots[2]);
  const r = await A.customerAction({ token: ctx.token, action: "reschedule", start: target });
  assert.ok(r.manageToken, JSON.stringify(r));
  assert.equal((await A.customerView(ctx.token)).status, 404, "old link stops working");
  ctx.token = r.manageToken; ctx.newStart = target;
  const appt = await db.collection("calendar_records").findOne({ _id: new ObjectId(ctx.apptId) });
  assert.equal(appt.start.toISOString(), target);
  assert.equal(appt.sequence, 1);
});

test("reminders: claimed once, error recorded when email isn't configured", async () => {
  const appt = await db.collection("calendar_records").findOne({ _id: new ObjectId(ctx.apptId) });
  const rem = appt.reminders.find((x) => x.channel === "email" && x.offsetMinutes === 60) || appt.reminders.find((x) => x.channel === "email");
  const now = new Date(new Date(rem.dueAt).getTime() + 1000);
  const r1 = await R.processDueReminders({ now });
  const r2 = await R.processDueReminders({ now });
  assert.ok(r1.appointments >= 1);
  const after = await db.collection("calendar_records").findOne({ _id: appt._id });
  const done = after.reminders.find((x) => x.id === rem.id);
  assert.ok(done.sentAt, "claimed");
  assert.ok(r2.email + r2.failed <= r1.email + r1.failed, "not sent twice");
});

test("lifecycle: can't complete a future meeting; a past one completes and logs a CRM MEETING", async () => {
  const early = await A.transitionAppointment({ orgId: String(orgId), membership: staff, actorEmail: staff.email, appointmentId: ctx.apptId, toStatus: "COMPLETED" });
  assert.equal(early.status, 409);
  const past = await A.bookAppointment({ orgId: String(orgId), typeId: ctx.type.id, staffEmail: staff.email, start: new Date(Date.now() - 2 * 3600000).toISOString(), customer, customerNote: "walk-in", answers: [{ id: ctx.type.questions[0].id, value: "x" }], source: "staff", actorEmail: owner.email, membership: owner, skipAvailabilityCheck: true });
  assert.ok(past.appointment, JSON.stringify(past));
  const notes = await A.updateAppointmentDetails({ orgId: String(orgId), membership: staff, actorEmail: staff.email, appointmentId: past.appointment.id, notes: "Discussed the contract." });
  assert.equal(notes.appointment.notes, "Discussed the contract.");
  const sealed = await db.collection("calendar_records").findOne({ _id: new ObjectId(past.appointment.id) });
  assert.ok(sealed.notesSealed.startsWith("eng1:"), "notes encrypted at rest");
  const done = await A.transitionAppointment({ orgId: String(orgId), membership: staff, actorEmail: staff.email, appointmentId: past.appointment.id, toStatus: "COMPLETED", outcome: "Will send proposal" });
  assert.equal(done.appointment.status, "COMPLETED");
  const meeting = await db.collection("crm_activities").findOne({ orgId, type: "MEETING", appointmentId: past.appointment.id });
  assert.equal(meeting?.body, "Will send proposal");
  ctx.pastId = past.appointment.id;
});

test("calendar feed (ICS out) and team/department visibility", async () => {
  const f = await F.enableFeed({ orgId: String(orgId), membership: staff });
  const token = f.feedUrl.split("/").pop();
  const ics = await F.feedIcs(token);
  assert.match(ics, /BEGIN:VCALENDAR/); assert.match(ics, /Consultation: Sara Test/);
  assert.equal(await F.feedIcs("x".repeat(30)), null);
  const mine = await A.listAppointments({ orgId: String(orgId), membership: approver });
  assert.equal(mine.appointments.length, 0, "someone else's calendar isn't visible");
  assert.equal((await A.listAppointments({ orgId: String(orgId), membership: approver, scope: "team" })).status, 403);
  const team = await A.listAppointments({ orgId: String(orgId), membership: owner, scope: "team" });
  assert.ok(team.appointments.length >= 2);
  const dept = await A.listAppointments({ orgId: String(orgId), membership: owner, scope: "department", departmentId: String(deptId) });
  assert.ok(dept.appointments.length >= 2);
  const dash = await ST.appointmentDashboard({ orgId: String(orgId), membership: owner, scope: "team" });
  assert.ok(dash.cards.total.value >= 2); assert.equal(dash.cards.completed.value, 1);
  assert.equal(dash.rates.bookingCompletion, null, "no starts recorded via API in this test");
});

test("customer cancel sends nothing internal back", async () => {
  const r = await A.customerAction({ token: ctx.token, action: "cancel", reason: "Travelling" });
  assert.equal(r.appointment.status, "CANCELLED");
  assert.ok(!("notes" in r.appointment) && !("customerPhone" in r.appointment));
});

test("marketing: approval workflow, delivery, webhooks, tracking, unsubscribe, report", async () => {
  const o = String(orgId);
  assert.equal((await S.updateMarketingSettings({ orgId: o, membership: staff, updates: { fromName: "x" } })).status, 403);
  await S.updateMarketingSettings({ orgId: o, membership: owner, actorEmail: owner.email, updates: { fromName: "Engagement Test", postalAddress: "1 Test Road, Lahore", replyTo: owner.email } });
  // a second contact who will bounce
  await db.collection("crm_contacts").insertOne({ orgId, departmentId: deptId, type: "CUSTOMER", name: "Bounce Me", email: `bounce-${tag}@test.invalid`, createdAt: new Date().toISOString(), deletedAt: null });
  const prev = await G.previewAudience({ orgId: o, membership: owner, rules: {} });
  assert.equal(prev.count, 2);
  const consented = await G.previewAudience({ orgId: o, membership: owner, rules: { consentedOnly: true } });
  assert.equal(consented.count, 1, "only the customer who ticked the box on the booking page");
  const c = await C.createCampaign({ orgId: o, membership: owner, actorEmail: owner.email, name: "Test newsletter", templateId: "starter:newsletter" });
  await C.updateCampaign({ orgId: o, membership: owner, actorEmail: owner.email, campaignId: c.campaign.id, updates: { audience: { rules: {} } } });
  const sub = await C.submitCampaign({ orgId: o, membership: owner, actorEmail: owner.email, campaignId: c.campaign.id });
  assert.equal(sub.campaign?.status, "PENDING_APPROVAL", JSON.stringify(sub));
  assert.equal((await C.decideCampaign({ orgId: o, membership: owner, actorEmail: owner.email, campaignId: c.campaign.id, approve: true })).status, 403, "four-eyes: submitter can't approve");
  const ok = await C.decideCampaign({ orgId: o, membership: approver, actorEmail: approver.email, campaignId: c.campaign.id, approve: true, note: "Looks good" });
  assert.equal(ok.campaign.status, "SCHEDULED");
  const run = await X.processCampaigns({ fetchImpl: mockFetch });
  assert.ok(run.sent >= 2, JSON.stringify(run));
  const done = await C.getCampaign({ orgId: o, membership: owner, campaignId: c.campaign.id });
  assert.equal(done.campaign.status, "SENT");
  const sends = await db.collection("marketing_records").find({ orgId, kind: "send", campaignId: new ObjectId(c.campaign.id) }).toArray();
  assert.equal(sends.length, 2);
  const good = sends.find((s) => s.email === customer.email); const bad = sends.find((s) => s.email !== customer.email);
  await X.handleProviderEvent({ type: "email.delivered", data: { email_id: good.providerId } });
  await X.handleProviderEvent({ type: "email.bounced", data: { email_id: bad.providerId, bounce: { type: "Permanent", message: "no such user" } } });
  assert.equal(await S.isSuppressed(orgId, bad.email), true, "hard bounce suppressed");
  assert.equal(await X.trackOpen(S.signToken("o", String(good._id))), true);
  await X.trackOpen(S.signToken("o", String(good._id)));
  const url = "https://example.com/offer";
  assert.equal(await X.trackClick(S.signToken("c", String(good._id)), url, S.signClick(String(good._id), url)), url);
  assert.equal(await X.trackClick(S.signToken("c", String(good._id)), "https://evil.example", S.signClick(String(good._id), url)), null);
  const un = await S.unsubscribeByToken(S.signToken("u", String(good._id)));
  assert.equal(un.ok, true);
  assert.equal(await S.isSuppressed(orgId, customer.email), true);
  const rep = await C.campaignReport({ orgId: o, membership: owner, campaignId: c.campaign.id });
  const st = rep.campaign.stats;
  assert.deepEqual([st.sent, st.delivered, st.bounced, st.opened, st.clicked, st.unsubscribed], [2, 1, 1, 1, 1, 1], JSON.stringify(st));
  assert.equal(rep.campaign.rates.open, 100);
  assert.equal(rep.links[0].url, url);
  assert.equal((await G.previewAudience({ orgId: o, membership: owner, rules: {} })).count, 0, "both are now suppressed");
  assert.equal((await S.unsuppress({ orgId: o, membership: owner, email: customer.email })).status, 409, "an unsubscribe can't be undone by staff");
});

test("follow-up sequence: approval, enrolment, send, exits on suppression", async () => {
  const o = String(orgId);
  const seq = await Q.saveSequence({ orgId: o, membership: owner, actorEmail: owner.email, name: "After consultation", steps: [{ delayHours: 0, subject: "Thanks {{first_name}}", blocks: [{ type: "text", text: "Thank you." }] }, { delayHours: 48, subject: "Next steps", blocks: [{ type: "text", text: "Here's what's next." }] }] });
  const id = seq.sequence.id;
  await Q.submitSequence({ orgId: o, membership: owner, actorEmail: owner.email, sequenceId: id });
  const fresh = `fresh-${tag}@test.invalid`;
  const en = await Q.enrollMany({ orgId: o, sequenceId: id, people: [{ email: fresh, name: "Fresh Person" }, { email: customer.email }], source: "test" });
  assert.deepEqual([en.enrolled, en.skipped], [1, 1], "suppressed customer skipped");
  const held = await Q.processDueEnrollments({ fetchImpl: mockFetch });
  assert.ok(held.held >= 1, "nothing sends before approval");
  assert.equal((await Q.decideSequence({ orgId: o, membership: approver, actorEmail: approver.email, sequenceId: id, approve: true })).sequence.status, "ACTIVE");
  const r = await Q.processDueEnrollments({ fetchImpl: mockFetch });
  assert.equal(r.sent, 1, JSON.stringify(r));
  const e = await db.collection("marketing_records").findOne({ orgId, kind: "enrollment", email: fresh });
  assert.equal(e.step, 1); assert.equal(e.status, "ACTIVE");
  await S.suppress({ orgId: o, email: fresh, reason: "unsubscribed" });
  assert.equal((await db.collection("marketing_records").findOne({ _id: e._id })).status, "UNSUBSCRIBED");
});
