// app/api/orgs/pqc/devices/[deviceId]/active-key/route.js -- resolve the currently-active PQC
// public key for a device, within the caller's own organization. What a sender looks up before
// wrapping a content key to a recipient device (public keys are not secret, but still org-scoped
// for isolation -- any org member can resolve another org member's active key, same trust model
// as existing chat/sharing device lookups).
import * as K from "../../../../../../lib/pqc/deviceKeys.js";
import { pqcRoute } from "../../_lib.js";

export const dynamic = "force-dynamic";

export const GET = (req, ctx) =>
  pqcRoute(req, ctx, async ({ orgId, params }) => {
    const k = await K.activeKeyForDevice({ orgId, deviceId: params.deviceId });
    if (!k) return { key: null };
    return { key: K.keyView(k) };
  });
