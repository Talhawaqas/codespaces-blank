/* Loads inayaodbc.dll directly with LoadLibrary and calls its exported
 * SQL* functions by pointer -- bypassing the Windows ODBC Driver
 * Manager (odbc32.dll) entirely.
 *
 * This is a real, standard technique for testing an ODBC driver DLL
 * before it is registered with the system (see e.g. how ODBC driver
 * test suites validate a freshly-built driver in CI without an
 * installer step). It is used here specifically because registering a
 * driver with the Driver Manager requires writing
 * HKLM\SOFTWARE\ODBC\ODBCINST.INI, which requires local administrator
 * rights -- confirmed NOT available in this environment (see
 * ../README.md's "What wasn't tested, and why" section) -- so this
 * harness is what actually proves the driver's real behavior here.
 *
 * It exercises the exact same functions the Driver Manager would call
 * on behalf of an application: SQLAllocHandle -> SQLDriverConnect ->
 * SQLExecDirect -> SQLNumResultCols/SQLDescribeCol -> SQLFetch/SQLGetData
 * -> SQLTables/SQLColumns -> SQLDisconnect -> SQLFreeHandle, plus a
 * negative test (querying an unpublished table must be rejected).
 *
 * Usage: direct_test.exe <dllPath> <host> <dataSourceId> <apiKey>
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sql.h>
#include <sqlext.h>
#include <stdio.h>
#include <string.h>

typedef SQLRETURN (SQL_API *AllocHandleFn)(SQLSMALLINT, SQLHANDLE, SQLHANDLE *);
typedef SQLRETURN (SQL_API *FreeHandleFn)(SQLSMALLINT, SQLHANDLE);
typedef SQLRETURN (SQL_API *SetEnvAttrFn)(SQLHENV, SQLINTEGER, SQLPOINTER, SQLINTEGER);
typedef SQLRETURN (SQL_API *DriverConnectFn)(SQLHDBC, SQLHWND, SQLCHAR *, SQLSMALLINT, SQLCHAR *, SQLSMALLINT, SQLSMALLINT *, SQLUSMALLINT);
typedef SQLRETURN (SQL_API *ExecDirectFn)(SQLHSTMT, SQLCHAR *, SQLINTEGER);
typedef SQLRETURN (SQL_API *NumResultColsFn)(SQLHSTMT, SQLSMALLINT *);
typedef SQLRETURN (SQL_API *DescribeColFn)(SQLHSTMT, SQLUSMALLINT, SQLCHAR *, SQLSMALLINT, SQLSMALLINT *, SQLSMALLINT *, SQLULEN *, SQLSMALLINT *, SQLSMALLINT *);
typedef SQLRETURN (SQL_API *FetchFn)(SQLHSTMT);
typedef SQLRETURN (SQL_API *GetDataFn)(SQLHSTMT, SQLUSMALLINT, SQLSMALLINT, SQLPOINTER, SQLLEN, SQLLEN *);
typedef SQLRETURN (SQL_API *GetDiagRecFn)(SQLSMALLINT, SQLHANDLE, SQLSMALLINT, SQLCHAR *, SQLINTEGER *, SQLCHAR *, SQLSMALLINT, SQLSMALLINT *);
typedef SQLRETURN (SQL_API *TablesFn)(SQLHSTMT, SQLCHAR *, SQLSMALLINT, SQLCHAR *, SQLSMALLINT, SQLCHAR *, SQLSMALLINT, SQLCHAR *, SQLSMALLINT);
typedef SQLRETURN (SQL_API *ColumnsFn)(SQLHSTMT, SQLCHAR *, SQLSMALLINT, SQLCHAR *, SQLSMALLINT, SQLCHAR *, SQLSMALLINT, SQLCHAR *, SQLSMALLINT);
typedef SQLRETURN (SQL_API *DisconnectFn)(SQLHDBC);
typedef SQLRETURN (SQL_API *RowCountFn)(SQLHSTMT, SQLLEN *);
typedef SQLRETURN (SQL_API *PrepareFn)(SQLHSTMT, SQLCHAR *, SQLINTEGER);
typedef SQLRETURN (SQL_API *ExecuteFn)(SQLHSTMT);
typedef SQLRETURN (SQL_API *BindParameterFn)(SQLHSTMT, SQLUSMALLINT, SQLSMALLINT, SQLSMALLINT, SQLSMALLINT, SQLULEN, SQLSMALLINT, SQLPOINTER, SQLLEN, SQLLEN *);

static AllocHandleFn pAllocHandle;
static FreeHandleFn pFreeHandle;
static SetEnvAttrFn pSetEnvAttr;
static DriverConnectFn pDriverConnect;
static ExecDirectFn pExecDirect;
static NumResultColsFn pNumResultCols;
static DescribeColFn pDescribeCol;
static FetchFn pFetch;
static GetDataFn pGetData;
static GetDiagRecFn pGetDiagRec;
static TablesFn pTables;
static ColumnsFn pColumns;
static DisconnectFn pDisconnect;
static RowCountFn pRowCount;
static PrepareFn pPrepare;
static ExecuteFn pExecute;
static BindParameterFn pBindParameter;

static int g_pass = 0, g_fail = 0;

static void report(const char *name, int ok, const char *detail) {
    printf("[%s] %s%s%s\n", ok ? "PASS" : "FAIL", name, detail ? " -- " : "", detail ? detail : "");
    if (ok) g_pass++; else g_fail++;
}

static void print_diag(SQLSMALLINT handleType, SQLHANDLE h) {
    SQLCHAR state[6]; SQLINTEGER native; SQLCHAR msg[512]; SQLSMALLINT msgLen;
    if (pGetDiagRec(handleType, h, 1, state, &native, msg, sizeof(msg), &msgLen) == SQL_SUCCESS) {
        printf("       diag: [%s] %s\n", state, msg);
    }
}

#define LOAD(sym, type) do { \
    p##sym = (type)GetProcAddress(dll, "SQL" #sym); \
    if (!p##sym) { printf("FATAL: missing export SQL%s\n", #sym); return 1; } \
} while (0)

int main(int argc, char **argv) {
    if (argc < 5) {
        printf("usage: %s <dllPath> <host> <dataSourceId> <apiKey>\n", argv[0]);
        return 2;
    }
    const char *dllPath = argv[1];
    const char *host = argv[2];
    const char *dataSourceId = argv[3];
    const char *apiKey = argv[4];

    HMODULE dll = LoadLibraryA(dllPath);
    if (!dll) {
        printf("FATAL: LoadLibrary(%s) failed, GetLastError=%lu\n", dllPath, (unsigned long)GetLastError());
        return 1;
    }
    printf("Loaded %s directly (no ODBC Driver Manager involved).\n\n", dllPath);

    LOAD(AllocHandle, AllocHandleFn);
    LOAD(FreeHandle, FreeHandleFn);
    LOAD(SetEnvAttr, SetEnvAttrFn);
    LOAD(DriverConnect, DriverConnectFn);
    LOAD(ExecDirect, ExecDirectFn);
    LOAD(NumResultCols, NumResultColsFn);
    LOAD(DescribeCol, DescribeColFn);
    LOAD(Fetch, FetchFn);
    LOAD(GetData, GetDataFn);
    LOAD(GetDiagRec, GetDiagRecFn);
    LOAD(Tables, TablesFn);
    LOAD(Columns, ColumnsFn);
    LOAD(Disconnect, DisconnectFn);
    LOAD(RowCount, RowCountFn);
    LOAD(Prepare, PrepareFn);
    LOAD(Execute, ExecuteFn);
    LOAD(BindParameter, BindParameterFn);
    report("all 17 exports resolved via GetProcAddress", 1, NULL);

    SQLHANDLE henv = NULL, hdbc = NULL, hstmt = NULL;
    SQLRETURN rc;

    rc = pAllocHandle(SQL_HANDLE_ENV, NULL, &henv);
    report("SQLAllocHandle(ENV)", rc == SQL_SUCCESS, NULL);
    pSetEnvAttr(henv, SQL_ATTR_ODBC_VERSION, (SQLPOINTER)SQL_OV_ODBC3, 0);

    rc = pAllocHandle(SQL_HANDLE_DBC, henv, &hdbc);
    report("SQLAllocHandle(DBC)", rc == SQL_SUCCESS, NULL);

    char connStr[1024];
    snprintf(connStr, sizeof(connStr), "DRIVER={Inaya SQL Driver};HOST=%s;DATASOURCEID=%s;APIKEY=%s;",
             host, dataSourceId, apiKey);
    char connStrOut[1024];
    SQLSMALLINT connStrOutLen = 0;
    rc = pDriverConnect(hdbc, NULL, (SQLCHAR *)connStr, SQL_NTS,
                         (SQLCHAR *)connStrOut, sizeof(connStrOut), &connStrOutLen, SQL_DRIVER_NOPROMPT);
    report("SQLDriverConnect (real connect + health check over WinHTTP)", rc == SQL_SUCCESS || rc == SQL_SUCCESS_WITH_INFO, NULL);
    if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO) { print_diag(SQL_HANDLE_DBC, hdbc); goto done; }

    rc = pAllocHandle(SQL_HANDLE_STMT, hdbc, &hstmt);
    report("SQLAllocHandle(STMT)", rc == SQL_SUCCESS, NULL);

    /* Real query: SELECT with WHERE, against the published virtual table. */
    rc = pExecDirect(hstmt, (SQLCHAR *)"SELECT id, sku, price, in_stock FROM products WHERE in_stock = 1", SQL_NTS);
    report("SQLExecDirect (real SELECT ... WHERE, over the SQL gateway)", rc == SQL_SUCCESS, NULL);
    if (rc != SQL_SUCCESS) print_diag(SQL_HANDLE_STMT, hstmt);

    SQLSMALLINT numCols = 0;
    pNumResultCols(hstmt, &numCols);
    report("SQLNumResultCols == 4", numCols == 4, NULL);

    SQLCHAR colName[128]; SQLSMALLINT colNameLen, dataType, decDigits, nullable; SQLULEN colSize;
    pDescribeCol(hstmt, 1, colName, sizeof(colName), &colNameLen, &dataType, &colSize, &decDigits, &nullable);
    char detail[256];
    snprintf(detail, sizeof(detail), "column 1 name='%s'", colName);
    report("SQLDescribeCol", strcmp((char *)colName, "id") == 0, detail);

    int rowsSeen = 0;
    while ((rc = pFetch(hstmt)) == SQL_SUCCESS) {
        SQLCHAR skuBuf[256]; SQLLEN skuInd;
        pGetData(hstmt, 2, SQL_C_CHAR, skuBuf, sizeof(skuBuf), &skuInd);
        SQLCHAR priceBuf[64]; SQLLEN priceInd;
        pGetData(hstmt, 3, SQL_C_CHAR, priceBuf, sizeof(priceBuf), &priceInd);
        printf("       row: sku=%s price=%s\n", skuBuf, priceBuf);
        rowsSeen++;
    }
    report("SQLFetch/SQLGetData real row retrieval (expect 1 in-stock row)", rowsSeen == 1, NULL);

    SQLLEN rowCount = -99;
    pRowCount(hstmt, &rowCount);
    snprintf(detail, sizeof(detail), "server-reported rowCount=%ld", (long)rowCount);
    report("SQLRowCount", rowCount == 1, detail);

    /* Catalog functions: real metadata REST call, not fabricated. */
    SQLHANDLE hstmt2 = NULL;
    pAllocHandle(SQL_HANDLE_STMT, hdbc, &hstmt2);
    rc = pTables(hstmt2, NULL, 0, NULL, 0, NULL, 0, NULL, 0);
    report("SQLTables (real GET /metadata)", rc == SQL_SUCCESS, NULL);
    int tableRows = 0;
    while (pFetch(hstmt2) == SQL_SUCCESS) tableRows++;
    snprintf(detail, sizeof(detail), "%d table(s) returned", tableRows);
    report("SQLTables returned at least one published table", tableRows >= 1, detail);
    pFreeHandle(SQL_HANDLE_STMT, hstmt2);

    SQLHANDLE hstmt3 = NULL;
    pAllocHandle(SQL_HANDLE_STMT, hdbc, &hstmt3);
    rc = pColumns(hstmt3, NULL, 0, NULL, 0, (SQLCHAR *)"products", SQL_NTS, NULL, 0);
    report("SQLColumns (real GET /metadata, filtered to 'products')", rc == SQL_SUCCESS, NULL);
    int colRows = 0;
    while (pFetch(hstmt3) == SQL_SUCCESS) colRows++;
    snprintf(detail, sizeof(detail), "%d column(s) returned", colRows);
    report("SQLColumns returned 4 columns for products", colRows == 4, detail);
    pFreeHandle(SQL_HANDLE_STMT, hstmt3);

    /* Negative test: an unpublished/system table must be rejected by the
     * gateway's authorizer, not silently allowed. */
    SQLHANDLE hstmt4 = NULL;
    pAllocHandle(SQL_HANDLE_STMT, hdbc, &hstmt4);
    rc = pExecDirect(hstmt4, (SQLCHAR *)"SELECT * FROM sqlite_master", SQL_NTS);
    report("Querying an unpublished table is rejected (fails closed)", rc == SQL_ERROR, NULL);
    if (rc == SQL_ERROR) print_diag(SQL_HANDLE_STMT, hstmt4);
    pFreeHandle(SQL_HANDLE_STMT, hstmt4);

    /* SQLPrepare + SQLExecute round trip (no parameter markers, per the
     * JDBC driver's same documented scope). */
    SQLHANDLE hstmt5 = NULL;
    pAllocHandle(SQL_HANDLE_STMT, hdbc, &hstmt5);
    rc = pPrepare(hstmt5, (SQLCHAR *)"SELECT sku FROM products", SQL_NTS);
    rc = (rc == SQL_SUCCESS) ? pExecute(hstmt5) : rc;
    report("SQLPrepare + SQLExecute", rc == SQL_SUCCESS, NULL);
    int prepRows = 0;
    while (pFetch(hstmt5) == SQL_SUCCESS) prepRows++;
    snprintf(detail, sizeof(detail), "%d row(s)", prepRows);
    report("SQLPrepare/SQLExecute returned both products rows", prepRows == 2, detail);
    pFreeHandle(SQL_HANDLE_STMT, hstmt5);

    /* Write-back must be rejected by the gateway (read-only this pass -- see
     * jdbc-driver/README.md's identical documented scope). */
    SQLHANDLE hstmt6 = NULL;
    pAllocHandle(SQL_HANDLE_STMT, hdbc, &hstmt6);
    rc = pExecDirect(hstmt6, (SQLCHAR *)"DELETE FROM products WHERE id = 1", SQL_NTS);
    report("Write-back (DELETE) is rejected (read-only gateway)", rc == SQL_ERROR, NULL);
    if (rc == SQL_ERROR) print_diag(SQL_HANDLE_STMT, hstmt6);
    pFreeHandle(SQL_HANDLE_STMT, hstmt6);

    /* Parameter markers are explicitly unsupported, not silently ignored. */
    SQLHANDLE hstmt7 = NULL;
    pAllocHandle(SQL_HANDLE_STMT, hdbc, &hstmt7);
    SQLLEN dummyLen = 0;
    int dummyVal = 1;
    rc = pBindParameter(hstmt7, 1, SQL_PARAM_INPUT, SQL_C_LONG, SQL_INTEGER, 0, 0, &dummyVal, 0, &dummyLen);
    report("SQLBindParameter honestly returns SQL_ERROR/HYC00 (not silently accepted)", rc == SQL_ERROR, NULL);
    if (rc == SQL_ERROR) print_diag(SQL_HANDLE_STMT, hstmt7);
    pFreeHandle(SQL_HANDLE_STMT, hstmt7);

    pFreeHandle(SQL_HANDLE_STMT, hstmt);
    pDisconnect(hdbc);

done:
    if (hdbc) pFreeHandle(SQL_HANDLE_DBC, hdbc);
    if (henv) pFreeHandle(SQL_HANDLE_ENV, henv);
    FreeLibrary(dll);

    printf("\n%d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
