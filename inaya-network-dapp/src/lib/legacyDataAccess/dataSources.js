// src/lib/legacyDataAccess/dataSources.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW,
// Phase 1 -- the source registry. Register/list/test/delete a data
// source, backed by connectorRegistry.js's connector interface and
// credentials.js's envelope-encrypted credential store.
//
// Status values are explicit and never optimistic (SOW Section 23.2:
// "Do not show 'healthy' merely because the connector process is
// running"). Every lifecycle mutation calls logOrgActivity -- no second
// audit chain, per the SOW's own Section 3.3 instruction.

import { getOrgCollections, toObjectId, canManageDataSources, canAccessDataSources } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { getConnector, listAllConnectorTypes } from "./connectorRegistry.js";
import { storeDataSourceCredential, resolveDataSourceCredential, revokeDataSourceCredential } from "./credentials.js";

export const DATA_SOURCE_STATUS = ["CONNECTED", "DEGRADED", "AUTHENTICATION_FAILED", "SOURCE_UNAVAILABLE", "SCHEMA_ERROR", "DISABLED", "UNKNOWN"];

async function assertAccess(membership, requireManage) {
  const ok = requireManage ? canManageDataSources(membership) : canAccessDataSources(membership);
  if (!ok) return { error: requireManage ? "Only a data source manager can do that." : "You don't have data-source access.", status: 403 };
  return null;
}

export async function registerDataSource({ orgId, name, connectorType, credentials, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  if (!name?.trim()) return { error: "name is required.", status: 400 };
  if (!listAllConnectorTypes().includes(connectorType)) {
    return { error: `Unknown connector type "${connectorType}". Available: ${listAllConnectorTypes().join(", ")}.`, status: 400 };
  }

  const { legacyDataSources } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId, name: name.trim(), connectorType,
    status: "UNKNOWN", lastHealthCheckAt: null, lastHealthDetail: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await legacyDataSources.insertOne(doc);
  const dataSourceId = result.insertedId;

  const credResult = await storeDataSourceCredential({ orgId, dataSourceId, connectorType, credentials, actorEmail, membership });
  if (credResult.error) {
    // Roll back the just-created data source rather than leaving a
    // credential-less, permanently UNKNOWN row behind.
    await legacyDataSources.deleteOne({ _id: dataSourceId });
    return credResult;
  }

  await logOrgActivity({ orgId, recordType: "LEGACY_DATA_SOURCE", recordId: dataSourceId, actorEmail, action: "REGISTERED", previousState: null, newState: "UNKNOWN", metadata: { connectorType, name: doc.name } });

  const tested = await testDataSourceConnection({ orgId, dataSourceId, membership });
  return { dataSource: tested.dataSource || { ...doc, _id: dataSourceId } };
}

export async function listDataSources({ orgId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { legacyDataSources } = await getOrgCollections();
  const dataSources = await legacyDataSources.find({ orgId: toObjectId(orgId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
  return { dataSources };
}

export async function getDataSource({ orgId, dataSourceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { legacyDataSources } = await getOrgCollections();
  const dataSource = await legacyDataSources.findOne({ _id: toObjectId(dataSourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!dataSource) return { error: "Data source not found.", status: 404 };
  return { dataSource };
}

/** Real connection test -- resolves the stored credential, calls the
 *  connector's own testConnection(), and persists an honest status.
 *  Never optimistic: a failure sets AUTHENTICATION_FAILED/
 *  SOURCE_UNAVAILABLE, not a generic "error" the UI has to guess at. */
export async function testDataSourceConnection({ orgId, dataSourceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { legacyDataSources } = await getOrgCollections();
  const dataSource = await legacyDataSources.findOne({ _id: toObjectId(dataSourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!dataSource) return { error: "Data source not found.", status: 404 };

  const resolved = await resolveDataSourceCredential({ orgId, dataSourceId });
  if (!resolved) {
    await legacyDataSources.updateOne({ _id: dataSource._id }, { $set: { status: "AUTHENTICATION_FAILED", lastHealthCheckAt: new Date().toISOString(), lastHealthDetail: "No credential on file." } });
    return { error: "No credential on file for this data source.", status: 409 };
  }

  const connector = getConnector(dataSource.connectorType);
  const result = await connector.testConnection(resolved.credentials);
  const now = new Date().toISOString();
  const status = result.ok ? "CONNECTED" : "SOURCE_UNAVAILABLE";
  await legacyDataSources.updateOne({ _id: dataSource._id }, { $set: { status, lastHealthCheckAt: now, lastHealthDetail: result.error || null, updatedAt: now } });

  const updated = await legacyDataSources.findOne({ _id: dataSource._id });
  return { dataSource: updated, connectionOk: result.ok, error: result.error };
}

export async function checkDataSourceHealth({ orgId, dataSourceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { legacyDataSources } = await getOrgCollections();
  const dataSource = await legacyDataSources.findOne({ _id: toObjectId(dataSourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!dataSource) return { error: "Data source not found.", status: 404 };

  const resolved = await resolveDataSourceCredential({ orgId, dataSourceId });
  if (!resolved) return { status: "AUTHENTICATION_FAILED", detail: "No credential on file." };

  const connector = getConnector(dataSource.connectorType);
  const result = await connector.health(resolved.credentials);
  const now = new Date().toISOString();
  await legacyDataSources.updateOne({ _id: dataSource._id }, { $set: { status: result.status, lastHealthCheckAt: now, lastHealthDetail: result.detail || null } });
  return result;
}

export async function deleteDataSource({ orgId, dataSourceId, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  const { legacyDataSources } = await getOrgCollections();
  const dataSource = await legacyDataSources.findOne({ _id: toObjectId(dataSourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!dataSource) return { error: "Data source not found.", status: 404 };

  await legacyDataSources.updateOne({ _id: dataSource._id }, { $set: { deletedAt: new Date().toISOString(), status: "DISABLED" } });
  await logOrgActivity({ orgId, recordType: "LEGACY_DATA_SOURCE", recordId: dataSource._id, actorEmail, action: "DELETED", previousState: dataSource.status, newState: "DISABLED", metadata: {} });
  return { deleted: true };
}

export async function getConnectorForDataSource({ orgId, dataSourceId }) {
  const { legacyDataSources } = await getOrgCollections();
  const dataSource = await legacyDataSources.findOne({ _id: toObjectId(dataSourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!dataSource) return null;
  const resolved = await resolveDataSourceCredential({ orgId, dataSourceId });
  if (!resolved) return null;
  const connector = getConnector(dataSource.connectorType);
  if (!connector) return null;
  return { dataSource, connector, credentials: resolved.credentials };
}
