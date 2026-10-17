// Route handlers for /tasks/:taskId/sharing and /crm/deals/:dealId/sharing.
//   GET    ?orgId                          -> { visibility, grants, canManage }
//   PATCH  { orgId, visibility }           -> DEPARTMENT | PRIVATE
//   POST   { orgId, email, level, expiresAt? }
//   DELETE ?orgId&email
// Reading requires seeing the record; changing it requires being its
// creator or an org owner/admin (record-grants.js).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "./orgs.js";
import { canAccessRecord, canManageRecordSharing, setVisibility, listGrants, grantAccess, revokeAccess } from "./record-grants.js";

export function makeSharingHandlers({ recordType, idParam }) {
  async function load(req, orgId, params) {
    const recordId = (await params)[idParam];
    if (!orgId) return { error: "orgId is required.", status: 400 };
    if (!ObjectId.isValid(String(recordId))) return { error: "Not found.", status: 404 };
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return { error: auth.error, status: auth.status };
    const c = await getOrgCollections();
    const col = recordType === "TASK" ? c.tasks : c.crmDeals;
    const record = await col.findOne({ _id: toObjectId(recordId), orgId: toObjectId(orgId), deletedAt: null });
    if (!record || !canAccessDepartment(auth.membership, record.departmentId)) return { error: "Not found.", status: 404 };
    if (!(await canAccessRecord({ orgId, recordType, record, membership: auth.membership, email: auth.session.email }))) return { error: "Not found.", status: 404 };
    return { auth, record, canManage: canManageRecordSharing(record, auth.membership, auth.session.email) };
  }
  const fail = (r) => NextResponse.json({ error: r.error }, { status: r.status });
  const wrap = (fn) => async (req, ctx) => {
    try { return await fn(req, ctx); } catch (err) {
      console.error(`${recordType} sharing route failed:`, err);
      return NextResponse.json({ error: "Could not update sharing." }, { status: 500 });
    }
  };

  return {
    GET: wrap(async (req, { params }) => {
      const orgId = new URL(req.url).searchParams.get("orgId");
      const r = await load(req, orgId, params);
      if (r.error) return fail(r);
      return NextResponse.json({ visibility: r.record.visibility || "DEPARTMENT", grants: await listGrants({ orgId, recordType, recordId: r.record._id }), canManage: r.canManage });
    }),
    PATCH: wrap(async (req, { params }) => {
      const body = await req.json().catch(() => ({}));
      const r = await load(req, body.orgId, params);
      if (r.error) return fail(r);
      if (!r.canManage) return NextResponse.json({ error: "Only the creator or an owner/admin can change who sees this." }, { status: 403 });
      const out = await setVisibility({ orgId: body.orgId, recordType, record: r.record, visibility: body.visibility, actorEmail: r.auth.session.email });
      return out.error ? fail(out) : NextResponse.json(out);
    }),
    POST: wrap(async (req, { params }) => {
      const body = await req.json().catch(() => ({}));
      const r = await load(req, body.orgId, params);
      if (r.error) return fail(r);
      if (!r.canManage) return NextResponse.json({ error: "Only the creator or an owner/admin can share this." }, { status: 403 });
      const out = await grantAccess({ orgId: body.orgId, recordType, record: r.record, email: body.email, level: body.level, expiresAt: body.expiresAt, actorEmail: r.auth.session.email });
      return out.error ? fail(out) : NextResponse.json(out);
    }),
    DELETE: wrap(async (req, { params }) => {
      const sp = new URL(req.url).searchParams;
      const r = await load(req, sp.get("orgId"), params);
      if (r.error) return fail(r);
      if (!r.canManage) return NextResponse.json({ error: "Only the creator or an owner/admin can change sharing." }, { status: 403 });
      const out = await revokeAccess({ orgId: sp.get("orgId"), recordType, record: r.record, email: sp.get("email"), actorEmail: r.auth.session.email });
      return out.error ? fail(out) : NextResponse.json(out);
    }),
  };
}
