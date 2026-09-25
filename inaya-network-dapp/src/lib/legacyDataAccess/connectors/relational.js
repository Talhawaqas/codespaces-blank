// src/lib/legacyDataAccess/connectors/relational.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW.
//
// A REAL, genuinely tested reference connector -- never described as
// mainframe-equivalent. It exists to prove the connector framework,
// metadata engine, and SQL gateway actually work end-to-end against a
// real SQL engine, since no Adabas/VSAM/IMS/RMS-OpenVMS environment
// exists in this session to validate those against (see
// docs/MAINFRAME_DATA_ACCESS_CAPABILITY_AUDIT.md). Matches the SOW's own
// "Secondary Connector Families -> Relational" category (PostgreSQL/SQL
// Server/Oracle/MySQL are the same class of target; SQLite via Node's
// built-in node:sqlite is the only one realistically standable-up with
// zero external infrastructure).
//
// Credentials: { filePath: string } -- a real filesystem path to a real
// SQLite database file. There is no network/auth layer to fake here; the
// file either opens or it genuinely doesn't.

import { DatabaseSync } from "node:sqlite";

const HARD_ROW_CAP = 10000; // defense-in-depth cap; the SQL gateway applies its own configured limit on top of this

export function isConfigured() {
  return true; // node:sqlite ships with Node itself -- no external dependency to check
}

export function capabilities() {
  return {
    read: true,
    write: true, // SQLite genuinely supports INSERT/UPDATE/DELETE -- the SQL gateway's own phase-gating (not this connector) is what keeps write-back disabled this pass, per SOW Section 17
    transactions: true,
    cdc: false, // no real CDC mechanism implemented against this connector this pass
    metadataImport: true,
    joins: true,
    lob: false,
  };
}

function open(credentials) {
  if (!credentials?.filePath) throw new Error("relational connector requires credentials.filePath.");
  return new DatabaseSync(credentials.filePath);
}

export async function testConnection(credentials) {
  let db;
  try {
    db = open(credentials);
    db.prepare("SELECT 1").get();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    db?.close();
  }
}

/** Real metadata discovery -- reads SQLite's own sqlite_master catalog
 *  and PRAGMA table_info, not a hardcoded/assumed schema. */
export async function discoverMetadata(credentials) {
  const db = open(credentials);
  try {
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const tables = tableRows.map((row) => {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdent(row.name)})`).all();
      const primaryKeyCols = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      return {
        name: row.name,
        columns: columns.map((c) => ({
          name: c.name,
          sqlType: normalizeSqliteType(c.type),
          nullable: c.notnull === 0,
        })),
        primaryKey: primaryKeyCols.length > 0 ? primaryKeyCols : undefined,
      };
    });
    return { tables };
  } finally {
    db.close();
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** SQLite's own declared column types are free-text (SQLite is
 *  dynamically typed) -- this maps the common declared-type spellings to
 *  a normalized SQL type name for the metadata registry, per the SOW's
 *  own "no silent lossy conversion" instruction (Section 20). An
 *  unrecognized declared type is passed through as-is rather than
 *  guessed. */
function normalizeSqliteType(declared) {
  const t = (declared || "").toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  if (t.includes("BLOB")) return "BLOB";
  if (t.includes("NUMERIC") || t.includes("DECIMAL")) return "NUMERIC";
  return t || "TEXT";
}

/** Executes real SQL against the real SQLite file. `sql` here is the
 *  gateway's already-parsed-and-rewritten query (virtual table names
 *  already resolved to this source's real table names) -- this
 *  connector does no parsing or authorization of its own, per the SOW's
 *  own layering (Section 6/11: the gateway owns parse/validate/
 *  authorize; the connector only executes). */
export async function executeQuery(credentials, sql, params = [], limits = {}) {
  const db = open(credentials);
  const startedAt = Date.now();
  try {
    const stmt = db.prepare(sql);
    const maxRows = Math.min(limits.maxRows || HARD_ROW_CAP, HARD_ROW_CAP);
    const allRows = stmt.all(...params);
    const truncated = allRows.length > maxRows;
    const rows = truncated ? allRows.slice(0, maxRows) : allRows;
    return { rows, rowCount: rows.length, truncated, elapsedMs: Date.now() - startedAt };
  } finally {
    db.close();
  }
}

export async function health(credentials) {
  try {
    const db = open(credentials);
    db.prepare("SELECT 1").get();
    db.close();
    return { status: "CONNECTED" };
  } catch (err) {
    return { status: "SOURCE_UNAVAILABLE", detail: err.message };
  }
}
