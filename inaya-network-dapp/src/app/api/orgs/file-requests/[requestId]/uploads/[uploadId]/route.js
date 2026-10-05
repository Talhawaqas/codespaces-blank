// app/api/orgs/file-requests/[requestId]/uploads/[uploadId]/route.js
//   GET    ?orgId&index -> one CIPHERTEXT part of a received upload (requester or admin only)
//   DELETE ?orgId       -> delete the upload
import { requesterRoute } from "../../../_lib.js";
import { readUploadPart, deleteUpload } from "../../../../../../../lib/filerequests/requests.js";
export const dynamic = "force-dynamic";
export async function GET(req, ctx) { return requesterRoute(req, ctx, async ({ orgId, membership, email, params, query }) => readUploadPart({ orgId, requestId: params.requestId, uploadId: params.uploadId, index: query.index, actorEmail: email, membership })); }
export async function DELETE(req, ctx) { return requesterRoute(req, ctx, async ({ orgId, membership, email, params }) => deleteUpload({ orgId, requestId: params.requestId, uploadId: params.uploadId, actorEmail: email, membership })); }
