// app/api/orgs/shares/member/route.js -- POST { orgId, documentId, email, permission: view|edit|manage, expiresAt? }
// Share with a person already in the organization (an explicit, optionally expiring document grant). Needs MANAGE on the document.
import { shareRoute } from "../_lib.js";
import { requireDocumentAccess } from "../../../../../lib/document-permissions.js";
import { createMemberShare, ShareError } from "../../../../../lib/sharing/shares.js";
export const dynamic = "force-dynamic";
export async function POST(req, ctx) {
  return shareRoute(req, ctx, async ({ orgId, membership, email, body }) => {
    if (!body.documentId) throw new ShareError(400, "documentId is required.");
    const access = await requireDocumentAccess({ orgId, documentId: body.documentId, membership, email, minLevel: "MANAGE" });
    if (access.error) throw new ShareError(access.status, access.error);
    let expiresAt = null;
    if (body.expiresAt) { const ms = new Date(body.expiresAt).getTime(); if (Number.isNaN(ms) || ms <= Date.now() || ms - Date.now() > 365 * 86400_000) throw new ShareError(400, "expiresAt must be in the future and within one year."); expiresAt = new Date(ms).toISOString(); }
    return createMemberShare({ orgId, documentId: body.documentId, actorEmail: email, targetEmail: body.email, permission: body.permission, expiresAt, note: body.note });
  });
}
