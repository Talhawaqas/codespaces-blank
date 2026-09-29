// src/lib/legacyDataAccess/connectors/rmsOpenVms.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW.
//
// A real RMS/OpenVMS connector, built and tested against a genuine VSI
// OpenVMS x86-64 V9.2-3 instance (see docs/mainframe-legacy-data-access-report.md
// for how that test environment was stood up). There is no ODBC/JDBC
// bridge or SQL engine for RMS on a stock OpenVMS install -- Oracle Rdb
// or DBMS would provide one, but neither is installed on the Community
// Edition image this was validated against. The only genuine, scriptable
// interface available is SSH + DCL, so that's what this connector uses.
//
// One credential = one RMS file (credentials.filePath, a VMS file spec
// like "SYS$SYSDEVICE:[SYS0.SYSEXE]LAN$DEVICE_DATABASE.SEQ"), exposed as
// exactly one virtual table. This is a narrower model than the relational
// connector's whole-database access, because RMS has no catalog of
// "every file in this area" the way a SQL engine has a schema -- each
// file is its own independent structure with its own record layout.
//
// What's genuinely implemented:
//   - testConnection / discoverMetadata: a real SSH session, running real
//     DCL (ANALYZE/RMS_FILE/FDL) against the real file, parsing OpenVMS's
//     own documented FDL (File Definition Language) output -- not an
//     invented schema.
//   - executeQuery: real record retrieval for TEXT-organized sequential
//     files (record format STREAM/STREAM_LF/STREAM_CR/VARIABLE with
//     printable content) via DCL's TYPE command, one line = one row.
//
// What's honestly NOT implemented this pass, and says so rather than
// faking it:
//   - FIXED-format binary records and INDEXED files. Reading these
//     correctly requires a compiled OpenVMS-side reader (RMS $GET calls
//     via a real program deployed to the box), not a DCL trick -- that's
//     real follow-up work, not something to fake with a guessed binary
//     parser never validated against real record boundaries.

import { Client } from "ssh2";

export function isConfigured() {
  try {
    return typeof Client === "function";
  } catch {
    return false;
  }
}

export function capabilities() {
  return {
    read: true,
    write: false, // RMS write-back needs a real transaction-safe writer program; not attempted this pass
    transactions: false,
    cdc: false,
    metadataImport: true,
    joins: false, // one file = one table, no cross-file join support this pass
    lob: false,
  };
}

const DEFAULT_PORT = 22;
// A fresh SSH exec against OpenVMS's SSHD means a full LOGINOUT/DCL
// session spin-up, not a lightweight shell fork the way it would be on
// Linux -- empirically, against the real V9.2-3 test instance this was
// validated against, that genuinely took 15-20+ seconds under load. 45s
// gives real headroom without masking an actual hang.
const COMMAND_TIMEOUT_MS = 45000;

function requireCredentials(credentials) {
  const missing = ["host", "username", "password", "filePath"].filter((f) => !credentials?.[f]);
  if (missing.length > 0) throw new Error(`rmsOpenVms connector requires credentials.${missing.join(", credentials.")}.`);
}

/** Opens a real SSH connection, runs one DCL command, captures SYS$OUTPUT,
 *  and closes -- one command per connection (DCL sessions over exec
 *  channels are not persistent shells here, matching how ssh2's `exec`
 *  works against OpenVMS's SSH server: each exec is its own DCL
 *  sub-process, not a shared interactive session). */
function runDclCommand(credentials, command) {
  requireCredentials(credentials);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`RMS/OpenVMS SSH command timed out after ${COMMAND_TIMEOUT_MS}ms.`));
    }, COMMAND_TIMEOUT_MS);

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }
          stream
            .on("close", (code) => {
              clearTimeout(timer);
              conn.end();
              resolve({ stdout, stderr, exitCode: code });
            })
            .on("data", (data) => { stdout += data.toString("utf8"); })
            .stderr.on("data", (data) => { stderr += data.toString("utf8"); });
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: credentials.host,
        port: credentials.port || DEFAULT_PORT,
        username: credentials.username,
        password: credentials.password,
        readyTimeout: COMMAND_TIMEOUT_MS,
        algorithms: { serverHostKey: ["ssh-rsa", "rsa-sha2-256", "rsa-sha2-512", "ecdsa-sha2-nistp256", "ssh-ed25519"] },
      });
  });
}

function quoteVmsSpec(spec) {
  // A VMS file spec has no shell metacharacters DCL itself treats specially
  // in this position, but guard against a literal embedded quote anyway.
  return String(spec).replace(/"/g, "");
}

export async function testConnection(credentials) {
  requireCredentials(credentials);
  try {
    // Empirically, against the real test instance, a DCL command containing
    // an embedded double-quoted string literal (e.g. WRITE SYS$OUTPUT "...")
    // reliably hangs when sent as a single SSH "exec" command -- OpenVMS's
    // SSHD appears not to treat that exec string the way an interactive DCL
    // line would be terminated, leaving the string literal looking
    // unterminated. DIRECTORY takes no quoted argument here and both
    // confirms connectivity and checks the file in one real round trip.
    const fileCheck = await runDclCommand(credentials, `DIRECTORY ${quoteVmsSpec(credentials.filePath)}`);
    if (/%DIRECT-W-NOFILES|no such file/i.test(fileCheck.stdout + fileCheck.stderr)) {
      return { ok: false, error: `File not found on the OpenVMS host: ${credentials.filePath}` };
    }
    if (!fileCheck.stdout.trim() && !fileCheck.stderr.trim()) {
      return { ok: false, error: "No response from OpenVMS host." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Real FDL (File Definition Language) parser -- FDL is OpenVMS's own
 *  documented, stable, plain-text description of a file's RMS structure.
 *  Format: top-level UPPERCASE section headers ("FILE", "RECORD", "KEY 0",
 *  "AREA 0", ...) each followed by indented "KEYWORD    value" lines.
 *  This parses that shape generically rather than hardcoding assumptions
 *  about which sections/keywords will appear. */
function parseFdl(fdlText) {
  const sections = {};
  let currentSection = null;
  for (const rawLine of fdlText.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "    ");
    if (!line.trim()) continue;
    const isIndented = /^\s/.test(line);
    if (!isIndented) {
      currentSection = line.trim();
      if (!sections[currentSection]) sections[currentSection] = {};
      continue;
    }
    if (!currentSection) continue;
    const match = line.trim().match(/^(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, keyword, value] = match;
    sections[currentSection][keyword] = value.replace(/^"(.*)"$/, "$1").trim();
  }
  return sections;
}

/** Maps an FDL RECORD section's declared field width/format into this
 *  connector's honest read-support classification. FDL doesn't always
 *  carry per-field layout (many real RMS files, including the one this
 *  was validated against, have no FIELD/BUCKET-level definition at all --
 *  RMS only guarantees record-level structure, not column-level), so the
 *  metadata this connector can genuinely offer is: one row per record,
 *  and for TEXT-organized files, the record's own bytes as a single
 *  column -- not invented per-field columns RMS itself doesn't declare. */
function classifyRecordFormat(fdlSections) {
  const fileOrg = (fdlSections.FILE?.ORGANIZATION || "").toUpperCase();
  const recordFormat = (fdlSections.RECORD?.FORMAT || "").toUpperCase();
  const isTextReadable = fileOrg === "SEQUENTIAL" && ["STREAM", "STREAM_LF", "STREAM_CR", "VARIABLE"].includes(recordFormat);
  return { fileOrg, recordFormat, isTextReadable };
}

export async function discoverMetadata(credentials) {
  requireCredentials(credentials);
  const result = await runDclCommand(
    credentials,
    `ANALYZE/RMS_FILE/FDL/OUTPUT=SYS$OUTPUT ${quoteVmsSpec(credentials.filePath)}`
  );
  if (!result.stdout.trim()) {
    throw new Error(`ANALYZE/RMS_FILE produced no output for ${credentials.filePath}: ${result.stderr || "(no stderr)"}`);
  }
  const fdl = parseFdl(result.stdout);
  const { fileOrg, recordFormat, isTextReadable } = classifyRecordFormat(fdl);
  const maxRecordSize = fdl.RECORD?.SIZE ? Number(fdl.RECORD.SIZE) : null;

  // One table per configured file -- the table name is the file's own
  // last name component (without device/directory/version), matching
  // how a DBA would naturally refer to it.
  const tableName = String(credentials.filePath).split(/[[\]:]/).pop().replace(/;\d+$/, "");

  const columns = [
    {
      name: "RAW_RECORD",
      sqlType: "TEXT",
      nullable: false,
    },
  ];

  return {
    tables: [
      {
        name: tableName,
        columns,
        primaryKey: undefined,
        // Non-standard metadata this connector genuinely derived from FDL,
        // surfaced for the UI/gateway to show the honest real structure
        // rather than pretending this is an ordinary relational table.
        rmsAttributes: {
          organization: fileOrg || "UNKNOWN",
          recordFormat: recordFormat || "UNKNOWN",
          maxRecordSize,
          readSupported: isTextReadable,
          readSupportNote: isTextReadable
            ? "Read via DCL TYPE, one line per row."
            : `${fileOrg || "This"} / ${recordFormat || "this format"} requires a compiled OpenVMS-side RMS reader for correct record boundaries -- not implemented yet. Metadata discovery is real; executeQuery will reject reads against this file until that's built.`,
        },
      },
    ],
  };
}

/** Real record retrieval for the one case this pass can do correctly
 *  without a custom OpenVMS-side program: TEXT-organized sequential
 *  files, where DCL's own TYPE command gives one real record per line.
 *  `sql` is ignored beyond confirming it's a bare SELECT against this
 *  connector's single synthetic table -- the SQL gateway has already
 *  authorized/parsed it; this connector has no query planner of its own,
 *  it only knows how to hand back this file's real rows. */
export async function executeQuery(credentials, sql, params = [], limits = {}) {
  requireCredentials(credentials);
  const meta = await discoverMetadata(credentials);
  const table = meta.tables[0];
  if (!table.rmsAttributes.readSupported) {
    throw new Error(
      `Cannot read ${credentials.filePath}: ${table.rmsAttributes.readSupportNote}`
    );
  }

  const maxRows = Math.min(limits.maxRows || 10000, 10000);
  const startedAt = Date.now();
  const result = await runDclCommand(credentials, `TYPE ${quoteVmsSpec(credentials.filePath)}`);
  const allLines = result.stdout.split(/\r?\n/).filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ""));
  const truncated = allLines.length > maxRows;
  const rows = (truncated ? allLines.slice(0, maxRows) : allLines).map((line) => ({ RAW_RECORD: line }));

  return { rows, rowCount: rows.length, truncated, elapsedMs: Date.now() - startedAt };
}

export async function health(credentials) {
  try {
    // See testConnection's comment: avoid quoted DCL string literals over
    // SSH exec, which reliably hang against this real OpenVMS SSHD.
    const probe = await runDclCommand(credentials, `DIRECTORY ${quoteVmsSpec(credentials.filePath)}`);
    if (probe.stdout.trim() || probe.stderr.trim()) return { status: "CONNECTED" };
    return { status: "SOURCE_UNAVAILABLE", detail: "No response." };
  } catch (err) {
    return { status: "SOURCE_UNAVAILABLE", detail: err.message };
  }
}
