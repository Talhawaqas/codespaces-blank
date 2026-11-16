// src/lib/dbBackup.js
//
// Daily database backup (founder request, 16 Nov 2026, after every `orgs` record was found deleted on
// 15 Nov with no backup to restore from). Once a day /api/cron/db-backup writes a snapshot of every
// collection to Vercel Blob (the store is private: reading needs the Blob token):
//   - one gzip of NDJSON lines {"c": "<collection>", "d": <document as canonical Extended JSON>}, so
//     ObjectIds, dates and binary data restore exactly;
//   - encrypted with AES-256-GCM using DB_BACKUP_ENCRYPTION_KEY (32 bytes, base64), on top of the private
//     store. Without the key a backup cannot be read: keep a copy of the key outside Vercel;
//   - 14 daily backups are kept; older ones are deleted.
// Skipped: the AI search index (rag_chunks, rag_embedding_cache), which is rebuilt from source files.
// Restore with scripts/db-restore.mjs (insert-only: never overwrites existing records).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { put, list, del, get } from "@vercel/blob";
import { BSON } from "mongodb";
import { connectToDatabase } from "./mongodb.js";

const { EJSON } = BSON;
export const BACKUP_PREFIX = "db-backups/";
const KEEP_DAYS = 14;
const SKIP = /^(system\.|rag_chunks$|rag_embedding_cache$)/;
const MAGIC = Buffer.from("INAYADB1");

function key() {
  const raw = Buffer.from(String(process.env.DB_BACKUP_ENCRYPTION_KEY || "").trim(), "base64");
  if (raw.length !== 32) throw new Error("DB_BACKUP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return raw;
}

/** Layout: "INAYADB1" | 12-byte IV | 16-byte auth tag | ciphertext (gzip of NDJSON). */
export function encryptBackup(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(buf) {
  if (!buf.subarray(0, 8).equals(MAGIC)) throw new Error("Not an Inaya database backup.");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(8, 20));
  decipher.setAuthTag(buf.subarray(20, 36));
  return gunzipSync(Buffer.concat([decipher.update(buf.subarray(36)), decipher.final()]));
}

/** Takes one snapshot, uploads it, prunes old ones. Returns a summary. */
export async function runDbBackup() {
  key(); // fail fast before reading anything
  const { db } = await connectToDatabase();
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !SKIP.test(n)).sort();
  const lines = [];
  const counts = {};
  for (const name of names) {
    let n = 0;
    for await (const doc of db.collection(name).find({})) {
      lines.push(JSON.stringify({ c: name, d: EJSON.serialize(doc, { relaxed: false }) }));
      n++;
    }
    counts[name] = n;
  }
  const takenAt = new Date().toISOString();
  const plain = gzipSync(Buffer.from(lines.join("\n"), "utf8"));
  const blob = await put(`${BACKUP_PREFIX}${takenAt.slice(0, 10)}/inaya-db-${takenAt.replace(/[:.]/g, "-")}.bin`, encryptBackup(plain), {
    access: "private", addRandomSuffix: true, contentType: "application/octet-stream",
  });
  const documents = Object.values(counts).reduce((a, b) => a + b, 0);
  const summary = { takenAt, url: blob.url, pathname: blob.pathname, bytes: plain.length, collections: names.length, documents, orgs: counts.orgs ?? 0, orgMembers: counts.org_members ?? 0 };
  await db.collection("_meta").updateOne(
    { _id: "dbBackups" },
    { $push: { runs: { $each: [summary], $slice: -30 } }, $set: { lastSuccessAt: takenAt } },
    { upsert: true }
  );

  // Retention: delete backups older than KEEP_DAYS.
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const old = [];
  let cursor;
  do {
    const r = await list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
    for (const b of r.blobs) if (new Date(b.uploadedAt).getTime() < cutoff) old.push(b.url);
    cursor = r.cursor;
  } while (cursor);
  if (old.length) await del(old);
  return { ...summary, pruned: old.length };
}

/** Downloads a backup (pathname or URL) from the private Blob store and returns the decrypted NDJSON text. */
export async function readBackup(pathnameOrUrl) {
  const result = await get(pathnameOrUrl, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN });
  if (!result) throw new Error("Backup not found in storage.");
  return decryptBackup(Buffer.from(await new Response(result.stream).arrayBuffer())).toString("utf8");
}
