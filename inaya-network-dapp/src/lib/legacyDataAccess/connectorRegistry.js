// src/lib/legacyDataAccess/connectorRegistry.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW,
// Phase 1 -- Connector Framework/SDK.
//
// Follows this codebase's established pluggable-backend shape
// (src/lib/pinningProviders/index.js), not the OAuth-shaped
// integrationProviders/ pattern -- a legacy-source connector isn't an
// OAuth flow, it's closer to "another storage-like backend." A flat
// name -> module map, each module a plain ES module (no classes),
// filtered by isConfigured().
//
// THE CONNECTOR INTERFACE (every connector module must export):
//   isConfigured()                        -> boolean (env/runtime dependency check, not per-source credential check)
//   capabilities()                        -> { read, write, transactions, cdc, metadataImport, joins, lob }
//   testConnection(credentials)           -> Promise<{ ok, error? }>
//   discoverMetadata(credentials)         -> Promise<{ tables: [{ name, columns: [{name, sqlType, nullable}], primaryKey? }] }>
//   executeQuery(credentials, sql, params, limits) -> Promise<{ rows, rowCount, truncated }>
//   health(credentials)                   -> Promise<{ status, detail? }>
//
// Every connector must declare its capabilities honestly (SOW Section 7)
// -- the SQL gateway checks capabilities() before attempting an
// operation, rather than assuming every connector supports everything.
//
// "relational" (connectors/relational.js, a real node:sqlite reference
// implementation) and "rmsOpenVms" (connectors/rmsOpenVms.js, a real
// SSH+DCL connector validated against a genuine VSI OpenVMS x86-64
// instance -- see docs/mainframe-legacy-data-access-report.md) are
// registered. Adabas/VSAM/IMS adapters are still NOT implemented -- this
// codebase's own discipline (established across every prior SOW this
// project has shipped) is to never ship a mock as proof of compatibility.
// See docs/MAINFRAME_DATA_ACCESS_CAPABILITY_AUDIT.md.

import * as relational from "./connectors/relational.js";
import * as rmsOpenVms from "./connectors/rmsOpenVms.js";

export const CONNECTORS = {
  relational,
  rmsOpenVms,
};

export function listAvailableConnectorTypes() {
  return Object.entries(CONNECTORS)
    .filter(([, mod]) => mod.isConfigured())
    .map(([type]) => type);
}

export function getConnector(connectorType) {
  return CONNECTORS[connectorType] || null;
}

export function listAllConnectorTypes() {
  return Object.keys(CONNECTORS);
}
