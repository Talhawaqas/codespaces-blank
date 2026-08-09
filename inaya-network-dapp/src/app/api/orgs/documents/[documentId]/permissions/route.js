// app/api/orgs/documents/[documentId]/permissions/route.js
//
// GET    /api/orgs/documents/:documentId/permissions?orgId=...              -> list explicit grants (MANAGE required)
// POST   /api/orgs/documents/:documentId/permissions { orgId, email, level } -> grant/update (MANAGE required)
// DELETE /api/orgs/documents/:documentId/permissions { orgId, email }        -> revoke (MANAGE required)
//
// This is the "people with access" panel's backend. All three verbs
// require MANAGE-level access to the document — resolved via
// requireDocumentAccess() in document-permissions.js (org owner/admin,
// the document's own uploader, or someone previously granted MANAGE all
// qualify; nothing here checks org role directly, so a MANAGE grant is
// genuinely enough to manage sharing/permissions, per the SOW's own
// permission-level definitions).
//
// Every grant/update/revoke is recorded in the existing append-only
// document_activity log (DOCUMENT_PERMISSION_GRANTED/UPDATED/REVOKED) —
// no separate audit mechanism.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, normalizeEmail, isValidEmail, toObjectId } from "../../../../../../lib/orgs.js";
import { requireDocumentAccess, PERMISSION_LEVELS } from "../../../../../../lib/document-permissions.js";
import { logDocumentActivity } from "../../../../../../lib/document-workflow.js";

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

    const { documentPermissions } = await getOrgCollections();
    const grants = await documentPermissions
      .find({ orgId: toObjectId(orgId), documentId: toObjectId(documentId) })
      .toArray();

    return NextResponse.json({
      owner: access.doc.uploadedByEmail,
      grants: grants.map((g) => ({ email: g.email, level: g.level, grantedByEmail: g.grantedByEmail, grantedAt: g.grantedAt })),
    });
  } catch (err) {
    console.error("orgs/documents/[documentId]/permissions GET failed:", err);
    return NextResponse.json({ error: "Could not fetch permissions." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { documentId } = params;
    const { orgId, email: rawEmail, level } = await req.json();
    const email = normalizeEmail(rawEmail);
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!email || !isValidEmail(email)) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    if (!PERMISSION_LEVELS.includes(level)) return NextResponse.json({ error: `level must be one of: ${PERMISSION_LEVELS.join(", ")}` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const access = await requireDocumentAccess({ orgId, documentId, membership: auth.membership, email: auth.session.email, minLevel: "MANAGE" });
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

    if (email === access.doc.uploadedByEmail) {
      return NextResponse.json({ error: "The document owner already has full access — no grant needed." }, { status: 400 });
    }

    const { orgMembers, documentPermissions } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const documentObjectId = toObjectId(documentId);

    const isOrgMember = await orgMembers.findOne({ orgId: orgObjectId, email, status: "active" });
    if (!isOrgMember) return NextResponse.json({ error: "That person isn't a member of this company yet — invite them first." }, { status: 400 });

    const now = new Date().toISOString();
    const previous = await documentPermissions.findOne({ orgId: orgObjectId, documentId: documentObjectId, email });
    await documentPermissions.updateOne(
      { orgId: orgObjectId, documentId: documentObjectId, email },
      { $set: { level, grantedByEmail: auth.session.email, grantedAt: now }, $setOnInsert: { orgId: orgObjectId, documentId: documentObjectId, email } },
      { upsert: true }
    );

    await logDocumentActivity({
      organizationId: orgObjectId,
      documentId: documentObjectId,
      actorId: auth.session.email,
      action: previous ? "DOCUMENT_PERMISSION_UPDATED" : "DOCUMENT_PERMISSION_GRANTED",
      previousState: previous?.level || null,
      newState: level,
      metadata: { targetEmail: email },
    });

    return NextResponse.json({ email, level });
  } catch (err) {
    console.error("orgs/documents/[documentId]/permissions POST failed:", err);
    return NextResponse.json({ error: "Could not update the permission." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { documentId } = params;
    const { orgId, email: rawEmail } = await req.json();
    const email = normalizeEmail(rawEmail);
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!email) return NextResponse.json({ error: "email is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const access = await requireDocumentAccess({ orgId, documentId, membership: auth.membership, email: auth.session.email, minLevel: "MANAGE" });
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

    const { documentPermissions } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const documentObjectId = toObjectId(documentId);

    const previous = await documentPermissions.findOne({ orgId: orgObjectId, documentId: documentObjectId, email });
    if (!previous) return NextResponse.json({ error: "That person doesn't have an explicit grant on this document." }, { status: 404 });

    await documentPermissions.deleteOne({ orgId: orgObjectId, documentId: documentObjectId, email });

    await logDocumentActivity({
      organizationId: orgObjectId,
      documentId: documentObjectId,
      actorId: auth.session.email,
      action: "DOCUMENT_PERMISSION_REVOKED",
      previousState: previous.level,
      newState: null,
      metadata: { targetEmail: email },
    });

    return NextResponse.json({ revoked: true });
  } catch (err) {
    console.error("orgs/documents/[documentId]/permissions DELETE failed:", err);
    return NextResponse.json({ error: "Could not revoke the permission." }, { status: 500 });
  }
}
