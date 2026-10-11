import { route } from "../../../_lib.js";
import * as I from "../../../../../../../lib/infrastructure/nodes.js";

// Issues a one-time, 30-minute enrollment token for a human operator to
// hand to a new node (e.g. paste into `inaya-infra-cli node enroll`).
// Manage-only — minting join credentials is a privileged action.
export const POST = (req, ctx) =>
  route(req, ctx, ({ orgId, membership, params }) => I.createEnrollmentToken({ orgId, membership, clusterId: params.clusterId }), { requireManage: true });
