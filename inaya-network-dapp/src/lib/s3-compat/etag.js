// src/lib/s3-compat/etag.js
//
// SQA-023: the ETag this layer returned was the object's internal pin name (for example "s3-compat:<orgId>:<key>:<documentId>:alpha"), so it exposed
// internal identifiers and could not be compared with anything a client holds. Real S3 returns the MD5 of the content for a single-part upload and
// "<md5 of the concatenated part md5s>-<part count>" for a multipart upload; tools rely on that for integrity checks and change detection
// (rclone --checksum / md5 verification, Terraform's etag = filemd5(...), backup and sync software).
//
// New objects store their S3 ETag in `etag`. Objects written before this change have none (their bytes would have to be read back to derive it),
// so they keep the value they always had; only the objects a client writes from now on carry the real one.

import { createHash } from "node:crypto";

export const md5Hex = (buffer) => createHash("md5").update(buffer).digest("hex");

/** ETag of a completed multipart upload from its parts' md5 hex digests, in part-number order. */
export function multipartEtag(partMd5Hexes) {
  const combined = createHash("md5");
  for (const hex of partMd5Hexes) combined.update(Buffer.from(hex, "hex"));
  return `${combined.digest("hex")}-${partMd5Hexes.length}`;
}

/** The ETag value (without quotes) for a stored object row. */
export function etagOf(doc) {
  return doc?.etag || doc?.cidAlpha || doc?.fileHash || "";
}
