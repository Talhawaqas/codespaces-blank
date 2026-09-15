// Azure Blob container-level REST surface. Real Azure addresses containers
// via {account}.blob.core.windows.net/{container} (account in the
// hostname); since enterprise Azure tooling is pointed at a custom
// endpoint for this compatibility layer anyway (exactly like AzCopy/the
// SDK support for Azurite), the account is resolved from the credential,
// not the URL -- documented plainly in the SOW report, not silently
// different from real Azure without saying so.
//
// PUT  /:container                          -> Create Container
// GET  /:container?restype=container&comp=list&prefix=&delimiter= -> List Blobs
// GET  /:container?comp=list (no restype)    -> also List Blobs (some SDKs omit restype on this call)
// DELETE /:container                         -> Delete Container (must be empty)
import { authenticateAzureRequest, AzureAuthError } from "../../../../lib/s3-compat/azureAuthMiddleware.js";
import * as orgStore from "../../../../lib/s3-compat/store.js";
import * as walletStore from "../../../../lib/s3-compat/walletStore.js";
import { azureError, azureXmlResponse, listBlobsXml } from "../../../../lib/s3-compat/azureXml.js";

function storeFor(owner) {
  return owner.type === "org" ? orgStore : walletStore;
}
function ownerArgs(owner) {
  return owner.type === "org" ? { orgId: owner.orgId } : { walletAddress: owner.walletAddress };
}

export async function PUT(req, { params }) {
  try {
    const { owner, accessKeyId } = await authenticateAzureRequest(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const existing = await store.getS3Bucket({ ...ownerArgs(owner), bucket: params.container });
    if (existing) return azureError("ContainerAlreadyExists", "The specified container already exists.");
    await store.ensureS3Bucket({ ...ownerArgs(owner), bucket: params.container, actorEmail: accessKeyId });
    return new Response(null, { status: 201, headers: { "x-ms-version": "2021-08-06" } });
  } catch (err) {
    if (err instanceof AzureAuthError) return azureError(err.code, err.message);
    console.error("PUT /api/azure/[container] failed:", err);
    return azureError("InternalError", "An internal error occurred.");
  }
}

export async function GET(req, { params }) {
  try {
    const { owner } = await authenticateAzureRequest(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const url = new URL(req.url);
    const prefix = url.searchParams.get("prefix") || "";
    const delimiter = url.searchParams.get("delimiter") || "";
    const result = await store.listS3Objects({ ...ownerArgs(owner), bucket: params.container, prefix, delimiter, maxKeys: Number(url.searchParams.get("maxresults")) || 5000 });
    if (!result) return azureError("ContainerNotFound", "The specified container does not exist.");
    return azureXmlResponse(listBlobsXml({ container: params.container, prefix, blobs: result.contents, blobPrefixes: result.commonPrefixes }));
  } catch (err) {
    if (err instanceof AzureAuthError) return azureError(err.code, err.message);
    console.error("GET /api/azure/[container] failed:", err);
    return azureError("InternalError", "An internal error occurred.");
  }
}

export async function DELETE(req, { params }) {
  try {
    const { owner } = await authenticateAzureRequest(req, Buffer.alloc(0));
    const store = storeFor(owner);
    const result = await store.deleteS3Bucket({ ...ownerArgs(owner), bucket: params.container });
    if (!result.deleted) {
      return azureError(result.reason === "BucketNotEmpty" ? "ContainerNotEmpty" : "ContainerNotFound", result.reason === "BucketNotEmpty" ? "The container is not empty." : "The specified container does not exist.");
    }
    return new Response(null, { status: 202, headers: { "x-ms-version": "2021-08-06" } });
  } catch (err) {
    if (err instanceof AzureAuthError) return azureError(err.code, err.message);
    console.error("DELETE /api/azure/[container] failed:", err);
    return azureError("InternalError", "An internal error occurred.");
  }
}
