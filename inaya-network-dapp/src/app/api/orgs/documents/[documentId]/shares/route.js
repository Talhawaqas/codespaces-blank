// app/api/orgs/documents/[documentId]/shares/route.js
//
// POST /api/orgs/documents/:documentId/shares
//   Body: { orgId, expirationPreset OR customExpiresAt, maxUses? }
//   Creates a share link. Requires MANAGE-level document access. The raw
//   token is returned exactly once, here — it's stored only as a SHA-256
//   hash (createDocumentShare(), document-permissions.js), so this is the
//   only response that will ever contain it.
//
// GET /api/orgs/documents/:documentId/shares?orgId=...
//   Lists this document's shares (MANAGE required) for the "view active
//   shares" / revoke UI — token hashes are never returned, only enough to
//   identify and manage each share (creator, expiry, use count, status).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireDocumentAccess, createDocumentShare, resolveExpiresAt, SHARE_EXPIRATION_PRESETS } from "../../../../../../lib/document-permissions.js";
import { logDocumentActivity } from "../../../../../../lib/document-workflow.js";
import { getOrgCollections, toObjectId } from "../../../../../../lib/orgs.js";

export async function POST(req, { params }) {
  try {
    const { documentId } = params;
    const { orgId, expirationPreset, customExpiresAt, maxUses } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    if (maxUses !== undefined && maxUses !== null) {
      if (!Number.isInteger(maxUses) || maxUses < 1) {
        return NextResponse.json({ error: "maxUses must be a positive integer if provided." }, { status: 400 });
      }
    }

    const expiresAt = resolveExpiresAt({ preset: expirationPreset, customExpiresAt });
    if (!expiresAt) {
      return NextResponse.json({ error: `expirationPreset must be one of ${Object.keys(SHARE_EXPIRATION_PRESETS).join(", ")}, or customExpiresAt must be a valid future date within one year.` }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const access = await requireDocumentAccess({ orgId, documentId, membership: auth.membership, email: auth.session.email, minLevel: "MANAGE" });
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

    const { shareId, token } = await createDocumentShare({
      orgId,
      documentId,
      createdByEmail: auth.session.email,
      expiresAt,
      maxUses: maxUses ?? null,
    });

    await logDocumentActivity({
      organizationId: orgId,
      documentId,
      actorId: auth.session.email,
      action: "DOCUMENT_SHARE_CREATED",
      previousState: null,
      newState: null,
      metadata: { shareId: shareId.toString(), expiresAt, maxUses: maxUses ?? null },
    });

    const origin = new URL(req.url).origin;
    return NextResponse.json({ shareUrl: `${origin}/business/share/${token}`, expiresAt, maxUses: maxUses ?? null });
  } catch (err) {
    console.error("orgs/documents/[documentId]/shares POST failed:", err);
    return NextResponse.json({ error: "Could not create the share link." }, { status: 500 });
  }
}

export async function GET(req, { params }) {
  try {
    const { documentId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const access = await requireDocumentAccess({ orgId, documentId, membership: auth.membership, email: auth.session.email, minLevel: "MANAGE" });
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

    const { documentShares } = await getOrgCollections();
    const shares = await documentShares
      .find({ orgId: toObjectId(orgId), documentId: toObjectId(documentId) })
      .sort({ createdAt: -1 })
      .toArray();

    const now = Date.now();
    return NextResponse.json({
      shares: shares.map((s) => ({
        shareId: s._id.toString(),
        createdByEmail: s.createdByEmail,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        maxUses: s.maxUses,
        useCount: s.useCount,
        revokedAt: s.revokedAt,
        status: s.revokedAt ? "revoked" : new Date(s.expiresAt).getTime() < now ? "expired" : s.maxUses !== null && s.useCount >= s.maxUses ? "exhausted" : "active",
      })),
    });
  } catch (err) {
    console.error("orgs/documents/[documentId]/shares GET failed:", err);
    return NextResponse.json({ error: "Could not fetch shares." }, { status: 500 });
  }
}
