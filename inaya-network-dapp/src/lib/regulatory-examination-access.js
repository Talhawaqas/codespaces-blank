// src/lib/regulatory-examination-access.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§52, §103) — the
// external examiner's own login/session, deliberately separate from
// org_members. An outside auditor/regulator must never get org-wide
// access just because they can view one examination.
//
// Confirmed via codebase audit that NOTHING reusable exists for this
// today: dataroom.js's visitor/magic-link/session trio is the closest
// shape, but its own header comment says it is deliberately NOT
// multi-tenant (no orgId field anywhere, single founder-owned room,
// gated by one shared admin passphrase) — retrofitting it to be
// org-scoped would be a large, risky change to an unrelated, already-
// shipped feature. document-shares (bearer tokens, no name/email) and
// document-permissions (email ACL, no login of its own) are both the
// wrong shape too.
//
// So this file deliberately COPIES dataroom.js's proven token mechanics
// (hash tokens before storage, TTL-indexed expiry, revoke = clear
// revokedAt + delete active sessions) but scoped to {orgId, examinationId}
// from day one, and with an explicit per-session `scope` — an examiner
// session never grants implicit org-wide or even implicit
// whole-examination access; it only ever covers the request IDs it was
// explicitly issued for.

import { getOrgCollections, toObjectId, hashToken, generateToken } from "./orgs.js";
import { canManageAudit } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

const EXAMINER_MAGIC_LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes, same as every other magic link in this app
const EXAMINER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — an examination engagement window, not a 30-day investor-style session
export const EXAMINER_SESSION_COOKIE = "inaya_regulatory_examiner_session";

/** Issues a scoped magic link for a named external examiner. Only an
 *  audit manager (or org owner/admin) can do this — never automatic,
 *  never self-service. `requestIds` is the explicit allowlist of
 *  evidence requests this examiner may see; omit/empty means the whole
 *  examination's requests, but never any OTHER examination's. */
export async function createExaminerMagicLink({ orgId, examinationId, examinerEmail, requestIds, expiresInHours = 72, actorEmail, membership }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can issue examiner access.", status: 403 };
  if (!examinerEmail?.trim()) return { error: "An examiner email is required.", status: 400 };

  const { regulatoryExaminations, regulatoryExaminerMagicLinks } = await getOrgCollections();
  const examination = await regulatoryExaminations.findOne({ _id: toObjectId(examinationId), orgId: toObjectId(orgId) });
  if (!examination) return { error: "Examination not found.", status: 404 };

  const token = generateToken();
  const now = new Date().toISOString();
  const doc = {
    tokenHash: hashToken(token),
    orgId: toObjectId(orgId),
    examinationId: toObjectId(examinationId),
    examinerEmail: examinerEmail.trim(),
    scope: { examinationId: toObjectId(examinationId), requestIds: (requestIds || []).map((id) => toObjectId(id)) },
    expiresAt: new Date(Date.now() + EXAMINER_MAGIC_LINK_TTL_MS).toISOString(),
    usedAt: null,
    issuedByEmail: actorEmail,
    createdAt: now,
    // Session TTL is carried on the link so exchangeMagicLink() doesn't
    // need a second caller-supplied value it could get wrong.
    sessionTtlMs: expiresInHours * 60 * 60 * 1000,
  };
  await regulatoryExaminerMagicLinks.insertOne(doc);

  await logOrgActivity({ orgId, recordType: "REGULATORY_EXAMINATION", recordId: examination._id, actorEmail, action: "EXAMINER_ACCESS_ISSUED", previousState: null, newState: null, metadata: { examinerEmail: doc.examinerEmail } });
  return { token };
}

/** Validates + consumes a magic-link token, issues a session — same
 *  invalidate-on-use shape as dataroom.js's consumeDataroomMagicLink. */
export async function exchangeMagicLink(rawToken) {
  if (!rawToken) return { error: "missing_token", status: 400 };
  const { regulatoryExaminerMagicLinks, regulatoryExaminerSessions } = await getOrgCollections();

  const link = await regulatoryExaminerMagicLinks.findOne({ tokenHash: hashToken(rawToken) });
  if (!link || link.usedAt || new Date(link.expiresAt).getTime() < Date.now()) {
    return { error: "invalid_or_expired", status: 400 };
  }

  const now = new Date().toISOString();
  await regulatoryExaminerMagicLinks.updateOne({ _id: link._id }, { $set: { usedAt: now } });

  const sessionToken = generateToken();
  await regulatoryExaminerSessions.insertOne({
    tokenHash: hashToken(sessionToken),
    orgId: link.orgId,
    examinationId: link.examinationId,
    examinerEmail: link.examinerEmail,
    scope: link.scope,
    revokedAt: null,
    expiresAt: new Date(Date.now() + (link.sessionTtlMs || EXAMINER_SESSION_TTL_MS)).toISOString(),
    createdAt: now,
  });

  return { sessionToken, orgId: link.orgId.toString(), examinationId: link.examinationId.toString() };
}

/** Resolves a raw session token to the examiner's session, or null.
 *  Defense-in-depth: checks revokedAt in addition to expiry, matching
 *  dataroom.js's getDataroomVisitor precedent. */
export async function getExaminerSession(rawToken) {
  if (!rawToken) return null;
  const { regulatoryExaminerSessions } = await getOrgCollections();
  const session = await regulatoryExaminerSessions.findOne({ tokenHash: hashToken(rawToken) });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

/** Immediately ends an examiner's access — deletes their active sessions
 *  (not just marks them revoked) AND stamps revokedAt so a session row
 *  that somehow outlives deletion is still rejected by getExaminerSession's
 *  own check, same double-guard dataroom.js's revoke uses. */
export async function revokeExaminerAccess({ orgId, examinationId, examinerEmail, actorEmail, membership }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can revoke examiner access.", status: 403 };
  const { regulatoryExaminerSessions } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), examinationId: toObjectId(examinationId), examinerEmail };
  const now = new Date().toISOString();

  await regulatoryExaminerSessions.updateMany(query, { $set: { revokedAt: now } });
  await regulatoryExaminerSessions.deleteMany(query);

  await logOrgActivity({ orgId, recordType: "REGULATORY_EXAMINATION", recordId: toObjectId(examinationId), actorEmail, action: "EXAMINER_ACCESS_REVOKED", previousState: null, newState: null, metadata: { examinerEmail } });
  return { revoked: true };
}
