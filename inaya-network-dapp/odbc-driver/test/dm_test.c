/* Minimal test through the REAL Windows ODBC Driver Manager (odbc32.dll),
 * not direct-loading the driver -- isolates whether the SQLSetStmtAttr
 * crash is a genuine driver/DM interaction bug or specific to .NET's
 * own P/Invoke marshaling. */
#include <windows.h>
#include <sql.h>
#include <sqlext.h>
#include <stdio.h>

int main(void) {
    SQLHENV henv = NULL;
    SQLHDBC hdbc = NULL;
    SQLHSTMT hstmt = NULL;
    SQLRETURN rc;

    rc = SQLAllocHandle(SQL_HANDLE_ENV, SQL_NULL_HANDLE, &henv);
    printf("SQLAllocHandle(ENV) rc=%d\n", rc);
    rc = SQLSetEnvAttr(henv, SQL_ATTR_ODBC_VERSION, (SQLPOINTER)SQL_OV_ODBC3, 0);
    printf("SQLSetEnvAttr rc=%d\n", rc);
    rc = SQLAllocHandle(SQL_HANDLE_DBC, henv, &hdbc);
    printf("SQLAllocHandle(DBC) rc=%d\n", rc);

    SQLCHAR outstr[1024];
    SQLSMALLINT outstrlen;
    rc = SQLDriverConnect(hdbc, NULL, (SQLCHAR *)"DSN=Inaya SQL;", SQL_NTS,
                           outstr, sizeof(outstr), &outstrlen, SQL_DRIVER_NOPROMPT);
    printf("SQLDriverConnect rc=%d\n", rc);
    if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO) {
        printf("Connect failed, aborting.\n");
        return 1;
    }

    rc = SQLAllocHandle(SQL_HANDLE_STMT, hdbc, &hstmt);
    printf("SQLAllocHandle(STMT) rc=%d\n", rc);

    fflush(stdout);
    printf("About to call SQLSetStmtAttr(SQL_ATTR_NOSCAN)...\n");
    fflush(stdout);
    rc = SQLSetStmtAttr(hstmt, SQL_ATTR_NOSCAN, (SQLPOINTER)SQL_NOSCAN_OFF, 0);
    printf("SQLSetStmtAttr(NOSCAN) rc=%d -- SURVIVED\n", rc);
    fflush(stdout);

    printf("About to call SQLSetStmtAttr(SQL_ATTR_ROW_ARRAY_SIZE)...\n");
    fflush(stdout);
    rc = SQLSetStmtAttr(hstmt, SQL_ATTR_ROW_ARRAY_SIZE, (SQLPOINTER)1, 0);
    printf("SQLSetStmtAttr(ROW_ARRAY_SIZE) rc=%d -- SURVIVED\n", rc);
    fflush(stdout);

    rc = SQLExecDirect(hstmt, (SQLCHAR *)"SELECT * FROM customers", SQL_NTS);
    printf("SQLExecDirect rc=%d\n", rc);

    SQLFreeHandle(SQL_HANDLE_STMT, hstmt);
    SQLDisconnect(hdbc);
    SQLFreeHandle(SQL_HANDLE_DBC, hdbc);
    SQLFreeHandle(SQL_HANDLE_ENV, henv);
    printf("Done.\n");
    return 0;
}
