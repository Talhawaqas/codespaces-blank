// src/lib/legacyDataAccess/metadata.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW,
// Phase 2 -- Metadata and Virtual Schema Engine.
//
// importMetadata() calls the real connector's discoverMetadata() (never
// a hand-typed schema) and publishes a versioned virtual schema + one
// virtual table per source table. Never silently overwrites an existing
// published schema (SOW Section 28: "Never silently modify an existing
// published virtual schema") -- each import creates a new version;
// callers/administrators see both.
//
// Record-type redefinition (SOW Section 10.4 -- splitting one legacy file
// into multiple virtual tables by a discriminator field) is NOT built
// this pass -- no connector that needs it (the relational reference
// connector's tables already map 1:1) exists yet.

import { getOrgCollections, toObjectId, canManageDataSources, canAccessDataSources } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { getConnectorForDataSource } from "./dataSources.js";

async function assertAccess(membership, requireManage) {
  const ok = requireManage ? canManageDataSources(membership) : canAccessDataSources(membership);
  if (!ok) return { error: requireManage ? "Only a data source manager can do that." : "You don't have data-source access.", status: 403 };
  return null;
}

/** Real metadata discovery + a new versioned virtual schema. Each call
 *  creates a NEW version rather than mutating the previous one -- SOW
 *  Section 28's controlled schema-change flow (DETECT -> COMPARE -> FLAG
 *  -> ADMIN REVIEW -> PUBLISH NEW VERSION) starts here; this function is
 *  the "PUBLISH NEW VERSION" step, always explicit, never automatic. */
export async function importAndPublishSchema({ orgId, dataSourceId, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;

  const resolved = await getConnectorForDataSource({ orgId, dataSourceId });
  if (!resolved) return { error: "Data source not found or has no working credential.", status: 404 };
  if (!resolved.connector.capabilities().metadataImport) {
    return { error: `Connector "${resolved.dataSource.connectorType}" does not support metadata import.`, status: 409 };
  }

  let discovered;
  try {
    discovered = await resolved.connector.discoverMetadata(resolved.credentials);
  } catch (err) {
    return { error: `Metadata discovery failed: ${err.message}`, status: 502 };
  }

  const { legacyVirtualSchemas, legacyVirtualTables } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();

  const priorCount = await legacyVirtualSchemas.countDocuments({ orgId: orgObjectId, dataSourceId: toObjectId(dataSourceId) });
  const version = priorCount + 1;

  const schemaResult = await legacyVirtualSchemas.insertOne({
    orgId: orgObjectId, dataSourceId: toObjectId(dataSourceId), version,
    tableCount: discovered.tables.length, publishedByEmail: actorEmail, publishedAt: now,
  });
  const virtualSchemaId = schemaResult.insertedId;

  const tableDocs = discovered.tables.map((table) => ({
    orgId: orgObjectId, dataSourceId: toObjectId(dataSourceId), virtualSchemaId,
    name: table.name, sourceTableName: table.name,
    columns: table.columns, primaryKey: table.primaryKey || null,
    createdAt: now,
  }));
  if (tableDocs.length > 0) await legacyVirtualTables.insertMany(tableDocs);

  await logOrgActivity({ orgId, recordType: "LEGACY_VIRTUAL_SCHEMA", recordId: virtualSchemaId, actorEmail, action: "PUBLISHED", previousState: null, newState: `v${version}`, metadata: { dataSourceId: dataSourceId.toString(), tableCount: tableDocs.length } });
  return { virtualSchema: { _id: virtualSchemaId, version, tableCount: tableDocs.length, publishedAt: now }, tables: tableDocs };
}

export async function listVirtualSchemas({ orgId, dataSourceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { legacyVirtualSchemas } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (dataSourceId) query.dataSourceId = toObjectId(dataSourceId);
  const schemas = await legacyVirtualSchemas.find(query).sort({ publishedAt: -1 }).toArray();
  return { schemas };
}

/** Lists virtual tables from the MOST RECENTLY published schema version
 *  for a data source -- never a stale earlier version by default, so a
 *  query against "the current schema" always means the latest publish. */
export async function listVirtualTables({ orgId, dataSourceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { legacyVirtualSchemas, legacyVirtualTables } = await getOrgCollections();
  const latestSchema = await legacyVirtualSchemas.findOne({ orgId: toObjectId(orgId), dataSourceId: toObjectId(dataSourceId) }, { sort: { version: -1 } });
  if (!latestSchema) return { tables: [] };
  const tables = await legacyVirtualTables.find({ virtualSchemaId: latestSchema._id }).sort({ name: 1 }).toArray();
  return { tables, schemaVersion: latestSchema.version };
}

export async function getVirtualTableByName({ orgId, dataSourceId, tableName }) {
  const { legacyVirtualSchemas, legacyVirtualTables } = await getOrgCollections();
  const latestSchema = await legacyVirtualSchemas.findOne({ orgId: toObjectId(orgId), dataSourceId: toObjectId(dataSourceId) }, { sort: { version: -1 } });
  if (!latestSchema) return null;
  return legacyVirtualTables.findOne({ virtualSchemaId: latestSchema._id, name: tableName });
}
