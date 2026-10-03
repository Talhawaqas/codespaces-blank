// app/api/orgs/s3-compat/notifications/route.js
//
// S3 event notifications for this organization's buckets (see lib/s3-compat/notifications.js).
//
//   GET    ?orgId=[&bucket=][&view=deliveries[&configId=][&status=]]   list configs, or recent deliveries
//   POST   { orgId, action: "create", bucket, url, events[], prefix?, suffix? }   returns the signing secret ONCE
//          { orgId, action: "test", configId }                                   sends a synthetic s3:TestEvent now
//          { orgId, action: "redeliver", deliveryId }                            re-queues a failed/dead delivery
//   PATCH  { orgId, configId, active }                                           enable / disable
//   DELETE ?orgId=&configId=
//
// Owner/admin only: a notification streams object names and sizes from this org's storage to an endpoint.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg } from "../../../../../lib/orgs.js";
import {
  createNotificationConfig, listNotificationConfigs, setNotificationActive, deleteNotificationConfig,
  listNotificationDeliveries, redeliverNotification, sendTestNotification,
} from "../../../../../lib/s3-compat/notifications.js";

async function authorize(req, orgId) {
  if (!orgId) return { response: NextResponse.json({ error: "orgId is required." }, { status: 400 }) };
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  if (!canManageOrg(auth.membership)) return { response: NextResponse.json({ error: "Only the owner or an admin can manage S3 notifications." }, { status: 403 }) };
  return { auth };
}

const reply = (result) => (result?.error ? NextResponse.json({ error: result.error }, { status: result.status || 400 }) : NextResponse.json(result));

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId");
    const { response } = await authorize(req, orgId);
    if (response) return response;
    if (url.searchParams.get("view") === "deliveries") {
      return NextResponse.json(await listNotificationDeliveries({ orgId, configId: url.searchParams.get("configId"), status: url.searchParams.get("status") }));
    }
    return NextResponse.json(await listNotificationConfigs({ orgId, bucket: url.searchParams.get("bucket") }));
  } catch (err) {
    console.error("orgs/s3-compat/notifications GET failed:", err);
    return NextResponse.json({ error: "Could not load notifications." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { response, auth } = await authorize(req, body.orgId);
    if (response) return response;
    if (body.action === "create") {
      return reply(await createNotificationConfig({ orgId: body.orgId, bucket: body.bucket, url: body.url, events: body.events, prefix: body.prefix, suffix: body.suffix, actorEmail: auth.session.email }));
    }
    if (body.action === "test") return reply(await sendTestNotification({ orgId: body.orgId, configId: body.configId }));
    if (body.action === "redeliver") return reply(await redeliverNotification({ orgId: body.orgId, deliveryId: body.deliveryId }));
    return NextResponse.json({ error: "Unrecognized action." }, { status: 400 });
  } catch (err) {
    console.error("orgs/s3-compat/notifications POST failed:", err);
    return NextResponse.json({ error: "Could not complete that request." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, configId, active } = await req.json();
    const { response } = await authorize(req, orgId);
    if (response) return response;
    return reply(await setNotificationActive({ orgId, configId, active }));
  } catch (err) {
    console.error("orgs/s3-compat/notifications PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the notification." }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId");
    const { response } = await authorize(req, orgId);
    if (response) return response;
    return reply(await deleteNotificationConfig({ orgId, configId: url.searchParams.get("configId") }));
  } catch (err) {
    console.error("orgs/s3-compat/notifications DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the notification." }, { status: 500 });
  }
}
