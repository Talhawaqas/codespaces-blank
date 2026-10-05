# Compliance readiness and evidence

Code: `src/lib/compliance/` (catalog, implementation, collectors, governmentProfile, oscal), `src/lib/crypto/policy.js`, screen **Compliance Readiness**, route `/api/orgs/compliance/*`. Behind `FEATURE_COMPLIANCE_READINESS`.

## What this is, and is not

It helps an organization **track** how controls are implemented, who owns them and what evidence supports them, and export that as machine-readable evidence. **It is not an assessment, a certification, an authorization or a statement that anyone is compliant.** FedRAMP, FISMA and similar authorizations are granted by the relevant bodies, not by software.

## Control catalog

`NIST_800_53_R5` is a versioned **internal, curated** catalog of NIST SP 800-53 Rev. 5 **base** controls across the 19 families (IDs and titles follow NIST; descriptions are our own short paraphrases). It has no enhancements, no FedRAMP parameter values and omits withdrawn controls. It is registered with the existing Regulatory Framework Engine, so controls, evidence and exceptions use the same workspace as the other frameworks.

## Control status

For every control a team records:

* **Implementation**: implemented, partially implemented, not implemented, inherited, not applicable, or **not assessed** (the honest start).
* **Responsibility**: provider, customer, shared, inherited.
* **Owner**: a named active member.
* **Evidence state** (computed, never typed): *available* when approved, unexpired Evidence Vault items, fresh snapshots (90 days) or valid links are attached, or a live fact shows the condition holds; *required* when the control is implemented but nothing supports it; *none* otherwise.
* **Exception**: needs a reason, a compensating measure and an expiry within one year. It is never permanent; an expired one is flagged and counted.

Where Inaya itself provides a capability, a curated **default** says so (and which live facts support it), labelled "default, not yet confirmed by your team" until someone confirms or overrides it. Physical and maintenance controls default to *inherited* from the hosting and storage providers, whose own attestations must be obtained.

## Live facts (collectors)

Metadata only: audit-chain verification, accounts and roles, MFA enrollment, encryption inventory, backups, recovery tests, replication, governance policies, devices, security signals, gateways, data residency. A collector with nothing to observe reports **no data**; it never reports a pass it did not see.

## Evidence package

`GET .../package` returns one JSON file: an **OSCAL-shaped** system security plan (OSCAL 1.1.x field names; stable identifiers; every control with origination, status and evidence links), plus system description, component inventory, control status, evidence references, policy versions, audit-chain verification, configuration snapshots, deployment profile, data-flow description, identity integrations, vulnerability status (**not collected**), incidents and signals, resilience results, data residency, encryption and key-management modes, cryptography, and a customer-responsibility statement. It carries a SHA-256 and a structural self-check. It is **not validated against the official OSCAL schema**.

## Cryptography (FIPS-ready, not FIPS-validated)

`policy.js` provides a provider registry, an algorithm policy (NIST-approved set; `fips_ready` mode refuses the rest), known-answer self-tests with published vectors run against **two independent implementations** (Node's OpenSSL and the noble libraries), pairwise-consistency checks, a usage inventory and a dependency inventory. **No provider is marked validated.** Status reaches `FIPS_READY` only when the runtime reports FIPS mode **and** the operator records a validation reference; Inaya does not verify that reference. The noble libraries are not validated cryptographic modules; a validated provider can be registered later without rewriting callers.

## Shared responsibility

Inaya provides capabilities and evidence. The customer is responsible for policies, personnel controls, risk assessment, configuration choices, reviewing evidence and any authorization decision. Physical, environmental and platform controls are inherited from the hosting and storage providers.
