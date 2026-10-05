# Shared responsibility model

Inaya provides capabilities and evidence. The customer is responsible for how they are used and for everything outside the system boundary. Three parties are involved: **Inaya** (the provider of the application), **hosting and storage providers** (the application host, the operational database, content-addressed storage providers, optionally the customer's own key service), and **the customer** (including their people, devices and networks).

| Area | Inaya | Hosting and storage providers | Customer |
|---|---|---|---|
| Application security (access enforcement, tenant isolation, audit chain) | provides and tests | | configures roles and policies; reviews audit |
| Encryption of workspace documents, chats, notes | client-side by design; the platform cannot read them | stores ciphertext | holds keys (passkeys, passphrases); manages devices |
| Server-managed encryption (S3/Azure layer) | envelope encryption | | optionally holds the key in their own key service; owns destruction consequences |
| Physical and environmental protection | | **inherited**: data centers, power, media | obtain their attestations |
| Network and platform hardening, disk encryption of databases | | **inherited** | |
| Identity | sign-in links, MFA, scoped roles | | enforces MFA, joiner/mover/leaver process |
| Backups and replicas | scheduling, verification, replication measurements | provide storage | set targets, run recovery tests, operate failover |
| Customer gateways | agent, enrollment, audit forwarding | | operate the machine, protect the key and passphrase, approve folders |
| Data classification and sharing rules | engines | | define labels, policies and approvals |
| Vulnerability management | patches the application's dependencies | patch their platforms | scans and patches their own systems and devices; vulnerability results are **not collected** by Inaya |
| Incident response | provides signals and records | their own incident processes | handles incidents; reports to authorities |
| Personnel security, training, risk assessment, authorization | | | **customer** |
| Assessments and authorizations (FedRAMP, ATO, ISO, SOC) | provides evidence | provide theirs | commission and obtain them |

## Where this appears in the product

* Every control shows a **responsibility** (provider, customer, shared, inherited).
* The evidence package carries a customer-responsibility statement and lists inherited components.
* The government profile never marks a control complete on the customer's behalf.

## Practical rule

If a control is marked *inherited*, attach the provider's attestation. If it is marked *customer*, name an owner. If it is *shared*, write down the customer's half in the control statement.
