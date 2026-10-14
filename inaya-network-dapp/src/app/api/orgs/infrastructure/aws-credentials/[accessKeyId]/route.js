import { route } from "../../_lib.js";
import * as A from "../../../../../../lib/infrastructure/awsCredentials.js";

export const DELETE = (req, ctx) => route(req, ctx, ({ orgId, membership, params }) => A.revokeAccessKey({ orgId, membership, accessKeyId: params.accessKeyId }), { requireManage: true });
