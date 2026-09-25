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
lastVerifiedAt: "2026-09-24"
relatedDocs: [storage-control-plane]
---

## Overview

A live SQL virtualization layer, inspired by Software AG's CONNX product family: connect a data source, publish it as a virtual schema, and query it in real time with standard SQL — without moving the data or replacing the source system. Open it from the Business Workspace's **Data Sources** and **SQL Console** tabs.

## What's real

- **Connector framework** — a pluggable connector interface (`isConfigured`, `testConnection`, `discoverMetadata`, `executeQuery`, `health`, `capabilities`), following the same pattern this codebase already uses for its storage pinning providers.
- **A real reference connector** — a relational connector built on Node's own `node:sqlite`, genuinely tested end-to-end: real connection, real metadata discovery (`sqlite_master`/`PRAGMA table_info`), real SQL execution (SELECT with WHERE/JOIN/GROUP BY/aggregates), real error handling.
- **Metadata & virtual schema engine** — real schema discovery, versioned publishing (a re-import never silently overwrites a prior published schema — each import is a new, explicit version).
- **SQL gateway** — parses real SQL with a real parser, authorizes every referenced table against what's actually been published, executes read-only queries, enforces row/timeout limits, and audits every query (executed, denied, or failed) to the same audit trail every other Inaya feature uses.
- **A real JDBC driver** (`jdbc-driver/`) — a genuine, compiled, tested `java.sql.Driver` implementation. Connect any JDBC-aware tool with `jdbc:inaya:http://your-host/<dataSourceId>` and an API key.
- **A real ODBC driver** (`odbc-driver/`) — a genuine, compiled Win32 DLL (`inayaodbc.dll`) exporting 28 standard ODBC entry points, built against the real ODBC SDK. Verified end-to-end (19/19 checks) by loading the compiled DLL directly and driving its real exported functions — connect, `SELECT`, catalog browsing, prepared statements, and the same fail-closed rejections as the JDBC driver. Registering it with the Windows ODBC Driver Manager (the step Excel/Power BI need) requires local administrator rights on the target machine — see `odbc-driver/README.md` and `register-driver.ps1`.
- **REST API** (`/api/public/v1/data-sources/**`) — the same transport both drivers use; usable directly from any HTTP client.

## What's not built

- **Adabas, VSAM, IMS, and RMS/OpenVMS connectors** — no real vendor environment exists to validate them against yet. Building a mock and calling it "compatible" would be dishonest, so none are implemented. RMS/OpenVMS and Adabas both have realistic, free/low-cost paths to a real test environment (VSI's OpenVMS community program; Software AG's Adabas & Natural Community Edition) and are the next planned connectors. VSAM and IMS require a genuine z/OS environment, which is a much larger undertaking — deferred further out.
- **Write-back (INSERT/UPDATE/DELETE)** — the gateway is read-only this pass, matching the phased rollout every real data-virtualization product follows.
- **Federated cross-source joins** — this pass supports single-source queries only. Joining across two different data sources in one query isn't built yet.
- **Power BI/Excel validation** — requires a real license and Driver-Manager registration (admin rights), neither available in this environment. See the completion report for exact status.

## Related

- [Storage Control Plane & Terraform Provider](/docs/products/storage-control-plane)
