package network.inaya.jdbc;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Types;
import java.util.List;

/**
 * {@link java.sql.ResultSetMetaData} proxy handler.
 *
 * KNOWN, DOCUMENTED LIMITATION (see README.md): the query response this
 * driver parses carries column NAMES only, not their declared SQL types
 * (the gateway's /query endpoint doesn't join back to the virtual
 * table's column metadata this pass -- a real, scoped follow-up, not
 * silently glossed over). getColumnType()/getColumnTypeName() therefore
 * always report VARCHAR/String rather than guessing -- an honest
 * "unknown, treat as text" answer, not a fabricated INTEGER/DATE/etc.
 */
final class InayaResultSetMetaDataHandler implements InvocationHandler {

    private final List<String> columns;

    private InayaResultSetMetaDataHandler(List<String> columns) {
        this.columns = columns;
    }

    static ResultSetMetaData create(List<String> columns) {
        return (ResultSetMetaData) Proxy.newProxyInstance(
                InayaResultSetMetaDataHandler.class.getClassLoader(),
                new Class<?>[]{ResultSetMetaData.class},
                new InayaResultSetMetaDataHandler(columns));
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        String name = method.getName();
        switch (name) {
            case "getColumnCount":
                return columns.size();
            case "getColumnName":
            case "getColumnLabel":
                return columns.get(((Integer) args[0]) - 1);
            case "getColumnType":
                return Types.VARCHAR;
            case "getColumnTypeName":
                return "VARCHAR";
            case "getColumnClassName":
                return "java.lang.String";
            case "isNullable":
                return java.sql.ResultSetMetaData.columnNullableUnknown;
            case "isCaseSensitive":
                return true;
            case "isSearchable":
                return true;
            case "isCurrency":
                return false;
            case "isSigned":
                return false;
            case "isAutoIncrement":
                return false;
            case "isReadOnly":
                return true;
            case "isWritable":
            case "isDefinitelyWritable":
                return false;
            case "getPrecision":
                return 0;
            case "getScale":
                return 0;
            case "getTableName":
                return "";
            case "getCatalogName":
                return "";
            case "getSchemaName":
                return "";
            case "getColumnDisplaySize":
                return 255;
            case "unwrap":
                if (((Class<?>) args[0]).isInstance(proxy)) return proxy;
                throw new SQLException("Not a wrapper for " + args[0]);
            case "isWrapperFor":
                return ((Class<?>) args[0]).isInstance(proxy);
            case "toString":
                return "InayaResultSetMetaData{columns=" + columns + "}";
            case "equals":
                return proxy == args[0];
            case "hashCode":
                return System.identityHashCode(proxy);
            default:
                throw new SQLFeatureNotSupportedException("ResultSetMetaData." + name + "() is not implemented by the Inaya JDBC driver in this pass.");
        }
    }
}
