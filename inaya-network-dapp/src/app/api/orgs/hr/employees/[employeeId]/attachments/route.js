// app/api/orgs/hr/employees/[employeeId]/attachments/route.js
//
// GET  /api/orgs/hr/employees/:employeeId/attachments?orgId=... — HR
//   roles or the employee's own record (self can VIEW their own HR
//   documents, e.g. their own contract, matching "personal HR
//   information and permitted documents").
// POST — HR roles only (only HR uploads/controls employee documents;
//   self-access is view-only here, same read/no-write split as the base
//   employee record).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessHR, isSelfEmployeeRecord, toObjectId } from "../../../../../../../lib/orgs.js";
import { createAttachment, listAttachmentsForRecord, serializeAttachment } from "../../../../../../../lib/attachments.js";

async function loadEmployee(req, orgId, employeeId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };

  const { employees } = await getOrgCollections();
  const employee = await employees.findOne({ _id: toObjectId(employeeId), orgId: toObjectId(orgId), deletedAt: null });
  if (!employee) return { error: "Employee not found.", status: 404 };

  const hasHR = canAccessHR(auth.membership) && canAccessDepartment(auth.membership, employee.departmentId);
  const isSelf = isSelfEmployeeRecord(employee, auth.session.email);
  if (!hasHR && !isSelf) return { error: "Employee not found.", status: 404 };

  return { auth, employee, hasHR };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadEmployee(req, orgId, params.employeeId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    const list = await listAttachmentsForRecord({ orgId, relatedRecordType: "EMPLOYEE", relatedRecordId: params.employeeId });
    return NextResponse.json({ attachments: list.map(serializeAttachment) });
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId]/attachments GET failed:", err);
    return NextResponse.json({ error: "Could not fetch documents." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { orgId, filename, fileHash, sizeBytes, cidAlpha, cidBeta } = await req.json();
    if (!orgId || !filename || !fileHash || !cidAlpha || !cidBeta) {
      return NextResponse.json({ error: "orgId, filename, fileHash, cidAlpha, and cidBeta are required." }, { status: 400 });
    }
    const result = await loadEmployee(req, orgId, params.employeeId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (!result.hasHR) return NextResponse.json({ error: "Only HR can upload employee documents." }, { status: 403 });

    const attachment = await createAttachment({
      orgId, departmentId: result.employee.departmentId, relatedRecordType: "EMPLOYEE", relatedRecordId: params.employeeId,
      filename, fileHash, sizeBytes, cidAlpha, cidBeta, uploadedByEmail: result.auth.session.email,
    });
    return NextResponse.json(serializeAttachment(attachment));
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId]/attachments POST failed:", err);
    return NextResponse.json({ error: "Could not upload the document." }, { status: 500 });
  }
}
