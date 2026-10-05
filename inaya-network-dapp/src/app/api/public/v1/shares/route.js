// GET  /api/public/v1/shares[?status=&documentId=&limit=&before=]   every share in the organization (links and member grants)
// POST /api/public/v1/shares { documentId, expiresAt | expirationPreset | customExpiresAt, options?, memberEmail?, permission? }
//   creates a link share (the token is returned ONCE) or, with memberEmail, a share with a person already in the organization.
//   The same checks as the app apply: the document must belong to this organization, the expiry must be in the future and within a year, and the share
//   policy (and DLP) is enforced. Requires FEATURE_ADVANCED_SHARING. The link's content key lives in the browser fragment: this API shares access and
//   never sees document content.
import * as S from "../../../../../lib/sharing/shares.js";
import { requireDocumentAccess, resolveExpiresAt, SHARE_EXPIRATION_PRESETS } from "../../../../../lib/document-permissions.js";
import { publicRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
const F = { flag: "FEATURE_ADVANCED_SHARING" };
const bad = (message) => { throw new S.ShareError(400, message); };

export const GET = (req, ctx) => publicRoute(req, ctx, F, ({ orgId, membership, email, query }) => S.listShares({ orgId, actorEmail: email, membership, scope: "org", documentId: query.documentId || null, status: query.status || null, limit: query.limit, before: query.before || null }));

export const POST = (req, ctx) => publicRoute(req, ctx, F, async ({ orgId, membership, email, body }) => {
  if (!body.documentId || typeof body.documentId !== "string") bad("documentId is required.");
  const access = await requireDocumentAccess({ orgId, documentId: body.documentId, membership, email, minLevel: "MANAGE" });
  if (access.error) throw new S.ShareError(access.status, access.error);
  if (body.memberEmail) {
    let expiresAt = null;
    if (body.expiresAt) { const ms = new Date(body.expiresAt).getTime(); if (Number.isNaN(ms) || ms <= Date.now() || ms - Date.now() > 365 * 86400_000) bad("expiresAt must be in the future and within one year."); expiresAt = new Date(ms).toISOString(); }
    return S.createMemberShare({ orgId, documentId: body.documentId, actorEmail: email, targetEmail: body.memberEmail, permission: body.permission, expiresAt, note: body.note || null });
  }
  const expiresAt = resolveExpiresAt({ preset: body.expirationPreset, customExpiresAt: body.customExpiresAt || body.expiresAt });
  if (!expiresAt) bad(`expirationPreset must be one of ${Object.keys(SHARE_EXPIRATION_PRESETS).join(", ")}, or expiresAt must be a valid future date within one year.`);
  const made = await S.createLinkShare({ orgId, documentId: body.documentId, actorEmail: email, expiresAt, options: body.options || {}, role: membership.role });
  return { ...made.share, shareId: made.shareId, token: made.token, shareUrl: `${new URL(req.url).origin}/business/share/${made.token}` };
});
