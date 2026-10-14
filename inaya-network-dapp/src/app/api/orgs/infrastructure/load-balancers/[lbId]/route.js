import { route } from "../../_lib.js";
import * as L from "../../../../../../lib/infrastructure/loadBalancers.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId, params }) => L.syncLoadBalancerStatus({ orgId, lbId: params.lbId }));

export const DELETE = (req, ctx) => route(req, ctx, ({ orgId, membership, params }) => L.deleteLoadBalancer({ orgId, membership, lbId: params.lbId }), { requireManage: true });
