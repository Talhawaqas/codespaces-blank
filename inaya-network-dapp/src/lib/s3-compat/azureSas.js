// Azure Shared Access Signature (SAS) support for the Azure Blob compatibility layer.
//
// A SAS is a URL whose query string carries a signature made with the storage account key, so a client
// that holds only the URL (AzCopy, a browser, a script) can act with exactly the rights it encodes.
// Before this module the layer accepted Shared Key and Entra tokens only, which is why AzCopy (SAS or
// Entra login only) could not be used. Two forms are verified here, both signed with the same key a
// Shared Key request uses (an Inaya access key id is the "account name", its secret the "account key"):
//
//   - service SAS  (sr=b|c)  scoped to one blob, or to one container
//   - account SAS  (ss/srt)  scoped by service, resource type and permissions
//
// The string-to-sign layouts below were taken from, and are tested against, the real
// @azure/storage-blob generators (test/azure-sas.test.mjs), not re-derived from documentation.
//
// ONE Inaya-specific thing: a real Azure SAS carries no account name because Azure finds the account
// from the host name, and Inaya's endpoint has no per-account host. So a SAS URL must also carry
// `inaya-account=<access key id>`; the server uses it only to look up which key to verify the signature
// with. It is not part of the signed string and cannot widen anything: the signature either verifies
// against that credential's key or it doesn't. Azure ignores unknown query parameters, and AzCopy and the
// SDKs pass them through unchanged.
//
// Not supported, rejected with a clear message rather than silently misbehaving: stored access policies
// (`si`), directory SAS (`sr=d`), user-delegation SAS (needs Entra-issued delegation keys), and any
// signed version older than 2018-11-09.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SAS_ACCOUNT_PARAM = "inaya-account";
export const SAS_VERSION = "2021-08-06";
const MIN_VERSION = "2018-11-09";
const WITH_ENCRYPTION_SCOPE = "2020-12-06";
const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_SAS_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const fail = (reason, code = "AuthenticationFailed") => ({ ok: false, reason, code });

export function hasSas(url) {
  return url.searchParams.has("sig") && url.searchParams.has("sv");
}

export function sasAccountHint(url) {
  return url.searchParams.get(SAS_ACCOUNT_PARAM);
}

/** The container and blob a request addresses, from /api/azure/<container>/<blob...>. */
export function azureTargetOf(url) {
  const segments = url.pathname.replace(/^\/api\/azure\/?/, "").split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  return { container: segments[0] || null, blob: segments.length > 1 ? segments.slice(1).join("/") : null };
}

function hmac(accountKeyBase64, stringToSign) {
  return createHmac("sha256", Buffer.from(accountKeyBase64, "base64")).update(stringToSign, "utf8").digest();
}

function signaturesMatch(provided, expected) {
  // URLSearchParams turns an unescaped "+" in a base64 signature into a space; put it back.
  const buf = Buffer.from(String(provided).replace(/ /g, "+"), "base64");
  return buf.length === expected.length && timingSafeEqual(buf, expected);
}

function ipToInt(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((acc, p) => acc * 256 + p, 0);
}

function ipAllowed(range, clientIp) {
  if (!range) return true;
  const ip = ipToInt(clientIp);
  if (ip === null) return false;
  const [lo, hi] = range.split("-");
  const low = ipToInt(lo);
  const high = hi === undefined ? low : ipToInt(hi);
  return low !== null && high !== null && ip >= low && ip <= high;
}

/** Builds the string-to-sign for a SAS and the metadata needed to authorize the request. */
function stringToSignFor({ url, accountName, target }) {
  const q = (k) => url.searchParams.get(k) || "";
  const sv = q("sv");
  const withScope = sv >= WITH_ENCRYPTION_SCOPE;

  if (url.searchParams.has("ss") && url.searchParams.has("srt")) {
    const fields = [accountName, q("sp"), q("ss"), q("srt"), q("st"), q("se"), q("sip"), q("spr"), sv];
    if (withScope) fields.push(q("ses"));
    fields.push(""); // an account SAS ends with an extra newline
    return { kind: "account", stringToSign: fields.join("\n") };
  }

  const resource = q("sr");
  if (resource === "d") return { error: "Directory SAS (sr=d) is not supported." };
  if (resource !== "b" && resource !== "c") return { error: `Unsupported signed resource "${resource}" (expected b or c).` };
  if (!target.container) return { error: "A service SAS must address a container or blob." };
  if (resource === "b" && !target.blob) return { error: "A blob SAS (sr=b) must address a blob." };

  const canonical = `/blob/${accountName}/${target.container}${resource === "b" ? `/${target.blob}` : ""}`;
  const fields = [q("sp"), q("st"), q("se"), canonical, q("si"), q("sip"), q("spr"), sv, resource, q("snapshot") || q("versionid")];
  if (withScope) fields.push(q("ses"));
  fields.push(q("rscc"), q("rscd"), q("rsce"), q("rscl"), q("rsct"));
  return { kind: "service", resource, stringToSign: fields.join("\n") };
}

/**
 * Verifies the signature, validity window, IP range and protocol of a SAS URL.
 * Returns { ok: true, kind, resource, permissions, services, resourceTypes } or { ok: false, reason, code }.
 */
export function verifySas({ url, accountName, accountKeyBase64, now = Date.now(), clientIp = null, isHttps = true }) {
  const q = (k) => url.searchParams.get(k);
  const sv = q("sv");
  if (!q("sig") || !sv) return fail("Missing SAS signature or version.");
  if (sv < MIN_VERSION) return fail(`SAS signed version ${sv} is not supported (minimum ${MIN_VERSION}).`);
  if (q("si")) return fail("Stored access policies (si) are not supported; use explicit permissions and expiry.");
  if (!q("se")) return fail("The SAS has no expiry time (se).");

  const built = stringToSignFor({ url, accountName, target: azureTargetOf(url) });
  if (built.error) return fail(built.error);

  if (!signaturesMatch(q("sig"), hmac(accountKeyBase64, built.stringToSign))) return fail("Server failed to authenticate the request: the SAS signature does not match.");

  const expires = Date.parse(q("se"));
  if (!Number.isFinite(expires) || now > expires) return fail("The SAS has expired.");
  if (q("st")) {
    const start = Date.parse(q("st"));
    if (!Number.isFinite(start) || now + CLOCK_SKEW_MS < start) return fail("The SAS is not yet valid.");
  }
  if (q("spr") === "https" && !isHttps) return fail("This SAS only permits HTTPS requests.");
  if (q("sip") && !ipAllowed(q("sip"), clientIp)) return fail("The request IP is outside the SAS's allowed range.");

  return {
    ok: true,
    kind: built.kind,
    resource: built.resource || null,
    permissions: new Set((q("sp") || "").split("")),
    services: new Set((q("ss") || "").split("")),
    resourceTypes: new Set((q("srt") || "").split("")),
  };
}

/** Maps a request onto the SAS permission letters that allow it (any one suffices). */
export function requiredPermissions({ method, container, blob, searchParams }) {
  const comp = searchParams.get("comp");
  const m = method.toUpperCase();
  if (!container) return m === "GET" ? { level: "service", anyOf: ["l"] } : null;
  if (!blob) {
    if (m === "PUT") return { level: "container", anyOf: ["c", "w"], createsOrDeletesContainer: true };
    if (m === "DELETE") return { level: "container", anyOf: ["d"], createsOrDeletesContainer: true };
    if (m === "GET" && comp === "list") return { level: "container", anyOf: ["l"] };
    if (m === "GET" || m === "HEAD") return { level: "container", anyOf: ["r", "l"] };
    return null;
  }
  if (m === "GET" || m === "HEAD") return { level: "object", anyOf: ["r"] };
  if (m === "DELETE") return { level: "object", anyOf: ["d"] };
  if (m === "PUT") return { level: "object", anyOf: comp === "block" || comp === "blocklist" ? ["a", "c", "w"] : comp ? ["w"] : ["c", "w"] };
  return null;
}

/** Decides whether a VERIFIED SAS permits this request. Returns { ok: true } or { ok: false, reason, code }. */
export function authorizeSasRequest({ sas, method, url }) {
  const { container, blob } = azureTargetOf(url);
  const need = requiredPermissions({ method, container, blob, searchParams: url.searchParams });
  if (!need) return fail("This SAS does not allow that operation.", "AuthorizationPermissionMismatch");

  if (sas.kind === "account") {
    if (!sas.services.has("b")) return fail("This account SAS does not include the blob service.", "AuthorizationServiceMismatch");
    const typeNeeded = need.level === "service" ? "s" : need.level === "container" ? "c" : "o";
    if (!sas.resourceTypes.has(typeNeeded)) return fail("This account SAS does not include the required resource type.", "AuthorizationResourceTypeMismatch");
  } else {
    // A service SAS is bound to one blob or one container by its signature. It can never create or delete containers or list the account.
    if (need.level === "service" || need.createsOrDeletesContainer) return fail("A service SAS cannot perform account or container management.", "AuthorizationResourceTypeMismatch");
    if (sas.resource === "b" && need.level !== "object") return fail("A blob SAS only permits operations on that blob.", "AuthorizationResourceTypeMismatch");
  }
  if (!need.anyOf.some((p) => sas.permissions.has(p))) return fail("This SAS does not grant the permission this operation needs.", "AuthorizationPermissionMismatch");
  return { ok: true };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Signs a service SAS for a container or blob with an access key (server-side issuing). Returns the query string. */
export function signServiceSas({ accountName, accountKeyBase64, container, blob = null, permissions, startsAt = null, expiresAt, protocol = "", version = SAS_VERSION }) {
  const resource = blob ? "b" : "c";
  const fields = {
    sp: permissions, st: startsAt ? iso(startsAt) : "", se: iso(expiresAt), sip: "", spr: protocol, sv: version, sr: resource,
  };
  const canonical = `/blob/${accountName}/${container}${blob ? `/${blob}` : ""}`;
  const stringToSign = [fields.sp, fields.st, fields.se, canonical, "", fields.sip, fields.spr, fields.sv, fields.sr, "", "", "", "", "", "", ""].join("\n");
  const signature = hmac(accountKeyBase64, stringToSign).toString("base64");
  const params = new URLSearchParams();
  params.set("sv", version);
  if (protocol) params.set("spr", protocol);
  if (fields.st) params.set("st", fields.st);
  params.set("se", fields.se);
  params.set("sr", resource);
  params.set("sp", permissions);
  params.set("sig", signature);
  params.set(SAS_ACCOUNT_PARAM, accountName);
  return params.toString();
}
