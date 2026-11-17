// app/api/orgs/finance/expenses/[expenseId]/attachments/route.js
//
// GET  /api/orgs/finance/expenses/:expenseId/attachments?orgId=... -> list receipts
// POST /api/orgs/finance/expenses/:expenseId/attachments
//   Body: { orgId, filename, fileHash, sizeBytes, cidAlpha, cidBeta }
//   The client has ALREADY encrypted+sharded+pinned the file to IPFS via
//   the existing /api/upload route (same client-side pipeline as every
//   other document upload in this app) — this route only records the
//   resulting metadata, exactly like org_documents' own POST route does.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../../../lib/orgs.js";
import { createAttachment, attachmentStorage, listAttachmentsForRecord, serializeAttachment } from "../../../../../../../lib/attachments.js";
import { ChunkedError } from "../../../../../../../lib/chunkedStorage.js";

async function loadExpense(req, orgId, expenseId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };
  if (!canAccessFinance(auth.membership)) return { error: "You don't have finance access.", status: 403 };

  const { expenses } = await getOrgCollections();
  const expense = await expenses.findOne({ _id: toObjectId(expenseId), orgId: toObjectId(orgId), deletedAt: null });
  if (!expense) return { error: "Expense not found.", status: 404 };
  if (!canAccessDepartment(auth.membership, expense.departmentId)) return { error: "Expense not found.", status: 404 };

  return { auth, expense };
}

export async function GET(req, { params }) {
  params = await params; // Next.js 15: params is a Promise (SQA 17 Nov 2026)
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadExpense(req, orgId, params.expenseId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    const list = await listAttachmentsForRecord({ orgId, relatedRecordType: "EXPENSE", relatedRecordId: params.expenseId });
    return NextResponse.json({ attachments: list.map(serializeAttachment) });
  } catch (err) {
    console.error("orgs/finance/expenses/[expenseId]/attachments GET failed:", err);
    return NextResponse.json({ error: "Could not fetch attachments." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  params = await params; // Next.js 15: params is a Promise (SQA 17 Nov 2026)
  try {
    const { orgId, filename, fileHash, sizeBytes, cidAlpha, cidBeta, chunkedUploadToken = null } = await req.json();
    if (!orgId || !filename || !fileHash || !cidAlpha || !cidBeta) {
      return NextResponse.json({ error: "orgId, filename, fileHash, cidAlpha, and cidBeta are required." }, { status: 400 });
    }
    const result = await loadExpense(req, orgId, params.expenseId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const storage = await attachmentStorage({ chunkedUploadToken, orgId, email: result.auth.session.email, cidAlpha, cidBeta, sizeBytes });

    const attachment = await createAttachment({
      orgId, departmentId: result.expense.departmentId, relatedRecordType: "EXPENSE", relatedRecordId: params.expenseId,
      filename, fileHash, sizeBytes, cidAlpha, cidBeta, uploadedByEmail: result.auth.session.email, storage,
    });
    return NextResponse.json(serializeAttachment(attachment));
  } catch (err) {
    if (err instanceof ChunkedError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("orgs/finance/expenses/[expenseId]/attachments POST failed:", err);
    return NextResponse.json({ error: "Could not attach the receipt." }, { status: 500 });
  }
}
