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

export async function PUT(req, { params }) {
  try {
    const { owner, accessKeyId } = await authenticateS3Request(req, Buffer.alloc(0));
    const store = storeFor(owner);
    await store.ensureS3Bucket({ ...ownerArgs(owner), bucket: params.bucket, actorEmail: accessKeyId });
    return new Response(null, { status: 200, headers: { Location: `/${params.bucket}` } });
  } catch (err) {
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("PUT /api/s3/[bucket] failed:", err);
    return s3Error("InternalError", "An internal error occurred.");
  }
}

export async function GET(req, { params }) {
  try {
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const url = new URL(req.url);
    const prefix = url.searchParams.get("prefix") || "";
    const delimiter = url.searchParams.get("delimiter") || "";
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
    return s3Error("InternalError", "An internal error occurred.");
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
