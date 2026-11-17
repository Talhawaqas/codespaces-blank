// src/lib/ipfsGateways.js — the public IPFS gateways used to read encrypted shards, in order of preference.
//
// SQA 17 Nov 2026: readers tried cloudflare-ipfs.com first, but that gateway no longer exists (its name doesn't
// resolve), so every download first failed and then waited 4-5 s on Pinata's gateway. Measured that day:
// ipfs.filebase.io served shards pinned at Pinata AND at Filebase in 0.5-0.8 s; gateway.pinata.cloud in 4-5.5 s;
// ipfs.io and dweb.link answered 429 (rate limited). Isomorphic (browser and server). Nothing secret passes here:
// shards are ciphertext.

export const IPFS_GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

export const gatewayUrl = (cid) => `${IPFS_GATEWAYS[0]}${cid}`;

/** Fetches a shard JSON ({ shard, element }) by CID, trying each gateway in turn. Returns the shard string. */
export async function fetchShardFromIPFS(cid, { timeoutMs = 30000 } = {}) {
  if (!cid) throw new Error("This file has no storage address.");
  let lastError;
  for (const base of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${base}${cid}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`gateway answered ${res.status}`);
      const json = await res.json();
      if (typeof json?.shard !== "string") throw new Error("not a shard");
      return json.shard;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`The encrypted file could not be fetched right now (${lastError?.message || "unknown error"}). Try again in a moment.`);
}
