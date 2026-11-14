// app/api/orgs/appointments/[[...path]]/route.js -- Appointment Calendar (Business Workspace, Business and Enterprise plans).
// Session + membership, then the plan gate, then routing. Role checks live in src/lib/engagement/*.
//
//   GET dashboard ?scope=mine|team&timeZone&period=week|month|quarter      GET options
//   GET|PUT settings                                                      PUT roles { email, calendarRole|null }
//   GET|PUT availability ?staffEmail                                      (weekly hours, time zone, time off)
//   POST sync/feed | DELETE sync/feed        POST sync/import { url } | DELETE sync/import | POST sync/import/refresh
//   GET|POST types   PATCH types/{id}        GET types/{id}/slots ?from&to&staffEmail
//   GET|POST pages   PATCH pages/{id}
//   GET appointments ?scope=mine|team|department&departmentId&staffEmail&from&to&status&contactId
//   POST appointments { typeId, start, staffEmail?, customer{name,email,phone}, note, answers, timeZone, skipAvailabilityCheck? }
//   GET appointments/{id}   PATCH appointments/{id} { notes, outcome, contactId, addAttachment{documentId,label}, removeAttachmentId }
//   POST appointments/{id}/status { status, reason, outcome }   POST appointments/{id}/reschedule { start, staffEmail? }
//   GET enquiries ?status   PATCH enquiries/{id} { status }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { engagementAccess, setEngagementRole, CALENDAR_ROLES, canManageCalendar, listOrgMembers } from "../../../../../lib/engagement/store.js";
import * as A from "../../../../../lib/engagement/appointments.js";
import * as B from "../../../../../lib/engagement/booking.js";
import * as F from "../../../../../lib/engagement/feeds.js";
import { appointmentDashboard } from "../../../../../lib/engagement/stats.js";
import { isConfigured as smsConfigured } from "../../../../../lib/smsProviders/twilio.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r, ok = 200) => (r?.error ? json({ error: r.error }, r.status || 400) : json(r, ok));

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const q = Object.fromEntries(new URL(req.url).searchParams.entries()); let body = {};
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) { try { body = await req.json(); } catch { body = {}; } }
    const orgId = q.orgId || body.orgId; if (!orgId || typeof orgId !== "string") return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const gate = await engagementAccess(orgId, "appointments"); if (gate) return json({ error: gate.error, upgrade: true }, gate.status);
    const membership = auth.membership, actorEmail = auth.session.email; const base = { orgId, membership, actorEmail }; const [a, b, c, d] = path;

    if (a === "dashboard" && method === "GET") return out(await appointmentDashboard({ ...base, scope: q.scope, timeZone: q.timeZone, period: q.period }));
    if (a === "options" && method === "GET") {
      const members = canManageCalendar(membership) ? (await listOrgMembers(orgId)).map((m) => ({ email: m.email, name: m.name || "", calendarRole: m.calendarRole || null, departmentIds: (m.departmentIds || []).map(String) })) : [];
      return json({ roles: CALENDAR_ROLES, calendarRole: membership.calendarRole || null, canManage: canManageCalendar(membership), statuses: A.STATUSES, locationKinds: A.LOCATION_KINDS, useCases: A.USE_CASES, members, smsAvailable: smsConfigured(), me: actorEmail });
    }
    if (a === "settings") { if (method === "GET") return json({ settings: await A.getCalendarSettings(orgId) }); if (method === "PUT") return out(await A.updateCalendarSettings({ ...base, updates: body })); }
    if (a === "roles" && method === "PUT") return out(await setEngagementRole({ orgId, membership, email: body.email, field: "calendarRole", value: body.calendarRole ?? null }));
    if (a === "availability") {
      if (method === "GET") return out(await A.getAvailability({ ...base, staffEmail: q.staffEmail }));
      if (method === "PUT") return out(await A.saveAvailability({ ...base, staffEmail: body.staffEmail, timeZone: body.timeZone, weekly: body.weekly, timeOff: body.timeOff, bookable: body.bookable }));
    }
    if (a === "sync") {
      if (b === "feed" && method === "POST") return out(await F.enableFeed({ ...base, staffEmail: body.staffEmail }));
      if (b === "feed" && method === "DELETE") return out(await F.disableFeed({ ...base, staffEmail: body.staffEmail }));
      if (b === "import" && !c && method === "POST") return out(await F.connectImport({ ...base, staffEmail: body.staffEmail, url: body.url }));
      if (b === "import" && !c && method === "DELETE") return out(await F.disconnectImport({ ...base, staffEmail: body.staffEmail }));
      if (b === "import" && c === "refresh" && method === "POST") return out(await F.syncImportNow({ ...base, staffEmail: body.staffEmail }));
    }
    if (a === "types") {
      if (!b && method === "GET") return out(await A.listTypes(orgId, { includeArchived: q.archived === "1" }));
      if (!b && method === "POST") return out(await A.createType({ ...base, ...body, orgId }), 201);
      if (b && !c && method === "PATCH") { const { orgId: _o, ...updates } = body; return out(await A.updateType({ ...base, typeId: b, updates })); }
      if (b && c === "slots" && method === "GET") {
        const type = await A.getType(orgId, b); if (!type) return json({ error: "Appointment type not found." }, 404);
        return out(await A.availableSlots({ orgId, type, from: q.from, to: q.to, staffEmail: q.staffEmail || null }));
      }
    }
    if (a === "pages") {
      if (!b && method === "GET") return out(await B.listPages(orgId));
      if (!b && method === "POST") return out(await B.createPage({ ...base, ...body, orgId }), 201);
      if (b && method === "PATCH") { const { orgId: _o, ...updates } = body; return out(await B.updatePage({ ...base, pageId: b, updates })); }
    }
    if (a === "appointments") {
      if (!b && method === "GET") return out(await A.listAppointments({ ...base, scope: q.scope, staffEmail: q.staffEmail, departmentId: q.departmentId, from: q.from, to: q.to, status: q.status, contactId: q.contactId }));
      if (!b && method === "POST") {
        const skip = body.skipAvailabilityCheck === true && canManageCalendar(membership);
        return out(await A.bookAppointment({ orgId, typeId: body.typeId, staffEmail: body.staffEmail || actorEmail, start: body.start, customer: body.customer || {}, customerNote: body.note, answers: body.answers || [], timeZone: body.timeZone, source: "staff", actorEmail, membership, skipAvailabilityCheck: skip }), 201);
      }
      if (b && !c && method === "GET") return out(await A.getAppointment({ ...base, appointmentId: b }));
      if (b && !c && method === "PATCH") return out(await A.updateAppointmentDetails({ ...base, appointmentId: b, notes: body.notes, outcome: body.outcome, contactId: body.contactId, addAttachment: body.addAttachment, removeAttachmentId: body.removeAttachmentId }));
      if (b && c === "status" && method === "POST") return out(await A.transitionAppointment({ ...base, appointmentId: b, toStatus: body.status, reason: body.reason, outcome: body.outcome }));
      if (b && c === "reschedule" && method === "POST") return out(await A.rescheduleAppointment({ ...base, appointmentId: b, start: body.start, staffEmail: body.staffEmail }));
    }
    if (a === "enquiries") {
      if (!b && method === "GET") return out(await B.listEnquiries({ ...base, status: q.status }));
      if (b && method === "PATCH") return out(await B.setEnquiryStatus({ ...base, enquiryId: b, status: body.status }));
    }
    void d;
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error("appointments route failed:", err?.message);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

export const GET = handle; export const POST = handle; export const PUT = handle; export const PATCH = handle; export const DELETE = handle;
