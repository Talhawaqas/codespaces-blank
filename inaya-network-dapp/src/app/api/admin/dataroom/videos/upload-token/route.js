// app/api/admin/dataroom/videos/upload-token/route.js
//
// POST /api/admin/dataroom/videos/upload-token — the server half of a
// client-upload flow (@vercel/blob/client's handleUpload). The admin's
// browser calls this twice per upload, transparently, via the client
// upload() helper: once to get a short-lived signed token before the PUT
// (our bytes never touch this server), and once more — a server-to-server
// webhook FROM Vercel Blob, not the browser — after the upload finishes,
// which is where the dataroom_documents row actually gets created. That
// second call requires this route to be reachable at a public HTTPS URL,
// so it only fires against a real deployment, not local dev.
//
// Gated the same way the token-generation step matters: only an
// authenticated admin should ever be handed a token that can write into
// this Blob store. onUploadCompleted itself is NOT re-gated — by the time
// it fires, the upload already happened under a token this route only
// ever issued to an authenticated admin in the first place.

import { NextResponse } from "next/server";
import { handleUpload } from "@vercel/blob/client";
import { isAdminAuthenticated } from "../../../../../../lib/admin-auth.js";
import { ensureDataroomIndexes, getDataroomCollections, validateVideoUploadInput, ALLOWED_VIDEO_MIME_TYPES, MAX_VIDEO_SIZE_BYTES } from "../../../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = await req.json();

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        access: "private",
        allowedContentTypes: ALLOWED_VIDEO_MIME_TYPES,
        addRandomSuffix: true,
        maximumSizeInBytes: MAX_VIDEO_SIZE_BYTES,
      }),
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const meta = JSON.parse(tokenPayload || "{}");
        const clean = validateVideoUploadInput({
          title: meta.title,
          category: meta.category,
          sizeBytes: blob.size,
          mimeType: blob.contentType,
        });

        await ensureDataroomIndexes();
        const { documents } = await getDataroomCollections();
        const count = await documents.countDocuments({});
        await documents.insertOne({
          title: clean.title,
          category: clean.category,
          filename: meta.filename || blob.pathname,
          storageType: "blob",
          blobPathname: blob.pathname,
          sizeBytes: blob.size,
          mimeType: blob.contentType,
          uploadedAt: new Date().toISOString(),
          order: count,
        });
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    console.error("admin/dataroom/videos/upload-token failed:", err);
    return NextResponse.json({ error: err.message || "Could not process the upload." }, { status: 400 });
  }
}
