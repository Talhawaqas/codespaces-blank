// app/api/orgs/shares/route.js -- Secure Sharing 2.0 (behind FEATURE_ADVANCED_SHARING)
//   POST { orgId, documentId, expirationPreset | customExpiresAt, permission, password?, maxUses?, maxDownloads?, oneTime?, ipAllow?[],
//          domainAllow?[], deviceBinding?, notifyOnAccess?, watermark?, label?, note?, managerEmails?[] }
//        -> creates a policy-enforced link (needs MANAGE on the document). The token is returned once.
//   GET  ?orgId&scope=byMe|withMe|org|document&documentId&status=active|expired|revoked|exhausted&limit&before
//        -> the share manager's list (paginated; scope "org" is owner/admin only).
import { shareRoute } from "./_lib.js";
import { requireDocumentAccess, resolveExpiresAt, SHARE_EXPIRATION_PRESETS } from "../../../../lib/document-permissions.js";
import { createLinkShare, listShares, ShareError } from "../../../../lib/sharing/shares.js";
import { getClientIp } from "../../../../lib/rateLimit.js";
export const dynamic = "force-dynamic";

export async function POST(req, ctx) {
  return shareRoute(req, ctx, async ({ orgId, membership, email, body, req: r }) => {
    if (!body.documentId) throw new ShareError(400, "documentId is required.");
    const access = await requireDocumentAccess({ orgId, documentId: body.documentId, membership, email, minLevel: "MANAGE" });
    if (access.error) throw new ShareError(access.status, access.error);
    const expiresAt = resolveExpiresAt({ preset: body.expirationPreset, customExpiresAt: body.customExpiresAt });
    if (!expiresAt) throw new ShareError(400, `expirationPreset must be one of ${Object.keys(SHARE_EXPIRATION_PRESETS).join(", ")}, or customExpiresAt must be a valid future date within one year.`);
    const made = await createLinkShare({ orgId, documentId: body.documentId, actorEmail: email, expiresAt, options: body, role: membership.role, ip: getClientIp(r) });
    return { ...made.share, shareUrl: `${new URL(r.url).origin}/business/share/${made.token}` };
  });
}

export async function GET(req, ctx) {
  return shareRoute(req, ctx, async ({ orgId, membership, email, query }) => {
    if (query.scope === "document" && query.documentId) {
      const access = await requireDocumentAccess({ orgId, documentId: query.documentId, membership, email, minLevel: "MANAGE" });
      if (access.error) throw new ShareError(access.status, access.error);
    }
    return listShares({ orgId, actorEmail: email, membership, scope: query.scope || "byMe", documentId: query.documentId || null, status: query.status || null, limit: query.limit, before: query.before || null });
  });
}
