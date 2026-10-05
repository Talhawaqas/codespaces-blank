# FedRAMP-high-inspired readiness: the boundary

**Inaya is not FedRAMP authorized, certified or "FedRAMP High".** Nothing in the product or in these documents says otherwise, and no feature, label or state implies it. Authorization decisions belong to the relevant agency and its assessors. This page separates what the product provides from what only an external process can grant.

## What the product provides (technical readiness)

| Area | Provided | Where |
|---|---|---|
| Control tracking | NIST SP 800-53 Rev. 5 base-control internal catalog with implementation state, responsibility, owner, evidence and time-limited exceptions | `docs/compliance/readiness-and-evidence.md` |
| Evidence | OSCAL-shaped evidence package with SHA-256; live facts; audit-chain verification | same |
| Government profile | Declared technical-readiness states with live checks; enhanced access records; government data labels | `docs/architecture/government-security-profile.md` |
| Cryptography | FIPS-ready provider abstraction, approved-algorithm policy, published-vector self-tests, inventories | `src/lib/crypto/policy.js` |
| Key management | Customer-managed keys for server-managed storage, rotation, audit | `docs/architecture/customer-managed-keys.md` |
| Resilience | Replication measurements, recovery tests, failover readiness blockers | `docs/architecture/site-replication.md` |
| Sovereignty | Customer gateway, deployment modes | `docs/architecture/sovereign-gateway.md` |

## What the product does NOT provide

* An authorization to operate, a FedRAMP package, a third-party assessment (3PAO) or any assessor's report.
* **FIPS 140-3 validated cryptography.** The libraries in use are strong but are not validated modules; `FIPS_READY` is reachable only when the runtime reports FIPS mode and the operator records a validation reference Inaya does not verify.
* A government-cloud deployment, personnel screening, physical and environmental controls (inherited from hosting and storage providers), continuous-monitoring submissions, vulnerability scanning results (not collected), or incident reporting to a government authority.
* A complete NIST catalog: base controls only, no enhancements, no FedRAMP baseline parameters.
* An **active-active** architecture, or a measured full-site recovery time.

## How the words are used

* "Ready", "readiness" and "technical profile" describe capabilities and checks that currently hold. They never mean authorized.
* "Customer-specific authorization" is a field where the customer records an authorization **they** hold or pursue. Inaya stores it and does not verify it.
* "Evidence available" means evidence is attached or live facts support the control. It does not mean the control was assessed as effective.

## What a customer still has to do

Define their authorization boundary, select and tailor a baseline, assign control owners, write the plans and procedures, collect and review evidence (including the hosting and storage providers' own attestations), run assessments, and obtain the authorization decision from their authorizing body. See `docs/compliance/responsibility-model.md`.
