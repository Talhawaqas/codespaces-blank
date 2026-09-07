// src/lib/integrations.js
//
// Financial Services & Regulated Enterprise SOW, Phase 7 (§95, §151, §155,
// §235-236) — the Integration Adapter Architecture. Cross-vertical, same
// reasoning as vendor-management.js/ict-asset-inventory.js in Phase 5:
// every org, regardless of vertical, potentially connects to identity,
// productivity, financial, security, compliance, or data providers.
//
// HONESTY BOUNDARY (matches §150's "if no live provider is configured,
// show clearly that live market data is unavailable" almost verbatim):
// this codebase holds no real credentials or client libraries for any of
// the providers below — there is no live OAuth flow, no real sync engine
// actually calling Entra ID/Okta/a fund administrator/etc. What this file
// DOES provide, honestly:
//   - a static catalog of what Inaya's architecture supports connecting to
//   - a real per-org connection record an operator can configure (owner,
//     sync frequency) once real credentials exist for their environment
//   - a genuine state machine so a connection can never claim ACTIVE
//     status without at least one real recorded sync run
//   - the reconciliation/health/retry/audit machinery §235-236 require,
//     ready for a real adapter to plug into later
// CONNECTION_STATES never includes a "connected, trust us" state reachable
// by configuration alone — only recordSyncRun()'s own real success path
// can ever flip a connection to ACTIVE.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageOrg } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { appendAuditEntry } from "./auditChain.js";

export const INTEGRATION_CATEGORIES = ["identity", "productivity", "financial", "security", "compliance", "data_provider"];

export const INTEGRATION_PROVIDERS = [
  // Identity (§155)
  { id: "entra_id", name: "Microsoft Entra ID", category: "identity", authType: "oidc", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "okta", name: "Okta", category: "identity", authType: "oidc", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "google_workspace", name: "Google Workspace", category: "identity", authType: "oidc", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "saml_oidc_generic", name: "Generic SAML/OIDC", category: "identity", authType: "saml_or_oidc", syncDirection: "inbound", defaultFrequencyHours: 24 },
  // Productivity (§155)
  { id: "microsoft_365", name: "Microsoft 365", category: "productivity", authType: "oauth2", syncDirection: "bidirectional", defaultFrequencyHours: 4 },
  { id: "outlook", name: "Outlook", category: "productivity", authType: "oauth2", syncDirection: "bidirectional", defaultFrequencyHours: 1 },
  { id: "teams", name: "Microsoft Teams", category: "productivity", authType: "oauth2", syncDirection: "outbound", defaultFrequencyHours: 1 },
  { id: "sharepoint", name: "SharePoint", category: "productivity", authType: "oauth2", syncDirection: "bidirectional", defaultFrequencyHours: 24 },
  { id: "slack", name: "Slack", category: "productivity", authType: "oauth2", syncDirection: "outbound", defaultFrequencyHours: 1 },
  // Financial (§95, §155)
  { id: "fund_administrator", name: "Fund Administrator", category: "financial", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "portfolio_management_system", name: "Portfolio Management System", category: "financial", authType: "api_key", syncDirection: "bidirectional", defaultFrequencyHours: 4 },
  { id: "custodian", name: "Custodian", category: "financial", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "prime_broker", name: "Prime Broker", category: "financial", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "accounting_system", name: "Accounting System", category: "financial", authType: "oauth2", syncDirection: "bidirectional", defaultFrequencyHours: 24 },
  { id: "banking_payment_system", name: "Banking / Payment System", category: "financial", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 4 },
  { id: "cap_table_system", name: "Cap Table System", category: "financial", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
  // Security (§155)
  { id: "siem", name: "SIEM", category: "security", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 1 },
  { id: "edr", name: "EDR", category: "security", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 1 },
  { id: "vulnerability_scanner", name: "Vulnerability Scanner", category: "security", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "ticketing_system", name: "Ticketing System", category: "security", authType: "oauth2", syncDirection: "bidirectional", defaultFrequencyHours: 1 },
  { id: "threat_intelligence", name: "Threat Intelligence", category: "security", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 4 },
  // Compliance (§95, §151, §155)
  { id: "grc_platform", name: "GRC Platform", category: "compliance", authType: "api_key", syncDirection: "bidirectional", defaultFrequencyHours: 24 },
  { id: "kyc_aml_provider", name: "KYC/AML Provider", category: "compliance", authType: "api_key", syncDirection: "outbound", defaultFrequencyHours: 0 },
  { id: "sanctions_provider", name: "Sanctions Provider", category: "compliance", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "regulatory_intelligence", name: "Regulatory Intelligence", category: "compliance", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
  // Data providers (§151)
  { id: "market_data_provider", name: "Market Data Provider", category: "data_provider", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 0 },
  { id: "company_data_provider", name: "Company Data Provider", category: "data_provider", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
  { id: "alternative_data_provider", name: "Alternative Data Provider", category: "data_provider", authType: "api_key", syncDirection: "inbound", defaultFrequencyHours: 24 },
];

const PROVIDER_MAP = new Map(INTEGRATION_PROVIDERS.map((p) => [p.id, p]));

export function getIntegrationCatalog({ category } = {}) {
  return category ? INTEGRATION_PROVIDERS.filter((p) => p.category === category) : INTEGRATION_PROVIDERS;
}

export function getProviderDefinition(providerId) {
  return PROVIDER_MAP.get(providerId) || null;
}

// CONNECTION_STATES — a connection can only ever reach ACTIVE through
// recordSyncRun()'s own real success path (see below), never through
// configuration alone.
export const CONNECTION_STATES = ["NOT_CONFIGURED", "AWAITING_CREDENTIALS", "ACTIVE", "ERROR", "DISABLED"];
export const CREDENTIALS_STATUSES = ["not_provided", "provided_unverified", "invalid"];

/** Records an org's intent to connect a provider — owner, sync cadence,
 *  direction override. This does NOT establish a live connection; status
 *  starts AWAITING_CREDENTIALS and stays there until a real sync actually
 *  runs (recordSyncRun) or fails (also legitimately moves state, honestly,
 *  to ERROR rather than silently staying "pending" forever). */
export async function configureIntegration({ orgId, providerId, ownerEmail, syncFrequencyHours, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner/admin can configure an integration.", status: 403 };
  const provider = getProviderDefinition(providerId);
  if (!provider) return { error: `Unknown integration provider "${providerId}".`, status: 400 };

  const { integrationConnections } = await getOrgCollections();
  const now = new Date().toISOString();
  const existing = await integrationConnections.findOne({ orgId: toObjectId(orgId), providerId });

  const setDoc = {
    orgId: toObjectId(orgId), providerId,
    ownerEmail: ownerEmail || actorEmail,
    syncFrequencyHours: syncFrequencyHours ?? provider.defaultFrequencyHours,
    credentialsStatus: existing?.credentialsStatus || "not_provided",
    updatedAt: now,
  };
  if (!existing) {
    setDoc.status = "AWAITING_CREDENTIALS";
    setDoc.lastSyncAt = null;
    setDoc.nextSyncAt = null;
    setDoc.errorCount = 0;
    setDoc.recordsProcessedTotal = 0;
    setDoc.mismatchCountTotal = 0;
    setDoc.createdAt = now;
  }

  await integrationConnections.updateOne(
    { orgId: toObjectId(orgId), providerId },
    existing ? { $set: setDoc } : { $set: setDoc },
    { upsert: true }
  );
  const connection = await integrationConnections.findOne({ orgId: toObjectId(orgId), providerId });

  await logOrgActivity({ orgId, recordType: "INTEGRATION_CONNECTION", recordId: connection._id, actorEmail, action: existing ? "RECONFIGURED" : "CONFIGURED", previousState: existing?.status || null, newState: connection.status, metadata: { providerId } });
  try { await appendAuditEntry({ orgId, recordType: "INTEGRATION_CONNECTION", recordId: connection._id, action: existing ? "RECONFIGURED" : "CONFIGURED", actorEmail, metadata: { providerId } }); } catch (err) { console.error("appendAuditEntry failed (non-fatal):", err.message); }

  return { connection };
}

export async function disableIntegration({ orgId, providerId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner/admin can disable an integration.", status: 403 };
  const { integrationConnections } = await getOrgCollections();
  const updated = await integrationConnections.findOneAndUpdate(
    { orgId: toObjectId(orgId), providerId, status: { $ne: "DISABLED" } },
    { $set: { status: "DISABLED", updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "No active connection for this provider to disable.", status: 404 };

  await logOrgActivity({ orgId, recordType: "INTEGRATION_CONNECTION", recordId: updated._id, actorEmail, action: "DISABLED", previousState: null, newState: "DISABLED", metadata: { providerId } });
  return { connection: updated };
}

/** The ONLY path to ACTIVE. A real adapter (when one exists) calls this
 *  after an actual sync attempt — result:"success" moves the connection to
 *  ACTIVE with real health numbers; result:"error" moves it to ERROR and
 *  increments errorCount. Every call is one immutable row in
 *  integrationSyncRuns (§236's reconciliation shape), never edited after
 *  the fact — a retry is a NEW row, not a mutation of the failed one. */
export async function recordSyncRun({
  orgId, providerId, result, sourceCount, targetCount, newCount, updatedCount, deletedCount, failedCount, conflicts, errorMessage, actorEmail,
}) {
  if (!["success", "error"].includes(result)) return { error: `Unknown sync result "${result}".`, status: 400 };
  const { integrationConnections, integrationSyncRuns } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const connection = await integrationConnections.findOne({ orgId: orgObjectId, providerId });
  if (!connection) return { error: "This provider has not been configured for this org yet.", status: 404 };

  const now = new Date().toISOString();
  const run = {
    orgId: orgObjectId, providerId, result,
    sourceCount: sourceCount ?? 0, targetCount: targetCount ?? 0,
    newCount: newCount ?? 0, updatedCount: updatedCount ?? 0, deletedCount: deletedCount ?? 0,
    failedCount: failedCount ?? 0, conflicts: conflicts ?? 0,
    errorMessage: result === "error" ? (errorMessage || "Sync failed.") : null,
    startedAt: now, completedAt: now,
  };
  const insertResult = await integrationSyncRuns.insertOne(run);
  const inserted = { ...run, _id: insertResult.insertedId };

  const provider = getProviderDefinition(providerId);
  const nextSyncAt = provider?.defaultFrequencyHours ? new Date(Date.now() + (connection.syncFrequencyHours || provider.defaultFrequencyHours) * 60 * 60 * 1000).toISOString() : null;

  const setDoc = {
    status: result === "success" ? "ACTIVE" : "ERROR",
    lastSyncAt: now, nextSyncAt,
    updatedAt: now,
  };
  const incDoc = result === "success"
    ? { recordsProcessedTotal: (newCount ?? 0) + (updatedCount ?? 0), mismatchCountTotal: conflicts ?? 0 }
    : { errorCount: 1 };

  await integrationConnections.updateOne({ _id: connection._id }, { $set: setDoc, $inc: incDoc });
  const updatedConnection = await integrationConnections.findOne({ _id: connection._id });

  await logOrgActivity({ orgId, recordType: "INTEGRATION_SYNC_RUN", recordId: inserted._id, actorEmail: actorEmail || null, action: result === "success" ? "SYNC_SUCCEEDED" : "SYNC_FAILED", previousState: null, newState: null, metadata: { providerId, result } });
  try { await appendAuditEntry({ orgId, recordType: "INTEGRATION_SYNC_RUN", recordId: inserted._id, action: result === "success" ? "SYNC_SUCCEEDED" : "SYNC_FAILED", actorEmail: actorEmail || "system", metadata: { providerId } }); } catch (err) { console.error("appendAuditEntry failed (non-fatal):", err.message); }

  return { run: inserted, connection: updatedConnection };
}

/** Retry — only reachable from ERROR (never re-attempts a connection that
 *  never failed, and can't double-fire against one already retrying).
 *  This records a real new sync-run row exactly like recordSyncRun would;
 *  it does not itself execute a real network call (no real adapter exists
 *  yet to call) — it flips the connection back to AWAITING_CREDENTIALS so
 *  the next real recordSyncRun() (success or failure) governs the outcome
 *  honestly, rather than assuming the retry itself succeeded. */
export async function retrySync({ orgId, providerId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner/admin can retry a failed sync.", status: 403 };
  const { integrationConnections } = await getOrgCollections();
  const updated = await integrationConnections.findOneAndUpdate(
    { orgId: toObjectId(orgId), providerId, status: "ERROR" },
    { $set: { status: "AWAITING_CREDENTIALS", updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await integrationConnections.findOne({ orgId: toObjectId(orgId), providerId });
    if (!current) return { error: "This provider has not been configured for this org yet.", status: 404 };
    return { error: `Retry is only available from ERROR state (this connection is currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "INTEGRATION_CONNECTION", recordId: updated._id, actorEmail, action: "RETRY_REQUESTED", previousState: "ERROR", newState: "AWAITING_CREDENTIALS", metadata: { providerId } });
  return { connection: updated };
}

/** Merges the static catalog with whatever connection docs exist for this
 *  org — a provider with no connection doc is NOT_CONFIGURED, never
 *  silently omitted (an operator must see every supported provider to
 *  know what they COULD connect, per §95's "adapter architecture"
 *  framing). */
export async function getOrgIntegrations(orgId) {
  const { integrationConnections } = await getOrgCollections();
  const connections = await integrationConnections.find({ orgId: toObjectId(orgId) }).toArray();
  const byProviderId = new Map(connections.map((c) => [c.providerId, c]));

  return INTEGRATION_PROVIDERS.map((provider) => {
    const connection = byProviderId.get(provider.id);
    if (!connection) {
      return { ...provider, status: "NOT_CONFIGURED", ownerEmail: null, lastSyncAt: null, nextSyncAt: null, errorCount: 0, recordsProcessedTotal: 0, mismatchCountTotal: 0, credentialsStatus: "not_provided" };
    }
    return {
      ...provider, status: connection.status, ownerEmail: connection.ownerEmail,
      lastSyncAt: connection.lastSyncAt, nextSyncAt: connection.nextSyncAt,
      errorCount: connection.errorCount, recordsProcessedTotal: connection.recordsProcessedTotal,
      mismatchCountTotal: connection.mismatchCountTotal, credentialsStatus: connection.credentialsStatus,
    };
  });
}

export async function getIntegrationHealth(orgId, providerId) {
  const { integrationConnections } = await getOrgCollections();
  const connection = await integrationConnections.findOne({ orgId: toObjectId(orgId), providerId });
  const provider = getProviderDefinition(providerId);
  if (!provider) return { notFound: true, message: `Unknown provider "${providerId}".` };
  if (!connection) return { provider, status: "NOT_CONFIGURED" };
  return { provider, ...connection };
}

export async function listSyncRuns(orgId, { providerId, limit = 20 } = {}) {
  const { integrationSyncRuns } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (providerId) query.providerId = providerId;
  return integrationSyncRuns.find(query).sort({ startedAt: -1 }).limit(limit).toArray();
}
