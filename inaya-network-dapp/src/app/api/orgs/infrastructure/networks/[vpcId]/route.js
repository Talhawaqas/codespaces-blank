import { route } from "../../_lib.js";
import * as O from "../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId, params }) => O.getVpc({ orgId, vpcId: params.vpcId }));

export const DELETE = (req, ctx) => route(req, ctx, ({ orgId, membership, params }) => O.deleteVpc({ orgId, membership, vpcId: params.vpcId }), { requireManage: true });
