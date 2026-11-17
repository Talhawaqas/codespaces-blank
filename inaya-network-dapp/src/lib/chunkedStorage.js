// src/lib/chunkedStorage.js
//
// Server side of the chunked document format (see chunkedFile.js). The browser uploads each encrypted
// half-piece straight to the Filebase bucket through short-lived signed PUT links, so no file bytes
// pass through a server function (whose ~4.5 MB request limit is what made large uploads fail).
//
// No new collection (Atlas is at its collection limit): an upload in progress is described by a signed
// token (HMAC with a key derived from INTEGRATION_ENCRYPTION_KEY) that names the org, the uploader, the
// upload id, the size and an expiry. Signed links are only issued for object keys under that upload's
// own prefix, and only to the member the token was issued to. When the document is registered, the
// manifests stored at the prefix must carry exactly the CIDs being registered, and the document keeps
// { storage: { format, provider, prefix } } so readers can be handed fresh signed download links.
//
// The bucket needs a CORS rule allowing PUT and GET from the site (scripts/filebase-cors.mjs).

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FORMAT, FORMAT_VERSION, PIECE_SIZE, pieceCount, isChunkedManifest } from "./chunkedFile.js";

export const STORAGE_FORMAT = `${FORMAT}-v${FORMAT_VERSION}`;
const UPLOAD_TTL_MS = 12 * 60 * 60 * 1000; // a very large file on a slow line can take hours
const PUT_LINK_SECONDS = 60 * 60;
const GET_LINK_SECONDS = 60 * 60;
const MAX_SIGN_BATCH = 64;

let client;
function s3() {
  if (!process.env.FILEBASE_ACCESS_KEY || !process.env.FILEBASE_SECRET_KEY || !process.env.FILEBASE_BUCKET) {
    throw new ChunkedError(503, "Large-file storage is not configured.");
  }
  client ||= new S3Client({
    endpoint: "https://s3.filebase.io", region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: process.env.FILEBASE_ACCESS_KEY, secretAccessKey: process.env.FILEBASE_SECRET_KEY },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}
const bucket = () => process.env.FILEBASE_BUCKET;

export class ChunkedError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function tokenKey() {
  const root = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!root) throw new ChunkedError(503, "Large-file uploads are not configured on this server.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(root), Buffer.alloc(0), Buffer.from("inaya-chunked-upload-token-v1"), 32));
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (body) => b64u(createHmac("sha256", tokenKey()).update(body).digest());

export function issueUploadToken(claims) {
  const body = b64u(JSON.stringify(claims));
  return `${body}.${sign(body)}`;
}

/** Verifies a token and that it belongs to this org and member. Throws ChunkedError otherwise. */
export function readUploadToken(token, { orgId, email, allowExpired = false } = {}) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) throw new ChunkedError(400, "This upload is not valid. Start it again.");
  const expected = Buffer.from(sign(body)); const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ChunkedError(400, "This upload is not valid. Start it again.");
  let claims;
  try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new ChunkedError(400, "This upload is not valid. Start it again."); }
  if (!allowExpired && Date.now() > claims.exp) throw new ChunkedError(410, "This upload took too long and has expired. Start it again.");
  if (orgId && claims.orgId !== String(orgId)) throw new ChunkedError(403, "This upload belongs to another company.");
  if (email && claims.email !== String(email).toLowerCase()) throw new ChunkedError(403, "This upload was started by someone else.");
  return claims;
}

export const prefixFor = (orgId, uploadId) => `ws/${orgId}/${uploadId}/`;
const pieceKey = (prefix, role, index) => `${prefix}${role === "alpha" ? "a" : "b"}/${index}`;
const manifestKey = (prefix, role) => `${prefix}${role}.json`;

/** Starts an upload after the caller has checked membership and plan limits. */
export function startUpload({ orgId, email, sizeBytes }) {
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) throw new ChunkedError(400, "sizeBytes must be a positive number.");
  const uploadId = randomBytes(12).toString("hex");
  const claims = { v: 1, orgId: String(orgId), email: String(email).toLowerCase(), uploadId, size, pieceSize: PIECE_SIZE, count: pieceCount(size), exp: Date.now() + UPLOAD_TTL_MS };
  return { uploadId, token: issueUploadToken(claims), pieceSize: PIECE_SIZE, count: claims.count };
}

const putLink = (Key, ContentType) => getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket(), Key, ContentType }), { expiresIn: PUT_LINK_SECONDS });
const getLink = (Key) => getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key }), { expiresIn: GET_LINK_SECONDS });

/** Signed PUT links for pieces [from, from+count). */
export async function signPieces(claims, from, count) {
  const start = Math.max(0, Math.floor(Number(from) || 0));
  const n = Math.min(MAX_SIGN_BATCH, Math.max(0, Math.floor(Number(count) || 0)), claims.count - start);
  if (n <= 0) throw new ChunkedError(400, "No pieces in that range.");
  const prefix = prefixFor(claims.orgId, claims.uploadId);
  return Promise.all(Array.from({ length: n }, async (_, k) => {
    const index = start + k;
    const [a, b] = [pieceKey(prefix, "alpha", index), pieceKey(prefix, "beta", index)];
    return { index, alpha: { key: a, url: await putLink(a, "application/octet-stream") }, beta: { key: b, url: await putLink(b, "application/octet-stream") } };
  }));
}

export async function signManifests(claims) {
  const prefix = prefixFor(claims.orgId, claims.uploadId);
  const [a, b] = [manifestKey(prefix, "alpha"), manifestKey(prefix, "beta")];
  return { alpha: { key: a, url: await putLink(a, "application/json") }, beta: { key: b, url: await putLink(b, "application/json") } };
}

async function readManifest(prefix, role) {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: manifestKey(prefix, role) }));
  const manifest = JSON.parse(await res.Body.transformToString("utf-8"));
  if (!isChunkedManifest(manifest)) throw new ChunkedError(422, "The uploaded file's storage record is not readable.");
  return manifest;
}

/**
 * Called when a chunked document is registered. Confirms the token, that both manifests exist under the
 * upload's prefix with exactly the CIDs being registered, that every piece key stays inside the prefix,
 * and that the sizes add up. Returns the `storage` field to save on the document.
 */
export async function verifyChunkedRegistration({ token, orgId, email, cidAlpha, cidBeta, sizeBytes }) {
  const claims = readUploadToken(token, { orgId, email });
  const prefix = prefixFor(claims.orgId, claims.uploadId);
  if (Number(sizeBytes) !== claims.size) throw new ChunkedError(400, "The file size does not match the upload.");
  const [headA, headB] = await Promise.all(["alpha", "beta"].map((r) => s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: manifestKey(prefix, r) })).catch(() => null)));
  if (!headA || !headB) throw new ChunkedError(422, "The upload did not finish. Try again.");
  if (headA.Metadata?.cid !== cidAlpha || headB.Metadata?.cid !== cidBeta) throw new ChunkedError(422, "The upload does not match what is being saved.");
  const [alpha, beta] = await Promise.all([readManifest(prefix, "alpha"), readManifest(prefix, "beta")]);
  const pieces = [...alpha.pieces, ...beta.pieces];
  if (alpha.uploadId !== claims.uploadId || beta.uploadId !== claims.uploadId || alpha.count !== claims.count || alpha.size !== claims.size) throw new ChunkedError(422, "The upload does not match what is being saved.");
  if (pieces.some((p) => typeof p.key !== "string" || !p.key.startsWith(prefix))) throw new ChunkedError(422, "The upload's storage record points outside this upload.");
  return { format: STORAGE_FORMAT, provider: "filebase", prefix, uploadId: claims.uploadId, pieces: claims.count };
}

/** For a reader allowed to see the document: one manifest with a fresh signed download link on every piece. */
export async function manifestWithLinks(doc, part) {
  const prefix = doc?.storage?.prefix;
  if (!prefix || doc.storage.format !== STORAGE_FORMAT) throw new ChunkedError(400, "This document is not stored in pieces.");
  const role = part === "beta" ? "beta" : "alpha";
  const manifest = await readManifest(prefix, role);
  manifest.pieces = await Promise.all(manifest.pieces.map(async (p) => {
    if (!p.key.startsWith(prefix)) throw new ChunkedError(422, "This document's storage record is damaged.");
    return { ...p, url: await getLink(p.key) };
  }));
  return manifest;
}

/** Both manifests with links, for routes that answer once (the document retrieve route, legacy share links). */
export async function chunkedForReader(doc) {
  if (doc?.storage?.format !== STORAGE_FORMAT) return null;
  const [alpha, beta] = await Promise.all([manifestWithLinks(doc, "alpha"), manifestWithLinks(doc, "beta")]);
  return { alpha, beta };
}

/** Deletes every object under an upload's prefix (abandoned uploads, purges). Idempotent. */
export async function deletePrefix(prefix) {
  if (!/^ws\/[^/]+\/[0-9a-f]{24}\/$/.test(String(prefix))) throw new ChunkedError(400, "Refusing to delete outside one upload.");
  let deleted = 0;
  let ContinuationToken;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken }));
    const keys = (page.Contents || []).map((o) => ({ Key: o.Key }));
    if (keys.length) { await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys, Quiet: true } })); deleted += keys.length; }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return { deleted };
}
