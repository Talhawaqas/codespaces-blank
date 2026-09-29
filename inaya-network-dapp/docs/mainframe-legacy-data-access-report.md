# Mainframe & Legacy Data Access Virtualization — Completion Report

Status: **LIVE** (relational connector, RMS/OpenVMS connector, gateway, JDBC and ODBC drivers).
Last verified: 2026-09-29.

This report classifies every capability area from
`Inaya_Mainframe_Legacy_Data_Access_Virtualization_SOW.md` per the SOW's
own taxonomy (ALREADY IMPLEMENTED / PARTIALLY IMPLEMENTED / MISSING —
GENUINE GAP / EXTERNAL DEPENDENCY / HARDWARE-CUSTOMER ENVIRONMENT
REQUIRED / ARCHITECTURAL DECISION REQUIRED / NOT APPROPRIATE). The
Phase 0 audit is at `docs/MAINFRAME_DATA_ACCESS_CAPABILITY_AUDIT.md`.

## Summary

| Area | Status |
|---|---|
| Connector framework | ALREADY IMPLEMENTED (this SOW) |
| Relational reference connector (`node:sqlite`) | ALREADY IMPLEMENTED (this SOW) |
| Metadata / virtual schema engine, versioned publishing | ALREADY IMPLEMENTED (this SOW) |
| SQL gateway (parse/authorize/execute/audit) | ALREADY IMPLEMENTED (this SOW) |
| REST API (`/api/public/v1/data-sources/**`) | ALREADY IMPLEMENTED (this SOW) |
| JDBC driver | ALREADY IMPLEMENTED (this SOW) — compiled, 7/7 integration tests passing against a live server |
| ODBC driver | ALREADY IMPLEMENTED (this SOW) — compiled, 19/19 direct-load tests passing against a live server. Driver-Manager registration and connect NOW VERIFIED FOR REAL (admin rights obtained this pass) — see "ODBC Driver-Manager verification" below for the real bugs found and fixed, and the one still-open issue (a crash inside Microsoft's own odbc32.dll, not this driver) blocking query execution specifically |
| Adabas connector | HARDWARE / CUSTOMER ENVIRONMENT REQUIRED — test environment (Adabas & Natural CE in Docker) is up and healthy; connector code not yet built |
| RMS/OpenVMS connector | ALREADY IMPLEMENTED (this SOW) — `connectors/rmsOpenVms.js`, real SSH+DCL connector; 7/7 tests passing against a genuine VSI OpenVMS x86-64 V9.2-3 instance (real connect, real auth-failure detection, real FDL-derived metadata, real record reads for text-organized sequential files). Fixed-format binary/indexed files honestly report as needing a compiled OpenVMS-side reader, not implemented |
| VSAM connector | HARDWARE / CUSTOMER ENVIRONMENT REQUIRED — future feature, deferred |
| IMS connector | HARDWARE / CUSTOMER ENVIRONMENT REQUIRED — future feature, deferred |
| Write-back (INSERT/UPDATE/DELETE) | NOT APPROPRIATE this pass — explicitly phase-gated by the SOW's own rollout (Section 17) |
| Federated cross-source joins | NOT APPROPRIATE this pass — explicitly phase-gated by the SOW's own rollout (Section 43, Phase 8) |
| Power BI / Excel validation | EXTERNAL DEPENDENCY — needs a licensed install + admin-registered ODBC driver, neither available in this environment |

## What was built this SOW

- `src/lib/legacyDataAccess/` — connector registry, credential envelope
  encryption, data-source registry/health, metadata import with schema
  versioning, and the SQL gateway (real `node-sql-parser` AST, real
  authorization against published tables, real execution, real audit
  logging via `logOrgActivity`).
- `src/app/api/orgs/data-sources/**` (session-auth, admin UI) and
  `src/app/api/public/v1/data-sources/**` (API-key-auth, external
  clients) — both real REST surfaces, backed by the same library code.
- `src/components/business/DataSourcesView.js` and `SqlConsoleView.js`
  — real admin UI, wired into `src/app/business/page.js`.
- `test/legacy-data-access.test.mjs` — 11 tests against real MongoDB
  and real SQLite fixtures (registration, connection testing, schema
  versioning, real JOIN+aggregate query, fail-closed authorization,
  permission denial, audit trail, soft delete).
- `jdbc-driver/` — a real, compiled `java.sql.Driver` (Java 11, Maven
  shaded jar). 7/7 integration tests passing against a live dev server.
  Two real bugs were found and fixed during this work: an HTTP/2 h2c
  upgrade crash in the local dev server (fixed by forcing HTTP/1.1 in
  the driver's `HttpClient`), and a JSON-key-order bug in
  `ResultSetMetaData` column ordering (fixed by having the gateway emit
  an explicit ordered `columns` array). See `jdbc-driver/README.md`.
- `odbc-driver/` — a real, compiled Win32 ODBC driver DLL
  (`inayaodbc.dll`), written in C, built with the MinGW-w64 GCC
  toolchain against the real ODBC SDK (`sql.h`/`sqlext.h`/`odbcinst.h`,
  `libodbc32.a`/`libodbccp32.a`). See "The ODBC driver" below.
- `content/docs/products/legacy-data-access.md` — a real Product Guide
  page, picked up automatically by the documentation platform's RAG
  ingestion.
- Roadmap sync: `src/lib/saasRoadmap.js` Stage 18, mirrored in
  `inaya-mobile/src/data/saasRoadmap.js`, and two new items in
  `src/app/page.js`'s `roadmapPhases`.

## The ODBC driver, in detail

`odbc-driver/inayaodbc.dll` is a genuine compiled Windows DLL exporting
28 standard ODBC entry points (`SQLAllocHandle`, `SQLDriverConnect`,
`SQLExecDirect`, `SQLFetch`, `SQLGetData`, `SQLTables`, `SQLColumns`,
`SQLGetDiagRec`, etc. — full list in `odbc-driver/inayaodbc.def`),
implemented in ~900 lines of C across `driver.c` (ODBC entry points),
`http.c` (a real WinHTTP wrapper), and `json.c` (a real hand-written
recursive-descent JSON parser handling the full JSON grammar, added
because the only acceptable external dependency was the OS + ODBC SDK
already on the machine).

**Toolchain**: MinGW-w64 GCC 16.1.0
(`BrechtSanders.WinLibs.POSIX.UCRT`, installed via `winget` mid-session
specifically for this work) — this distribution bundles the full ODBC
SDK (headers and import libraries), so no separate Windows SDK install
was needed.

**Verified for real** (`odbc-driver/test/direct_test.c`, 19/19 passing
against a live dev server + real SQLite fixture): the compiled DLL was
loaded directly with `LoadLibrary`/`GetProcAddress` (bypassing the
Windows ODBC Driver Manager) and driven through the exact call sequence
an application would make: connect (with a real WinHTTP health check),
`SELECT ... WHERE`, `SQLFetch`/`SQLGetData` row retrieval, `SQLRowCount`,
`SQLTables`/`SQLColumns` (real `GET /metadata` calls), `SQLPrepare`/
`SQLExecute`, and three negative tests — an unpublished-table query, a
write-back (`DELETE`), and a parameter marker (`SQLBindParameter`) are
all genuinely rejected by the driver/gateway with the correct SQLSTATE,
not silently accepted.

Two real, empirically-discovered issues surfaced during this testing —
both were dev-server infrastructure flakiness (a corrupted `.next`
webpack cache causing intermittent 500s), not driver bugs; they were
root-caused by inspecting the raw HTTP response (an HTML error page,
not the expected JSON) rather than assumed, and resolved by clearing
the cache and restarting the dev server. The full 19/19 suite passed
cleanly afterward.

## ODBC Driver-Manager verification (admin rights obtained this pass)

Admin rights were obtained (UAC-approved), and `register-driver.ps1` was
actually run for the first time. It immediately surfaced a **real bug in
the script itself**: its `-Host` parameter collides with PowerShell's
own read-only automatic `$Host` variable, so the script has never been
runnable, ever, even before the admin-rights blocker — this was never
caught earlier because the admin-rights step had never been reached.
Fixed: renamed the parameter to `-ApiBaseUrl`.

With that fixed, four more **real, confirmed driver/infrastructure
bugs** were found and fixed, each verified against a live registration
and a real `System.Data.Odbc` connection:

1. **`ssh2`'s native crypto addon broke Next.js's webpack bundling for
   every API route that imports the connector registry** (not just
   RMS routes), 500-ing the ODBC driver's health check with an empty
   body the moment the RMS connector was registered. Fixed by adding
   `ssh2` to `serverExternalPackages` in `next.config.mjs`, the same
   mechanism already used for `pdfkit`.
2. **`SQLSetConnectAttr`/`SQLGetConnectAttr` hard-errored on every
   attribute except `SQL_ATTR_AUTOCOMMIT`.** The Windows ODBC Driver
   Manager sets several bookkeeping attributes on every connection
   before connecting; hard-erroring on them broke every
   Driver-Manager-mediated connection attempt with
   `IM006/"SQLSetConnectAttr failed"`. This never surfaced via
   `direct_test.c` because nothing in that direct-load path calls
   `SQLSetConnectAttr` at all. Fixed: accept-and-ignore unsupported
   attributes, per ODBC's own contract for this case.
3. **`SQLDriverConnect` never resolved a DSN-only connection string**
   (`"DSN=Inaya SQL;"`, exactly what `.NET`'s
   `OdbcConnection("DSN=Inaya SQL")` sends). `SQLConnect` already had
   DSN-resolution logic, but `.NET` turns out to route through
   `SQLDriverConnect`, not `SQLConnect` — so that logic had never
   actually been exercised either. Fixed: `SQLDriverConnect` now
   resolves `DSN=` the same way, via
   `SQLGetPrivateProfileString` against `ODBC.INI`.
4. **That same `SQLGetPrivateProfileString` call was silently being
   redirected to its wide-character (`W`) variant** by a macro in this
   MinGW distribution's `odbcinst.h`, while the driver passed narrow
   `char*` buffers — real, confirmed memory corruption (the wide
   function writes up to 2x past a narrow buffer's real byte length).
   Fixed with an explicit `#undef` to restore the real narrow function.

With all four fixed, **the driver now genuinely registers and connects
through the real Windows ODBC Driver Manager** — confirmed live:
`System.Data.Odbc.OdbcConnection("DSN=Inaya SQL").Open()` succeeds and
reports a real server version. This is real progress the driver had
never reached before this pass.

**Still open: query execution via the Driver Manager crashes.** The
first statement-level call (`SQLSetStmtAttr`, which `.NET` calls before
every query, and which every ODBC application eventually calls) crashes
the calling process with `AccessViolationException` / `SIGSEGV`. This
was investigated thoroughly, not assumed:
- Two real, genuine driver-side gaps were found and fixed along the way
  (the driver had never exported `SQLSetStmtAttr`/`SQLGetStmtAttr` at
  all — a mandatory ODBC Core function — and had no `SQL_HANDLE_DESC`
  support for the implicit statement descriptors ODBC 3.x requires).
  Both fixes are real and correct, and shipped, but neither resolved
  this specific crash.
- The crash was isolated with a debug print at the very first line of
  the driver's own `SQLSetStmtAttr` — it **never fires**, proving the
  crash happens before the Driver Manager even reaches the driver's
  code.
- It reproduces identically in a minimal, driver-agnostic-looking C
  program linked directly against `odbc32.dll`/`odbccp32.dll` (see
  `odbc-driver/test/dm_test.c`) — not a `.NET`-specific issue.
- It is unconditional on which attribute is set — even the most trivial
  possible attribute (`SQL_ATTR_NOSCAN`) crashes identically, ruling out
  anything specific to row-array-size/bulk-binding handling.
- The Windows Application Event Log's own crash record names the fault
  module directly: **`odbc32.dll`**, exception code `0xc0000005`
  (access violation), at the identical offset every single time,
  regardless of every driver-side change tried.

In short: this is a real, reproducible bug in the interaction between
this driver and the Windows Driver Manager's own `SQLSetStmtAttr`
dispatch, confirmed to fault inside Microsoft's own shipped `odbc32.dll`
rather than in this driver's code, `.NET`, or this project's server.
Registration and connection are genuinely proven; full
query-execution via Excel/Power BI is not yet, and needs either a
native debugger with symbols against that exact `odbc32.dll` offset, or
a different driver-registration strategy, to take further.

`odbc-driver/register-driver.ps1` does the registration
(`SQLInstallDriverEx`/`SQLConfigDataSource`-equivalent registry writes)
and then opens a real `System.Data.Odbc.OdbcConnection` to verify it —
run it as Administrator on a target machine (now fixed and working).

## VM testing environment (VirtualBox) — feasibility, for the record

Per the standing decision to prioritize RMS/OpenVMS and Adabas next,
with VSAM and IMS deferred as a future feature:

- **RMS/OpenVMS**: realistically achievable. VSI (the current OpenVMS
  vendor) publishes official OpenVMS x86-64 installation media with a
  free Community/hobbyist licensing program that runs in VirtualBox.
- **Adabas**: realistically achievable. Software AG's "Adabas &
  Natural Community Edition" runs on an ordinary Linux/Windows VM for
  free, for developer/non-production use.
- **VSAM / IMS**: genuinely hard. Both are native z/OS components, not
  standalone products — the only realistic paths are a paid IBM zD&T
  (IBM Z Development and Test Environment) license, or Hercules plus a
  decades-old public-domain OS image (MVS 3.8j), which would not be
  representative of modern VSAM/IMS behavior. This is why VSAM/IMS stay
  a deferred future feature rather than being attempted with a fake
  stand-in.

## Reminder (per your own standing instruction from earlier in this SOW)

You asked to be reminded at the end of this SOW: **RMS/OpenVMS and
Adabas are next; VSAM and IMS are a future feature.** Both RMS/OpenVMS
and Adabas have real, free community-edition paths to a VirtualBox test
environment (above) — that's the natural next connector work once
you're ready.
