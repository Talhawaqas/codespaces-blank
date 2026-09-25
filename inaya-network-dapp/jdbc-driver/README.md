# inaya-jdbc-driver

A real JDBC 4.2 driver for Inaya's SQL virtualization gateway (Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW). It talks to the live `/api/public/v1/data-sources/{id}/{query,metadata,health}` REST routes over HTTP/HTTPS with an org API key.

## Status

Built and tested for real — not a stub. `mvn test` runs a genuine integration test suite (`InayaDriverIntegrationTest`) against a real running Inaya dev server: real connection, real `SELECT`/`JOIN`/aggregate query execution, real `ResultSetMetaData`, real `DatabaseMetaData.getTables()`/`getColumns()`, and real rejection of write operations and unpublished-table queries. The shaded jar (`mvn package`) was verified standalone — zero other classpath dependencies — against a live server.

## Installation

```bash
mvn package
```

Produces `target/inaya-jdbc-driver-0.1.0.jar` (shaded — includes `org.json`, no other runtime dependency). Drop it on your classpath; `META-INF/services/java.sql.Driver` registers it automatically.

## Connecting

```java
Properties props = new Properties();
props.setProperty("apiKey", System.getenv("INAYA_API_KEY"));
Connection conn = DriverManager.getConnection(
    "jdbc:inaya:http://localhost:3000/<dataSourceId>", props);
```

URL format: `jdbc:inaya:<http-or-https-url-to-your-Inaya-deployment>/<dataSourceId>`. The API key goes in connection `Properties`, never the URL string — so it can't end up logged in a connection-string history.

## Scope — stated honestly

This driver is genuinely narrow, matching the SQL gateway's own phase-gating (write-back and transactions are not enabled this pass, see the SOW's Section 17):

| Real and tested | Not implemented (throws `SQLFeatureNotSupportedException`) |
|---|---|
| `Statement.executeQuery(String)` | `PreparedStatement` (no parameter binding in the gateway yet) |
| `ResultSet.next()`/typed getters (`getString`/`getInt`/`getLong`/`getDouble`/`getBoolean`/`getObject`) by index or column name | Scrollable/updatable `ResultSet`, `getDate`/`getTimestamp`/`getBytes`/`getArray`/`getBlob`/`getClob` |
| `ResultSetMetaData` (column names/count — real; column SQL types report as VARCHAR, a documented limitation, see below) | Real per-column type reporting (the query response doesn't yet carry declared column types, only names) |
| `DatabaseMetaData.getTables()`/`getColumns()` (real, calls the metadata endpoint) | The other ~200 `DatabaseMetaData` methods |
| `Connection.isValid()` (real, calls the health endpoint) | `commit()`/`rollback()`/`setAutoCommit(false)` (no transactions) |
| Query row limits (`Statement.setMaxRows`) and timeout (`setQueryTimeout`) | Query cancellation (`Statement.cancel()`) |

Every unimplemented method throws `SQLFeatureNotSupportedException` naming the method — never a silently-ignored no-op or a fabricated return value, matching this whole SOW's own "no fake compatibility" discipline.

## A real bug this driver's own testing found and fixed

`java.net.http.HttpClient` defaults to attempting an HTTP/2 `h2c` upgrade on a plain `http://` URL. Inaya's Next.js dev server crashes handling that upgrade request (`Error handling upgrade request TypeError: Cannot read properties of undefined (reading 'bind')` in the dev server's own logs) — every network call failed with a cryptic `HTTP/1.1 header parser received no bytes` until `HttpClient.Version.HTTP_1_1` was forced explicitly in `InayaHttpClient`. A second real bug: `ResultSetMetaData`/`ResultSet` column order was initially inferred from JSON object key iteration order, which the JSON spec never actually guarantees — fixed by having the gateway (`sqlGateway.js`) emit an explicit, ordered `columns` array instead of leaving the driver to infer order from row keys.

## Running the integration test yourself

```bash
mvn test -Dinaya.test.dataSourceId=<a real, registered relational data source id> -Dinaya.test.apiKey=<a real org API key>
```

Skipped (not silently passed) if those two system properties aren't set.
