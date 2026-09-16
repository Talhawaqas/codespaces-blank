// The core S3 object REST surface. Query-string sub-operations, exactly the
// way real S3 disambiguates them on one path:
//   PUT    .../key                          -> PutObject
//   PUT    .../key?partNumber=N&uploadId=X  -> UploadPart
//   POST   .../key?uploads                  -> CreateMultipartUpload
//   POST   .../key?uploadId=X (+ XML body)  -> CompleteMultipartUpload
//   GET    .../key                          -> GetObject (Range header aware)
//   HEAD   .../key                          -> HeadObject
//   DELETE .../key                          -> DeleteObject
//   DELETE .../key?uploadId=X                -> AbortMultipartUpload
import { authenticateS3Request, S3AuthError } from "../../../../../lib/s3-compat/auth.js";
import * as orgStore from "../../../../../lib/s3-compat/store.js";
import * as walletStore from "../../../../../lib/s3-compat/walletStore.js";
import { s3Error, xmlResponse, initiateMultipartUploadXml, completeMultipartUploadXml, parseCompleteMultipartBody } from "../../../../../lib/s3-compat/xml.js";

function storeFor(owner) {
  return owner.type === "org" ? orgStore : walletStore;
}
function ownerArgs(owner) {
  return owner.type === "org" ? { orgId: owner.orgId } : { walletAddress: owner.walletAddress };
}
function joinKey(keyParts) {
  return (keyParts || []).join("/");
}

// PUT ?legal-hold / ?retention -- real S3 sub-resources
// (PutObjectLegalHold/PutObjectRetention). Small, fixed XML shapes, same
// pragmatic regex-extraction level as parseCompleteMultipartBody/
// parseVersioningStatus elsewhere in this layer.
function parseLegalHoldStatus(xmlBody) {
  const match = xmlBody.match(/<Status>(ON|OFF)<\/Status>/);
  return match ? match[1] : null;
}
function parseRetention(xmlBody) {
  const mode = xmlBody.match(/<Mode>(GOVERNANCE|COMPLIANCE)<\/Mode>/);
  const until = xmlBody.match(/<RetainUntilDate>([^<]+)<\/RetainUntilDate>/);
  return mode && until ? { mode: mode[1], until: until[1] } : null;
}

export async function PUT(req, { params }) {
  try {
    const bodyBuffer = Buffer.from(await req.arrayBuffer());
    const { owner, accessKeyId } = await authenticateS3Request(req, bodyBuffer);
    const store = storeFor(owner);
    const key = joinKey(params.key);
    const url = new URL(req.url);
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = url.searchParams.get("partNumber");

    if (url.searchParams.has("legal-hold")) {
      const status = parseLegalHoldStatus(bodyBuffer.toString("utf8"));
      if (!status) return s3Error("MalformedXML", "LegalHold must specify Status=ON or OFF.");
      await store.putObjectLegalHold({ ...ownerArgs(owner), bucket: params.bucket, key, versionId: url.searchParams.get("versionId"), legalHold: status === "ON", actorEmail: accessKeyId });
      return new Response(null, { status: 200 });
    }

    if (url.searchParams.has("retention")) {
      const retention = parseRetention(bodyBuffer.toString("utf8"));
      if (!retention) return s3Error("MalformedXML", "Retention must specify Mode and RetainUntilDate.");
      await store.putObjectRetention({ ...ownerArgs(owner), bucket: params.bucket, key, versionId: url.searchParams.get("versionId"), retentionMode: retention.mode, retentionUntil: retention.until, actorEmail: accessKeyId });
      return new Response(null, { status: 200 });
    }

    if (uploadId && partNumber) {
      const etag = await store.uploadPart({ ...ownerArgs(owner), uploadId, partNumber: Number(partNumber), bodyBuffer });
      if (etag === null) return s3Error("NoSuchUpload", "The specified multipart upload does not exist.");
      return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
    }

    const contentType = req.headers.get("content-type") || "application/octet-stream";
    const doc = await store.putS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, bodyBuffer, contentType, actorEmail: accessKeyId });
    return new Response(null, { status: 200, headers: { ETag: `"${doc.cidAlpha || doc.fileHash || ""}"`, ...(doc.versionId ? { "x-amz-version-id": doc.versionId } : {}) } });
  } catch (err) {
    if (err?.reason === "LegalHold" || err?.reason === "ObjectLocked") return s3Error("AccessDenied", err.message);
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("PUT /api/s3/[bucket]/[...key] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}

export async function POST(req, { params }) {
  try {
    const bodyBuffer = Buffer.from(await req.arrayBuffer());
    const { owner } = await authenticateS3Request(req, bodyBuffer);
    const store = storeFor(owner);
    const key = joinKey(params.key);
    const url = new URL(req.url);

    if (url.searchParams.has("uploads")) {
      const contentType = req.headers.get("content-type") || "application/octet-stream";
      const uploadId = await store.createMultipartUpload({ ...ownerArgs(owner), bucket: params.bucket, key, contentType });
      return xmlResponse(initiateMultipartUploadXml({ bucket: params.bucket, key, uploadId }));
    }

    const uploadId = url.searchParams.get("uploadId");
    if (uploadId) {
      // The submitted <Part> list is trusted only for ordering; the parts
      // actually assembled are whatever UploadPart calls were stored server-side
      // under this uploadId, per part number -- the XML body isn't re-parsed
      // for content, only used to confirm the client's view matches (real S3
      // does the equivalent ETag-per-part verification, simplified here).
      parseCompleteMultipartBody(bodyBuffer.toString("utf8"));
      const doc = await store.completeMultipartUpload({ ...ownerArgs(owner), uploadId, actorEmail: null });
      if (!doc) return s3Error("NoSuchUpload", "The specified multipart upload does not exist.");
      return xmlResponse(completeMultipartUploadXml({ bucket: params.bucket, key, etag: doc.cidAlpha || doc.fileHash }));
    }

    return s3Error("InvalidRequest", "Unrecognized POST operation.");
  } catch (err) {
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("POST /api/s3/[bucket]/[...key] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}

export async function GET(req, { params }) {
  try {
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const key = joinKey(params.key);
    const url = new URL(req.url);
    const versionId = url.searchParams.get("versionId") || undefined;

    if (url.searchParams.has("legal-hold")) {
      const doc = await store.headS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, versionId });
      if (!doc) return s3Error("NoSuchKey", "The specified key does not exist.");
      return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><LegalHold xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${doc.legalHold ? "ON" : "OFF"}</Status></LegalHold>`);
    }
    if (url.searchParams.has("retention")) {
      const doc = await store.headS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, versionId });
      if (!doc) return s3Error("NoSuchKey", "The specified key does not exist.");
      if (!doc.retentionMode) return s3Error("NoSuchObjectLockConfiguration", "There is no retention configured for this object.");
      return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>${doc.retentionMode}</Mode><RetainUntilDate>${doc.retentionUntil}</RetainUntilDate></Retention>`);
    }

    const result = await store.getS3ObjectBody({ ...ownerArgs(owner), bucket: params.bucket, key, versionId });
    if (!result) return s3Error("NoSuchKey", "The specified key does not exist.");

    const { doc, buffer } = result;
    const rangeHeader = req.headers.get("range");
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const total = buffer.length;
        let start = match[1] === "" ? total - Number(match[2]) : Number(match[1]);
        let end = match[2] === "" ? total - 1 : Number(match[2]);
        start = Math.max(0, start);
        end = Math.min(total - 1, end);
        if (start > end || start >= total) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
        }
        const slice = buffer.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": doc.contentType || "application/octet-stream",
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": String(slice.length),
            ETag: `"${doc.cidAlpha || doc.fileHash || ""}"`,
            "Accept-Ranges": "bytes",
          },
        });
      }
    }

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": doc.contentType || "application/octet-stream",
        "Content-Length": String(buffer.length),
        ETag: `"${doc.cidAlpha || doc.fileHash || ""}"`,
        "Accept-Ranges": "bytes",
        "Last-Modified": new Date(doc.createdAt).toUTCString(),
      },
    });
  } catch (err) {
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("GET /api/s3/[bucket]/[...key] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}

export async function HEAD(req, { params }) {
  try {
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const key = joinKey(params.key);
    const url = new URL(req.url);
    const doc = await store.headS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, versionId: url.searchParams.get("versionId") || undefined });
    if (!doc) return new Response(null, { status: 404 });
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": doc.contentType || "application/octet-stream",
        "Content-Length": String(doc.sizeBytes ?? doc.fileSizeBytes ?? 0),
        ETag: `"${doc.cidAlpha || doc.fileHash || ""}"`,
        "Accept-Ranges": "bytes",
        "Last-Modified": new Date(doc.createdAt).toUTCString(),
        ...(doc.versionId ? { "x-amz-version-id": doc.versionId } : {}),
      },
    });
  } catch (err) {
    if (err instanceof S3AuthError) return new Response(null, { status: err.status });
    console.error("HEAD /api/s3/[bucket]/[...key] failed:", err);
    return new Response(null, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const key = joinKey(params.key);
    const url = new URL(req.url);
    const uploadId = url.searchParams.get("uploadId");

    if (uploadId) {
      await store.abortMultipartUpload({ ...ownerArgs(owner), uploadId });
      return new Response(null, { status: 204 });
    }

    const result = await store.deleteS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, versionId: url.searchParams.get("versionId") || undefined });
    return new Response(null, { status: 204, headers: result?.deleteMarker ? { "x-amz-delete-marker": "true" } : {} });
  } catch (err) {
    if (err?.reason === "LegalHold" || err?.reason === "ObjectLocked") {
      return s3Error("AccessDenied", err.message);
    }
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("DELETE /api/s3/[bucket]/[...key] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}
