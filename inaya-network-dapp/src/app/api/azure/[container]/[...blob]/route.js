// The core Azure Blob REST surface. Query-string sub-operations, exactly
// the way real Azure Blob Storage disambiguates them:
//   PUT    .../blob (x-ms-blob-type: BlockBlob header) -> Put Blob (simple upload)
//   PUT    .../blob?comp=block&blockid=<base64>         -> Put Block (stage)
//   PUT    .../blob?comp=blocklist (+ XML body)          -> Put Block List (commit)
//   GET    .../blob                                      -> Get Blob (Range header aware)
//   HEAD   .../blob                                       -> Get Blob Properties
//   DELETE .../blob                                       -> Delete Blob
import { authenticateAzureRequest, AzureAuthError } from "../../../../../lib/s3-compat/azureAuthMiddleware.js";
import * as orgStore from "../../../../../lib/s3-compat/store.js";
import * as walletStore from "../../../../../lib/s3-compat/walletStore.js";
import { azureError, parseBlockListBody } from "../../../../../lib/s3-compat/azureXml.js";

function storeFor(owner) {
  return owner.type === "org" ? orgStore : walletStore;
}
function ownerArgs(owner) {
  return owner.type === "org" ? { orgId: owner.orgId } : { walletAddress: owner.walletAddress };
}
function joinBlob(parts) {
  return (parts || []).join("/");
}

export async function PUT(req, { params }) {
  try {
    const bodyBuffer = Buffer.from(await req.arrayBuffer());
    const { owner, accessKeyId } = await authenticateAzureRequest(req, bodyBuffer);
    const store = storeFor(owner);
    const blob = joinBlob(params.blob);
    const url = new URL(req.url);
    const comp = url.searchParams.get("comp");

    if (comp === "block") {
      const blockId = url.searchParams.get("blockid");
      if (!blockId) return azureError("InvalidInput", "blockid is required for Put Block.");
      await store.stageAzureBlock({ ...ownerArgs(owner), bucket: params.container, key: blob, blockId, bodyBuffer });
      return new Response(null, { status: 201, headers: { "x-ms-version": "2021-08-06" } });
    }

    if (comp === "blocklist") {
      const blockIds = parseBlockListBody(bodyBuffer.toString("utf8"));
      if (blockIds.length === 0) return azureError("InvalidBlockList", "The specified block list is invalid or empty.");
      const contentType = req.headers.get("x-ms-blob-content-type") || req.headers.get("content-type") || "application/octet-stream";
      try {
        const doc = await store.commitAzureBlockList({ ...ownerArgs(owner), bucket: params.container, key: blob, blockIds, contentType, actorEmail: accessKeyId });
        return new Response(null, { status: 201, headers: { "x-ms-version": "2021-08-06", ETag: `"${doc.cidAlpha || doc.fileHash || ""}"` } });
      } catch (err) {
        return azureError("InvalidBlockList", err.message);
      }
    }

    // Simple Put Blob -- real Azure requires x-ms-blob-type: BlockBlob for this
    // form; PageBlob/AppendBlob are explicitly not implemented (see the SOW
    // report for why neither applies to Inaya's whole-object storage model).
    const blobType = req.headers.get("x-ms-blob-type");
    if (blobType && blobType !== "BlockBlob") {
      return azureError("InvalidInput", `Only BlockBlob is supported by this compatibility layer (got "${blobType}"). PageBlob and AppendBlob are not applicable to Inaya's storage model -- see the SOW report.`);
    }
    const contentType = req.headers.get("x-ms-blob-content-type") || req.headers.get("content-type") || "application/octet-stream";
    const doc = await store.putS3Object({ ...ownerArgs(owner), bucket: params.container, key: blob, bodyBuffer, contentType, actorEmail: accessKeyId });
    return new Response(null, { status: 201, headers: { "x-ms-version": "2021-08-06", ETag: `"${doc.cidAlpha || doc.fileHash || ""}"` } });
  } catch (err) {
    if (err instanceof AzureAuthError) return azureError(err.code, err.message);
    console.error("PUT /api/azure/[container]/[...blob] failed:", err);
    return azureError("InternalError", err.message || "An internal error occurred.");
  }
}

export async function GET(req, { params }) {
  try {
    const { owner } = await authenticateAzureRequest(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const blob = joinBlob(params.blob);
    const result = await store.getS3ObjectBody({ ...ownerArgs(owner), bucket: params.container, key: blob });
    if (!result) return azureError("BlobNotFound", "The specified blob does not exist.");

    const { doc, buffer } = result;
    const rangeHeader = req.headers.get("x-ms-range") || req.headers.get("range");
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const total = buffer.length;
        let start = match[1] === "" ? total - Number(match[2]) : Number(match[1]);
        let end = match[2] === "" ? total - 1 : Number(match[2]);
        start = Math.max(0, start);
        end = Math.min(total - 1, end);
        if (start > end || start >= total) return new Response(null, { status: 416, headers: { "x-ms-version": "2021-08-06" } });
        const slice = buffer.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": doc.contentType || "application/octet-stream",
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": String(slice.length),
            "x-ms-blob-type": "BlockBlob",
            "x-ms-version": "2021-08-06",
            ETag: `"${doc.cidAlpha || doc.fileHash || ""}"`,
          },
        });
      }
    }

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": doc.contentType || "application/octet-stream",
        "Content-Length": String(buffer.length),
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": "2021-08-06",
        "Last-Modified": new Date(doc.createdAt).toUTCString(),
        ETag: `"${doc.cidAlpha || doc.fileHash || ""}"`,
      },
    });
  } catch (err) {
    if (err instanceof AzureAuthError) return azureError(err.code, err.message);
    console.error("GET /api/azure/[container]/[...blob] failed:", err);
    return azureError("InternalError", err.message || "An internal error occurred.");
  }
}

export async function HEAD(req, { params }) {
  try {
    const { owner } = await authenticateAzureRequest(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const blob = joinBlob(params.blob);
    const doc = await store.headS3Object({ ...ownerArgs(owner), bucket: params.container, key: blob });
    if (!doc) return new Response(null, { status: 404, headers: { "x-ms-version": "2021-08-06" } });
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": doc.contentType || "application/octet-stream",
        "Content-Length": String(doc.sizeBytes ?? doc.fileSizeBytes ?? 0),
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": "2021-08-06",
        "Last-Modified": new Date(doc.createdAt).toUTCString(),
        ETag: `"${doc.cidAlpha || doc.fileHash || ""}"`,
      },
    });
  } catch (err) {
    if (err instanceof AzureAuthError) return new Response(null, { status: err.status });
    console.error("HEAD /api/azure/[container]/[...blob] failed:", err);
    return new Response(null, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { owner } = await authenticateAzureRequest(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const blob = joinBlob(params.blob);
    await store.deleteS3Object({ ...ownerArgs(owner), bucket: params.container, key: blob, actorEmail: null });
    return new Response(null, { status: 202, headers: { "x-ms-version": "2021-08-06" } });
  } catch (err) {
    if (err instanceof AzureAuthError) return azureError(err.code, err.message);
    console.error("DELETE /api/azure/[container]/[...blob] failed:", err);
    return azureError("InternalError", "An internal error occurred.");
  }
}
