// GET  /api/orgs/crm/contacts/:contactId/activities?orgId=...  -> timeline + lead score
// POST /api/orgs/crm/contacts/:contactId/activities  { orgId, type: NOTE|CALL, subject?, body?, at?, durationMinutes? }
//   (EMAIL and MEETING have their own routes, since they send something.)
import { NextResponse } from "next/server";
import { listActivities, logActivity, scoreContact } from "../../../../../../../lib/crm-activity.js";
import { loadContact, serializeActivity } from "../_contact.js";

export async function GET(req, { params }) {
  try {
    const { contactId } = await params;
    const loaded = await loadContact(req, new URL(req.url).searchParams.get("orgId"), contactId);
    if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    const orgId = loaded.contact.orgId.toString();
    const [activities, score] = await Promise.all([listActivities(orgId, contactId), scoreContact(orgId, loaded.contact)]);
    return NextResponse.json({ activities: activities.map(serializeActivity), score });
  } catch (err) {
    console.error("crm/contacts/[contactId]/activities GET failed:", err);
    return NextResponse.json({ error: "Could not load activity." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { contactId } = await params;
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (!["NOTE", "CALL"].includes(body.type)) return NextResponse.json({ error: "type must be NOTE or CALL here." }, { status: 400 });
    const loaded = await loadContact(req, body.orgId, contactId);
    if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    const result = await logActivity({
      orgId: body.orgId, contact: loaded.contact, type: body.type, subject: body.subject, body: body.body,
      at: body.at, durationMinutes: body.durationMinutes ?? undefined, actorEmail: loaded.auth.session.email,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeActivity(result.activity));
  } catch (err) {
    console.error("crm/contacts/[contactId]/activities POST failed:", err);
    return NextResponse.json({ error: "Could not log the activity." }, { status: 500 });
  }
}
