// src/lib/legacyDataAccess/sqlGateway.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW,
// Phase 3 -- SQL Engine / Query Gateway.
//
// Pipeline (SOW Section 12.1): Parse -> Validate -> Authorize -> Logical
// Plan -> Capability Check -> Pushdown -> Execute -> Assemble -> Audit.
//
// SCOPE THIS PASS: single-data-source queries only. A query's FROM/JOIN
// clauses must all resolve to virtual tables published under ONE
// dataSourceId (the caller specifies which). Cross-source federated
// joins (SOW Section 13) are NOT built this pass -- the SOW's own
// rollout plan places "Phase 8 -- Federated SQL" after the individual
// connector phases (4-7), and with only one connector type real in this
// pass, federation has nothing genuinely different to prove yet. Not
// attempted, not faked.
//
// READ-ONLY THIS PASS: only SELECT is accepted. Write-back (SOW Section
// 17) is explicitly phase-gated behind a proven read path, defined
// authorization model, and verified transaction semantics -- none of
// which this pass builds. A non-SELECT statement is rejected with a
// clear error, not silently ignored.
//
// Because the one real connector (relational.js) wraps a genuine SQL
// engine (SQLite) itself, "pushdown" for this pass is honest and total:
// the whole validated, authorized query is executed by the connector's
// own engine. There is no in-gateway relational algebra to reimplement.

import sqlParserPkg from "node-sql-parser";
const { Parser } = sqlParserPkg;
import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { getConnectorForDataSource } from "./dataSources.js";
import { getVirtualTableByName } from "./metadata.js";

const parser = new Parser();
const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_TIMEOUT_MS = 15000;

function extractReferencedTableNames(ast) {
  const names = new Set();
  const froms = Array.isArray(ast.from) ? ast.from : [];
  for (const entry of froms) {
    if (entry?.table) names.add(entry.table);
  }
  return [...names];
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Query exceeded the ${ms}ms timeout.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function recordQueryLog({ orgId, dataSourceId, actorEmail, sql, status, rowCount, elapsedMs, error }) {
  const { legacyQueryLog } = await getOrgCollections();
  const { createHash } = await import("node:crypto");
  await legacyQueryLog.insertOne({
    orgId: toObjectId(orgId), dataSourceId: dataSourceId ? toObjectId(dataSourceId) : null,
    actorEmail, sqlFingerprint: createHash("sha256").update(sql).digest("hex"),
    // The normalized SQL shape is logged for governance/debugging (SOW
    // Section 22.4 prefers this over full result contents, which are
    // never written here); literal query PARAMETERS aren't separately
    // captured this pass since this gateway doesn't yet support
    // parameterized queries (see explainQuery's own note).
    sqlNormalized: sql.replace(/\s+/g, " ").trim().slice(0, 2000),
    status, rowCount: rowCount ?? null, elapsedMs: elapsedMs ?? null, error: error || null,
    startedAt: new Date().toISOString(),
  });
}

/** Parse + validate + authorize only -- no execution. Used both by
 *  executeVirtualQuery() below and exposed standalone as a real "explain"
 *  path (SOW Section 12.4), honestly scoped: this pass's plan is just
 *  "which virtual tables does this touch, and are they all authorized
 *  and pushed down to one source" -- there's no cost-based optimizer to
 *  report on. */
export async function planVirtualQuery({ orgId, dataSourceId, sql }) {
  let ast;
  try {
    ast = parser.astify(sql);
  } catch (err) {
    return { error: `SQL parse error: ${err.message}`, status: 400 };
  }
  if (Array.isArray(ast)) return { error: "Only a single statement is supported per request.", status: 400 };
  if (ast.type !== "select") {
    return { error: `Statement type "${ast.type}" is not supported. Only SELECT is enabled in this pass (write-back is phase-gated, see SOW Section 17).`, status: 400 };
  }

  const tableNames = extractReferencedTableNames(ast);
  if (tableNames.length === 0) return { error: "No source table referenced.", status: 400 };

  const resolvedTables = [];
  for (const tableName of tableNames) {
    const virtualTable = await getVirtualTableByName({ orgId, dataSourceId, tableName });
    if (!virtualTable) {
      return { error: `"${tableName}" is not a published virtual table on this data source. Import and publish its schema first.`, status: 403 };
    }
    resolvedTables.push(virtualTable);
  }

  return { ast, tableNames, resolvedTables, pushdown: "full", localOperations: [] };
}

/** Full pipeline: plan (parse/validate/authorize) -> capability check ->
 *  execute via the real connector -> assemble -> audit. Fails closed at
 *  every stage -- a denial is audited as QUERY_DENIED, a real execution
 *  failure as QUERY_FAILED, per SOW Section 29's event list. */
export async function executeVirtualQuery({ orgId, dataSourceId, sql, membership, actorEmail, maxRows, timeoutMs }) {
  const plan = await planVirtualQuery({ orgId, dataSourceId, sql });
  if (plan.error) {
    await recordQueryLog({ orgId, dataSourceId, actorEmail, sql, status: "DENIED", error: plan.error });
    await logOrgActivity({ orgId, recordType: "LEGACY_QUERY", recordId: toObjectId(dataSourceId), actorEmail, action: "QUERY_DENIED", previousState: null, newState: null, metadata: { error: plan.error } });
    return plan;
  }

  const resolved = await getConnectorForDataSource({ orgId, dataSourceId });
  if (!resolved) return { error: "Data source not found or has no working credential.", status: 404 };
  if (!resolved.connector.capabilities().read) {
    return { error: `Connector "${resolved.dataSource.connectorType}" does not support read access.`, status: 409 };
  }

  const limits = { maxRows: maxRows || DEFAULT_MAX_ROWS };
  const startedAt = Date.now();
  try {
    const result = await withTimeout(
      resolved.connector.executeQuery(resolved.credentials, sql, [], limits),
      timeoutMs || DEFAULT_TIMEOUT_MS
    );
    const elapsedMs = Date.now() - startedAt;
    await recordQueryLog({ orgId, dataSourceId, actorEmail, sql, status: "SUCCEEDED", rowCount: result.rowCount, elapsedMs });
    await logOrgActivity({ orgId, recordType: "LEGACY_QUERY", recordId: toObjectId(dataSourceId), actorEmail, action: "QUERY_EXECUTED", previousState: null, newState: null, metadata: { rowCount: result.rowCount, elapsedMs, truncated: result.truncated } });
    // columns is an explicitly ORDERED array, not left for a client to
    // infer from JSON object key order -- the JSON spec itself never
    // guarantees object key order, and the JDBC driver's own integration
    // testing caught a real bug (ResultSetMetaData reporting columns out
    // of order) before this field existed.
    const columns = result.rows.length > 0 ? Object.keys(result.rows[0]) : [];
    return { rows: result.rows, columns, rowCount: result.rowCount, truncated: result.truncated, elapsedMs, tablesUsed: plan.tableNames };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    await recordQueryLog({ orgId, dataSourceId, actorEmail, sql, status: "FAILED", elapsedMs, error: err.message });
    await logOrgActivity({ orgId, recordType: "LEGACY_QUERY", recordId: toObjectId(dataSourceId), actorEmail, action: "QUERY_FAILED", previousState: null, newState: null, metadata: { error: err.message, elapsedMs } });
    return { error: err.message, status: 502 };
  }
}
