// app/api/orgs/chat/attachments/route.js -- encrypted chat attachment blobs (ciphertext only; see chat/attachments.js).
//   POST { orgId, action:"begin",    conversationId, size, partCount }            -> { blobId, partBytes }
//   POST { orgId, action:"part",     conversationId, blobId, index, data(base64) } -> { index }
//   POST { orgId, action:"complete", conversationId, blobId }                      -> { blobId, size, partCount }
//   GET  ?orgId&conversationId&blobId&index                                       -> { index, partCount, size, data(base64) }
import { chatRoute } from "../_lib.js";
import { fail } from "../../../../../lib/chat/common.js";
import * as att from "../../../../../lib/chat/attachments.js";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req, routeCtx) {
  return chatRoute(req, routeCtx, async ({ orgId, email, body }) => {
    const base = { orgId, email, conversationId: body.conversationId };
    if (body.action === "begin") return att.beginAttachment({ ...base, size: body.size, partCount: body.partCount });
    if (body.action === "part") return att.uploadPart({ ...base, blobId: body.blobId, index: body.index, data: body.data });
    if (body.action === "complete") return att.completeAttachment({ ...base, blobId: body.blobId });
    fail(400, "action must be begin, part or complete.");
  });
}

export async function GET(req, routeCtx) {
  return chatRoute(req, routeCtx, async ({ orgId, email, query }) => att.readPart({ orgId, email, conversationId: query.conversationId, blobId: query.blobId, index: query.index }));
}
