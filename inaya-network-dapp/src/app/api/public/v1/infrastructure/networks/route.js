import { publicRoute } from "../../_lib.js";
import * as O from "../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, query }) => O.listVpcs({ orgId, clusterId: query.clusterId }).then((vpcs) => ({ vpcs })));

export const POST = (req, ctx) =>
  publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, membership, body }) =>
    O.createVpc({ orgId, membership, clusterId: body.clusterId, nodeId: body.nodeId, cidr: body.cidr, securityGroupRules: body.securityGroupRules })
  );
