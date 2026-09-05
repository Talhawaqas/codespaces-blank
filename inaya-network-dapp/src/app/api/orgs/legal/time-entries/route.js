// app/api/orgs/legal/time-entries/route.js
// GET   ?orgId=&matterId= -> list time entries for a matter
// POST  { orgId, matterId, taskDescription, minutes, rate, ... } -> log time
// PATCH { orgId, timeEntryId, action:"submit"|"approve"|"reject" } -> advance

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createTimeEntry, submitTimeEntry, decideTimeEntry, listTimeEntriesForMatter } from "../../../../../lib/legal-time-tracking.js";

function serialize(t) {
  return { id: t._id.toString(), taskDescription: t.taskDescription, minutes: t.minutes, rate: t.rate, status: t.status, billed: t.billed, entryDate: t.entryDate };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const matterId = searchParams.get("matterId");
    if (!orgId || !matterId) return NextResponse.json({ error: "orgId and matterId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const entries = await listTimeEntriesForMatter(orgId, matterId);
    return NextResponse.json({ timeEntries: entries.map(serialize) });
  } catch (err) {
    console.error("orgs/legal/time-entries GET failed:", err);
    return NextResponse.json({ error: "Could not fetch time entries." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.matterId || !body.minutes) return NextResponse.json({ error: "orgId, matterId, and minutes are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(body.orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createTimeEntry({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ timeEntry: serialize(result.timeEntry) });
  } catch (err) {
    console.error("orgs/legal/time-entries POST failed:", err);
    return NextResponse.json({ error: "Could not log time entry." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, timeEntryId, action } = await req.json();
    if (!orgId || !timeEntryId || !action) return NextResponse.json({ error: "orgId, timeEntryId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    let result;
    if (action === "submit") {
      result = await submitTimeEntry({ orgId, timeEntryId, actorEmail: auth.session.email, membership: auth.membership });
    } else if (action === "approve" || action === "reject") {
      result = await decideTimeEntry({ orgId, timeEntryId, approve: action === "approve", actorEmail: auth.session.email, membership: auth.membership });
    } else {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ timeEntry: serialize(result.timeEntry) });
  } catch (err) {
    console.error("orgs/legal/time-entries PATCH failed:", err);
    return NextResponse.json({ error: "Could not update time entry." }, { status: 500 });
  }
}
