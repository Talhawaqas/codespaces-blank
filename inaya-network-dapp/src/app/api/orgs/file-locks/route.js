// app/api/orgs/file-locks/route.js -- file locking (Competitive Expansion SOW B4), behind FEATURE_ADVANCED_SHARING.
//   POST   { orgId, documentId, leaseMinutes?, reason? }   take or renew a lock (needs EDIT on the document). 423 if someone else holds it.
//   DELETE ?orgId&documentId[&force=1]                     release your lock; force=1 breaks someone else's (MANAGE on the document, or owner/admin)
//   GET    ?orgId&documentId                               who holds the lock on one document
//   GET    ?orgId&scope=mine|org                           your locks / every lock in force (owner/admin)
// Enforcement is at the storage chokepoints (S3/Azure store, new-version route), not here: see src/lib/filelocks.js.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { requireDocumentAccess } from "../../../../lib/document-permissions.js";
import { LockError, acquireLock, getLockInfo, listLocks, releaseLock } from "../../../../lib/filelocks.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function gate(req, orgId) {
  if (!orgId) return { res: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { res: json({ error: auth.error }, auth.status) };
  const off = await requireFeature("FEATURE_ADVANCED_SHARING", orgId);
  if (off) return { res: json({ error: off.error }, off.status) };
  return { auth };
}
const fail = (err) => {
  if (err instanceof LockError) return json({ error: err.message, ...(err.lockedBy ? { lockedBy: err.lockedBy } : {}), ...(err.expiresAt ? { expiresAt: err.expiresAt } : {}) }, err.status);
  console.error("file-locks route failed:", err?.name, String(err?.message || "").slice(0, 200));
  return json({ error: "Something went wrong. Please try again." }, 500);
};

export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const g = await gate(req, body.orgId); if (g.res) return g.res;
    if (!body.documentId) return json({ error: "documentId is required." }, 400);
    const access = await requireDocumentAccess({ orgId: body.orgId, documentId: body.documentId, membership: g.auth.membership, email: g.auth.session.email, minLevel: "EDIT" });
    if (access.error) return json({ error: access.error }, access.status);
    return json(await acquireLock({ orgId: body.orgId, documentId: body.documentId, actorEmail: g.auth.session.email, leaseMinutes: body.leaseMinutes, reason: body.reason }));
  } catch (err) { return fail(err); }
}

export async function DELETE(req) {
  try {
    const q = new URL(req.url).searchParams; const orgId = q.get("orgId"); const documentId = q.get("documentId");
    const g = await gate(req, orgId); if (g.res) return g.res;
    if (!documentId) return json({ error: "documentId is required." }, 400);
    const access = await requireDocumentAccess({ orgId, documentId, membership: g.auth.membership, email: g.auth.session.email, minLevel: "VIEW" });
    if (access.error) return json({ error: access.error }, access.status);
    const force = q.get("force") === "1";
    const canForce = force && (await requireDocumentAccess({ orgId, documentId, membership: g.auth.membership, email: g.auth.session.email, minLevel: "MANAGE" })).error === undefined;
    return json(await releaseLock({ orgId, documentId, actorEmail: g.auth.session.email, membership: g.auth.membership, force, canForce }));
  } catch (err) { return fail(err); }
}

export async function GET(req) {
  try {
    const q = new URL(req.url).searchParams; const orgId = q.get("orgId");
    const g = await gate(req, orgId); if (g.res) return g.res;
    const documentId = q.get("documentId");
    if (documentId) {
      const access = await requireDocumentAccess({ orgId, documentId, membership: g.auth.membership, email: g.auth.session.email, minLevel: "VIEW" });
      if (access.error) return json({ error: access.error }, access.status);
      const info = await getLockInfo({ orgId, documentId });
      return json({ ...info, mine: !!info.locked && String(info.byEmail).toLowerCase() === String(g.auth.session.email).toLowerCase() });
    }
    return json(await listLocks({ orgId, actorEmail: g.auth.session.email, membership: g.auth.membership, scope: q.get("scope") || "mine" }));
  } catch (err) { return fail(err); }
}
