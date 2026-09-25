# inayaodbc.dll -- Inaya SQL Virtualization ODBC Driver

A real ODBC driver (Win32/x64), written in C, compiled with MinGW-w64
GCC, that talks to the same REST API as the [JDBC driver](../jdbc-driver/):
`/api/public/v1/data-sources/<id>/{query,metadata,health}`. See
`../docs/mainframe-legacy-data-access-report.md` for this SOW's full
completion report and honesty classification.

## What's real

- **A genuine compiled Win32 DLL** exporting 28 standard ODBC entry
  points with correct `__stdcall` calling convention and undecorated
  names (verified with `objdump -p`), built against the real ODBC SDK
  headers (`sql.h`/`sqlext.h`/`odbcinst.h`) and import libraries
  (`libodbc32.a`/`libodbccp32.a`) bundled with MinGW-w64.
- **Real network I/O** -- WinHTTP (`winhttp.dll`), not a mock transport.
- **A real, hand-written recursive-descent JSON parser** (`src/json.c`)
  handling the full JSON grammar (not a partial parser scoped to this
  driver's own response shapes) -- no vendored dependency needed beyond
  the OS and the ODBC SDK.
- **Connect, query, catalog browsing, and diagnostics all genuinely
  implemented**: `SQLDriverConnect`/`SQLConnect` (including real DSN
  lookup via `SQLGetPrivateProfileString`), `SQLExecDirect`/
  `SQLPrepare`/`SQLExecute`, `SQLNumResultCols`/`SQLDescribeCol`/
  `SQLColAttribute`, `SQLBindCol`/`SQLFetch`/`SQLGetData` (with real
  truncation handling, SQLSTATE `01004`), `SQLRowCount`, `SQLTables`/
  `SQLColumns` (real `GET /metadata` calls, not fabricated), and
  `SQLGetDiagRec` with real per-handle SQLSTATE/message tracking.
- **Verified end-to-end against a live dev server**, 19/19 checks
  passing (see `test/direct_test.c` and "How this was tested" below):
  real connect, real `SELECT ... WHERE`, real row fetch, real
  `SQLPrepare`/`SQLExecute`, real `SQLTables`/`SQLColumns`, a real
  rejected write-back (`DELETE`), a real rejected unpublished-table
  query, and a real rejected parameter marker.

## Scope (matches the JDBC driver and the SQL gateway underneath both)

- **Read-only.** `INSERT`/`UPDATE`/`DELETE` are rejected by the SQL
  gateway server-side, not faked as supported here.
- **Every result column reports as `SQL_VARCHAR`.** The query response
  doesn't carry per-column declared SQL types -- the identical, honestly
  documented limitation as `InayaResultSetMetaDataHandler.java`.
- **No parameter markers (`?`).** `SQLBindParameter` returns
  `SQL_ERROR`/`HYC00` naming the limitation, not a silent no-op.
- **No transactions.** `SQL_TXN_CAPABLE` honestly reports
  `SQL_TC_NONE`; `SQLEndTran` is a real no-op (there is nothing to
  commit or roll back on this REST transport), not a fabricated
  transaction API.
- Any exported function called outside this scope returns `SQL_ERROR`
  with SQLSTATE `HYC00` and a message naming the unsupported call --
  never a silent no-op and never a fabricated success, mirroring the
  JDBC driver's `SQLFeatureNotSupportedException` discipline.

## What wasn't tested, and why

**Registration with the Windows ODBC Driver Manager** (`odbc32.dll`) --
the layer Excel, Power BI, and `System.Data.Odbc` actually go through --
was **not completed in this environment**, because it requires writing
`HKLM:\SOFTWARE\ODBC\ODBCINST.INI`, which requires local administrator
rights. This was verified empirically, not assumed: a direct registry
write to that key returned `Access denied` under the account this
session runs as (confirmed non-elevated via `net session`).

What this means concretely:
- The driver's actual behavior **was** verified for real -- just via
  `LoadLibrary`/`GetProcAddress` directly against the compiled DLL
  (`test/direct_test.c`), a standard technique for testing an ODBC
  driver before installation, rather than through the Driver Manager.
- **Not verified**: a DSN-based connection through `odbc32.dll` itself,
  and end-to-end use from Excel, Power BI, or `System.Data.Odbc`. These
  depend only on registration succeeding (the driver code they'd call
  into is the exact same code the direct-load test already exercised),
  but registration itself needs to happen on a machine with admin
  rights to be verified.
- `register-driver.ps1` (run as Administrator) does the same registry
  writes `SQLInstallDriverEx`/`SQLConfigDataSource` would, then opens a
  real `System.Data.Odbc.OdbcConnection` against the new DSN to verify
  it -- run it yourself once you have an admin session, and it will
  either work or report exactly what fails.

Per this SOW's own classification taxonomy: registration and
driver-manager-mediated testing are **EXTERNAL DEPENDENCY /
CUSTOMER ENVIRONMENT REQUIRED** (specifically, local admin rights),
not a gap in the driver's own implementation.

## Building

Requires the MinGW-w64 GCC toolchain (this repo used
`winget install BrechtSanders.WinLibs.POSIX.UCRT`, which bundles the
full ODBC SDK headers and import libraries -- no separate Windows SDK
install needed):

```bash
./build.sh
```

Produces `inayaodbc.dll` (and `libinayaodbc.a`, an import library, for
anything wanting to link against it directly rather than through the
Driver Manager).

## How this was tested

Since Driver-Manager registration wasn't available (see above), the
driver was tested by loading the compiled DLL directly:

```bash
MINGW_BIN=".../mingw64/bin"
"$MINGW_BIN/x86_64-w64-mingw32-gcc.exe" -o test/direct_test.exe test/direct_test.c -Wall -O2
./test/direct_test.exe "$(pwd)/inayaodbc.dll" http://localhost:3000 <dataSourceId> <apiKey>
```

This loads `inayaodbc.dll` with `LoadLibrary`, resolves all 17 of its
exported functions with `GetProcAddress`, and exercises the exact
sequence an application (mediated by the Driver Manager) would:
`SQLAllocHandle` -> `SQLDriverConnect` -> `SQLExecDirect` ->
`SQLNumResultCols`/`SQLDescribeCol` -> `SQLFetch`/`SQLGetData` ->
`SQLTables`/`SQLColumns` -> `SQLPrepare`/`SQLExecute` -> negative tests
(unpublished table, write-back, parameter markers) -> `SQLDisconnect`.

Last run against a real dev server and a real SQLite fixture
(`products` table, 2 rows): **19/19 passed.**

Once you have admin rights on a target machine, complete the loop with:

```powershell
.\register-driver.ps1 -DataSourceId <id> -ApiKey <key> -Host http://localhost:3000
```

which registers the driver, creates a System DSN, and opens a real
`System.Data.Odbc` connection through the Driver Manager to verify it.

## Connection string / DSN parameters

| Key | Meaning |
|---|---|
| `HOST` | Base URL of the Inaya API, e.g. `http://localhost:3000` |
| `DATASOURCEID` | The legacy data source's id |
| `APIKEY` | An Inaya API key (org-scoped) |

Example `SQLDriverConnect` string:
```
DRIVER={Inaya SQL Driver};HOST=http://localhost:3000;DATASOURCEID=<id>;APIKEY=<key>;
```
