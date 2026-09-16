// PUT /:bucket -> CreateBucket (idempotent)
// GET /:bucket -> ListObjectsV2 (?prefix=&delimiter=&max-keys=)
// DELETE /:bucket -> DeleteBucket (must be empty)
import { authenticateS3Request, S3AuthError } from "../../../../lib/s3-compat/auth.js";
import * as orgStore from "../../../../lib/s3-compat/store.js";
import * as walletStore from "../../../../lib/s3-compat/walletStore.js";
import { s3Error, xmlResponse, listObjectsV2Xml } from "../../../../lib/s3-compat/xml.js";

function storeFor(owner) {
  return owner.type === "org" ? orgStore : walletStore;
}
function ownerArgs(owner) {
  return owner.type === "org" ? { orgId: owner.orgId } : { walletAddress: owner.walletAddress };
}

// PUT ?versioning (real S3 sub-resource -- PutBucketVersioning) --
// <VersioningConfiguration><Status>Enabled|Suspended</Status></VersioningConfiguration>.
// Simple regex extraction, same pragmatic level as this file's own
// parseCompleteMultipartBody -- this one XML shape is small and fixed
// enough not to need a real parser.
function parseVersioningStatus(xmlBody) {
  const match = xmlBody.match(/<Status>(Enabled|Suspended)<\/Status>/);
  return match ? match[1] : null;
}

export async function PUT(req, { params }) {
  try {
    const bodyBuffer = Buffer.from(await req.arrayBuffer());
    const { owner, accessKeyId } = await authenticateS3Request(req, bodyBuffer);
    const store = storeFor(owner);
    const url = new URL(req.url);

    if (url.searchParams.has("versioning")) {
      const status = parseVersioningStatus(bodyBuffer.toString("utf8"));
      if (!status) return s3Error("MalformedXML", "VersioningConfiguration must specify Status=Enabled or Suspended.");
      await store.putBucketVersioning({ ...ownerArgs(owner), bucket: params.bucket, status });
      return new Response(null, { status: 200 });
    }

    if (url.searchParams.has("object-lock")) {
      await store.enableBucketObjectLock({ ...ownerArgs(owner), bucket: params.bucket });
      return new Response(null, { status: 200 });
    }

    await store.ensureS3Bucket({ ...ownerArgs(owner), bucket: params.bucket, actorEmail: accessKeyId });
    return new Response(null, { status: 200, headers: { Location: `/${params.bucket}` } });
  } catch (err) {
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("PUT /api/s3/[bucket] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}

export async function GET(req, { params }) {
  try {
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const url = new URL(req.url);

    if (url.searchParams.has("versioning")) {
      const info = await store.getBucketVersioning({ ...ownerArgs(owner), bucket: params.bucket });
      if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist.");
      return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${info.versioningStatus === "Unversioned" ? "" : info.versioningStatus}</Status></VersioningConfiguration>`);
    }

    const prefix = url.searchParams.get("prefix") || "";
    const delimiter = url.searchParams.get("delimiter") || "";

    if (url.searchParams.has("versions")) {
      // ListObjectVersions is real S3, but only ever exercised by the
      // real tools this SOW asks for at object granularity in practice --
      // implemented here at the single-key granularity Business Workspace
      // and the dApp actually consume (store.listObjectVersions), rather
      // than the full bucket-wide enumerate-every-key-then-every-version
      // shape, since no key means "which object's versions" is undefined
      // for this layer's translation model (see store.js header).
      const key = url.searchParams.get("prefix");
      if (!key) return s3Error("InvalidRequest", "ListObjectVersions on this layer requires ?versions&prefix=<key> naming the exact object.");
      const versions = await store.listObjectVersions({ ...ownerArgs(owner), bucket: params.bucket, key });
      if (!versions) return s3Error("NoSuchBucket", "The specified bucket does not exist.");
      return Response.json({ bucket: params.bucket, key, versions });
    }

    const result = await store.listS3Objects({
      ...ownerArgs(owner),
      bucket: params.bucket,
      prefix,
      delimiter,
      maxKeys: Number(url.searchParams.get("max-keys")) || 1000,
    });
    if (!result) return s3Error("NoSuchBucket", "The specified bucket does not exist.");
    return xmlResponse(
      listObjectsV2Xml({ bucket: params.bucket, prefix, delimiter, contents: result.contents, commonPrefixes: result.commonPrefixes, isTruncated: result.isTruncated })
    );
  } catch (err) {
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("GET /api/s3/[bucket] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}

export async function DELETE(req, { params }) {
  try {
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const result = await store.deleteS3Bucket({ ...ownerArgs(owner), bucket: params.bucket });
    if (!result.deleted) return s3Error(result.reason, result.reason === "BucketNotEmpty" ? "The bucket you tried to delete is not empty." : "The specified bucket does not exist.");
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("DELETE /api/s3/[bucket] failed:", err);
    return s3Error("InternalError", "An internal error occurred.");
  }
}
