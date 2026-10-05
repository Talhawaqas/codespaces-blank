// app/api/public/file-requests/[token]/route.js -- PUBLIC, inbound only. Whoever has the link can submit files and nothing else:
// no listing, no download, no view of any organization data.
//   GET  -> what the upload page shows (title, instructions, limits, the request's PUBLIC key). A dead link says only that it is dead.
//   POST { action: "begin", uploader:{name,email,company,note}, ext, size, partCount, keyEnvelope } -> { uploadId, uploadKey, partBytes }
//   POST { action: "part", uploadId, uploadKey, index, data(base64 ciphertext) }                    -> { index }
//   POST { action: "complete", uploadId, uploadKey }                                                -> { receiptId, receivedAt }
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { getClientIp } from "../../../../../lib/rateLimit.js";
import { RequestError, publicInfo, beginUpload, uploadPart, completeUpload } from "../../../../../lib/filerequests/requests.js";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (data, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const fail = (err) => {
  if (err instanceof RequestError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
  console.error("public file-requests route failed:", err?.name, String(err?.message || "").slice(0, 200));
  return json({ error: "Something went wrong. Please try again." }, 500);
};
export async function GET(req, { params }) {
  try { const { token } = await params; await ensureOrgIndexes(); return json(await publicInfo(token)); } catch (err) { return fail(err); }
}
export async function POST(req, { params }) {
  try {
    const { token } = await params; await ensureOrgIndexes();
    let b = {}; try { b = await req.json(); } catch { b = {}; }
    if (b.action === "begin") return json(await beginUpload({ token, uploader: b.uploader || {}, ext: b.ext, size: b.size, partCount: b.partCount, keyEnvelope: b.keyEnvelope, ip: getClientIp(req) }));
    if (b.action === "part") return json(await uploadPart({ token, uploadId: b.uploadId, uploadKey: b.uploadKey, index: b.index, data: b.data }));
    if (b.action === "complete") return json(await completeUpload({ token, uploadId: b.uploadId, uploadKey: b.uploadKey }));
    return json({ error: "action must be begin, part or complete." }, 400);
  } catch (err) { return fail(err); }
}
