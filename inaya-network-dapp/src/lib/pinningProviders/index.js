// src/lib/pinningProviders/index.js
//
// Registry of pinning-provider adapters, each implementing the same small interface:
//   pin(content, { name }) -> { provider, cid, providerRef, contentHash }
//   fetchReplica(providerRef) -> content string
//   getPinStatus(providerRef) -> boolean
//   isConfigured() -> boolean
//
// The backup-replication engine loops over PROVIDERS / listAvailableProviders() without knowing
// which concrete provider it's talking to. Pinata is real and already backs the primary upload
// path; Filebase is the second, independent provider for redundancy -- see filebase.js's header
// for why it's coded but not yet live (pending FILEBASE_* credentials).

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
