# Control mapping: where Inaya's capabilities support NIST SP 800-53 Rev. 5 controls

This mapping is the curated default shipped in `src/lib/compliance/implementation.js` (`DEFAULTS`). It is a **starting point** a customer confirms or overrides, not an assessment. "Provider" means Inaya as the system provider; "shared" means the customer also has to act. Live facts come from `src/lib/compliance/collectors.js`.

| Control | Title | Default state | Responsibility | Capability and live facts |
|---|---|---|---|---|
| AC-2 | Account Management | partial | shared | roles, scoped administrator roles, auditor; facts: accounts, MFA |
| AC-3 | Access Enforcement | implemented | provider | every record scoped to its organization; governance only restricts |
| AC-4 | Information Flow Enforcement | partial | shared | sharing policy, data-loss rules |
| AC-5 | Separation of Duties | partial | shared | scoped administrator roles |
| AC-6 | Least Privilege | implemented | provider | document, department and project permissions |
| AC-7 | Unsuccessful Logon Attempts | partial | provider | rate limits |
| AC-12 | Session Termination | implemented | provider | expiring, revocable sessions |
| AC-16 | Security and Privacy Attributes | implemented | provider | classification labels, metadata |
| AC-17 | Remote Access | partial | shared | TLS everywhere; device inventory |
| AC-21 | Information Sharing | implemented | provider | secure sharing controls and access log |
| AU-2, AU-3, AU-12 | Event Logging, Content, Generation | implemented | provider | hash-chained audit trail; fact: audit chain |
| AU-9 | Protection of Audit Information | implemented | provider | tamper evidence by hash chaining |
| AU-10 | Non-repudiation | partial | provider | attribution through the chain; not a qualified signature |
| AU-6, AU-11 | Review, Retention | partial | shared | export and retention are the customer's decisions |
| CA-5, CA-7 | POA&M, Continuous Monitoring | partial | shared | findings workflow; signals |
| CM-8, CM-12 | Component Inventory, Information Location | partial | shared | component inventory in the package; residency policy |
| CP-2, CP-4, CP-6, CP-9, CP-10 | Contingency | partial / implemented | shared | recovery tests, replicas, backups; facts: resilience, replication, backup |
| IA-2, IA-5, IA-8, IA-9 | Authentication | partial / implemented | shared / provider | MFA, one-time links, signed gateway requests; fact: MFA |
| IR-4, IR-5, IR-6 | Incident handling | partial | shared | incident records, signals |
| MP-6 | Media Sanitization | partial | shared | crypto-shredding by key destruction; physical media inherited |
| SC-8 | Transmission Confidentiality and Integrity | implemented | shared | TLS with HSTS |
| SC-12 | Key Establishment and Management | partial | shared | platform keys; customer-managed keys behind a flag |
| SC-13 | Cryptographic Protection | partial | provider | strong algorithms; **not FIPS validated** |
| SC-28 | Protection of Information at Rest | implemented | shared | client-side or envelope encryption; disk encryption inherited |
| SI-4, SI-7 | Monitoring, Integrity | partial / implemented | shared / provider | signals, data-loss decisions, hashes and chain |
| PE-* , MA-* | Physical, Maintenance | inherited | inherited | hosting and storage providers; obtain their attestations |

All other base controls start as **not assessed** (customer or shared by family: AT, PS, PM, PL, RA customer; CA, SR, SA shared). They are listed in the product so nothing is silently out of scope.

## Reading a state

* *Implemented / partially implemented* says what the capability does today; it is not an effectiveness conclusion.
* *Evidence available* means evidence is attached or a live fact shows the condition holds.
* *Inherited* needs the provider's attestation attached as evidence; without it the control shows *evidence required*.
