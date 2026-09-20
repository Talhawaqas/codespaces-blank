// PUT /:bucket -> CreateBucket (idempotent)
// GET /:bucket -> ListObjectsV2 (?prefix=&delimiter=&max-keys=)
// DELETE /:bucket -> DeleteBucket (must be empty)
import { authenticateS3Request, S3AuthError } from "../../../../lib/s3-compat/auth.js";
import * as orgStore from "../../../../lib/s3-compat/store.js";
import * as walletStore from "../../../../lib/s3-compat/walletStore.js";
import { s3Error, xmlResponse, listObjectsV2Xml, listObjectVersionsXml } from "../../../../lib/s3-compat/xml.js";

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
    const { owner, accessKeyId } = await authenticateS3Request(req, bodyBuffer, { bucket: params.bucket, key: null });
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

    // ?migration-log -- Inaya-specific extension (not real S3), used by
    // the standalone inaya-migration-agent CLI (Enterprise Adoption SOW,
    // Workstream A) to record a job-level start/complete/fail event.
    // Reuses the existing audit chain verbatim (logOrgActivity) rather
    // than a parallel tracking system -- these events show up in the
    // org's existing Audit Trail view with zero new UI. Org destinations
    // only: wallet-side migration reporting isn't a defined concept here.
    if (url.searchParams.has("migration-log")) {
      if (owner.type !== "org") return s3Error("InvalidRequest", "Migration job logging is an organization feature.");
      let body;
      try {
        body = JSON.parse(bodyBuffer.toString("utf8"));
      } catch {
        return s3Error("MalformedXML", "migration-log body must be valid JSON.");
      }
      const { jobId, event, summary } = body || {};
      if (!jobId || !["STARTED", "COMPLETED", "FAILED"].includes(event)) {
        return s3Error("InvalidRequest", 'migration-log requires { jobId, event: "STARTED"|"COMPLETED"|"FAILED", summary? }.');
      }
      await store.recordMigrationEvent({ orgId: owner.orgId, bucket: params.bucket, jobId, event, summary, actorEmail: accessKeyId });
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
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0), { bucket: params.bucket, key: null });
    const store = storeFor(owner);
    const url = new URL(req.url);

    if (url.searchParams.has("versioning")) {
      const info = await store.getBucketVersioning({ ...ownerArgs(owner), bucket: params.bucket });
      if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist.");
      return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${info.versioningStatus === "Unversioned" ? "" : info.versioningStatus}</Status></VersioningConfiguration>`);
    }

    // Enterprise Adoption SOW, Workstream B (Terraform) -- real Terraform
    // apply against this endpoint surfaced a genuine gap: a bucket
    // sub-resource this layer doesn't implement (e.g. ?policy) was
    // silently falling through to plain ListObjectsV2 instead of a real
    // S3-shaped "not configured" response, which every S3 SDK -- not just
    // Terraform's -- treats as a parse failure rather than "nothing set."
    // Bucket policies/CORS/ownership-controls/public-access-block are
    // genuinely not implemented (no IAM-policy engine exists here, nor is
    // one in scope per this SOW's own "no second storage protocol stack"
    // principle) -- but a real, empty-state response for a Terraform
    // resource's normal refresh read is a narrow, justified gap-fill, not
    // new functionality.
    const UNIMPLEMENTED_BUCKET_SUBRESOURCES = {
      policy: () => s3Error("NoSuchBucketPolicy", "The bucket policy does not exist."),
      cors: () => s3Error("NoSuchCORSConfiguration", "The CORS configuration does not exist."),
      website: () => s3Error("NoSuchWebsiteConfiguration", "The website configuration does not exist."),
      encryption: () => s3Error("ServerSideEncryptionConfigurationNotFoundError", "The server-side encryption configuration was not found."),
      replication: () => s3Error("ReplicationConfigurationNotFoundError", "The replication configuration was not found."),
      ownershipControls: () => s3Error("OwnershipControlsNotFoundError", "The bucket ownership controls were not found."),
      publicAccessBlock: () => s3Error("NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found."),
      logging: () => xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><BucketLoggingStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></BucketLoggingStatus>`),
      accelerate: () => xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><AccelerateConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></AccelerateConfiguration>`),
      requestPayment: () => xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><RequestPaymentConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Payer>BucketOwner</Payer></RequestPaymentConfiguration>`),
    };
    for (const [param, respond] of Object.entries(UNIMPLEMENTED_BUCKET_SUBRESOURCES)) {
      if (url.searchParams.has(param)) return respond();
    }

    const prefix = url.searchParams.get("prefix") || "";
    const delimiter = url.searchParams.get("delimiter") || "";

    if (url.searchParams.has("versions")) {
      const key = url.searchParams.get("prefix");
      if (key) {
        // Single-key JSON shape -- Business Workspace's and the dApp's
        // own existing consumers (not a real S3 client, so a convenient
        // Inaya-specific JSON response rather than XML has always been
        // fine here). Unchanged, zero regression.
        const versions = await store.listObjectVersions({ ...ownerArgs(owner), bucket: params.bucket, key });
        if (!versions) return s3Error("NoSuchBucket", "The specified bucket does not exist.");
        return Response.json({ bucket: params.bucket, key, versions });
      }
      // No prefix -- a genuine S3 SDK client (e.g. Terraform's
      // aws_s3_bucket force_destroy, which must enumerate every version
      // of every object before deleting the bucket). Real S3 XML shape,
      // bucket-wide, single-page (Enterprise Adoption SOW, Workstream B --
      // see store.js's listAllObjectVersions for the disclosed pagination
      // limitation). A real prefix-FILTERED (not exact-key) call from a
      // third-party client is not yet distinguished from this bucket-wide
      // case -- a known, narrow remaining limitation, not claimed solved.
      const entries = await store.listAllObjectVersions({ ...ownerArgs(owner), bucket: params.bucket });
      if (!entries) return s3Error("NoSuchBucket", "The specified bucket does not exist.");
      return xmlResponse(listObjectVersionsXml({ bucket: params.bucket, entries }));
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

// Real S3 batch DeleteObjects XML body -- same pragmatic regex-extraction
// level as this layer's other small, fixed-shape parsers
// (parseCompleteMultipartBody etc.). Enterprise Adoption SOW, Workstream
// B: required for Terraform's aws_s3_bucket force_destroy, which deletes
// every object version this way before deleting the bucket itself.
function parseDeleteObjectsBody(xmlBody) {
  const objects = [];
  const objectBlocks = xmlBody.match(/<Object>[\s\S]*?<\/Object>/g) || [];
  for (const block of objectBlocks) {
    const key = block.match(/<Key>([^<]*)<\/Key>/)?.[1];
    const versionId = block.match(/<VersionId>([^<]*)<\/VersionId>/)?.[1];
    if (key) objects.push({ key: decodeXmlEntities(key), versionId: versionId || undefined });
  }
  return objects;
}
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// POST /:bucket?delete -> DeleteObjects (real S3 batch-delete API).
export async function POST(req, { params }) {
  try {
    const bodyBuffer = Buffer.from(await req.arrayBuffer());
    const { owner } = await authenticateS3Request(req, bodyBuffer, { bucket: params.bucket, key: null });
    const store = storeFor(owner);
    const url = new URL(req.url);

    if (!url.searchParams.has("delete")) return s3Error("InvalidRequest", "Unrecognized POST operation.");

    const objects = parseDeleteObjectsBody(bodyBuffer.toString("utf8"));
    const deleted = [];
    const errors = [];
    for (const obj of objects) {
      try {
        await store.deleteS3Object({ ...ownerArgs(owner), bucket: params.bucket, key: obj.key, versionId: obj.versionId });
        deleted.push(obj);
      } catch (err) {
        errors.push({ ...obj, code: "InternalError", message: err.message });
      }
    }

    const deletedXml = deleted.map((o) => `<Deleted><Key>${escXml(o.key)}</Key>${o.versionId ? `<VersionId>${escXml(o.versionId)}</VersionId>` : ""}</Deleted>`).join("");
    const errorXml = errors.map((e) => `<Error><Key>${escXml(e.key)}</Key><Code>${escXml(e.code)}</Code><Message>${escXml(e.message)}</Message></Error>`).join("");
    return xmlResponse(`<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedXml}${errorXml}</DeleteResult>`);
  } catch (err) {
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("POST /api/s3/[bucket] failed:", err);
    return s3Error("InternalError", err.message || "An internal error occurred.");
  }
}

export async function DELETE(req, { params }) {
  try {
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0), { bucket: params.bucket, key: null });
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
