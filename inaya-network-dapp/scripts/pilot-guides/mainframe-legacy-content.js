// Mainframe & Legacy Data Access Virtualization -- Enterprise Pilot
// Onboarding Guide. Plain-language, step-by-step instructions for a pilot
// client's IT/ops team to connect a legacy or relational data source to
// Inaya and query it live with standard SQL, JDBC, ODBC, or the REST API.
// Every claim here matches the real, tested behavior in
// docs/mainframe-legacy-data-access-report.md -- including the two
// disclosed open limitations (ODBC query execution via the Windows Driver
// Manager, and Power BI/Excel validation) -- rather than a rosier,
// untested version of events.

export const mainframeLegacyGuide = {
  cover: {
    company: "INAYA NETWORK",
    classification: "ENTERPRISE PILOT ONBOARDING GUIDE",
    kicker: "MAINFRAME & LEGACY DATA ACCESS VIRTUALIZATION",
    title: "Query Your Legacy and Mainframe Data Live, with Standard SQL",
    subtitle: "A step-by-step guide for pilot IT/ops teams: connect a data source, publish it as a virtual schema, and query it in real time through Inaya's REST API, real JDBC driver, or real ODBC driver -- without moving the data or replacing the source system.",
    docLine: "Pilot Guide - Mainframe & Legacy Data Access Virtualization - October 2026",
  },
  docId: "INAYA-PILOT-MAINFRAME-2026",
  sections: [
    {
      number: "01",
      title: "What This Gives You",
      blocks: [
        {
          type: "lead",
          text: "Inaya's Live Data Gateway connects to a data source, discovers its real schema, and lets you publish selected tables as a versioned virtual schema -- then query that virtual schema in real time with standard SQL, through Inaya's REST API, a real compiled JDBC driver, or a real compiled ODBC driver. Your source data is never copied or moved: every query reads live from the source through the gateway. This is a read-only gateway in this release -- write-back and joins across multiple sources are phase-gated for a later release, not yet enabled.",
        },
        {
          type: "table",
          headers: ["Connector", "Status this pilot"],
          rows: [
            ["Relational reference connector (SQL databases)", "Live -- real connection, real metadata discovery, real SQL execution"],
            ["RMS / OpenVMS", "Live -- proven against a genuine VSI OpenVMS x86-64 instance over SSH + DCL. Text-organized sequential files are read today; fixed-format binary and indexed files need a compiled OpenVMS-side reader, not yet built"],
            ["Adabas", "Not yet available -- a real Adabas & Natural Community Edition test environment is running, but the connector itself isn't written yet"],
            ["VSAM / IMS", "Not yet available -- both require a genuine z/OS environment and are deferred as a future feature, not attempted with a fake stand-in"],
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Step 1 - Register Your Data Source",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1. Sign in to Business Workspace.", body: "Open the \"Data Sources\" panel from the left navigation." },
            { heading: "2. Click \"+ Add Data Source.\"", body: "Choose your connector type and enter its real connection details -- credentials are encrypted at rest, never shown back in plain text, and never exposed to query clients." },
            { heading: "3. Test the connection.", body: "A real connection attempt against your actual source, not a format check -- a bad credential or unreachable host fails here, before anything is published." },
            { heading: "4. Discover metadata.", body: "Inaya reads your source's real schema (for RMS/OpenVMS, this parses the source's own FDL output directly, not an invented schema) and shows you what it found." },
            { heading: "5. Publish a virtual schema.", body: "Choose which tables to expose. Only published tables can ever be queried -- an unpublished or unauthorized table fails closed with a real 403, never a silent partial result. Re-publishing never silently overwrites a previous version." },
            { heading: "6. Apply permissions.", body: "Scope which members or API keys can query this data source, same organization/permission model as every other Inaya feature." },
          ],
        },
      ],
    },
    {
      number: "03",
      title: "Step 2 - Query via the REST API",
      blocks: [
        {
          type: "lead",
          text: "The fastest path to a working pilot: any script or application that can make an HTTPS call can query your virtual schema directly.",
        },
        {
          type: "code",
          label: "Terminal -- using curl",
          text: "curl -X POST https://<your-inaya-host>/api/public/v1/data-sources/<dataSourceId>/query \\\n  -H \"Authorization: Bearer <your API key>\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"sql\": \"SELECT * FROM customers WHERE region = '\\''EAST'\\'' LIMIT 50\", \"maxRows\": 50}'",
        },
        {
          type: "bullets",
          items: [
            "Every query is parsed with a real SQL parser, authorized against exactly what's been published, and executed with row and timeout limits you control.",
            "Every query -- succeeded, denied, or failed -- is written to the same audit trail every other Inaya feature uses, so you have a complete record for compliance review.",
            "/api/public/v1/data-sources/<id>/metadata and /health are also available, for schema discovery and connector health from your own tooling.",
          ],
        },
      ],
    },
    {
      number: "04",
      title: "Step 3 - Query via the Real JDBC Driver (Java Applications)",
      blocks: [
        {
          type: "lead",
          text: "A genuine, compiled java.sql.Driver implementation -- not a thin HTTP wrapper pretending to be JDBC. It's a real Driver your existing Java application, reporting tool, or ETL pipeline can load like any other database driver.",
        },
        {
          type: "code",
          label: "Java -- standard JDBC usage",
          text: "Class.forName(\"com.inaya.jdbc.InayaDriver\");\nConnection conn = DriverManager.getConnection(\n  \"jdbc:inaya://<your-inaya-host>/<dataSourceId>\",\n  \"<your API key>\", \"\"\n);\nResultSet rs = conn.createStatement().executeQuery(\"SELECT * FROM customers\");",
        },
        {
          type: "note",
          text: "Tested end-to-end, including a standalone-jar smoke test with zero other classpath dependencies: 7/7 integration tests passing against a live server, covering connection, query execution, and result-set metadata column ordering.",
        },
      ],
    },
    {
      number: "05",
      title: "Step 4 - Connect via the Real ODBC Driver (Windows)",
      blocks: [
        {
          type: "lead",
          text: "A genuine compiled Win32 DLL exporting the standard ODBC entry points, built against the real ODBC SDK -- the same kind of driver Excel, Power BI, and any other ODBC-aware Windows application expect.",
        },
        {
          type: "numbered",
          items: [
            { heading: "1. Run register-driver.ps1 as Administrator.", body: "Registers the driver with the Windows ODBC Driver Manager and configures a DSN pointing at your Inaya data source." },
            { heading: "2. Confirm the connection.", body: "The script opens a real System.Data.Odbc.OdbcConnection and confirms it reports a real server version -- registration and connection through the real Windows Driver Manager are proven working." },
          ],
        },
        {
          type: "note",
          label: "One honest, still-open limitation.",
          text: "Registration and connection through the Windows ODBC Driver Manager work today. Running an actual query through that same Driver-Manager-mediated path currently crashes -- we isolated this, with a debugger and the Windows Event Log, to a fault inside Microsoft's own odbc32.dll at a fixed offset, not inside this driver, not in .NET, and not in this project's server. Until this is resolved, use the direct REST API or JDBC paths above for pilot query workloads on Windows; we'll update you the moment Driver-Manager query execution is confirmed fixed.",
        },
      ],
    },
    {
      number: "06",
      title: "What's Tested, and What's Not Yet",
      blocks: [
        {
          type: "bullets",
          items: [
            "Connector framework, metadata discovery, versioned schema publishing, and the SQL gateway (parse/authorize/execute/audit): 11 automated tests against real MongoDB and real SQLite fixtures, including a real JOIN+aggregate query, fail-closed authorization, and permission denial.",
            "RMS/OpenVMS connector: 7/7 automated tests against a genuine VSI OpenVMS x86-64 instance -- real connect, real auth-failure detection, real FDL-derived metadata, real record reads for text-organized sequential files.",
            "JDBC driver: 7/7 integration tests against a live server, including two real bugs found and fixed during testing (an HTTP/2 upgrade crash in the dev server, and a result-set column-ordering bug).",
            "ODBC driver: 19/19 direct-load tests against a live server, plus real Driver-Manager registration and connection (five real driver/infrastructure bugs found and fixed to get there) -- query execution via that path is the one still-open item, disclosed above.",
          ],
        },
        {
          type: "note",
          label: "Not yet available this pilot.",
          text: "Adabas, VSAM and IMS connectors are not yet built (Adabas's test environment is ready; VSAM/IMS need a genuine z/OS environment and are a deferred future feature). Write-back (INSERT/UPDATE/DELETE) and federated cross-source joins are explicitly phase-gated for a later release -- this pilot is read-only, single-source-per-query. Power BI and Excel validation needs a licensed install and an admin-registered ODBC driver on your own machine; we have not yet run that validation ourselves and will do so together with your pilot team rather than claim it in advance.",
        },
      ],
    },
    {
      number: "07",
      title: "Getting Help",
      blocks: [
        {
          type: "lead",
          text: "During the pilot, route connection issues or questions about scope/permissions to your assigned Inaya technical contact rather than general support -- pilot feedback shapes the general-availability release, including the ODBC Driver-Manager query-execution fix above.",
        },
      ],
    },
  ],
};
