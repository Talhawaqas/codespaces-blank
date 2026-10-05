// app/api/orgs/shares/[shareId]/route.js
//   PATCH  { orgId, label?, note?, notifyOnAccess?, expiresAt?, managerEmails?, password? } -> update (creator, delegated manager or admin)
//   DELETE ?orgId                                                                             -> revoke now (same people)
import { shareRoute } from "../_lib.js";
import { revokeShare, updateShare } from "../../../../../lib/sharing/shares.js";
export const dynamic = "force-dynamic";

export async function PATCH(req, ctx) {
  return shareRoute(req, ctx, async ({ orgId, membership, email, body, params }) => {
    const { orgId: _o, ...patch } = body; void _o;
    return updateShare({ orgId, shareId: params.shareId, actorEmail: email, membership, patch });
  });
}
export async function DELETE(req, ctx) {
  return shareRoute(req, ctx, async ({ orgId, membership, email, params }) => revokeShare({ orgId, shareId: params.shareId, actorEmail: email, membership }));
}
