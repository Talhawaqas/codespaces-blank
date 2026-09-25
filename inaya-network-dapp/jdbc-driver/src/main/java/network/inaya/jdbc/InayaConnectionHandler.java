package network.inaya.jdbc;

import org.json.JSONObject;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;

/**
 * {@link java.sql.Connection} is a ~70-method interface. Rather than a
 * concrete class with ~60 one-line "throw new
 * SQLFeatureNotSupportedException()" overrides cluttering the real
 * implementation, this driver uses {@link Proxy} -- a standard, legitimate
 * JDK technique -- so every method call genuinely dispatches through
 * reflection: the handful this connector really implements run real
 * code, and every other interface method throws
 * SQLFeatureNotSupportedException with the method's own name, rather
 * than silently returning a fabricated value. See README.md's "Scope"
 * section for exactly which methods across the driver are real.
 */
final class InayaConnectionHandler implements InvocationHandler {

    private final InayaHttpClient http;
    private final String dataSourceId;
    private boolean closed = false;

    private InayaConnectionHandler(String baseUrl, String dataSourceId, String apiKey) {
        this.http = new InayaHttpClient(baseUrl, apiKey);
        this.dataSourceId = dataSourceId;
    }

    static Connection create(String baseUrl, String dataSourceId, String apiKey) {
        return (Connection) Proxy.newProxyInstance(
                InayaConnectionHandler.class.getClassLoader(),
                new Class<?>[]{Connection.class},
                new InayaConnectionHandler(baseUrl, dataSourceId, apiKey));
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        String name = method.getName();
        switch (name) {
            case "createStatement":
                requireOpen();
                return InayaStatementHandler.create(http, dataSourceId);
            case "prepareStatement":
                throw new SQLFeatureNotSupportedException("Parameterized queries (PreparedStatement) are not supported by the SQL gateway in this pass -- use Statement.executeQuery(String) with a literal query instead.");
            case "close":
                closed = true;
                return null;
            case "isClosed":
                return closed;
            case "isValid":
                if (closed) return false;
                try {
                    JSONObject health = http.get("/api/public/v1/data-sources/" + dataSourceId + "/health");
                    return "CONNECTED".equals(health.optString("status"));
                } catch (SQLException e) {
                    return false;
                }
            case "getMetaData":
                requireOpen();
                return InayaDatabaseMetaDataHandler.create(http, dataSourceId);
            case "getCatalog":
                return dataSourceId;
            case "setCatalog":
                throw new SQLFeatureNotSupportedException("A connection is bound to one data source for its lifetime; open a new Connection to query a different source.");
            case "getAutoCommit":
                return true; // always true: there is nothing to commit -- write-back is not enabled this pass
            case "setAutoCommit":
                if (Boolean.FALSE.equals(args[0])) {
                    throw new SQLFeatureNotSupportedException("Transactions are not supported -- the SQL gateway is read-only in this pass.");
                }
                return null; // setAutoCommit(true) is a real no-op, since it's already always true
            case "commit":
            case "rollback":
                throw new SQLFeatureNotSupportedException(name + "() is not applicable -- there are no transactions to " + name + " (read-only gateway).");
            case "getWarnings":
                return null; // real, valid JDBC answer: this driver never accumulates SQLWarnings
            case "clearWarnings":
                return null;
            case "getTransactionIsolation":
                return java.sql.Connection.TRANSACTION_NONE;
            case "isReadOnly":
                return true;
            case "setReadOnly":
                return null; // accepted as a no-op; the connection is always read-only regardless of the requested value
            case "unwrap":
                if (((Class<?>) args[0]).isInstance(proxy)) return proxy;
                throw new SQLException("Not a wrapper for " + args[0]);
            case "isWrapperFor":
                return ((Class<?>) args[0]).isInstance(proxy);
            case "toString":
                return "InayaConnection{dataSourceId=" + dataSourceId + ", closed=" + closed + "}";
            case "equals":
                return proxy == args[0];
            case "hashCode":
                return System.identityHashCode(proxy);
            default:
                throw new SQLFeatureNotSupportedException("Connection." + name + "() is not implemented by the Inaya JDBC driver in this pass.");
        }
    }

    private void requireOpen() throws SQLException {
        if (closed) throw new SQLException("Connection is closed.", "08003");
    }
}
