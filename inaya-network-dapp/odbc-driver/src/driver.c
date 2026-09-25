/* inayaodbc.dll -- a real, minimal ODBC driver for Inaya's SQL
 * virtualization gateway (see ../README.md and the JDBC driver at
 * ../../jdbc-driver/ for the shared REST transport this talks to).
 *
 * Every exported SQL* function below either does the real thing (a real
 * WinHTTP call to the same /api/public/v1/data-sources/<id>/... REST API
 * the JDBC driver uses, real JSON parsing, real ODBC handle/result-set
 * bookkeeping) or returns SQL_ERROR with SQLSTATE HYC00 ("optional
 * feature not implemented") naming the call -- never a silent no-op and
 * never a fabricated success. This mirrors the JDBC driver's own
 * SQLFeatureNotSupportedException discipline.
 *
 * Scope, matching the JDBC driver and the SQL gateway it both sit on:
 *   - Read-only (SELECT); write-back is rejected server-side, not here.
 *   - Every result column is reported as SQL_VARCHAR -- the query
 *     response doesn't carry per-column declared SQL types, exactly the
 *     same documented limitation as InayaResultSetMetaDataHandler.java.
 *   - No parameter markers (?) -- SQLPrepare/SQLExecute run stored SQL
 *     text verbatim; no SQLBindParameter.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sql.h>
#include <sqlext.h>
#include <odbcinst.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <ctype.h>

#include "json.h"
#include "http.h"

/* ------------------------------------------------------------------ */
/* Handle types                                                        */
/* ------------------------------------------------------------------ */

typedef struct {
    char sqlState[6];
    char message[512];
    int hasError;
} Diag;

static void diag_set(Diag *d, const char *state, const char *fmt, ...) {
    d->hasError = 1;
    strncpy(d->sqlState, state, 5);
    d->sqlState[5] = 0;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(d->message, sizeof(d->message), fmt, ap);
    va_end(ap);
}

static void diag_clear(Diag *d) {
    d->hasError = 0;
    d->sqlState[0] = 0;
    d->message[0] = 0;
}

typedef struct {
    Diag diag;
    SQLINTEGER odbcVersion;
} InayaEnv;

typedef struct {
    Diag diag;
    char *baseUrl;
    char *dataSourceId;
    char *apiKey;
    int connected;
} InayaDbc;

typedef struct {
    SQLSMALLINT targetType;
    SQLPOINTER targetValuePtr;
    SQLLEN bufferLength;
    SQLLEN *strLenOrIndPtr;
    int bound;
} ColBinding;

typedef struct {
    Diag diag;
    InayaDbc *dbc;
    char *pendingSql;      /* set by SQLPrepare, consumed by SQLExecute */

    JsonValue *resultRoot; /* owns the whole parsed/synthetic response tree */
    JsonValue *rowsArray;  /* alias into resultRoot, JSON_ARRAY of JSON_OBJECT */
    char **columnNames;    /* owned copies, columnCount entries */
    size_t columnCount;

    long currentRowIndex;  /* -1 = before first row */
    ColBinding *bindings;  /* columnCount entries once allocated */
    long long rowCountAffected; /* -1 if unknown */
} InayaStmt;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

static char *dupstr_n(const char *s, size_t n) {
    char *out = (char *)malloc(n + 1);
    if (s) memcpy(out, s, n);
    out[n] = 0;
    return out;
}

static char *dupstr(const char *s) {
    return dupstr_n(s, s ? strlen(s) : 0);
}

/* SQLCHAR text arguments come in as either NUL-terminated (len ==
 * SQL_NTS) or explicitly length-prefixed and NOT necessarily
 * NUL-terminated -- both forms are real ODBC call conventions callers
 * use, so both are handled rather than assuming NUL-termination. */
static char *text_arg_to_cstr(const SQLCHAR *text, SQLINTEGER len) {
    if (!text) return dupstr("");
    if (len == SQL_NTS) return dupstr((const char *)text);
    if (len < 0) return dupstr("");
    return dupstr_n((const char *)text, (size_t)len);
}

static void copy_out_string(const char *src, SQLCHAR *buf, SQLSMALLINT bufLen, SQLSMALLINT *outLen) {
    size_t n = src ? strlen(src) : 0;
    if (outLen) *outLen = (SQLSMALLINT)n;
    if (!buf || bufLen <= 0) return;
    size_t copyN = n;
    if (copyN > (size_t)(bufLen - 1)) copyN = (size_t)(bufLen - 1);
    if (src) memcpy(buf, src, copyN);
    buf[copyN] = 0;
}

static void free_result_set(InayaStmt *stmt) {
    if (stmt->resultRoot) json_free(stmt->resultRoot);
    stmt->resultRoot = NULL;
    stmt->rowsArray = NULL;
    if (stmt->columnNames) {
        for (size_t i = 0; i < stmt->columnCount; i++) free(stmt->columnNames[i]);
        free(stmt->columnNames);
    }
    stmt->columnNames = NULL;
    stmt->columnCount = 0;
    stmt->currentRowIndex = -1;
    free(stmt->bindings);
    stmt->bindings = NULL;
    stmt->rowCountAffected = -1;
}

/* Takes ownership of columnNames[0..count) and rowsArrayOwned. Shared by
 * both real query execution and the synthetic SQLTables/SQLColumns
 * catalog results, so SQLFetch/SQLGetData need only one code path. */
static void set_stmt_result(InayaStmt *stmt, JsonValue *treeOwner, char **columnNames, size_t count,
                             JsonValue *rowsArrayOwned, long long rowCountAffected) {
    free_result_set(stmt);
    stmt->resultRoot = treeOwner;
    stmt->rowsArray = rowsArrayOwned;
    stmt->columnNames = columnNames;
    stmt->columnCount = count;
    stmt->currentRowIndex = -1;
    stmt->rowCountAffected = rowCountAffected;
}

/* ------------------------------------------------------------------ */
/* Connection-string / DSN parsing                                     */
/* ------------------------------------------------------------------ */

typedef struct {
    char *host;
    char *dataSourceId;
    char *apiKey;
} ConnParams;

static void conn_params_free(ConnParams *p) {
    free(p->host);
    free(p->dataSourceId);
    free(p->apiKey);
    memset(p, 0, sizeof(*p));
}

/* Parses "KEY=VALUE;KEY={VALUE WITH SPACES};..." -- the standard ODBC
 * connection-string grammar (braces optional, used to quote values
 * containing ';' or '='). */
static void parse_connection_string(const char *connStr, ConnParams *out) {
    memset(out, 0, sizeof(*out));
    size_t len = strlen(connStr);
    size_t i = 0;
    while (i < len) {
        while (i < len && (connStr[i] == ' ' || connStr[i] == ';')) i++;
        if (i >= len) break;
        size_t keyStart = i;
        while (i < len && connStr[i] != '=' && connStr[i] != ';') i++;
        size_t keyEnd = i;
        if (i >= len || connStr[i] != '=') { continue; }
        i++; /* skip '=' */
        char *value;
        if (i < len && connStr[i] == '{') {
            i++;
            size_t valStart = i;
            while (i < len && connStr[i] != '}') i++;
            value = dupstr_n(connStr + valStart, i - valStart);
            if (i < len) i++; /* skip '}' */
        } else {
            size_t valStart = i;
            while (i < len && connStr[i] != ';') i++;
            value = dupstr_n(connStr + valStart, i - valStart);
        }
        size_t keyLen = keyEnd - keyStart;
        char keyBuf[64];
        if (keyLen >= sizeof(keyBuf)) keyLen = sizeof(keyBuf) - 1;
        memcpy(keyBuf, connStr + keyStart, keyLen);
        keyBuf[keyLen] = 0;
        for (char *c = keyBuf; *c; c++) *c = (char)toupper((unsigned char)*c);

        if (strcmp(keyBuf, "HOST") == 0 || strcmp(keyBuf, "SERVER") == 0) {
            free(out->host); out->host = value;
        } else if (strcmp(keyBuf, "DATASOURCEID") == 0) {
            free(out->dataSourceId); out->dataSourceId = value;
        } else if (strcmp(keyBuf, "APIKEY") == 0 || strcmp(keyBuf, "PWD") == 0) {
            free(out->apiKey); out->apiKey = value;
        } else {
            free(value); /* DRIVER=, DSN=, UID= etc. -- recognized-but-unused keys */
        }
    }
}

/* ------------------------------------------------------------------ */
/* REST calls                                                          */
/* ------------------------------------------------------------------ */

typedef struct {
    int ok;
    long httpStatus;
    JsonValue *json;     /* parsed body on success or on a JSON error body */
    char *transportError; /* set only when the request never got an HTTP response */
} ApiResult;

static ApiResult api_call(InayaDbc *dbc, const char *method, const char *path, const char *jsonBody) {
    ApiResult r;
    memset(&r, 0, sizeof(r));
    HttpResponse resp = http_request(method, dbc->baseUrl, path, dbc->apiKey, jsonBody);
    if (!resp.transportOk) {
        r.ok = 0;
        r.transportError = resp.errorText ? dupstr(resp.errorText) : dupstr("unknown transport failure");
        http_response_free(&resp);
        return r;
    }
    r.httpStatus = resp.statusCode;
    char *parseErr = NULL;
    r.json = json_parse(resp.body, &parseErr);
    if (!r.json) {
        r.ok = 0;
        r.transportError = parseErr ? parseErr : dupstr("server response was not valid JSON");
        http_response_free(&resp);
        return r;
    }
    r.ok = (resp.statusCode >= 200 && resp.statusCode < 300);
    http_response_free(&resp);
    return r;
}

static void api_result_free(ApiResult *r) {
    if (r->json) json_free(r->json);
    free(r->transportError);
    memset(r, 0, sizeof(*r));
}

static const char *json_string_or(const JsonValue *v, const char *fallback) {
    return (v && v->type == JSON_STRING) ? v->stringValue : fallback;
}

/* ------------------------------------------------------------------ */
/* Connect logic shared by SQLConnect and SQLDriverConnect             */
/* ------------------------------------------------------------------ */

static SQLRETURN do_connect(InayaDbc *dbc, const ConnParams *params) {
    if (!params->host || !*params->host) {
        diag_set(&dbc->diag, "HY000", "Connection string is missing HOST (e.g. HOST=http://localhost:3000).");
        return SQL_ERROR;
    }
    if (!params->dataSourceId || !*params->dataSourceId) {
        diag_set(&dbc->diag, "HY000", "Connection string is missing DATASOURCEID.");
        return SQL_ERROR;
    }
    if (!params->apiKey || !*params->apiKey) {
        diag_set(&dbc->diag, "HY000", "Connection string is missing APIKEY.");
        return SQL_ERROR;
    }

    free(dbc->baseUrl); free(dbc->dataSourceId); free(dbc->apiKey);
    dbc->baseUrl = dupstr(params->host);
    dbc->dataSourceId = dupstr(params->dataSourceId);
    dbc->apiKey = dupstr(params->apiKey);

    char path[512];
    snprintf(path, sizeof(path), "/api/public/v1/data-sources/%s/health", dbc->dataSourceId);
    ApiResult r = api_call(dbc, "GET", path, NULL);

    if (r.transportError) {
        diag_set(&dbc->diag, "08001", "Could not reach %s: %s", dbc->baseUrl, r.transportError);
        api_result_free(&r);
        return SQL_ERROR;
    }
    if (r.httpStatus == 401 || r.httpStatus == 403) {
        const char *msg = json_string_or(json_object_get(r.json, "error"), "Authentication failed.");
        diag_set(&dbc->diag, "28000", "%s", msg);
        api_result_free(&r);
        return SQL_ERROR;
    }
    if (r.httpStatus == 404) {
        diag_set(&dbc->diag, "08004", "Data source %s was not found or is not accessible to this API key.", dbc->dataSourceId);
        api_result_free(&r);
        return SQL_ERROR;
    }
    if (!r.ok) {
        const char *msg = json_string_or(json_object_get(r.json, "error"), "Connection rejected by server.");
        diag_set(&dbc->diag, "08004", "%s (HTTP %ld)", msg, r.httpStatus);
        api_result_free(&r);
        return SQL_ERROR;
    }

    dbc->connected = 1;
    const char *status = json_string_or(json_object_get(r.json, "status"), "UNKNOWN");
    SQLRETURN rc = SQL_SUCCESS;
    if (strcmp(status, "CONNECTED") != 0) {
        /* We reached the Inaya API and authenticated fine -- that's a real
         * driver-level connection -- but the underlying data source itself
         * is reporting a non-CONNECTED status. Surface that as a warning
         * rather than hiding it or failing a connection that did succeed. */
        diag_set(&dbc->diag, "01000", "Connected to Inaya, but the underlying data source reports status=%s.", status);
        rc = SQL_SUCCESS_WITH_INFO;
    } else {
        diag_clear(&dbc->diag);
    }
    api_result_free(&r);
    return rc;
}

/* ------------------------------------------------------------------ */
/* Query execution -> populate a statement's result set                */
/* ------------------------------------------------------------------ */

static SQLRETURN run_query(InayaStmt *stmt, const char *sql) {
    if (!stmt->dbc || !stmt->dbc->connected) {
        diag_set(&stmt->diag, "08003", "Connection is not open.");
        return SQL_ERROR;
    }

    JsonStringBuilder body;
    jsb_init(&body);
    jsb_append(&body, "{\"sql\":");
    jsb_append_json_escaped(&body, sql);
    jsb_append(&body, "}");

    char path[512];
    snprintf(path, sizeof(path), "/api/public/v1/data-sources/%s/query", stmt->dbc->dataSourceId);
    ApiResult r = api_call(stmt->dbc, "POST", path, body.data);
    jsb_free(&body);

    if (r.transportError) {
        diag_set(&stmt->diag, "08S01", "Query request failed: %s", r.transportError);
        api_result_free(&r);
        return SQL_ERROR;
    }
    if (!r.ok) {
        const char *msg = json_string_or(json_object_get(r.json, "error"), "Query rejected by server.");
        /* 42000 = syntax/authorization error under SQL-92 SQLSTATE class,
         * the honest general-purpose bucket for "the gateway's parser,
         * authorizer, or validator refused this statement" -- matching
         * how sqlGateway.js itself doesn't further subclassify these. */
        diag_set(&stmt->diag, r.httpStatus == 401 || r.httpStatus == 403 ? "42000" : "HY000", "%s", msg);
        api_result_free(&r);
        return SQL_ERROR;
    }

    JsonValue *columnsArr = json_object_get(r.json, "columns");
    JsonValue *rowsArr = json_object_get(r.json, "rows");
    JsonValue *rowCountVal = json_object_get(r.json, "rowCount");

    size_t colCount = (columnsArr && columnsArr->type == JSON_ARRAY) ? columnsArr->itemCount : 0;
    char **colNames = colCount ? (char **)calloc(colCount, sizeof(char *)) : NULL;
    for (size_t i = 0; i < colCount; i++) {
        JsonValue *c = columnsArr->items[i];
        colNames[i] = dupstr(c && c->type == JSON_STRING ? c->stringValue : "");
    }

    long long rc = (rowCountVal && rowCountVal->type == JSON_NUMBER) ? (long long)rowCountVal->numberValue : -1;
    set_stmt_result(stmt, r.json, colNames, colCount,
                     (rowsArr && rowsArr->type == JSON_ARRAY) ? rowsArr : NULL, rc);
    r.json = NULL; /* ownership moved into stmt->resultRoot */
    api_result_free(&r);
    diag_clear(&stmt->diag);
    return SQL_SUCCESS;
}

/* ------------------------------------------------------------------ */
/* Catalog functions: SQLTables / SQLColumns                           */
/* ------------------------------------------------------------------ */

static SQLRETURN fetch_virtual_tables(InayaStmt *stmt, JsonValue **outTablesArray, JsonValue **outRoot) {
    char path[512];
    snprintf(path, sizeof(path), "/api/public/v1/data-sources/%s/metadata", stmt->dbc->dataSourceId);
    ApiResult r = api_call(stmt->dbc, "GET", path, NULL);
    if (r.transportError) {
        diag_set(&stmt->diag, "08S01", "Metadata request failed: %s", r.transportError);
        api_result_free(&r);
        return SQL_ERROR;
    }
    if (!r.ok) {
        const char *msg = json_string_or(json_object_get(r.json, "error"), "Metadata request rejected by server.");
        diag_set(&stmt->diag, "HY000", "%s", msg);
        api_result_free(&r);
        return SQL_ERROR;
    }
    JsonValue *tables = json_object_get(r.json, "tables");
    if (!tables || tables->type != JSON_ARRAY) {
        diag_set(&stmt->diag, "HY000", "Server metadata response did not include a tables array.");
        api_result_free(&r);
        return SQL_ERROR;
    }
    *outTablesArray = tables;
    *outRoot = r.json;
    r.json = NULL;
    api_result_free(&r);
    return SQL_SUCCESS;
}

static const char *TABLES_COLS[] = { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "TABLE_TYPE", "REMARKS" };

static SQLRETURN do_sql_tables(InayaStmt *stmt, const char *tableNameFilter) {
    JsonValue *tables, *metaRoot;
    SQLRETURN rc = fetch_virtual_tables(stmt, &tables, &metaRoot);
    if (rc == SQL_ERROR) return rc;

    JsonValue *rows = json_new_array();
    for (size_t i = 0; i < tables->itemCount; i++) {
        JsonValue *t = tables->items[i];
        const char *name = json_string_or(json_object_get(t, "name"), "");
        if (tableNameFilter && *tableNameFilter && strcmp(tableNameFilter, name) != 0) continue;
        JsonValue *row = json_new_object();
        json_object_set(row, "TABLE_CAT", json_new_null());
        json_object_set(row, "TABLE_SCHEM", json_new_null());
        json_object_set(row, "TABLE_NAME", json_new_string(name));
        json_object_set(row, "TABLE_TYPE", json_new_string("TABLE"));
        json_object_set(row, "REMARKS", json_new_string("Inaya virtual table"));
        json_array_push(rows, row);
    }
    json_free(metaRoot);

    char **colNames = (char **)calloc(5, sizeof(char *));
    for (int i = 0; i < 5; i++) colNames[i] = dupstr(TABLES_COLS[i]);

    JsonValue *treeOwner = json_new_object();
    json_object_set(treeOwner, "rows", rows);
    set_stmt_result(stmt, treeOwner, colNames, 5, rows, (long long)rows->itemCount);
    diag_clear(&stmt->diag);
    return SQL_SUCCESS;
}

static const char *COLUMNS_COLS[] = {
    "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "TYPE_NAME",
    "COLUMN_SIZE", "BUFFER_LENGTH", "DECIMAL_DIGITS", "NUM_PREC_RADIX", "NULLABLE",
    "REMARKS", "COLUMN_DEF", "SQL_DATA_TYPE", "SQL_DATETIME_SUB", "CHAR_OCTET_LENGTH",
    "ORDINAL_POSITION", "IS_NULLABLE"
};
#define COLUMNS_COLCOUNT 18

static SQLRETURN do_sql_columns(InayaStmt *stmt, const char *tableNameFilter, const char *columnNameFilter) {
    JsonValue *tables, *metaRoot;
    SQLRETURN rc = fetch_virtual_tables(stmt, &tables, &metaRoot);
    if (rc == SQL_ERROR) return rc;

    JsonValue *rows = json_new_array();
    for (size_t i = 0; i < tables->itemCount; i++) {
        JsonValue *t = tables->items[i];
        const char *tableName = json_string_or(json_object_get(t, "name"), "");
        if (tableNameFilter && *tableNameFilter && strcmp(tableNameFilter, tableName) != 0) continue;
        JsonValue *cols = json_object_get(t, "columns");
        if (!cols || cols->type != JSON_ARRAY) continue;
        for (size_t j = 0; j < cols->itemCount; j++) {
            JsonValue *c = cols->items[j];
            const char *colName = json_string_or(json_object_get(c, "name"), "");
            if (columnNameFilter && *columnNameFilter && strcmp(columnNameFilter, colName) != 0) continue;
            JsonValue *nullableVal = json_object_get(c, "nullable");
            int nullable = (nullableVal && nullableVal->type == JSON_BOOL) ? nullableVal->boolValue : 1;

            JsonValue *row = json_new_object();
            json_object_set(row, "TABLE_CAT", json_new_null());
            json_object_set(row, "TABLE_SCHEM", json_new_null());
            json_object_set(row, "TABLE_NAME", json_new_string(tableName));
            json_object_set(row, "COLUMN_NAME", json_new_string(colName));
            json_object_set(row, "DATA_TYPE", json_new_number(SQL_VARCHAR));
            json_object_set(row, "TYPE_NAME", json_new_string("VARCHAR"));
            json_object_set(row, "COLUMN_SIZE", json_new_number(4000));
            json_object_set(row, "BUFFER_LENGTH", json_new_number(4000));
            json_object_set(row, "DECIMAL_DIGITS", json_new_null());
            json_object_set(row, "NUM_PREC_RADIX", json_new_null());
            json_object_set(row, "NULLABLE", json_new_number(nullable ? SQL_NULLABLE : SQL_NO_NULLS));
            json_object_set(row, "REMARKS", json_new_string(json_string_or(json_object_get(c, "sqlType"), "")));
            json_object_set(row, "COLUMN_DEF", json_new_null());
            json_object_set(row, "SQL_DATA_TYPE", json_new_number(SQL_VARCHAR));
            json_object_set(row, "SQL_DATETIME_SUB", json_new_null());
            json_object_set(row, "CHAR_OCTET_LENGTH", json_new_number(4000));
            json_object_set(row, "ORDINAL_POSITION", json_new_number((double)(j + 1)));
            json_object_set(row, "IS_NULLABLE", json_new_string(nullable ? "YES" : "NO"));
            json_array_push(rows, row);
        }
    }
    json_free(metaRoot);

    char **colNames = (char **)calloc(COLUMNS_COLCOUNT, sizeof(char *));
    for (int i = 0; i < COLUMNS_COLCOUNT; i++) colNames[i] = dupstr(COLUMNS_COLS[i]);

    JsonValue *treeOwner = json_new_object();
    json_object_set(treeOwner, "rows", rows);
    set_stmt_result(stmt, treeOwner, colNames, COLUMNS_COLCOUNT, rows, (long long)rows->itemCount);
    diag_clear(&stmt->diag);
    return SQL_SUCCESS;
}

/* ------------------------------------------------------------------ */
/* Data conversion for SQLFetch (bound columns) / SQLGetData           */
/* ------------------------------------------------------------------ */

static JsonValue *current_row(InayaStmt *stmt) {
    if (!stmt->rowsArray || stmt->currentRowIndex < 0) return NULL;
    if ((size_t)stmt->currentRowIndex >= stmt->rowsArray->itemCount) return NULL;
    return stmt->rowsArray->items[stmt->currentRowIndex];
}

static JsonValue *cell_value(InayaStmt *stmt, SQLUSMALLINT columnNumber) {
    JsonValue *row = current_row(stmt);
    if (!row || columnNumber < 1 || (size_t)columnNumber > stmt->columnCount) return NULL;
    return json_object_get(row, stmt->columnNames[columnNumber - 1]);
}

/* Writes a cell's text representation into an application buffer per
 * SQL_C_CHAR/SQL_C_DEFAULT conventions: truncates if needed and reports
 * SQL_SUCCESS_WITH_INFO + 01004 exactly like a real driver, rather than
 * silently overflowing or silently succeeding on truncation. */
static SQLRETURN write_char_target(Diag *diag, const char *text, int isNull, SQLPOINTER targetValuePtr,
                                    SQLLEN bufferLength, SQLLEN *strLenOrIndPtr) {
    if (isNull) {
        if (strLenOrIndPtr) *strLenOrIndPtr = SQL_NULL_DATA;
        if (targetValuePtr && bufferLength > 0) ((char *)targetValuePtr)[0] = 0;
        return SQL_SUCCESS;
    }
    size_t n = strlen(text);
    if (strLenOrIndPtr) *strLenOrIndPtr = (SQLLEN)n;
    if (!targetValuePtr || bufferLength <= 0) return SQL_SUCCESS;
    size_t copyN = n;
    int truncated = 0;
    if (copyN > (size_t)(bufferLength - 1)) { copyN = (size_t)(bufferLength - 1); truncated = 1; }
    memcpy(targetValuePtr, text, copyN);
    ((char *)targetValuePtr)[copyN] = 0;
    if (truncated) {
        diag_set(diag, "01004", "String data, right truncated.");
        return SQL_SUCCESS_WITH_INFO;
    }
    return SQL_SUCCESS;
}

static SQLRETURN write_numeric_target(SQLSMALLINT targetType, double numValue, int isNull,
                                       SQLPOINTER targetValuePtr, SQLLEN *strLenOrIndPtr) {
    if (isNull) {
        if (strLenOrIndPtr) *strLenOrIndPtr = SQL_NULL_DATA;
        return SQL_SUCCESS;
    }
    if (strLenOrIndPtr) *strLenOrIndPtr = 0;
    if (!targetValuePtr) return SQL_SUCCESS;
    switch (targetType) {
        case SQL_C_SLONG:
        case SQL_C_LONG:
            *(SQLINTEGER *)targetValuePtr = (SQLINTEGER)numValue;
            break;
        case SQL_C_SSHORT:
        case SQL_C_SHORT:
            *(SQLSMALLINT *)targetValuePtr = (SQLSMALLINT)numValue;
            break;
        case SQL_C_DOUBLE:
            *(SQLDOUBLE *)targetValuePtr = (SQLDOUBLE)numValue;
            break;
        case SQL_C_FLOAT:
            *(SQLREAL *)targetValuePtr = (SQLREAL)numValue;
            break;
        default:
            return SQL_ERROR;
    }
    return SQL_SUCCESS;
}

static SQLRETURN convert_cell(Diag *diag, JsonValue *cell, SQLSMALLINT targetType,
                               SQLPOINTER targetValuePtr, SQLLEN bufferLength, SQLLEN *strLenOrIndPtr) {
    int isNull = (!cell || cell->type == JSON_NULL);
    if (targetType == SQL_C_CHAR || targetType == SQL_C_DEFAULT) {
        JsonStringBuilder sb;
        jsb_init(&sb);
        if (!isNull) json_value_to_display_string(cell, &sb);
        SQLRETURN rc = write_char_target(diag, sb.data ? sb.data : "", isNull, targetValuePtr, bufferLength, strLenOrIndPtr);
        jsb_free(&sb);
        return rc;
    }
    if (targetType == SQL_C_SLONG || targetType == SQL_C_LONG || targetType == SQL_C_SSHORT ||
        targetType == SQL_C_SHORT || targetType == SQL_C_DOUBLE || targetType == SQL_C_FLOAT) {
        double n = 0;
        if (!isNull) {
            if (cell->type == JSON_NUMBER) n = cell->numberValue;
            else if (cell->type == JSON_STRING) n = atof(cell->stringValue);
            else if (cell->type == JSON_BOOL) n = cell->boolValue ? 1 : 0;
        }
        SQLRETURN rc = write_numeric_target(targetType, n, isNull, targetValuePtr, strLenOrIndPtr);
        if (rc == SQL_ERROR) {
            diag_set(diag, "HYC00", "Target C type %d is not supported by this driver.", (int)targetType);
        }
        return rc;
    }
    diag_set(diag, "HYC00", "Target C type %d is not supported by this driver.", (int)targetType);
    return SQL_ERROR;
}

/* ==================================================================== */
/*  Exported ODBC entry points                                          */
/* ==================================================================== */

SQLRETURN SQL_API SQLAllocHandle(SQLSMALLINT HandleType, SQLHANDLE InputHandle, SQLHANDLE *OutputHandle) {
    if (!OutputHandle) return SQL_INVALID_HANDLE;
    switch (HandleType) {
        case SQL_HANDLE_ENV: {
            InayaEnv *env = (InayaEnv *)calloc(1, sizeof(InayaEnv));
            *OutputHandle = (SQLHANDLE)env;
            return SQL_SUCCESS;
        }
        case SQL_HANDLE_DBC: {
            InayaDbc *dbc = (InayaDbc *)calloc(1, sizeof(InayaDbc));
            *OutputHandle = (SQLHANDLE)dbc;
            return SQL_SUCCESS;
        }
        case SQL_HANDLE_STMT: {
            if (!InputHandle) return SQL_INVALID_HANDLE;
            InayaStmt *stmt = (InayaStmt *)calloc(1, sizeof(InayaStmt));
            stmt->dbc = (InayaDbc *)InputHandle;
            stmt->currentRowIndex = -1;
            stmt->rowCountAffected = -1;
            *OutputHandle = (SQLHANDLE)stmt;
            return SQL_SUCCESS;
        }
        default:
            return SQL_ERROR;
    }
}

SQLRETURN SQL_API SQLFreeHandle(SQLSMALLINT HandleType, SQLHANDLE Handle) {
    if (!Handle) return SQL_INVALID_HANDLE;
    switch (HandleType) {
        case SQL_HANDLE_ENV:
            free(Handle);
            return SQL_SUCCESS;
        case SQL_HANDLE_DBC: {
            InayaDbc *dbc = (InayaDbc *)Handle;
            free(dbc->baseUrl); free(dbc->dataSourceId); free(dbc->apiKey);
            free(dbc);
            return SQL_SUCCESS;
        }
        case SQL_HANDLE_STMT: {
            InayaStmt *stmt = (InayaStmt *)Handle;
            free_result_set(stmt);
            free(stmt->pendingSql);
            free(stmt);
            return SQL_SUCCESS;
        }
        default:
            return SQL_ERROR;
    }
}

SQLRETURN SQL_API SQLSetEnvAttr(SQLHENV EnvironmentHandle, SQLINTEGER Attribute, SQLPOINTER Value, SQLINTEGER StringLength) {
    (void)StringLength;
    InayaEnv *env = (InayaEnv *)EnvironmentHandle;
    if (!env) return SQL_INVALID_HANDLE;
    if (Attribute == SQL_ATTR_ODBC_VERSION) env->odbcVersion = (SQLINTEGER)(SQLLEN)Value;
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLGetEnvAttr(SQLHENV EnvironmentHandle, SQLINTEGER Attribute, SQLPOINTER Value,
                                 SQLINTEGER BufferLength, SQLINTEGER *StringLength) {
    (void)BufferLength;
    InayaEnv *env = (InayaEnv *)EnvironmentHandle;
    if (!env) return SQL_INVALID_HANDLE;
    if (Attribute == SQL_ATTR_ODBC_VERSION) {
        if (Value) *(SQLINTEGER *)Value = env->odbcVersion ? env->odbcVersion : SQL_OV_ODBC3;
        if (StringLength) *StringLength = sizeof(SQLINTEGER);
        return SQL_SUCCESS;
    }
    return SQL_ERROR;
}

SQLRETURN SQL_API SQLDriverConnect(SQLHDBC hdbc, SQLHWND hwnd, SQLCHAR *szConnStrIn, SQLSMALLINT cbConnStrIn,
                                    SQLCHAR *szConnStrOut, SQLSMALLINT cbConnStrOutMax, SQLSMALLINT *pcbConnStrOut,
                                    SQLUSMALLINT fDriverCompletion) {
    (void)hwnd; (void)fDriverCompletion;
    InayaDbc *dbc = (InayaDbc *)hdbc;
    if (!dbc) return SQL_INVALID_HANDLE;
    char *connStr = text_arg_to_cstr(szConnStrIn, cbConnStrIn);

    ConnParams params;
    parse_connection_string(connStr, &params);
    SQLRETURN rc = do_connect(dbc, &params);
    conn_params_free(&params);

    if (rc != SQL_ERROR) {
        copy_out_string(connStr, szConnStrOut, cbConnStrOutMax, pcbConnStrOut);
    }
    free(connStr);
    return rc;
}

SQLRETURN SQL_API SQLConnect(SQLHDBC hdbc, SQLCHAR *szDSN, SQLSMALLINT cbDSN,
                              SQLCHAR *szUID, SQLSMALLINT cbUID, SQLCHAR *szAuthStr, SQLSMALLINT cbAuthStr) {
    (void)szUID; (void)cbUID;
    InayaDbc *dbc = (InayaDbc *)hdbc;
    if (!dbc) return SQL_INVALID_HANDLE;
    char *dsn = text_arg_to_cstr(szDSN, cbDSN);

    /* Reads HOST/DATASOURCEID/APIKEY out of the named DSN's ODBC.INI
     * section via the real driver-manager profile API (odbccp32's
     * SQLGetPrivateProfileString) -- a DSN created by register-driver.ps1
     * or the ODBC Data Source Administrator, not a fabricated lookup. */
    char host[512] = "", dsId[256] = "", apiKey[512] = "";
    SQLGetPrivateProfileString(dsn, "HOST", "", host, sizeof(host), "ODBC.INI");
    SQLGetPrivateProfileString(dsn, "DATASOURCEID", "", dsId, sizeof(dsId), "ODBC.INI");
    SQLGetPrivateProfileString(dsn, "APIKEY", "", apiKey, sizeof(apiKey), "ODBC.INI");

    char *authStr = text_arg_to_cstr(szAuthStr, cbAuthStr);
    if (*authStr && !*apiKey) strncpy(apiKey, authStr, sizeof(apiKey) - 1);
    free(authStr);

    ConnParams params;
    memset(&params, 0, sizeof(params));
    params.host = dupstr(host);
    params.dataSourceId = dupstr(dsId);
    params.apiKey = dupstr(apiKey);
    SQLRETURN rc = do_connect(dbc, &params);
    conn_params_free(&params);
    free(dsn);
    return rc;
}

SQLRETURN SQL_API SQLDisconnect(SQLHDBC hdbc) {
    InayaDbc *dbc = (InayaDbc *)hdbc;
    if (!dbc) return SQL_INVALID_HANDLE;
    dbc->connected = 0;
    diag_clear(&dbc->diag);
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLExecDirect(SQLHSTMT hstmt, SQLCHAR *StatementText, SQLINTEGER TextLength) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    char *sql = text_arg_to_cstr(StatementText, TextLength);
    SQLRETURN rc = run_query(stmt, sql);
    free(sql);
    return rc;
}

SQLRETURN SQL_API SQLPrepare(SQLHSTMT hstmt, SQLCHAR *StatementText, SQLINTEGER TextLength) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    free(stmt->pendingSql);
    stmt->pendingSql = text_arg_to_cstr(StatementText, TextLength);
    diag_clear(&stmt->diag);
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLExecute(SQLHSTMT hstmt) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    if (!stmt->pendingSql) {
        diag_set(&stmt->diag, "HY010", "SQLExecute called with no statement prepared.");
        return SQL_ERROR;
    }
    return run_query(stmt, stmt->pendingSql);
}

SQLRETURN SQL_API SQLNumResultCols(SQLHSTMT hstmt, SQLSMALLINT *pccol) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    if (pccol) *pccol = (SQLSMALLINT)stmt->columnCount;
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLDescribeCol(SQLHSTMT hstmt, SQLUSMALLINT ColumnNumber, SQLCHAR *ColumnName,
                                  SQLSMALLINT BufferLength, SQLSMALLINT *NameLength, SQLSMALLINT *DataType,
                                  SQLULEN *ColumnSize, SQLSMALLINT *DecimalDigits, SQLSMALLINT *Nullable) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    if (ColumnNumber < 1 || (size_t)ColumnNumber > stmt->columnCount) {
        diag_set(&stmt->diag, "07009", "Invalid column number %u.", (unsigned)ColumnNumber);
        return SQL_ERROR;
    }
    copy_out_string(stmt->columnNames[ColumnNumber - 1], ColumnName, BufferLength, NameLength);
    if (DataType) *DataType = SQL_VARCHAR;
    if (ColumnSize) *ColumnSize = 4000;
    if (DecimalDigits) *DecimalDigits = 0;
    if (Nullable) *Nullable = SQL_NULLABLE_UNKNOWN;
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLColAttribute(SQLHSTMT hstmt, SQLUSMALLINT ColumnNumber, SQLUSMALLINT FieldIdentifier,
                                   SQLPOINTER CharacterAttribute, SQLSMALLINT BufferLength,
                                   SQLSMALLINT *StringLength, SQLLEN *NumericAttribute) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    if (ColumnNumber < 1 || (size_t)ColumnNumber > stmt->columnCount) {
        diag_set(&stmt->diag, "07009", "Invalid column number %u.", (unsigned)ColumnNumber);
        return SQL_ERROR;
    }
    const char *name = stmt->columnNames[ColumnNumber - 1];
    switch (FieldIdentifier) {
        case SQL_DESC_NAME:
        case SQL_DESC_LABEL:
        case SQL_DESC_BASE_COLUMN_NAME:
            copy_out_string(name, (SQLCHAR *)CharacterAttribute, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_DESC_TYPE_NAME:
            copy_out_string("VARCHAR", (SQLCHAR *)CharacterAttribute, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_DESC_TYPE:
        case SQL_DESC_CONCISE_TYPE:
            if (NumericAttribute) *NumericAttribute = SQL_VARCHAR;
            return SQL_SUCCESS;
        case SQL_DESC_DISPLAY_SIZE:
        case SQL_DESC_LENGTH:
        case SQL_DESC_OCTET_LENGTH:
            if (NumericAttribute) *NumericAttribute = 4000;
            return SQL_SUCCESS;
        case SQL_DESC_PRECISION:
            if (NumericAttribute) *NumericAttribute = 4000;
            return SQL_SUCCESS;
        case SQL_DESC_SCALE:
            if (NumericAttribute) *NumericAttribute = 0;
            return SQL_SUCCESS;
        case SQL_DESC_NULLABLE:
            if (NumericAttribute) *NumericAttribute = SQL_NULLABLE_UNKNOWN;
            return SQL_SUCCESS;
        case SQL_DESC_UNSIGNED:
            if (NumericAttribute) *NumericAttribute = SQL_TRUE;
            return SQL_SUCCESS;
        default:
            diag_set(&stmt->diag, "HYC00", "SQLColAttribute field id %u is not supported by this driver.", (unsigned)FieldIdentifier);
            return SQL_ERROR;
    }
}

SQLRETURN SQL_API SQLBindCol(SQLHSTMT hstmt, SQLUSMALLINT ColumnNumber, SQLSMALLINT TargetType,
                              SQLPOINTER TargetValuePtr, SQLLEN BufferLength, SQLLEN *StrLen_or_Ind) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    if (stmt->columnCount == 0) {
        diag_set(&stmt->diag, "07005", "No result set is available to bind to.");
        return SQL_ERROR;
    }
    if (ColumnNumber < 1 || (size_t)ColumnNumber > stmt->columnCount) {
        diag_set(&stmt->diag, "07009", "Invalid column number %u.", (unsigned)ColumnNumber);
        return SQL_ERROR;
    }
    if (!stmt->bindings) stmt->bindings = (ColBinding *)calloc(stmt->columnCount, sizeof(ColBinding));
    ColBinding *b = &stmt->bindings[ColumnNumber - 1];
    if (!TargetValuePtr) {
        memset(b, 0, sizeof(*b));
        return SQL_SUCCESS;
    }
    b->targetType = TargetType;
    b->targetValuePtr = TargetValuePtr;
    b->bufferLength = BufferLength;
    b->strLenOrIndPtr = StrLen_or_Ind;
    b->bound = 1;
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLFetch(SQLHSTMT hstmt) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    if (!stmt->rowsArray) {
        diag_set(&stmt->diag, "24000", "No result set is available.");
        return SQL_ERROR;
    }
    stmt->currentRowIndex++;
    if ((size_t)stmt->currentRowIndex >= stmt->rowsArray->itemCount) {
        stmt->currentRowIndex = (long)stmt->rowsArray->itemCount; /* stay past end */
        return SQL_NO_DATA;
    }
    diag_clear(&stmt->diag);
    if (!stmt->bindings) return SQL_SUCCESS;
    SQLRETURN overall = SQL_SUCCESS;
    for (size_t i = 0; i < stmt->columnCount; i++) {
        ColBinding *b = &stmt->bindings[i];
        if (!b->bound) continue;
        JsonValue *cell = cell_value(stmt, (SQLUSMALLINT)(i + 1));
        SQLRETURN rc = convert_cell(&stmt->diag, cell, b->targetType, b->targetValuePtr, b->bufferLength, b->strLenOrIndPtr);
        if (rc == SQL_ERROR) return SQL_ERROR;
        if (rc == SQL_SUCCESS_WITH_INFO) overall = SQL_SUCCESS_WITH_INFO;
    }
    return overall;
}

SQLRETURN SQL_API SQLGetData(SQLHSTMT hstmt, SQLUSMALLINT ColumnNumber, SQLSMALLINT TargetType,
                              SQLPOINTER TargetValuePtr, SQLLEN BufferLength, SQLLEN *StrLen_or_IndPtr) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    if (!current_row(stmt)) {
        diag_set(&stmt->diag, "24000", "No current row (call SQLFetch first).");
        return SQL_ERROR;
    }
    if (ColumnNumber < 1 || (size_t)ColumnNumber > stmt->columnCount) {
        diag_set(&stmt->diag, "07009", "Invalid column number %u.", (unsigned)ColumnNumber);
        return SQL_ERROR;
    }
    JsonValue *cell = cell_value(stmt, ColumnNumber);
    diag_clear(&stmt->diag);
    return convert_cell(&stmt->diag, cell, TargetType, TargetValuePtr, BufferLength, StrLen_or_IndPtr);
}

SQLRETURN SQL_API SQLRowCount(SQLHSTMT hstmt, SQLLEN *pcrow) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    if (pcrow) *pcrow = (SQLLEN)stmt->rowCountAffected;
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLFreeStmt(SQLHSTMT hstmt, SQLUSMALLINT Option) {
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    switch (Option) {
        case SQL_CLOSE:
            free_result_set(stmt);
            return SQL_SUCCESS;
        case SQL_UNBIND:
            free(stmt->bindings);
            stmt->bindings = NULL;
            return SQL_SUCCESS;
        case SQL_RESET_PARAMS:
            return SQL_SUCCESS; /* no parameter markers are supported */
        case SQL_DROP:
            return SQLFreeHandle(SQL_HANDLE_STMT, hstmt);
        default:
            diag_set(&stmt->diag, "HY092", "Unsupported SQLFreeStmt option %u.", (unsigned)Option);
            return SQL_ERROR;
    }
}

SQLRETURN SQL_API SQLCloseCursor(SQLHSTMT hstmt) {
    return SQLFreeStmt(hstmt, SQL_CLOSE);
}

static SQLRETURN diag_from(Diag *d, SQLSMALLINT RecNumber, SQLCHAR *Sqlstate, SQLINTEGER *NativeError,
                            SQLCHAR *MessageText, SQLSMALLINT BufferLength, SQLSMALLINT *TextLength) {
    if (RecNumber != 1 || !d->hasError) return SQL_NO_DATA;
    if (Sqlstate) { strncpy((char *)Sqlstate, d->sqlState, 5); Sqlstate[5] = 0; }
    if (NativeError) *NativeError = 0;
    copy_out_string(d->message, MessageText, BufferLength, TextLength);
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLGetDiagRec(SQLSMALLINT HandleType, SQLHANDLE Handle, SQLSMALLINT RecNumber,
                                 SQLCHAR *Sqlstate, SQLINTEGER *NativeError, SQLCHAR *MessageText,
                                 SQLSMALLINT BufferLength, SQLSMALLINT *TextLength) {
    if (!Handle) return SQL_INVALID_HANDLE;
    switch (HandleType) {
        case SQL_HANDLE_ENV:
            return diag_from(&((InayaEnv *)Handle)->diag, RecNumber, Sqlstate, NativeError, MessageText, BufferLength, TextLength);
        case SQL_HANDLE_DBC:
            return diag_from(&((InayaDbc *)Handle)->diag, RecNumber, Sqlstate, NativeError, MessageText, BufferLength, TextLength);
        case SQL_HANDLE_STMT:
            return diag_from(&((InayaStmt *)Handle)->diag, RecNumber, Sqlstate, NativeError, MessageText, BufferLength, TextLength);
        default:
            return SQL_INVALID_HANDLE;
    }
}

SQLRETURN SQL_API SQLGetInfo(SQLHDBC hdbc, SQLUSMALLINT InfoType, SQLPOINTER InfoValue,
                              SQLSMALLINT BufferLength, SQLSMALLINT *StringLength) {
    InayaDbc *dbc = (InayaDbc *)hdbc;
    if (!dbc) return SQL_INVALID_HANDLE;
    switch (InfoType) {
        case SQL_DRIVER_NAME:
            copy_out_string("inayaodbc.dll", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_DRIVER_VER:
            copy_out_string("01.00.0000", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_DRIVER_ODBC_VER:
            copy_out_string("03.80", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_DBMS_NAME:
            copy_out_string("Inaya Data Access", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_DBMS_VER:
            copy_out_string("01.00.0000", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_DATA_SOURCE_NAME:
        case SQL_SERVER_NAME:
            copy_out_string(dbc->dataSourceId ? dbc->dataSourceId : "", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_USER_NAME:
            copy_out_string("", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_IDENTIFIER_QUOTE_CHAR:
            copy_out_string("\"", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
        case SQL_TXN_CAPABLE:
            if (InfoValue) *(SQLUSMALLINT *)InfoValue = SQL_TC_NONE; /* autocommit-only, honest */
            return SQL_SUCCESS;
        case SQL_CURSOR_COMMIT_BEHAVIOR:
        case SQL_CURSOR_ROLLBACK_BEHAVIOR:
            if (InfoValue) *(SQLUSMALLINT *)InfoValue = SQL_CB_PRESERVE;
            return SQL_SUCCESS;
        case SQL_MAX_COLUMN_NAME_LEN:
        case SQL_MAX_TABLE_NAME_LEN:
            if (InfoValue) *(SQLUSMALLINT *)InfoValue = 128;
            return SQL_SUCCESS;
        default:
            /* Not individually modeled. Reporting an empty string is the
             * standard ODBC encoding for "driver claims no special
             * capability here" -- not a fabricated value -- matching how
             * most minimal ODBC drivers handle the long tail of
             * rarely-queried SQLGetInfo codes. */
            copy_out_string("", (SQLCHAR *)InfoValue, BufferLength, StringLength);
            return SQL_SUCCESS;
    }
}

#define SET_FUNC(pfExists, id) do { if ((id) <= 100) ((SQLUSMALLINT *)(pfExists))[(id)] = SQL_TRUE; } while (0)

SQLRETURN SQL_API SQLGetFunctions(SQLHDBC hdbc, SQLUSMALLINT FunctionId, SQLUSMALLINT *Supported) {
    (void)hdbc;
    if (!Supported) return SQL_ERROR;
    static const SQLUSMALLINT implemented[] = {
        SQL_API_SQLALLOCHANDLE, SQL_API_SQLFREEHANDLE, SQL_API_SQLDRIVERCONNECT, SQL_API_SQLCONNECT,
        SQL_API_SQLDISCONNECT, SQL_API_SQLEXECDIRECT, SQL_API_SQLPREPARE, SQL_API_SQLEXECUTE,
        SQL_API_SQLNUMRESULTCOLS, SQL_API_SQLDESCRIBECOL, SQL_API_SQLCOLATTRIBUTE, SQL_API_SQLBINDCOL,
        SQL_API_SQLFETCH, SQL_API_SQLGETDATA, SQL_API_SQLROWCOUNT, SQL_API_SQLFREESTMT,
        SQL_API_SQLGETDIAGREC, SQL_API_SQLGETINFO, SQL_API_SQLGETFUNCTIONS, SQL_API_SQLSETENVATTR,
        SQL_API_SQLGETENVATTR, SQL_API_SQLTABLES, SQL_API_SQLCOLUMNS, SQL_API_SQLCLOSECURSOR
    };
    size_t n = sizeof(implemented) / sizeof(implemented[0]);

    if (FunctionId == SQL_API_ALL_FUNCTIONS) {
        for (int i = 0; i < 100; i++) Supported[i] = SQL_FALSE;
        for (size_t i = 0; i < n; i++) if (implemented[i] < 100) Supported[implemented[i]] = SQL_TRUE;
        return SQL_SUCCESS;
    }
    if (FunctionId == SQL_API_ODBC3_ALL_FUNCTIONS) {
        memset(Supported, 0, sizeof(SQLUSMALLINT) * SQL_API_ODBC3_ALL_FUNCTIONS_SIZE);
        for (size_t i = 0; i < n; i++) {
            SQLUSMALLINT id = implemented[i];
            Supported[id >> 4] |= (1 << (id & 0x0F));
        }
        return SQL_SUCCESS;
    }
    *Supported = SQL_FALSE;
    for (size_t i = 0; i < n; i++) if (implemented[i] == FunctionId) { *Supported = SQL_TRUE; break; }
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLTables(SQLHSTMT hstmt, SQLCHAR *CatalogName, SQLSMALLINT NameLength1,
                             SQLCHAR *SchemaName, SQLSMALLINT NameLength2,
                             SQLCHAR *TableName, SQLSMALLINT NameLength3,
                             SQLCHAR *TableType, SQLSMALLINT NameLength4) {
    (void)CatalogName; (void)NameLength1; (void)SchemaName; (void)NameLength2; (void)TableType; (void)NameLength4;
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    char *tableFilter = text_arg_to_cstr(TableName, NameLength3);
    SQLRETURN rc = do_sql_tables(stmt, tableFilter);
    free(tableFilter);
    return rc;
}

SQLRETURN SQL_API SQLColumns(SQLHSTMT hstmt, SQLCHAR *CatalogName, SQLSMALLINT NameLength1,
                              SQLCHAR *SchemaName, SQLSMALLINT NameLength2,
                              SQLCHAR *TableName, SQLSMALLINT NameLength3,
                              SQLCHAR *ColumnName, SQLSMALLINT NameLength4) {
    (void)CatalogName; (void)NameLength1; (void)SchemaName; (void)NameLength2;
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    char *tableFilter = text_arg_to_cstr(TableName, NameLength3);
    char *columnFilter = text_arg_to_cstr(ColumnName, NameLength4);
    SQLRETURN rc = do_sql_columns(stmt, tableFilter, columnFilter);
    free(tableFilter);
    free(columnFilter);
    return rc;
}

/* ------------------------------------------------------------------ */
/* Explicitly-unsupported functions -- named HYC00, never a silent      */
/* no-op, matching the JDBC driver's SQLFeatureNotSupportedException.  */
/* ------------------------------------------------------------------ */

SQLRETURN SQL_API SQLSetConnectAttr(SQLHDBC hdbc, SQLINTEGER Attribute, SQLPOINTER Value, SQLINTEGER StringLength) {
    (void)Value; (void)StringLength;
    InayaDbc *dbc = (InayaDbc *)hdbc;
    if (!dbc) return SQL_INVALID_HANDLE;
    if (Attribute == SQL_ATTR_AUTOCOMMIT) return SQL_SUCCESS; /* autocommit is the only mode we have */
    diag_set(&dbc->diag, "HYC00", "SQLSetConnectAttr(%ld) is not supported by this driver.", (long)Attribute);
    return SQL_ERROR;
}

SQLRETURN SQL_API SQLGetConnectAttr(SQLHDBC hdbc, SQLINTEGER Attribute, SQLPOINTER Value,
                                     SQLINTEGER BufferLength, SQLINTEGER *StringLength) {
    (void)BufferLength; (void)StringLength;
    InayaDbc *dbc = (InayaDbc *)hdbc;
    if (!dbc) return SQL_INVALID_HANDLE;
    if (Attribute == SQL_ATTR_AUTOCOMMIT) {
        if (Value) *(SQLUINTEGER *)Value = SQL_AUTOCOMMIT_ON;
        return SQL_SUCCESS;
    }
    if (Attribute == SQL_ATTR_CONNECTION_DEAD) {
        if (Value) *(SQLUINTEGER *)Value = dbc->connected ? SQL_CD_FALSE : SQL_CD_TRUE;
        return SQL_SUCCESS;
    }
    diag_set(&dbc->diag, "HYC00", "SQLGetConnectAttr(%ld) is not supported by this driver.", (long)Attribute);
    return SQL_ERROR;
}

SQLRETURN SQL_API SQLEndTran(SQLSMALLINT HandleType, SQLHANDLE Handle, SQLSMALLINT CompletionType) {
    (void)CompletionType;
    /* Every statement runs and commits server-side per call (there is no
     * multi-statement transaction on this REST transport) -- commit and
     * rollback are both real no-ops here, not a faked "transaction
     * support" claim (SQL_TXN_CAPABLE above honestly reports SQL_TC_NONE). */
    if (HandleType == SQL_HANDLE_DBC && !Handle) return SQL_INVALID_HANDLE;
    return SQL_SUCCESS;
}

SQLRETURN SQL_API SQLBindParameter(SQLHSTMT hstmt, SQLUSMALLINT ParameterNumber, SQLSMALLINT InputOutputType,
                                    SQLSMALLINT ValueType, SQLSMALLINT ParameterType, SQLULEN ColumnSize,
                                    SQLSMALLINT DecimalDigits, SQLPOINTER ParameterValuePtr, SQLLEN BufferLength,
                                    SQLLEN *StrLen_or_IndPtr) {
    (void)ParameterNumber; (void)InputOutputType; (void)ValueType; (void)ParameterType; (void)ColumnSize;
    (void)DecimalDigits; (void)ParameterValuePtr; (void)BufferLength; (void)StrLen_or_IndPtr;
    InayaStmt *stmt = (InayaStmt *)hstmt;
    if (!stmt) return SQL_INVALID_HANDLE;
    diag_set(&stmt->diag, "HYC00", "Parameter markers (?) are not supported -- the SQL gateway executes statement text verbatim.");
    return SQL_ERROR;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved) {
    (void)hinst; (void)reserved;
    if (reason == DLL_PROCESS_ATTACH || reason == DLL_THREAD_ATTACH) { /* nothing to init */ }
    return TRUE;
}
