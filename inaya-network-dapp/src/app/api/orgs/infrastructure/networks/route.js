import { route } from "../_lib.js";
import * as O from "../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId, query }) => O.listVpcs({ orgId, clusterId: query.clusterId }).then((vpcs) => ({ vpcs })));

export const POST = (req, ctx) =>
  route(
    req,
    ctx,
    ({ orgId, membership, body }) => O.createVpc({ orgId, membership, clusterId: body.clusterId, nodeId: body.nodeId, cidr: body.cidr, securityGroupRules: body.securityGroupRules }),
    { requireManage: true }
  );
