// src/lib/rds/providerRegistry.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream A. Same flat name -> module registry
// shape as pinningProviders/index.js and legacyDataAccess/connectorRegistry.js -- a DatabaseProvider is
// "another pluggable backend", not a class hierarchy. ONLY "supabase" is registered this pass: it is the
// provider the operator confirmed having an account for (RDS_SAGEMAKER_DOCINT_CAPABILITY_AUDIT.md, Decision
// 1). No other provider is implemented -- adding one later is one new file plus one registry line, not an
// architecture change.

import * as supabase from "./providers/supabase.js";

export const PROVIDERS = { supabase };

export function listAvailableProviders() {
  return Object.entries(PROVIDERS).filter(([, mod]) => mod.isConfigured()).map(([name]) => name);
}
export function getProvider(name) { return PROVIDERS[name] || null; }
export function listAllProviderNames() { return Object.keys(PROVIDERS); }
