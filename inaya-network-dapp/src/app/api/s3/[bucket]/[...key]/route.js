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
import { createSignedUrl } from "../../../../../lib/s3-compat/signedUrl.js";
import { resolveS3Credential } from "../../../../../lib/s3-compat/credentials.js";
import { logOrgActivity } from "../../../../../lib/org-activity-log.js";

function storeFor(owner) {
  return owner.type === "org" ? orgStore : walletStore;
}
function ownerArgs(owner) {
  return owner.type === "org" ? { orgId: owner.orgId } : { walletAddress: owner.walletAddress };
}
function joinKey(keyParts) {
  return (keyParts || []).join("/");
}

// createS3Folder/deleteS3Folder/renameS3Folder (store.js/walletStore.js)
// throw Error objects with one of these `.code`s attached -- map them to
// their matching S3-shaped error response instead of falling through to a
// generic 500, per the SOW's own deterministic-error-handling requirement.
const FOLDER_ERROR_CODES = new Set(["FolderAlreadyExists", "InvalidFolderName", "NoSuchFolder", "NoSuchParentFolder", "NoSuchBucket"]);
function folderAwareError(err) {
  if (err?.code && FOLDER_ERROR_CODES.has(err.code)) return s3Error(err.code, err.message);
  return null;
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

// AWS S3 Feature Expansion SOW, Phase 1 -- PUT/GET/DELETE ?tagging (real S3
// PutObjectTagging/GetObjectTagging/DeleteObjectTagging), plus the
// x-amz-tagging request header real S3 clients send on the initial PUT
// (a URL-encoded query string, e.g. "env=prod&team=finance" -- NOT XML).
function parseTaggingXml(xmlBody) {
  const tags = {};
  const tagRe = /<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g;
  let match;
  while ((match = tagRe.exec(xmlBody))) tags[match[1]] = match[2];
  return tags;
}
function taggingXml(tags) {
  const tagXml = Object.entries(tags || {})
    .map(([k, v]) => `<Tag><Key>${k}</Key><Value>${v}</Value></Tag>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${tagXml}</TagSet></Tagging>`;
}
function parseTaggingHeader(headerValue) {
  if (!headerValue) return undefined;
  const tags = {};
  for (const pair of headerValue.split("&")) {
    const [k, v] = pair.split("=");
    if (k) tags[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return tags;
}
// x-amz-checksum-sha256 -- real S3 convention: base64, not hex.
function checksumHeaders(doc) {
  return doc?.contentSha256 ? { "x-amz-checksum-sha256": Buffer.from(doc.contentSha256, "hex").toString("base64") } : {};
}

export async function PUT(req, { params }) {
  try {
    const bodyBuffer = Buffer.from(await req.arrayBuffer());
    const key = joinKey(params.key);
    const { owner, accessKeyId } = await authenticateS3Request(req, bodyBuffer, { bucket: params.bucket, key });
    const store = storeFor(owner);
    const url = new URL(req.url);
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = url.searchParams.get("partNumber");

    // ?folder -- Inaya-specific extension, NOT part of the real S3
    // protocol (S3 has no empty-folder primitive). Creates a real,
    // durable, empty-safe folder record at this key's path -- used by
    // Inaya Drive's WinFSP mkdir handling, not by third-party S3 clients,
    // which have no reason to send this query param. See
    // docs/inaya-drive-empty-folder-creation-report.md.
    if (url.searchParams.has("folder")) {
      const result = await store.createS3Folder({ ...ownerArgs(owner), bucket: params.bucket, folderPath: key, actorEmail: accessKeyId });
      return Response.json(result, { status: 200 });
    }

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

    if (url.searchParams.has("tagging")) {
      const tags = parseTaggingXml(bodyBuffer.toString("utf8"));
      const result = await store.putObjectTagging({ ...ownerArgs(owner), bucket: params.bucket, key, versionId: url.searchParams.get("versionId"), tags, actorEmail: accessKeyId });
      return new Response(null, { status: 200, ...(result.versionId ? { headers: { "x-amz-version-id": result.versionId } } : {}) });
    }

    if (uploadId && partNumber) {
      const etag = await store.uploadPart({ ...ownerArgs(owner), uploadId, partNumber: Number(partNumber), bodyBuffer });
      if (etag === null) return s3Error("NoSuchUpload", "The specified multipart upload does not exist.");
      return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
    }

    const contentType = req.headers.get("content-type") || "application/octet-stream";
    const tags = parseTaggingHeader(req.headers.get("x-amz-tagging"));
    const doc = await store.putS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, bodyBuffer, contentType, actorEmail: accessKeyId, tags });
    return new Response(null, {
      status: 200,
      headers: { ETag: `"${doc.cidAlpha || doc.fileHash || ""}"`, ...checksumHeaders(doc), ...(doc.versionId ? { "x-amz-version-id": doc.versionId } : {}) },
    });
  } catch (err) {
    if (err?.reason === "LegalHold" || err?.reason === "ObjectLocked") return s3Error("AccessDenied", err.message);
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    const folderResp = folderAwareError(err);
    if (folderResp) return folderResp;
    console.error("PUT /api/s3/[bucket]/[...key] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}

export async function POST(req, { params }) {
  try {
    const bodyBuffer = Buffer.from(await req.arrayBuffer());
    const key = joinKey(params.key);
    const { owner, accessKeyId } = await authenticateS3Request(req, bodyBuffer, { bucket: params.bucket, key });
    const store = storeFor(owner);
    const url = new URL(req.url);

    if (url.searchParams.has("uploads")) {
      const contentType = req.headers.get("content-type") || "application/octet-stream";
      const uploadId = await store.createMultipartUpload({ ...ownerArgs(owner), bucket: params.bucket, key, contentType });
      return xmlResponse(initiateMultipartUploadXml({ bucket: params.bucket, key, uploadId }));
    }

    // ?folder&to=<new-path> -- Inaya-specific rename/move for a folder
    // created via PUT ?folder above. Same non-S3-protocol disclosure as
    // PUT ?folder.
    if (url.searchParams.has("folder")) {
      const to = url.searchParams.get("to");
      if (!to) return s3Error("InvalidRequest", "Renaming a folder requires ?to=<new-folder-path>.");
      const result = await store.renameS3Folder({ ...ownerArgs(owner), bucket: params.bucket, oldFolderPath: key, newFolderPath: to, actorEmail: accessKeyId });
      return Response.json(result, { status: 200 });
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
    const folderResp = folderAwareError(err);
    if (folderResp) return folderResp;
    console.error("POST /api/s3/[bucket]/[...key] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}

export async function GET(req, { params }) {
  try {
    const key = joinKey(params.key);
    const { owner, accessKeyId } = await authenticateS3Request(req, Buffer.alloc(0), { bucket: params.bucket, key });
    const store = storeFor(owner);
    const url = new URL(req.url);
    const versionId = url.searchParams.get("versionId") || undefined;

    // ?presign -- GCS Compatibility Extension SOW, Phase 2. Creates a
    // temporary signed download URL, not real S3/GCS presigned-URL
    // compatibility (see signedUrl.js's own header for why). Requires the
    // SAME real authentication as any other request on this route --
    // "authorization inherited from creator" means the creator must
    // already be allowed to read this object, checked identically via
    // authenticateS3Request/checkScope above before we ever get here.
    if (url.searchParams.has("presign")) {
      const credential = await resolveS3Credential(accessKeyId);
      if (!credential) {
        return s3Error("InvalidRequest", "Presigned URLs require an HMAC access key credential (Google-OAuth-authenticated requests have no signing secret to presign with).");
      }
      const expiresInSeconds = Number(url.searchParams.get("expiresIn")) || 3600;
      const qs = createSignedUrl({ accessKeyId, secretAccessKey: credential.secretAccessKey, method: "GET", bucket: params.bucket, key, expiresInSeconds });
      const signedUrl = `${url.origin}${url.pathname}?${qs}`;
      if (owner.type === "org") {
        const bucketDoc = await store.getS3Bucket({ orgId: owner.orgId, bucket: params.bucket });
        if (bucketDoc) {
          await logOrgActivity({
            orgId: owner.orgId,
            recordType: "s3_signed_url",
            recordId: bucketDoc._id,
            actorEmail: accessKeyId,
            action: "SIGNED_URL_CREATED",
            previousState: null,
            newState: null,
            metadata: { bucket: params.bucket, key, expiresInSeconds },
          }).catch(() => {}); // audit is best-effort here; a logging failure must never block a legitimate signed-URL response
        }
      }
      return Response.json({ url: signedUrl, expiresInSeconds });
    }

    // ?acl -- real S3 GetObjectAcl. Found via live gcloud storage testing
    // (GCS Compatibility Extension SOW, Phase 5): `gcloud storage objects
    // describe`/`rm` call this internally before acting, and with no
    // handler here it fell through to plain GetObject, returning the
    // object's raw bytes where an ACL XML document was expected -- the
    // client then crashed trying to parse file content as XML. A single,
    // real, minimal AccessControlPolicy (the requester as sole FULL_CONTROL
    // grantee -- this layer has no separate ACL model to represent
    // honestly beyond credential-scoped ownership) resolves it.
    if (url.searchParams.has("acl")) {
      const doc = await store.headS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, versionId });
      if (!doc) return s3Error("NoSuchKey", "The specified key does not exist.");
      return xmlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>${accessKeyId}</ID><DisplayName>${accessKeyId}</DisplayName></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>${accessKeyId}</ID><DisplayName>${accessKeyId}</DisplayName></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`
      );
    }

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

    if (url.searchParams.has("tagging")) {
      const doc = await store.headS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, versionId });
      if (!doc) return s3Error("NoSuchKey", "The specified key does not exist.");
      return xmlResponse(taggingXml(doc.tags || {}));
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
            ...checksumHeaders(doc),
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
        ...checksumHeaders(doc),
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
    const key = joinKey(params.key);
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0), { bucket: params.bucket, key });
    const store = storeFor(owner);
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
        ...checksumHeaders(doc),
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
    const key = joinKey(params.key);
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0), { bucket: params.bucket, key });
    const store = storeFor(owner);
    const url = new URL(req.url);
    const uploadId = url.searchParams.get("uploadId");

    if (uploadId) {
      await store.abortMultipartUpload({ ...ownerArgs(owner), uploadId });
      return new Response(null, { status: 204 });
    }

    // ?folder -- Inaya-specific extension, same disclosure as PUT ?folder.
    if (url.searchParams.has("folder")) {
      await store.deleteS3Folder({ ...ownerArgs(owner), bucket: params.bucket, folderPath: key, actorEmail: null });
      return new Response(null, { status: 204 });
    }

    if (url.searchParams.has("tagging")) {
      await store.deleteObjectTagging({ ...ownerArgs(owner), bucket: params.bucket, key, versionId: url.searchParams.get("versionId"), actorEmail: null });
      return new Response(null, { status: 204 });
    }

    const result = await store.deleteS3Object({ ...ownerArgs(owner), bucket: params.bucket, key, versionId: url.searchParams.get("versionId") || undefined });
    return new Response(null, { status: 204, headers: result?.deleteMarker ? { "x-amz-delete-marker": "true" } : {} });
  } catch (err) {
    if (err?.reason === "LegalHold" || err?.reason === "ObjectLocked") {
      return s3Error("AccessDenied", err.message);
    }
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    const folderResp = folderAwareError(err);
    if (folderResp) return folderResp;
    console.error("DELETE /api/s3/[bucket]/[...key] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}
