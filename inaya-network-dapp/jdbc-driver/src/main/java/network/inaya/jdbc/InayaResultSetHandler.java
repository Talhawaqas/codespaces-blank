package network.inaya.jdbc;

import org.json.JSONObject;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.List;

/**
 * {@link java.sql.ResultSet} proxy handler -- see
 * {@link InayaConnectionHandler} for the dynamic-proxy rationale. The
 * common typed getters (getString/getInt/getLong/getDouble/getBoolean/
 * getObject, both by column index and by label) are real, backed by the
 * real JSON rows returned from a real query. Cursor-movement beyond
 * next() (absolute/relative/previous/scroll), updatable-ResultSet
 * methods, and the less-common typed getters (getDate/getTimestamp/
 * getBytes/getArray/getRef/getBlob/getClob) are NOT implemented this
 * pass -- SQLFeatureNotSupportedException, not a fabricated value.
 */
final class InayaResultSetHandler implements InvocationHandler {

    private final List<String> columns;
    private final List<JSONObject> rows;
    private int cursor = -1; // before the first row, per JDBC contract
    private boolean closed = false;
    private boolean lastWasNull = false;

    private InayaResultSetHandler(List<String> columns, List<JSONObject> rows) {
        this.columns = columns;
        this.rows = rows;
    }

    static ResultSet create(List<String> columns, List<JSONObject> rows) {
        return (ResultSet) Proxy.newProxyInstance(
                InayaResultSetHandler.class.getClassLoader(),
                new Class<?>[]{ResultSet.class},
                new InayaResultSetHandler(columns, rows));
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        String name = method.getName();
        switch (name) {
            case "next":
                requireOpen();
                cursor++;
                return cursor < rows.size();
            case "close":
                closed = true;
                return null;
            case "isClosed":
                return closed;
            case "wasNull":
                return lastWasNull;
            case "getMetaData":
                return InayaResultSetMetaDataHandler.create(columns);
            case "findColumn": {
                int idx = columns.indexOf((String) args[0]);
                if (idx < 0) throw new SQLException("No such column: " + args[0]);
                return idx + 1; // JDBC columns are 1-based
            }
            case "getString":
            case "getObject": {
                Object value = valueAt(resolveColumnIndex(args[0]));
                return value == null ? null : value.toString();
            }
            case "getInt": {
                Object value = valueAt(resolveColumnIndex(args[0]));
                return value == null ? 0 : ((Number) toNumber(value)).intValue();
            }
            case "getLong": {
                Object value = valueAt(resolveColumnIndex(args[0]));
                return value == null ? 0L : ((Number) toNumber(value)).longValue();
            }
            case "getDouble": {
                Object value = valueAt(resolveColumnIndex(args[0]));
                return value == null ? 0.0 : ((Number) toNumber(value)).doubleValue();
            }
            case "getFloat": {
                Object value = valueAt(resolveColumnIndex(args[0]));
                return value == null ? 0.0f : ((Number) toNumber(value)).floatValue();
            }
            case "getBoolean": {
                Object value = valueAt(resolveColumnIndex(args[0]));
                if (value == null) return false;
                if (value instanceof Boolean) return value;
                if (value instanceof Number) return ((Number) value).longValue() != 0;
                return Boolean.parseBoolean(value.toString());
            }
            case "getRow":
                return cursor + 1;
            case "isBeforeFirst":
                return cursor < 0;
            case "isAfterLast":
                return cursor >= rows.size();
            case "isFirst":
                return cursor == 0;
            case "isLast":
                return !rows.isEmpty() && cursor == rows.size() - 1;
            case "getFetchSize":
                return rows.size();
            case "setFetchSize":
                return null; // no-op: the full (server-capped) result is already held in memory
            case "getType":
                return ResultSet.TYPE_FORWARD_ONLY;
            case "getConcurrency":
                return ResultSet.CONCUR_READ_ONLY;
            case "getWarnings":
                return null;
            case "clearWarnings":
                return null;
            case "unwrap":
                if (((Class<?>) args[0]).isInstance(proxy)) return proxy;
                throw new SQLException("Not a wrapper for " + args[0]);
            case "isWrapperFor":
                return ((Class<?>) args[0]).isInstance(proxy);
            case "toString":
                return "InayaResultSet{row=" + (cursor + 1) + "/" + rows.size() + "}";
            case "equals":
                return proxy == args[0];
            case "hashCode":
                return System.identityHashCode(proxy);
            default:
                throw new SQLFeatureNotSupportedException("ResultSet." + name + "() is not implemented by the Inaya JDBC driver in this pass.");
        }
    }

    private int resolveColumnIndex(Object columnRef) throws SQLException {
        if (columnRef instanceof Integer) return (Integer) columnRef;
        int idx = columns.indexOf((String) columnRef);
        if (idx < 0) throw new SQLException("No such column: " + columnRef);
        return idx + 1;
    }

    private Object valueAt(int columnIndex1Based) throws SQLException {
        requireOpen();
        if (cursor < 0 || cursor >= rows.size()) throw new SQLException("Cursor is not positioned on a row.", "24000");
        if (columnIndex1Based < 1 || columnIndex1Based > columns.size()) throw new SQLException("Column index out of range: " + columnIndex1Based);
        String columnName = columns.get(columnIndex1Based - 1);
        JSONObject row = rows.get(cursor);
        Object value = row.isNull(columnName) ? null : row.opt(columnName);
        lastWasNull = value == null;
        return value;
    }

    private static Object toNumber(Object value) {
        if (value instanceof Number) return value;
        return Double.parseDouble(value.toString());
    }

    private void requireOpen() throws SQLException {
        if (closed) throw new SQLException("ResultSet is closed.", "08003");
    }
}
