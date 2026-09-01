// src/lib/pinningProviders/index.js
//
// Registry of pinning-provider adapters, each implementing the same small interface:
//   pin(content, { name }) -> { provider, cid, providerRef, contentHash }
//   fetchReplica(providerRef) -> content string
//   getPinStatus(providerRef) -> boolean
//   unpin(providerRef) -> void (idempotent -- removing an already-gone replica is not an error)
//   isConfigured() -> boolean
//
// The backup-replication engine loops over PROVIDERS / listAvailableProviders() without knowing
// which concrete provider it's talking to. Both providers are real and live: Pinata backs the
// primary upload path; Filebase (S3-compatible, IPFS-storage-class bucket) is the second,
// independent provider for redundancy -- confirmed working end-to-end 2026-09-01
// (docs/backup-redundancy-architecture.md §7).

import * as pinata from "./pinata.js";
import * as filebase from "./filebase.js";

export { sha256Hex } from "./hash.js";

export const PROVIDERS = { pinata, filebase };

export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`pinningProviders: unknown provider "${name}" — expected one of: ${Object.keys(PROVIDERS).join(", ")}`);
  return provider;
}

/** Providers whose required credentials are actually present right now. Used both to decide
 *  which providers replicate-shard fans out to, and to gate integration tests
 *  (test.skip when a provider isn't configured, rather than failing). */
export function listAvailableProviders() {
  return Object.entries(PROVIDERS)
    .filter(([, provider]) => provider.isConfigured())
    .map(([name]) => name);
}
