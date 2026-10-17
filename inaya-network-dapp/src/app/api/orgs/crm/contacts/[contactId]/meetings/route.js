// POST /api/orgs/crm/contacts/:contactId/meetings
//   { orgId, subject, start (ISO), durationMinutes?, location?, description?, attendeeEmails? }
//   -> emails an RFC 5545 calendar invite (.ics) to the contact and any
//      attendees, and logs the meeting on the contact's timeline.
// GET  /api/orgs/crm/contacts/:contactId/meetings?orgId=...&activityId=...
//   -> downloads that meeting's .ics.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../../../../../../../lib/orgs.js";
import { scheduleMeeting } from "../../../../../../../lib/crm-activity.js";
import { loadContact, serializeActivity } from "../_contact.js";

export async function POST(req, { params }) {
  try {
    const { contactId } = await params;
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const loaded = await loadContact(req, body.orgId, contactId);
    if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    const result = await scheduleMeeting({
      orgId: body.orgId, contact: loaded.contact, start: body.start,
      durationMinutes: body.durationMinutes === undefined ? 30 : Number(body.durationMinutes),
      subject: body.subject, description: body.description, location: body.location,
      attendeeEmails: Array.isArray(body.attendeeEmails) ? body.attendeeEmails : [],
      actorEmail: loaded.auth.session.email,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ activity: serializeActivity(result.activity), deliveries: result.deliveries });
  } catch (err) {
    console.error("crm/contacts/[contactId]/meetings POST failed:", err);
    return NextResponse.json({ error: "Could not schedule the meeting." }, { status: 500 });
  }
}

export async function GET(req, { params }) {
  try {
    const { contactId } = await params;
    const { searchParams } = new URL(req.url);
    const loaded = await loadContact(req, searchParams.get("orgId"), contactId);
    if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    const activityId = searchParams.get("activityId");
    if (!ObjectId.isValid(String(activityId))) return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
    const { crmActivities } = await getOrgCollections();
    const meeting = await crmActivities.findOne({ _id: toObjectId(activityId), contactId: loaded.contact._id, orgId: loaded.contact.orgId, type: "MEETING" });
    if (!meeting?.ics) return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
    return new NextResponse(meeting.ics, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="invite.ics"' } });
  } catch (err) {
    console.error("crm/contacts/[contactId]/meetings GET failed:", err);
    return NextResponse.json({ error: "Could not download the invite." }, { status: 500 });
  }
}
