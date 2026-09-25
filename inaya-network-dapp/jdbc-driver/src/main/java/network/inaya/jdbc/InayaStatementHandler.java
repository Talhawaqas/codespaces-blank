package network.inaya.jdbc;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/**
 * {@link java.sql.Statement} proxy handler -- see
 * {@link InayaConnectionHandler} for why this driver uses dynamic proxies
 * for the large java.sql interfaces. executeQuery() is the one real,
 * fully-tested path (SELECT only, matching the SQL gateway's own
 * read-only phase-gating this pass).
 */
final class InayaStatementHandler implements InvocationHandler {

    private final InayaHttpClient http;
    private final String dataSourceId;
    private int maxRows = 0;
    private int queryTimeoutSeconds = 0;
    private boolean closed = false;
    private ResultSet currentResultSet;

    private InayaStatementHandler(InayaHttpClient http, String dataSourceId) {
        this.http = http;
        this.dataSourceId = dataSourceId;
    }

    static Statement create(InayaHttpClient http, String dataSourceId) {
        return (Statement) Proxy.newProxyInstance(
                InayaStatementHandler.class.getClassLoader(),
                new Class<?>[]{Statement.class},
                new InayaStatementHandler(http, dataSourceId));
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        String name = method.getName();
        switch (name) {
            case "executeQuery": {
                requireOpen();
                String sql = (String) args[0];
                currentResultSet = runQuery(sql);
                return currentResultSet;
            }
            case "execute": {
                requireOpen();
                String sql = (String) args[0];
                currentResultSet = runQuery(sql);
                return true; // this driver only ever produces a ResultSet -- there is no execute() path that returns an update count (write-back is not supported this pass)
            }
            case "executeUpdate":
                throw new SQLFeatureNotSupportedException("executeUpdate() is not supported -- write-back is not enabled in this pass (SOW Section 17 phase-gating). Use executeQuery() for SELECT.");
            case "getResultSet":
                return currentResultSet;
            case "getUpdateCount":
                return -1; // per the JDBC contract: -1 means "the last result was a ResultSet, not an update count"
            case "getMoreResults":
                return false;
            case "setMaxRows":
                maxRows = (Integer) args[0];
                return null;
            case "getMaxRows":
                return maxRows;
            case "setQueryTimeout":
                queryTimeoutSeconds = (Integer) args[0];
                return null;
            case "getQueryTimeout":
                return queryTimeoutSeconds;
            case "close":
                closed = true;
                return null;
            case "isClosed":
                return closed;
            case "cancel":
                throw new SQLFeatureNotSupportedException("Query cancellation is not implemented by this driver in this pass (the gateway itself does enforce a server-side timeout regardless).");
            case "getWarnings":
                return null;
            case "clearWarnings":
                return null;
            case "getFetchSize":
                return 0;
            case "setFetchSize":
                return null; // accepted as a hint and ignored -- this driver always fetches the full (server-capped) result in one HTTP call
            case "unwrap":
                if (((Class<?>) args[0]).isInstance(proxy)) return proxy;
                throw new SQLException("Not a wrapper for " + args[0]);
            case "isWrapperFor":
                return ((Class<?>) args[0]).isInstance(proxy);
            case "toString":
                return "InayaStatement{dataSourceId=" + dataSourceId + "}";
            case "equals":
                return proxy == args[0];
            case "hashCode":
                return System.identityHashCode(proxy);
            default:
                throw new SQLFeatureNotSupportedException("Statement." + name + "() is not implemented by the Inaya JDBC driver in this pass.");
        }
    }

    private ResultSet runQuery(String sql) throws SQLException {
        JSONObject body = new JSONObject();
        body.put("sql", sql);
        if (maxRows > 0) body.put("maxRows", maxRows);
        if (queryTimeoutSeconds > 0) body.put("timeoutMs", queryTimeoutSeconds * 1000L);

        JSONObject response = http.post("/api/public/v1/data-sources/" + dataSourceId + "/query", body);
        JSONArray rows = response.optJSONArray("rows");
        if (rows == null) rows = new JSONArray();

        // Column order comes from the gateway's own explicit "columns"
        // array, never inferred from JSON object key order -- the JSON
        // spec itself doesn't guarantee object key order, and this
        // driver's own integration test caught a real bug (columns
        // silently reordered) when it relied on JSONObject.keySet()
        // instead. An empty result set still reports zero columns -- a
        // real, documented limitation (see README.md).
        JSONArray columnsJson = response.optJSONArray("columns");
        List<String> columns = new ArrayList<>();
        if (columnsJson != null) {
            for (int i = 0; i < columnsJson.length(); i++) columns.add(columnsJson.getString(i));
        }

        List<JSONObject> rowObjects = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) rowObjects.add(rows.getJSONObject(i));

        return InayaResultSetHandler.create(columns, rowObjects);
    }

    private void requireOpen() throws SQLException {
        if (closed) throw new SQLException("Statement is closed.", "08003");
    }
}
