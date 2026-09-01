// src/lib/pinningProviders/pinata.js
//
// Behavior-preserving extraction of the inline Pinata call already used by
// api/upload/route.js (same endpoint, same PINATA_JWT Bearer auth, same
// { pinataContent: { shard, element }, pinataMetadata: { name } } payload shape) -- this module
// exists so the backup-replication engine can share one implementation with the primary upload
// route instead of two copies silently drifting apart. api/upload/route.js's own inline call is
// left exactly as-is (this is additive, not a refactor of the existing upload path).

import { sha256Hex } from "./hash.js";

const PIN_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
const GATEWAY_URL = "https://gateway.pinata.cloud/ipfs";

export function isConfigured() {
  return Boolean(process.env.PINATA_JWT);
}

/** Pins `content` (a shard's ciphertext string) under Pinata's existing JSON-wrapper convention.
 *  Returns { provider: "pinata", cid, providerRef, contentHash } -- contentHash is computed
 *  locally over the raw content, not trusted from Pinata's response. providerRef equals cid here
 *  (Pinata addresses content by CID via its gateway) -- kept as a separate field so callers can
 *  treat every provider uniformly (see filebase.js, where providerRef is the S3 object key, not
 *  the CID). */
export async function pin(content, { name } = {}) {
  const pinataJWT = process.env.PINATA_JWT;
  if (!pinataJWT) throw new Error("pinningProviders/pinata: PINATA_JWT is not configured.");

  const res = await fetch(PIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${pinataJWT.trim()}` },
    body: JSON.stringify({
      pinataContent: { shard: content },
      pinataMetadata: { name: name || "inaya_backup_replica" },
    }),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`pinningProviders/pinata: pin failed (HTTP ${res.status}): ${errorText}`);
  }
  const data = await res.json();
  return { provider: "pinata", cid: data.IpfsHash, providerRef: data.IpfsHash, contentHash: sha256Hex(content) };
}

/** Fetches a replica's content back by providerRef (== cid for Pinata), via Pinata's own public
 *  gateway -- same URL shape page.js's fetchFastShard already uses for the primary shard fetch. */
export async function fetchReplica(providerRef) {
  const res = await fetch(`${GATEWAY_URL}/${providerRef}`);
  if (!res.ok) throw new Error(`pinningProviders/pinata: fetch failed for ${providerRef} (HTTP ${res.status})`);
  const json = await res.json();
  return json.shard;
}

/** Cheap Tier-1 check: does Pinata still report holding this CID as pinned? Uses the pinList
 *  query API (filters by hash), not a full content fetch. */
export async function getPinStatus(providerRef) {
  const pinataJWT = process.env.PINATA_JWT;
  if (!pinataJWT) throw new Error("pinningProviders/pinata: PINATA_JWT is not configured.");

  const res = await fetch(`https://api.pinata.cloud/data/pinList?hashContains=${encodeURIComponent(providerRef)}&status=pinned`, {
    headers: { Authorization: `Bearer ${pinataJWT.trim()}` },
  });
  if (!res.ok) throw new Error(`pinningProviders/pinata: pin-status check failed (HTTP ${res.status})`);
  const data = await res.json();
  return Array.isArray(data?.rows) && data.rows.some((row) => row.ipfs_pin_hash === providerRef);
}

/** Permanently removes a replica -- called by recoverShard when cleaning up a failed/corrupted
 *  replica, so a dead pin doesn't sit accumulating storage cost forever after recovery replaces
 *  it (SOW's storage-efficiency requirement: "cleanup of obsolete copies"). Idempotent: Pinata's
 *  unpin returns 404/"already unpinned" for an already-gone CID, treated as success here too. */
export async function unpin(providerRef) {
  const pinataJWT = process.env.PINATA_JWT;
  if (!pinataJWT) throw new Error("pinningProviders/pinata: PINATA_JWT is not configured.");

  const res = await fetch(`https://api.pinata.cloud/pinning/unpin/${providerRef}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${pinataJWT.trim()}` },
  });
  if (!res.ok && res.status !== 404) {
    const errorText = await res.text();
    throw new Error(`pinningProviders/pinata: unpin failed (HTTP ${res.status}): ${errorText}`);
  }
}
