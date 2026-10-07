// app/api/orgs/pqc/devices/[deviceId]/[keyId]/revoke/route.js -- revoke one PQC device key.
// Self-service (the device owner revoking their own key, e.g. after a rotation) or deviceAdmin
// (revoking someone else's as part of device offboarding) -- enforced inside revokeDeviceKey().
import * as K from "../../../../../../../../lib/pqc/deviceKeys.js";
import { pqcRoute } from "../../../_lib.js";

export const dynamic = "force-dynamic";

export const POST = (req, ctx) =>
  pqcRoute(req, ctx, ({ orgId, membership, email, params, body, hasAdminRole }) =>
    K.revokeDeviceKey({ orgId, membership, actorEmail: email, deviceId: params.deviceId, keyId: params.keyId, reason: body.reason, hasAdminRole })
  );
