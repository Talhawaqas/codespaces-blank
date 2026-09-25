package network.inaya.jdbc;

import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

import static org.junit.jupiter.api.Assertions.*;

/**
 * A REAL integration test -- connects via java.sql.DriverManager to a
 * genuinely running local Inaya dev server (started separately, see this
 * SOW's completion report), authenticates with a real org API key, and
 * runs real SQL through the real gateway against a real SQLite fixture.
 * Nothing here is mocked.
 *
 * Configured via system properties (set by -D flags), so this test is
 * skipped gracefully (not silently marked "passed") when they're not
 * provided -- see README.md for how to run it.
 */
class InayaDriverIntegrationTest {

    private static String jdbcUrl() {
        String dataSourceId = System.getProperty("inaya.test.dataSourceId");
        return dataSourceId == null ? null : "jdbc:inaya:http://localhost:3000/" + dataSourceId;
    }

    private static Connection connect() throws SQLException {
        String url = jdbcUrl();
        assumeConfigured(url);
        Properties props = new Properties();
        props.setProperty("apiKey", System.getProperty("inaya.test.apiKey"));
        return DriverManager.getConnection(url, props);
    }

    private static void assumeConfigured(String url) {
        org.junit.jupiter.api.Assumptions.assumeTrue(
                url != null && System.getProperty("inaya.test.apiKey") != null,
                "Skipped: set -Dinaya.test.dataSourceId=<id> -Dinaya.test.apiKey=<key> against a real running dev server to run this integration test."
        );
    }

    @Test
    void driverRegistersAndAcceptsItsOwnUrlScheme() throws SQLException {
        assertNotNull(DriverManager.getDriver("jdbc:inaya:http://localhost:3000/x"));
    }

    @Test
    void connectAndRunRealSelectQuery() throws SQLException {
        try (Connection conn = connect()) {
            assertFalse(conn.isClosed());
            assertTrue(conn.isValid(5));

            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery("SELECT id, sku, price FROM products ORDER BY id")) {

                List<String> skus = new ArrayList<>();
                while (rs.next()) {
                    skus.add(rs.getString("sku"));
                    assertFalse(rs.wasNull());
                }
                assertEquals(2, skus.size());
                assertEquals("WIDGET-1", skus.get(0));
                assertEquals("WIDGET-2", skus.get(1));
            }
        }
    }

    @Test
    void resultSetMetaDataReportsRealColumnNames() throws SQLException {
        try (Connection conn = connect();
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery("SELECT id, sku, price FROM products WHERE id = 1")) {

            ResultSetMetaData meta = rs.getMetaData();
            assertEquals(3, meta.getColumnCount());
            assertEquals("id", meta.getColumnName(1));
            assertEquals("sku", meta.getColumnName(2));
            assertEquals("price", meta.getColumnName(3));
        }
    }

    @Test
    void databaseMetaDataGetTablesAndGetColumnsReflectTheRealPublishedSchema() throws SQLException {
        try (Connection conn = connect()) {
            DatabaseMetaData meta = conn.getMetaData();

            List<String> tableNames = new ArrayList<>();
            try (ResultSet tables = meta.getTables(null, null, null, null)) {
                while (tables.next()) tableNames.add(tables.getString("TABLE_NAME"));
            }
            assertTrue(tableNames.contains("products"));

            List<String> columnNames = new ArrayList<>();
            try (ResultSet columns = meta.getColumns(null, null, null, null)) {
                while (columns.next()) columnNames.add(columns.getString("COLUMN_NAME"));
            }
            assertTrue(columnNames.contains("sku"));
            assertTrue(columnNames.contains("price"));
        }
    }

    @Test
    void writeBackIsHonestlyRejectedNotSilentlyIgnored() throws SQLException {
        try (Connection conn = connect();
             Statement stmt = conn.createStatement()) {
            SQLException ex = assertThrows(SQLException.class, () -> stmt.executeUpdate("DELETE FROM products WHERE id = 1"));
            assertTrue(ex.getMessage().contains("not supported"));
        }
    }

    @Test
    void queryingAnUnpublishedTableFailsClosedThroughTheRealDriver() throws SQLException {
        try (Connection conn = connect();
             Statement stmt = conn.createStatement()) {
            SQLException ex = assertThrows(SQLException.class, () -> stmt.executeQuery("SELECT * FROM sqlite_master"));
            assertTrue(ex.getMessage().contains("not a published virtual table"));
        }
    }

    @Test
    void unimplementedFeaturesThrowSqlFeatureNotSupportedRatherThanFakingSuccess() throws SQLException {
        try (Connection conn = connect()) {
            assertThrows(SQLException.class, conn::commit);
            assertThrows(java.sql.SQLFeatureNotSupportedException.class, () -> conn.prepareStatement("SELECT ?"));
        }
    }
}
