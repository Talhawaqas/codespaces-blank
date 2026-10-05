// app/api/orgs/devices/route.js -- device inventory (FEATURE_DEVICE_CONTROL).
//   GET ?orgId[&scope=mine|org|summary]    your devices; every device in the org (owner/admin); or the admin summary
import * as D from "../../../../lib/devices/devices.js";
import { deviceRoute } from "./_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => deviceRoute(req, ctx, ({ orgId, membership, email, query }) => (query.scope === "summary" ? D.deviceSummary({ orgId, membership }) : D.listDevices({ orgId, membership, email, scope: query.scope })));
