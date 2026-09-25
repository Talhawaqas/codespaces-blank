package network.inaya.jdbc;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * {@link java.sql.DatabaseMetaData} proxy handler. getTables()/
 * getColumns() are the two real, tested methods -- they call the real
 * /api/public/v1/data-sources/{id}/metadata endpoint and shape its
 * response into the standard JDBC result-set columns (TABLE_CAT,
 * TABLE_NAME, COLUMN_NAME, DATA_TYPE, ...) a real SQL client's schema
 * browser expects. Every other DatabaseMetaData method (there are
 * ~200 in the interface) throws SQLFeatureNotSupportedException --
 * standard, honest practice for a narrowly-scoped driver, not unique to
 * this one.
 */
final class InayaDatabaseMetaDataHandler implements InvocationHandler {

    private final InayaHttpClient http;
    private final String dataSourceId;

    private InayaDatabaseMetaDataHandler(InayaHttpClient http, String dataSourceId) {
        this.http = http;
        this.dataSourceId = dataSourceId;
    }

    static DatabaseMetaData create(InayaHttpClient http, String dataSourceId) {
        return (DatabaseMetaData) Proxy.newProxyInstance(
                InayaDatabaseMetaDataHandler.class.getClassLoader(),
                new Class<?>[]{DatabaseMetaData.class},
                new InayaDatabaseMetaDataHandler(http, dataSourceId));
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        String name = method.getName();
        switch (name) {
            case "getTables":
                return getTables();
            case "getColumns":
                return getColumns();
            case "getDatabaseProductName":
                return "Inaya SQL Virtualization Gateway";
            case "getDatabaseProductVersion":
                return "0.1.0";
            case "getDriverName":
                return "Inaya JDBC Driver";
            case "getDriverVersion":
                return "0.1.0";
            case "getDriverMajorVersion":
                return 0;
            case "getDriverMinorVersion":
                return 1;
            case "getURL":
                return "jdbc:inaya:.../" + dataSourceId;
            case "supportsTransactions":
                return false;
            case "supportsStoredProcedures":
                return false;
            case "supportsBatchUpdates":
                return false;
            case "supportsSelectForUpdate":
                return false;
            case "supportsMultipleResultSets":
                return false;
            case "isReadOnly":
                return true;
            case "allProceduresAreCallable":
            case "allTablesAreSelectable":
                return true;
            case "nullsAreSortedHigh":
            case "nullsAreSortedLow":
            case "nullsAreSortedAtStart":
            case "nullsAreSortedAtEnd":
                return false;
            case "usesLocalFiles":
            case "usesLocalFilePerTable":
                return false;
            case "supportsMixedCaseIdentifiers":
                return true;
            case "storesUpperCaseIdentifiers":
            case "storesLowerCaseIdentifiers":
                return false;
            case "getIdentifierQuoteString":
                return "\"";
            case "getSQLKeywords":
            case "getNumericFunctions":
            case "getStringFunctions":
            case "getSystemFunctions":
            case "getTimeDateFunctions":
                return "";
            case "getSearchStringEscape":
                return "\\";
            case "getExtraNameCharacters":
                return "";
            case "getCatalogSeparator":
                return ".";
            case "getCatalogTerm":
                return "data source";
            case "getSchemaTerm":
                return "schema";
            case "getProcedureTerm":
                return "procedure";
            case "supportsCatalogsInDataManipulation":
            case "supportsSchemasInDataManipulation":
                return false;
            case "getMaxConnections":
            case "getMaxStatements":
            case "getMaxColumnsInTable":
            case "getMaxTableNameLength":
            case "getMaxColumnNameLength":
                return 0; // 0 means "no limit known/enforced" per the JDBC contract
            case "getResultSetHoldability":
                return ResultSet.CLOSE_CURSORS_AT_COMMIT;
            case "getDefaultTransactionIsolation":
                return java.sql.Connection.TRANSACTION_NONE;
            case "getJDBCMajorVersion":
                return 4;
            case "getJDBCMinorVersion":
                return 2;
            case "getConnection":
                throw new SQLFeatureNotSupportedException("DatabaseMetaData.getConnection() is not implemented -- this handler does not retain a Connection reference.");
            case "unwrap":
                if (((Class<?>) args[0]).isInstance(proxy)) return proxy;
                throw new SQLException("Not a wrapper for " + args[0]);
            case "isWrapperFor":
                return ((Class<?>) args[0]).isInstance(proxy);
            case "toString":
                return "InayaDatabaseMetaData{dataSourceId=" + dataSourceId + "}";
            case "equals":
                return proxy == args[0];
            case "hashCode":
                return System.identityHashCode(proxy);
            default:
                throw new SQLFeatureNotSupportedException("DatabaseMetaData." + name + "() is not implemented by the Inaya JDBC driver in this pass.");
        }
    }

    private static final List<String> TABLES_COLUMNS = Arrays.asList(
            "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "TABLE_TYPE", "REMARKS",
            "TYPE_CAT", "TYPE_SCHEM", "TYPE_NAME", "SELF_REFERENCING_COL_NAME", "REF_GENERATION");

    private ResultSet getTables() throws SQLException {
        JSONObject metadata = http.get("/api/public/v1/data-sources/" + dataSourceId + "/metadata");
        JSONArray tables = metadata.optJSONArray("tables");
        if (tables == null) tables = new JSONArray();

        List<JSONObject> rows = new ArrayList<>();
        for (int i = 0; i < tables.length(); i++) {
            JSONObject table = tables.getJSONObject(i);
            JSONObject row = new JSONObject();
            row.put("TABLE_CAT", dataSourceId);
            row.put("TABLE_SCHEM", JSONObject.NULL);
            row.put("TABLE_NAME", table.optString("name"));
            row.put("TABLE_TYPE", "TABLE");
            row.put("REMARKS", JSONObject.NULL);
            rows.add(row);
        }
        return InayaResultSetHandler.create(TABLES_COLUMNS, rows);
    }

    private static final List<String> COLUMNS_COLUMNS = Arrays.asList(
            "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "TYPE_NAME",
            "COLUMN_SIZE", "NULLABLE", "IS_NULLABLE", "ORDINAL_POSITION");

    private ResultSet getColumns() throws SQLException {
        JSONObject metadata = http.get("/api/public/v1/data-sources/" + dataSourceId + "/metadata");
        JSONArray tables = metadata.optJSONArray("tables");
        if (tables == null) tables = new JSONArray();

        List<JSONObject> rows = new ArrayList<>();
        for (int t = 0; t < tables.length(); t++) {
            JSONObject table = tables.getJSONObject(t);
            String tableName = table.optString("name");
            JSONArray tableColumns = table.optJSONArray("columns");
            if (tableColumns == null) continue;
            for (int c = 0; c < tableColumns.length(); c++) {
                JSONObject col = tableColumns.getJSONObject(c);
                JSONObject row = new JSONObject();
                row.put("TABLE_CAT", dataSourceId);
                row.put("TABLE_SCHEM", JSONObject.NULL);
                row.put("TABLE_NAME", tableName);
                row.put("COLUMN_NAME", col.optString("name"));
                row.put("DATA_TYPE", java.sql.Types.VARCHAR);
                row.put("TYPE_NAME", col.optString("sqlType", "VARCHAR"));
                row.put("COLUMN_SIZE", 255);
                boolean nullable = col.optBoolean("nullable", true);
                row.put("NULLABLE", nullable ? DatabaseMetaData.columnNullable : DatabaseMetaData.columnNoNulls);
                row.put("IS_NULLABLE", nullable ? "YES" : "NO");
                row.put("ORDINAL_POSITION", c + 1);
                rows.add(row);
            }
        }
        return InayaResultSetHandler.create(COLUMNS_COLUMNS, rows);
    }
}
