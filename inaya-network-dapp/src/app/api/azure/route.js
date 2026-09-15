// GET /?comp=list -> List Containers
import { authenticateAzureRequest, AzureAuthError } from "../../../lib/s3-compat/azureAuthMiddleware.js";
import * as orgStore from "../../../lib/s3-compat/store.js";
import * as walletStore from "../../../lib/s3-compat/walletStore.js";
import { azureError, azureXmlResponse, listContainersXml } from "../../../lib/s3-compat/azureXml.js";

export async function GET(req) {
  try {
    const { owner } = await authenticateAzureRequest(req, Buffer.alloc(0));
    const containers = owner.type === "org" ? await orgStore.listS3Buckets(owner.orgId) : await walletStore.listS3Buckets(owner.walletAddress);
    return azureXmlResponse(listContainersXml(containers));
  } catch (err) {
    if (err instanceof AzureAuthError) return azureError(err.code, err.message);
    console.error("GET /api/azure failed:", err);
    return azureError("InternalError", "An internal error occurred.");
  }
}
