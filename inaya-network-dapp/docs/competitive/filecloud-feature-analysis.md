# FileCloud-inspired capabilities: where Inaya stands

Scope: the FileCloud-inspired parts of the Competitive Expansion SOW (enterprise governance, sovereignty, Office integration, network folders, data rooms, high availability, compliance readiness). Based on the SOW's own description and Inaya's implementation ledger. **Vendor features were not independently re-verified for this document**; statuses are Inaya's. Inaya does not become a monolithic customer-hosted clone: sovereignty is delivered by an outbound-only gateway agent.

## Capability comparison

| Capability | Inaya implementation | Status | Honest difference |
|---|---|---|---|
| Governance policies | versioned, immutable after publication, restrictions only | VERIFIED | one policy model; extends the existing policy engine |
| Metadata and classification | typed metadata fields; rule engine with confidence and history | VERIFIED (engine); history and client-side path IMPLEMENTED_NOT_LIVE / PARTIAL | content of client-side encrypted files cannot be read by the server; a browser or customer scanner can report |
| Data loss prevention | allow, deny, approval, stronger-auth refusal, log-only, quarantine decisions, events, wired to shares, downloads, uploads, S3/Azure | evaluator and events VERIFIED; wiring IMPLEMENTED_NOT_LIVE; some actions PARTIAL | "require stronger authentication" is enforced as a refusal today |
| Upload governance and antivirus | type, size, archive and bomb checks; adapter for an antivirus engine | IMPLEMENTED_NOT_LIVE / PARTIAL | no antivirus engine is configured on the deployment |
| Secure viewer (DRM-style) | view-only, watermark, session expiry, revocation, version pin | VERIFIED | a browser cannot prevent a screenshot or photograph; the product says so |
| Data rooms | templates, NDA gate, per-section permissions, watermark, final-version pin, bulk, visitor log | VERIFIED / IMPLEMENTED_NOT_LIVE | |
| Customer portal and file requests | upload, download, secure forms, hashed agreements, status, history | VERIFIED | uploads are up to 4 MB per request here; larger files use ticket attachments |
| Ransomware protection | cloud-file signals, containment, rollback plan | PARTIAL | heuristics, not proof; sees only what reaches Inaya |
| Endpoint backup | profiles, health, integrity, restore | PARTIAL | desktop client not yet wired |
| Self-hosted and hybrid | **Sovereign Gateway** agent, deployment modes 1 to 3, mode 4 recorded only | agent VERIFIED; connectors PARTIAL | no air-gapped operation; SMB and NFS rely on OS mounts |
| Network folders and NTFS/AD permissions | real NTFS ACL reading, deny semantics enforced (even for owners), mapping health | PARTIAL | no live LDAP/Active Directory source; permissions per approved folder, not per file |
| Microsoft Office integration | controlled edit sessions (lock, short-lived token, version verification); no file content to Microsoft | PARTIAL | desktop client not wired; nothing run against a live tenant |
| Outlook integration | secure-link add-in, policy-enforced links, inspector | IMPLEMENTED_NOT_LIVE | never loaded in a real Outlook; attachment conversion is manual |
| High availability and site replication | active-passive profile, measured lag and RPO exposure, recovery tests, readiness blockers, evidence | PARTIAL | **no active-active**; failover is a manual procedure; recovery-test time is sample-only |
| FedRAMP-inspired readiness | NIST 800-53 internal catalog, OSCAL-shaped export, government profile, FIPS-ready abstraction | VERIFIED / PARTIAL | **no authorization or certification**; cryptography is not FIPS validated (see `fedramp-readiness-boundary.md`) |
| Customer-managed keys | local and AWS KMS providers for server-managed storage | PARTIAL | KMS tested against a stand-in, not a live account; destroying the key destroys the data |
| Branding and white label | logo, accent, legal text, support URL on public pages and e-mail; custom domain challenge | PARTIAL | custom domain routing is NOT_CONFIGURED |
| Role-based administration, dashboard | additive scoped roles; honest NO DATA dashboard | VERIFIED | |
| Webhooks and API | signed registry with rotation, retries, dead letter; API families, SDK, CLI | VERIFIED / PARTIAL | chat, contacts and notes are not exposed over API keys (end-to-end encrypted) |

## Not claimed

Active-active clustering, a validated cryptographic module, a government authorization, internet-independent operation, per-file permission mapping, or that any feature works against a live Microsoft 365 tenant. Where a feature needs the customer to operate something (the gateway machine, their key service, their authorizing body), the product says so.
