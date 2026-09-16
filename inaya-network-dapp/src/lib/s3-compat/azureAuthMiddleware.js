// src/lib/s3-compat/azureAuthMiddleware.js
//
// Ties the SAME S3 credential store (credentials.js) to Azure Shared Key
// verification (azureAuth.js) -- one Inaya credential works for S3 AND
// Azure, since both are just "prove you know a secret bound to one owner"
// underneath. accessKeyId doubles as the Azure "account name" in the
// SharedKey header; secretAccessKey doubles as the base64 "account key" --
// but Azure's HMAC needs base64-decodable bytes, so credentials.js's
// secretAccessKey (already base64-ish) is re-encoded to valid base64 for
// this path only (see resolveAzureCredential below).

import { resolveS3Credential, checkScope } from "./credentials.js";
import { verifySharedKeyRequest } from "./azureAuth.js";
import { verifyConnection as verifyMicrosoftConnection } from "../integrationProviders/microsoft.js";
import { getOrgCollections, normalizeEmail } from "../orgs.js";

export class AzureAuthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function toValidBase64Key(secretAccessKey) {
  // credentials.js's secretAccessKey has had /,+,= replaced with 'x' to be
  // header/URL-safe (see generateSecretAccessKey()) -- valid for an HMAC
  // *input* of any bytes, but Azure's accountKey must itself be valid
  // base64 to decode into HMAC key bytes. Re-deriving a real base64 key
  // deterministically from the same secret keeps ONE secret value working
  // for both protocols without storing a second one.
  const buf = Buffer.from(secretAccessKey, "utf8");
  return buf.toString("base64");
}

/** Real Microsoft Entra ID identity federation (SOW §4/§7): a caller presents
 *  a genuine Microsoft Graph access token (the same OAuth flow already
 *  proven real by the Integrations SOW's microsoft.js) instead of an Inaya
 *  Shared Key. The token is verified live against Microsoft Graph itself
 *  (never decoded/trusted locally), and the resulting real Microsoft
 *  identity is mapped to an EXISTING Inaya org membership by email --
 *  exactly the SOW's own instruction to map external identity onto
 *  existing authorization rather than inventing a parallel permission
 *  system. A Microsoft-authenticated user with no matching active
 *  membership is rejected outright -- checked against real org_members
 *  data, never assumed. Once matched, the request carries the same
 *  compatibility-layer access level any issued SharedKey credential
 *  already carries (see credentials.js/api-keys.js's identical
 *  precedent), so Entra ID here is a second door into the same room, not
 *  a separately-scoped tier. */
async function authenticateViaEntra(bearerToken) {
  const result = await verifyMicrosoftConnection({ accessToken: bearerToken });
  if (!result.verified) throw new AzureAuthError("AuthenticationFailed", `Microsoft Entra ID token could not be verified: ${result.error}`, 403);
  if (!result.externalAccountName) throw new AzureAuthError("AuthenticationFailed", "Microsoft Graph did not return an identifiable account (no userPrincipalName/mail).", 403);

  const email = normalizeEmail(result.externalAccountName);
  const { orgMembers } = await getOrgCollections();
  const membership = await orgMembers.findOne({ email, status: "active" });
  if (!membership) {
    throw new AzureAuthError("AuthenticationFailed", `${email} authenticated with Microsoft Entra ID, but is not an active member of any Inaya organization.`, 403);
  }
  return { owner: { type: "org", orgId: membership.orgId.toString() }, accessKeyId: `entra:${email}` };
}

const OPERATION_BY_METHOD = { GET: "READ", HEAD: "READ", PUT: "WRITE", POST: "WRITE", DELETE: "DELETE" };

/** Same server-derived target parsing as auth.js's deriveRequestTarget, over
 *  /api/azure/[container]/[...blob] instead of /api/s3/[bucket]/[...key] --
 *  container plays the same "bucket" role a granular grant scopes against. */
function deriveRequestTarget(url) {
  const segments = url.pathname.replace(/^\/api\/azure\/?/, "").split("/").filter(Boolean);
  const container = segments[0] || null;
  const blob = segments.length > 1 ? segments.slice(1).join("/") : null;
  return { container, blob };
}

export async function authenticateAzureRequest(req, bodyBuffer) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) throw new AzureAuthError("AuthenticationFailed", "Missing Authorization header.", 403);

  let credential, owner, accessKeyId;
  if (authHeader.startsWith("Bearer ")) {
    ({ owner, accessKeyId } = await authenticateViaEntra(authHeader.slice("Bearer ".length).trim()));
    // Entra-authenticated requests carry the org's full membership-derived
    // access, not any one issued credential's scope -- there is no
    // s3_credentials row to check a grant against, matching how Entra auth
    // already bypasses the credential store entirely for signature purposes.
    return { owner, accessKeyId };
  }

  const accountMatch = authHeader.match(/^SharedKey\s+([^:]+):/);
  if (!accountMatch) throw new AzureAuthError("AuthenticationFailed", "Malformed Authorization header (expected SharedKey account:signature or Bearer <Entra token>).", 403);

  credential = await resolveS3Credential(accountMatch[1]);
  if (!credential) throw new AzureAuthError("AuthenticationFailed", "The specified account name does not exist or its credential has been revoked.", 403);

  const url = new URL(req.url);
  const result = verifySharedKeyRequest({
    method: req.method,
    url,
    headers: req.headers,
    bodyBuffer,
    accountKey: toValidBase64Key(credential.secretAccessKey),
  });

  if (!result.ok) throw new AzureAuthError("AuthenticationFailed", result.reason || "Signature verification failed.", 403);

  const { container, blob } = deriveRequestTarget(url);
  const operation = OPERATION_BY_METHOD[req.method] || "READ";
  if (credential.scope?.bucket && !container) {
    throw new AzureAuthError("AuthenticationFailed", "This credential is scoped to a specific container and cannot list all containers.", 403);
  }
  const scopeCheck = checkScope(credential, { bucket: container, key: blob, operation });
  if (!scopeCheck.allowed) {
    throw new AzureAuthError("AuthenticationFailed", `Denied by credential scope: ${scopeCheck.reason}.`, 403);
  }

  return { owner: credential.owner, accessKeyId: credential.accessKeyId };
}
