---
slug: identity-msp
title: "MSP Multi-Tenancy"
description: "How a managed service provider manages customer organizations through Inaya identity automation without ever crossing tenant boundaries, with delegated technician roles."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [msp, it-admin, security-admin]
status: beta
version: current
tags: [msp, multi-tenant, delegation, isolation]
lastVerifiedAt: "2026-09-26"
relatedDocs: [identity-integration, identity-rewst, identity-security]
---

## The link

An MSP is an Inaya organization. A customer links to it in two steps, and both sides must act:

1. The **customer** (owner/admin) creates an invite code in Identity & Access → MSP. It is shown once, valid for 7 days, single-use.
2. The **MSP** (owner/admin) accepts it. Only then can the MSP reach that customer.

Either side can end the link. Ending it cuts every MSP path immediately, because links are checked on every request.

## Reaching a customer

| Who | How | Limits |
|---|---|---|
| MSP credential (`idc_…`, kind msp) | Names the customer in `X-Inaya-Organization`. | Only customers with an active link **and** listed on the credential (or `*`). Anything else is refused and audited. |
| MSP technician (signed in) | Uses the customer's organization id in the console/API. | Delegated role, re-verified on every request: link active, technician still an active member of the MSP, assignment still covers this customer. |
| Customer's own admin | Normal. | Their organization only. |

## Delegated roles

| Role | Can |
|---|---|
| MSP Super Admin | Everything, across all linked customers. |
| MSP Customer Admin | Read, audit, provision, revoke, reconcile, manage mappings for assigned customers. |
| MSP Automation Operator | Read, audit, provision, revoke, reconcile. Not mappings. |
| MSP Read-only Auditor | Read and audit. |

Whatever the role, MSP staff and credentials **cannot** create credentials, providers, MSP links or access reviews inside a customer, and cannot restore a revoked person; those need the customer's own signed-in owner or admin.

## Isolation guarantees (tested)

An MSP credential cannot read or change an unlinked customer; a customer cannot see another customer or the MSP's other customers; a forged or reused invite code fails; a read-only auditor cannot revoke; ending the link stops access at once; an organization credential cannot be pointed at another organization. Every cross-tenant attempt is written to the audit trail.
