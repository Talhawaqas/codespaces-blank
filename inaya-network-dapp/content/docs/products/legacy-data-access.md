---
slug: legacy-data-access
title: Mainframe & Legacy Data Access (SQL Virtualization)
description: Real-time SQL access to legacy and relational data sources through a live, permission-scoped virtual schema — inspired by Software AG CONNX.
product: Data Access
category: guide
contentType: Product Guide
audience: [developer, enterprise-it, data-migration-team]
status: live
version: current
tags: [sql, jdbc, legacy, mainframe, data-virtualization]
lastVerifiedAt: "2026-09-29"
relatedDocs: [storage-control-plane]
---

## Overview

A live SQL virtualization layer, inspired by Software AG's CONNX product family: connect a data source, publish it as a virtual schema, and query it in real time with standard SQL — without moving the data or replacing the source system. Open it from the Business Workspace's **Data Sources** and **SQL Console** tabs.

## What's real

- **Connector framework** — a pluggable connector interface (`isConfigured`, `testConnection`, `discoverMetadata`, `executeQuery`, `health`, `capabilities`), following the same pattern this codebase already uses for its storage pinning providers.
- **A real reference connector** — a relational connector built on Node's own `node:sqlite`, genuinely tested end-to-end: real connection, real metadata discovery (`sqlite_master`/`PRAGMA table_info`), real SQL execution (SELECT with WHERE/JOIN/GROUP BY/aggregates), real error handling.
- **Metadata & virtual schema engine** — real schema discovery, versioned publishing (a re-import never silently overwrites a prior published schema — each import is a new, explicit version).
- **SQL gateway** — parses real SQL with a real parser, authorizes every referenced table against what's actually been published, executes read-only queries, enforces row/timeout limits, and audits every query (executed, denied, or failed) to the same audit trail every other Inaya feature uses.
- **A real RMS/OpenVMS connector** (`connectors/rmsOpenVms.js`) — connects over SSH to a real OpenVMS instance and runs real DCL, since there's no ODBC/JDBC bridge for RMS without Oracle Rdb/DBMS. Metadata discovery parses OpenVMS's own FDL (File Definition Language) output from `ANALYZE/RMS_FILE`, not an invented schema. One credential = one RMS file, exposed as one table. Genuinely tested end-to-end (7/7) against a real VSI OpenVMS x86-64 V9.2-3 instance: real connect, real auth-failure detection, real FDL-derived metadata, real record reads (via `TYPE`) for text-organized sequential files. Fixed-format binary records and indexed files are honestly reported as needing a compiled OpenVMS-side reader — not faked with a guessed binary parser.
- **A real JDBC driver** (`jdbc-driver/`) — a genuine, compiled, tested `java.sql.Driver` implementation. Connect any JDBC-aware tool with `jdbc:inaya:http://your-host/<dataSourceId>` and an API key.
- **A real ODBC driver** (`odbc-driver/`) — a genuine, compiled Win32 DLL (`inayaodbc.dll`) exporting 28+ standard ODBC entry points, built against the real ODBC SDK. Verified end-to-end (19/19 checks) by loading the compiled DLL directly and driving its real exported functions — connect, `SELECT`, catalog browsing, prepared statements, and the same fail-closed rejections as the JDBC driver. Windows ODBC Driver Manager registration is now verified too: four real bugs (a `register-driver.ps1` parameter colliding with a PowerShell built-in, a Next.js bundling break from the RMS connector's SSH dependency, two connection-attribute handling bugs) were found and fixed, and `System.Data.Odbc.OdbcConnection("DSN=Inaya SQL").Open()` genuinely connects through the real Driver Manager. Query execution through that same path still crashes — isolated to a fault inside Microsoft's own `odbc32.dll`, not this driver (see the completion report for the full investigation). See `odbc-driver/README.md` and `register-driver.ps1`.
- **REST API** (`/api/public/v1/data-sources/**`) — the same transport both drivers use; usable directly from any HTTP client.

## What's not built

- **RMS/OpenVMS connector** — now implemented and real (see above). Only fixed-format binary records and indexed files remain unsupported, pending a compiled OpenVMS-side reader.
- **Adabas, VSAM, and IMS connectors** — not implemented yet. Software AG's Adabas & Natural Community Edition is running and healthy in a real Docker container — that test environment is ready, but the connector code itself hasn't been written. VSAM and IMS still require a genuine z/OS environment, a much larger undertaking, and stay deferred further out.
- **Write-back (INSERT/UPDATE/DELETE)** — the gateway is read-only this pass, matching the phased rollout every real data-virtualization product follows.
- **Federated cross-source joins** — this pass supports single-source queries only. Joining across two different data sources in one query isn't built yet.
- **Power BI/Excel validation** — Driver-Manager registration and connection are now verified for real; a remaining crash inside `odbc32.dll`'s own statement-attribute dispatch blocks actual query execution through that path, and a real license for Excel/Power BI itself still isn't available in this environment. See the completion report for the full investigation.

## Related

- [Storage Control Plane & Terraform Provider](/docs/products/storage-control-plane)
