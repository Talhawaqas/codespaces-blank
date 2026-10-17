// POST /api/orgs/crm/contacts/:contactId/email  { orgId, subject, body }
//   -> sends from Inaya's mail sender (reply-to is the sender) and logs it
//      on the contact's timeline. Outbound only: replies go to the sender's
//      own inbox; there is no inbox sync.
import { NextResponse } from "next/server";
import { sendContactEmail } from "../../../../../../../lib/crm-activity.js";
import { loadContact, serializeActivity } from "../_contact.js";

export async function POST(req, { params }) {
  try {
    const { contactId } = await params;
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const loaded = await loadContact(req, body.orgId, contactId);
    if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    const result = await sendContactEmail({ orgId: body.orgId, contact: loaded.contact, subject: body.subject, body: body.body, actorEmail: loaded.auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ sent: result.sent, reason: result.reason, activity: serializeActivity(result.activity) });
  } catch (err) {
    console.error("crm/contacts/[contactId]/email failed:", err);
    return NextResponse.json({ error: "Could not send the email." }, { status: 500 });
  }
}
