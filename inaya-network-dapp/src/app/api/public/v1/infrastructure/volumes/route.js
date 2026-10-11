import { publicRoute } from "../../_lib.js";
import * as O from "../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, query }) => O.listVolumes({ orgId, clusterId: query.clusterId }).then((volumes) => ({ volumes })));

export const POST = (req, ctx) =>
  publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, membership, body }) => O.createVolume({ orgId, membership, clusterId: body.clusterId, nodeId: body.nodeId, sizeGib: body.sizeGib }));
