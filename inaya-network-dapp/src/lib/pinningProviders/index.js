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
import * as local from "./local.js"; // opt-in dev/CI provider, never active in production (see local.js)

export { sha256Hex } from "./hash.js";

export const PROVIDERS = { pinata, filebase, local };

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

// Business Workspace storage order (17 Nov 2026, owner decision): Filebase is the main upload store and Pinata is
// the fallback. Every Workspace write path takes its order from here, so the preference lives in one place.
// Reads never use this order: each stored object keeps the provider that actually holds it (pinProvider).
export const WORKSPACE_PRIMARY_PROVIDER = "filebase";

/** Configured providers for a Business Workspace write, Filebase first, Pinata last. */
export function workspaceProviderOrder() {
  const rank = (p) => (p === WORKSPACE_PRIMARY_PROVIDER ? 0 : p === "pinata" ? 2 : 1);
  return listAvailableProviders().sort((a, b) => rank(a) - rank(b));
}
