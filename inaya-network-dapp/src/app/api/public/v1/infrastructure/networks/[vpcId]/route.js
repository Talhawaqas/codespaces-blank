import { publicRoute } from "../../../_lib.js";
import * as O from "../../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, params }) => O.getVpc({ orgId, vpcId: params.vpcId }));

export const DELETE = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, membership, params }) => O.deleteVpc({ orgId, membership, vpcId: params.vpcId }));
