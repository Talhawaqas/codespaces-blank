---
slug: identity-mapping
title: "Group and Attribute Mapping"
description: "How directory groups and attributes become Inaya departments, projects and roles, why privileged access is never granted from an arbitrary group, and how manual overrides are kept."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [it-admin, security-admin]
status: beta
version: current
tags: [mapping, groups, attributes, roles, departments, override]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-lifecycle, identity-scim]
---

## Group mapping

A mapping says: when a person is in the directory group **X**, they get these Inaya grants. Each grant is a department, a project, or a role: `member` or `admin` (workspace), and the module roles `financeRole`, `hrRole`, `supportRole`, `storageRole`, `escrowRole`, `complianceRole` (`viewer`, `staff`, `manager` as that module defines them). Departments and projects are referenced by name (`dept:Finance`, `project:Ledger`); a name that matches nothing is **reported as unresolved, never guessed**.

## Attribute mapping

The same, keyed on an attribute: `department`, `jobTitle`, `employeeType`, or any custom attribute your source sends (`attributes` object). Example: `department = Finance` → department Finance.

## Rules that cannot be configured away

- **Owner can never be granted** by a mapping or a default.
- **Admin is privileged.** A mapping that grants admin (or is flagged privileged) does not apply directly: it becomes a Controlled Action a human approves, after the standard delay. Ordinary groups cannot become privileged by accident.
- A mapping is versioned; changing it does not silently change anyone's access until the next event or reconciliation.
- A disabled person receives no grants from any mapping.

## Manual override

An owner or admin can grant or remove a department, project or role for a person with a **reason** (and optional expiry). It is recorded as `INAYA MANUAL OVERRIDE` and survives directory changes: the directory baseline and the override are shown side by side, each labelled by source, in Identity & Access → People. Removing access that comes from the directory has to happen in the directory or the mapping, because the next event would restore it; the response says so.

## Existing access

The first time the integration manages a member, their current access becomes `INAYA (existing)` grants. Nothing they already had is removed unless someone removes it.

## Defaults

Each provider has default grants for a joiner (default: role `member` only). Owner and admin cannot be defaults.
