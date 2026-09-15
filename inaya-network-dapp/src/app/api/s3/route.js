// GET / -> ListBuckets. Dispatches to the org store or the wallet store
// based on which ownership type the credential resolves to -- see
// src/lib/s3-compat/store.js (org) and walletStore.js (wallet).
import { authenticateS3Request, S3AuthError } from "../../../lib/s3-compat/auth.js";
import * as orgStore from "../../../lib/s3-compat/store.js";
import * as walletStore from "../../../lib/s3-compat/walletStore.js";
import { s3Error, xmlResponse, listAllMyBucketsXml } from "../../../lib/s3-compat/xml.js";

export async function GET(req) {
  try {
    const { owner } = await authenticateS3Request(req, Buffer.alloc(0));
    const buckets =
      owner.type === "org" ? await orgStore.listS3Buckets(owner.orgId) : await walletStore.listS3Buckets(owner.walletAddress);
    return xmlResponse(listAllMyBucketsXml(buckets));
  } catch (err) {
    if (err instanceof S3AuthError) return s3Error(err.code, err.message);
    console.error("GET /api/s3 failed:", err);
    return s3Error("InternalError", "An internal error occurred.");
  }
}
