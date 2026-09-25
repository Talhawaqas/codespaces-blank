package network.inaya.jdbc;

import java.net.URI;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.Properties;
import java.util.logging.Logger;

/**
 * java.sql.Driver implementation for Inaya's SQL virtualization gateway.
 *
 * URL format: {@code jdbc:inaya:<http-or-https-url-to-the-gateway>/<dataSourceId>}
 * e.g. {@code jdbc:inaya:http://localhost:3000/68a1...}
 *      or     {@code jdbc:inaya:https://app.inaya.network/68a1...}
 *
 * The org API key is supplied via connection Properties ("apiKey"),
 * never embedded in the URL itself -- matches this codebase's own
 * "never place a secret where it could end up logged" discipline
 * (see e.g. legacyDataAccess/credentials.js's own header).
 */
public final class InayaDriver implements Driver {

    private static final String URL_PREFIX = "jdbc:inaya:";

    static {
        try {
            DriverManager.registerDriver(new InayaDriver());
        } catch (SQLException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    public InayaDriver() {
        // Required no-arg constructor for META-INF/services/java.sql.Driver registration.
    }

    @Override
    public Connection connect(String url, Properties info) throws SQLException {
        if (!acceptsURL(url)) return null; // per java.sql.Driver contract: null, not an exception, for a URL this driver doesn't own

        String remainder = url.substring(URL_PREFIX.length());
        URI uri;
        try {
            uri = URI.create(remainder);
        } catch (IllegalArgumentException e) {
            throw new SQLException("Malformed Inaya JDBC URL: " + url, "08001", e);
        }

        String dataSourceId = uri.getPath();
        if (dataSourceId == null || dataSourceId.isEmpty() || "/".equals(dataSourceId)) {
            throw new SQLException("Inaya JDBC URL must include the data source id as its path, e.g. jdbc:inaya:http://host:port/<dataSourceId>", "08001");
        }
        dataSourceId = dataSourceId.startsWith("/") ? dataSourceId.substring(1) : dataSourceId;

        String baseUrl = uri.getScheme() + "://" + uri.getAuthority();
        String apiKey = info != null ? info.getProperty("apiKey") : null;
        if (apiKey == null || apiKey.isEmpty()) {
            throw new SQLException("Missing required connection property \"apiKey\" (an Inaya org API key).", "28000");
        }

        return InayaConnectionHandler.create(baseUrl, dataSourceId, apiKey);
    }

    @Override
    public boolean acceptsURL(String url) {
        return url != null && url.startsWith(URL_PREFIX);
    }

    @Override
    public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
        DriverPropertyInfo apiKeyProp = new DriverPropertyInfo("apiKey", info != null ? info.getProperty("apiKey") : null);
        apiKeyProp.required = true;
        apiKeyProp.description = "An Inaya org API key, issued from Business Workspace's API Keys settings.";
        return new DriverPropertyInfo[]{apiKeyProp};
    }

    @Override
    public int getMajorVersion() {
        return 0;
    }

    @Override
    public int getMinorVersion() {
        return 1;
    }

    /** False, deliberately honest: this driver does not implement the
     *  full JDBC-compliant (SQL92 Entry Level) feature set -- no
     *  transactions, no PreparedStatement parameter binding, no batch
     *  updates. See README.md's scope section. */
    @Override
    public boolean jdbcCompliant() {
        return false;
    }

    @Override
    public Logger getParentLogger() throws SQLFeatureNotSupportedException {
        throw new SQLFeatureNotSupportedException("java.util.logging is not used by this driver.");
    }
}
