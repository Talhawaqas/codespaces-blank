// app/api/orgs/pqc/devices/route.js -- PQC device key registry (FEATURE_PQC).
//   GET  ?orgId[&scope=mine|org]   your own device keys, or (deviceAdmin) every key in the org
//   POST { orgId, deviceId, algorithm, publicKey }   register a NEW device's PQC public key; the matching
//                                                     secret key never leaves the device (see custody-sdk's
//                                                     InayaKernel.Pqc.generateDeviceKeyPair()).
import * as K from "../../../../../lib/pqc/deviceKeys.js";
import { pqcRoute } from "./_lib.js";

export const dynamic = "force-dynamic";

export const GET = (req, ctx) =>
  pqcRoute(req, ctx, ({ orgId, membership, email, query, hasAdminRole }) =>
    K.listDeviceKeys({ orgId, membership, email, scope: query.scope, hasAdminRole })
  );

export const POST = (req, ctx) =>
  pqcRoute(req, ctx, ({ orgId, email, body }) =>
    K.registerDeviceKey({ orgId, email, deviceId: body.deviceId, algorithm: body.algorithm, publicKey: body.publicKey })
  );
