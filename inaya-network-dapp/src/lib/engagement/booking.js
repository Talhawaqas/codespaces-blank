// src/lib/engagement/booking.js
//
// Appointment Calendar SOW — the customer self-service booking portal:
// public booking pages (/book/{slug}), live slot lookup, booking, and the
// enquiry form that starts the integrated workflow (enquiry -> CRM lead ->
// welcome email -> booking). Funnel counters on the page record
// (views -> starts -> completions) give the booking completion rate the
// SOW's success metric asks for (>= 80%).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { sendEmail } from "../email.js";
import { createNotification } from "../notifications.js";
import { engagementCollections, ensureEngagementIndexes, engagementAccess, oid, nowIso, normEmail, isEmail, fail, clean, canManageCalendar, listOrgMembers } from "./store.js";
import { seal } from "./crypto.js";
import { isValidTimeZone } from "./time.js";
import { getCalendarSettings, getType, availableSlots, bookAppointment, ensureCrmContact, USE_CASES } from "./appointments.js";
import * as MSG from "./messages.js";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const RESERVED = new Set(["manage", "api", "admin", "new", "edit", "inaya", "book", "support", "login"]);

function pageView(p) {
  if (!p) return null;
  const { orgId, kind, ...rest } = p;
  return { ...rest, id: String(p._id), typeIds: (p.typeIds || []).map(String), departmentId: p.departmentId ? String(p.departmentId) : null, url: `${MSG.appUrl()}/book/${p.slug}`, stats: p.stats || { views: 0, starts: 0, completions: 0, enquiries: 0 } };
}

export async function listPages(orgId) {
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  return { pages: (await calendar.find({ orgId: toObjectId(orgId), kind: "page" }).sort({ createdAt: 1 }).limit(50).toArray()).map(pageView) };
}

async function validatePage(orgId, input, existing = {}) {
  const title = input.title !== undefined ? clean(input.title, 100) : existing.title;
  if (!title) return fail("Give the booking page a title.");
  const typeIds = input.typeIds !== undefined ? (input.typeIds || []).map(oid).filter(Boolean) : existing.typeIds || [];
  if (!typeIds.length) return fail("Choose at least one appointment type for the page.");
  const { calendar } = await engagementCollections();
  const found = await calendar.countDocuments({ orgId: toObjectId(orgId), kind: "type", _id: { $in: typeIds } });
  if (found !== typeIds.length) return fail("One of the chosen appointment types doesn't exist.");
  let departmentId = existing.departmentId || null;
  if (input.departmentId !== undefined) {
    if (!input.departmentId) departmentId = null;
    else { const { departments } = await getOrgCollections(); const d = oid(input.departmentId) && await departments.findOne({ _id: oid(input.departmentId), orgId: toObjectId(orgId) }); if (!d) return fail("Department not found.", 404); departmentId = d._id; }
  }
  return {
    doc: {
      title, intro: input.intro !== undefined ? clean(input.intro, 1500) : existing.intro || "", typeIds, departmentId,
      active: input.active !== undefined ? input.active !== false : existing.active !== false,
      enquiryEnabled: input.enquiryEnabled !== undefined ? input.enquiryEnabled !== false : existing.enquiryEnabled !== false,
      showStaffChoice: input.showStaffChoice !== undefined ? input.showStaffChoice === true : existing.showStaffChoice === true,
      brandColor: /^#[0-9a-f]{6}$/i.test(input.brandColor || "") ? input.brandColor : existing.brandColor || "#0b6e75",
      privacyNote: input.privacyNote !== undefined ? clean(input.privacyNote, 600) : existing.privacyNote || "",
    },
  };
}

export async function createPage({ orgId, membership, actorEmail, slug, ...input }) {
  if (!canManageCalendar(membership)) return fail("Only a calendar manager, admin or owner can publish booking pages.", 403);
  await ensureEngagementIndexes();
  const s = String(slug || "").trim().toLowerCase();
  if (!SLUG_RE.test(s) || RESERVED.has(s)) return fail("The page address must be 3-48 lowercase letters, numbers or dashes (for example acme-clinic).");
  const v = await validatePage(orgId, input);
  if (v.error) return v;
  const { calendar } = await engagementCollections();
  try {
    const doc = { orgId: toObjectId(orgId), kind: "page", slug: s, ...v.doc, stats: { views: 0, starts: 0, completions: 0, enquiries: 0 }, createdBy: actorEmail, createdAt: nowIso(), updatedAt: nowIso() };
    const r = await calendar.insertOne(doc);
    return { page: pageView({ ...doc, _id: r.insertedId }) };
  } catch (e) {
    if (e?.code === 11000) return fail("That page address is taken. Try another.", 409);
    throw e;
  }
}

export async function updatePage({ orgId, membership, pageId, updates = {} }) {
  if (!canManageCalendar(membership)) return fail("Only a calendar manager, admin or owner can change booking pages.", 403);
  const { calendar } = await engagementCollections();
  const existing = oid(pageId) && await calendar.findOne({ _id: oid(pageId), orgId: toObjectId(orgId), kind: "page" });
  if (!existing) return fail("Booking page not found.", 404);
  const v = await validatePage(orgId, updates, existing);
  if (v.error) return v;
  await calendar.updateOne({ _id: existing._id }, { $set: { ...v.doc, updatedAt: nowIso() } });
  return { page: pageView(await calendar.findOne({ _id: existing._id })) };
}

async function activePage(slug) {
  await ensureEngagementIndexes();
  const s = String(slug || "").toLowerCase();
  if (!SLUG_RE.test(s)) return null;
  const { calendar } = await engagementCollections();
  const p = await calendar.findOne({ kind: "page", slug: s });
  if (!p || !p.active) return null;
  if (await engagementAccess(String(p.orgId))) return null; // plan lapsed: page goes dark
  return p;
}

const bump = async (p, field) => { const { calendar } = await engagementCollections(); await calendar.updateOne({ _id: p._id }, { $inc: { [`stats.${field}`]: 1 } }); };

/** Public page payload: never exposes staff emails, only display names when the page allows choosing. */
export async function publicPage(slug, { countView = true } = {}) {
  const p = await activePage(slug);
  if (!p) return fail("This booking page isn't available.", 404);
  const settings = await getCalendarSettings(p.orgId);
  const { calendar } = await engagementCollections();
  const types = await calendar.find({ _id: { $in: p.typeIds }, kind: "type", archived: { $ne: true } }).toArray();
  const members = p.showStaffChoice ? new Map((await listOrgMembers(String(p.orgId))).map((m) => [String(m.email).toLowerCase(), m.name || String(m.email).split("@")[0]])) : null;
  if (countView) await bump(p, "views");
  return {
    page: { slug: p.slug, title: p.title, intro: p.intro, brandColor: p.brandColor, enquiryEnabled: p.enquiryEnabled, privacyNote: p.privacyNote, businessName: settings.businessName },
    types: types.map((t) => ({
      id: String(t._id), name: t.name, description: t.description, durationMinutes: t.durationMinutes, location: t.location,
      locationDetail: t.location === "in_person" ? t.locationDetail : "", collectPhone: t.collectPhone !== false, questions: t.questions || [],
      useCase: USE_CASES[t.useCase]?.label || "", requiresConfirmation: !!t.requiresConfirmation,
      staff: members ? t.staffEmails.map((e, i) => ({ key: `s${i}`, name: members.get(e) || "Team member" })) : null,
    })),
  };
}

async function pageType(p, typeId) {
  if (!(p.typeIds || []).some((x) => String(x) === String(typeId))) return null;
  const t = await getType(p.orgId, typeId);
  return t && !t.archived ? t : null;
}

/** staffKey "s0", "s1"... maps to the type's staffEmails index, so emails never reach the browser. */
const staffFromKey = (type, key) => { const m = /^s(\d{1,2})$/.exec(String(key || "")); return m ? type.staffEmails[Number(m[1])] || null : null; };

export async function publicSlots(slug, { typeId, from, to, staffKey }) {
  const p = await activePage(slug);
  if (!p) return fail("This booking page isn't available.", 404);
  const type = await pageType(p, typeId);
  if (!type) return fail("That appointment type isn't offered here.", 404);
  const staffEmail = p.showStaffChoice ? staffFromKey(type, staffKey) : null;
  const r = await availableSlots({ orgId: p.orgId, type, from, to, staffEmail });
  if (r.error) return r;
  return { slots: r.slots.map((s) => s.start), durationMinutes: type.durationMinutes };
}

/** Funnel: the visitor picked a slot and opened the details form. */
export async function publicStart(slug) {
  const p = await activePage(slug);
  if (p) await bump(p, "starts");
  return { ok: true };
}

export async function publicBook(slug, { typeId, start, staffKey, name, email, phone, note, answers, timeZone, consentMarketing }) {
  const p = await activePage(slug);
  if (!p) return fail("This booking page isn't available.", 404);
  const type = await pageType(p, typeId);
  if (!type) return fail("That appointment type isn't offered here.", 404);
  const r = await bookAppointment({
    orgId: String(p.orgId), typeId: type._id, staffEmail: p.showStaffChoice ? staffFromKey(type, staffKey) : null, start,
    customer: { name, email, phone: type.collectPhone !== false ? phone : null }, customerNote: note, answers: Array.isArray(answers) ? answers : [],
    timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC", source: "portal", pageId: p._id,
  });
  if (r.error) return r;
  await bump(p, "completions");
  if (consentMarketing === true) {
    const { recordConsent } = await import("./suppression.js");
    await recordConsent({ orgId: String(p.orgId), email, source: `booking page ${p.slug}` }).catch(() => {});
  }
  return { ok: true, status: r.appointment.status, start: r.appointment.start, end: r.appointment.end, typeName: r.appointment.typeName, location: r.appointment.location, manageUrl: r.manageUrl, emailSent: r.emailSent };
}

/**
 * Enquiry form: step 1 of the integrated workflow. Creates (or finds) the CRM lead, stores the enquiry,
 * sends the automatic welcome email with a booking link, notifies calendar managers and emits
 * enquiry.received so a workflow can enrol the lead in a follow-up sequence.
 */
export async function publicEnquiry(slug, { name, email, phone, company, message, consentMarketing }) {
  const p = await activePage(slug);
  if (!p || !p.enquiryEnabled) return fail("This enquiry form isn't available.", 404);
  const e = normEmail(email);
  if (!isEmail(e)) return fail("Please enter a valid email address.");
  const n = clean(name, 120);
  if (!n) return fail("Please enter your name.");
  const msg = clean(message, 4000);
  if (!msg) return fail("Please tell us how we can help.");
  const ph = clean(phone, 40);
  if (ph && !/^\+?[0-9 ()-]{7,20}$/.test(ph)) return fail("Phone number should look like +92 300 1234567.");
  const orgId = String(p.orgId);
  const settings = await getCalendarSettings(orgId);
  const crm = await ensureCrmContact({ orgId, name: n, email: e, phone: ph, company, departmentId: p.departmentId || settings.defaultDepartmentId, source: `the enquiry form on ${p.slug}` });
  const { calendar } = await engagementCollections();
  const doc = { orgId: p.orgId, kind: "enquiry", pageId: p._id, name: n, email: e, phoneSealed: ph ? seal(ph) : null, company: clean(company, 120), messageSealed: seal(msg), contactId: crm?.contact?._id || null, status: "NEW", createdAt: nowIso(), updatedAt: nowIso() };
  const r = await calendar.insertOne(doc);
  await bump(p, "enquiries");
  if (crm?.contact) {
    const { logActivity } = await import("../crm-activity.js");
    await logActivity({ orgId, contact: crm.contact, type: "NOTE", subject: "Website enquiry", body: msg, at: nowIso(), actorEmail: "enquiry-form", extra: { enquiryId: String(r.insertedId) } }).catch(() => {});
  }
  let welcomeSent = false;
  if (settings.enquiryWelcome) {
    const w = MSG.enquiryWelcomeEmail({ name: n, businessName: settings.businessName, bookingUrl: `${MSG.appUrl()}/book/${p.slug}`, message: settings.enquiryWelcomeMessage || null });
    const d = await sendEmail({ to: e, ...w, replyTo: settings.replyToEmail || undefined }).catch(() => ({ sent: false }));
    welcomeSent = d?.sent !== false;
  }
  const managers = (await listOrgMembers(orgId)).filter((m) => m.role === "owner" || m.role === "admin" || m.calendarRole === "manager");
  for (const m of managers.slice(0, 20)) {
    await createNotification({ scope: "org", orgId: p.orgId, targetEmail: m.email, category: "business", severity: "info", type: "enquiry.received", title: `New enquiry from ${n}`, body: msg.slice(0, 200), sourceModule: "appointments", sourceId: String(r.insertedId), actionUrl: `/business?view=appointments&tab=enquiries`, metadata: {}, dedupeKey: `enquiry:${r.insertedId}:${m.email}` }).catch(() => {});
  }
  if (consentMarketing === true) {
    const { recordConsent } = await import("./suppression.js");
    await recordConsent({ orgId, email: e, source: `enquiry form ${p.slug}` }).catch(() => {});
  }
  import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId, type: "event", key: "enquiry.received", eventId: `enquiry.received:${r.insertedId}`, payload: { enquiry: { id: String(r.insertedId), name: n, email: e, company: doc.company, pageSlug: p.slug }, contactId: crm?.contact ? String(crm.contact._id) : null, contactCreated: !!crm?.created } })).catch(() => {});
  return { ok: true, welcomeSent };
}

export async function listEnquiries({ orgId, membership, status }) {
  if (!canManageCalendar(membership)) return fail("Enquiries are visible to calendar managers, admins and owners.", 403);
  const { calendar } = await engagementCollections();
  const { openSafe } = await import("./crypto.js");
  const rows = await calendar.find({ orgId: toObjectId(orgId), kind: "enquiry", ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(200).toArray();
  return { enquiries: rows.map((x) => ({ id: String(x._id), name: x.name, email: x.email, phone: openSafe(x.phoneSealed), company: x.company, message: openSafe(x.messageSealed) || "", status: x.status, contactId: x.contactId ? String(x.contactId) : null, createdAt: x.createdAt })) };
}

export async function setEnquiryStatus({ orgId, membership, enquiryId, status }) {
  if (!canManageCalendar(membership)) return fail("Only calendar managers, admins and owners can update enquiries.", 403);
  if (!["NEW", "CONTACTED", "BOOKED", "CLOSED"].includes(status)) return fail("Status must be NEW, CONTACTED, BOOKED or CLOSED.");
  const { calendar } = await engagementCollections();
  const r = oid(enquiryId) && await calendar.updateOne({ _id: oid(enquiryId), orgId: toObjectId(orgId), kind: "enquiry" }, { $set: { status, updatedAt: nowIso() } });
  if (!r?.matchedCount) return fail("Enquiry not found.", 404);
  return { ok: true, status };
}
