# Confidentiality & Trade Secret Framework

This is a usable internal policy, not a draft — it can be adopted as-is, though a lawyer's review is still recommended before treating it as the basis for any legal action (e.g., against a departing employee who takes confidential material).

## 1. What Counts as Confidential — By Category

Rather than a single blanket rule, information is classified because different categories need different handling.

### 1.1 Trade Secret Tier (highest sensitivity — never disclosed outside the company without NDA + need-to-know)

- **Encryption key derivation and custody logic** — the exact key-derivation parameters, passphrase-handling flow, and sharding/dispersal algorithm in the custody SDK. The *existence* of client-side AES-256 encryption is public (it's a marketed feature); the *exact implementation details* that would help someone attack it are not.
- **Security Layer detection logic** — the specific signals, thresholds, and scoring the threat-detection/reputation system uses. Publishing exact detection rules makes them trivial to evade.
- **Credential/secret encryption keys and their storage locations** — every `*_ENCRYPTION_KEY` environment variable convention used across the codebase (integration credentials, backup credentials, etc.) and the specific key-per-secret-class discipline the codebase follows. The pattern can be discussed abstractly; actual key material must never appear in a repository, a document, a chat log, or a ticket.
- **Unreleased feature source code** — anything merged but not yet publicly announced or shipped.
- **Infrastructure topology and credentials** — database connection details, cloud provider account structure, node operator agreements not yet public.

### 1.2 Confidential Business Tier (internal use, disclosed under NDA when necessary)

- Business plans, fundraising terms, cap table, investor communications not yet public.
- Customer/user data and any specific customer names or deal terms not already public.
- Internal roadmap items marked "planned" or "future" that haven't been publicly announced (compare against what's already public in the live roadmap pages before treating something as confidential — no point protecting what's already shipped and disclosed).
- Audit findings, security review results, and any identified-but-unpatched vulnerability, until it is fixed and (if applicable) responsibly disclosed.

### 1.3 Already Public (not confidential — don't over-classify)

- Anything already merged into the public GitHub repositories.
- Anything already described in a published PDF, the live website, or the public roadmap.
- General architectural descriptions already published in the ecosystem documentation (e.g., "Inaya uses client-side AES-256 encryption and binary sharding" — the concept is marketed; only the exact implementation detail is protected).

## 2. Marking Convention

- **Documents:** any document containing Tier 1.1 or 1.2 material should carry a header: `CONFIDENTIAL — [INAYA LEGAL ENTITY NAME] — Internal Use Only`. The existing fundraising PDFs already use a `classification` field in their cover metadata (see `scripts/fundraising-docs/content/*.js`'s `cover.classification`) — extend that same convention to internal-only documents rather than inventing a new one.
- **Code comments:** do not write secret *values* into code comments, ever — this codebase's own established discipline (seen throughout, e.g. every encryption key is read from an environment variable, never hardcoded) should be treated as a hard rule, not a preference.
- **Repository access:** private repositories only for anything touching Tier 1.1 material; the currently-public packages (`@inaya-network/react`, `inaya-cli`, `create-inaya-dapp`, `@inaya-network/custody-sdk`) are a deliberate, already-made decision to open-source SDK/tooling — that decision doesn't extend automatically to the core platform monorepo, which should remain private unless a specific, separate decision is made to open parts of it.

## 3. Access Control Baseline

- Principle: **need-to-know**, not "everyone on the team gets everything."
- New contributors get repository access scoped to what their actual work requires, not blanket access to every repository.
- Anyone with access to Tier 1.1 material must have signed the relevant agreement from Phase 2 (`02-` or `03-` in this folder) before that access is granted, not after.
- Offboarding: access revocation (GitHub, cloud infrastructure, any shared credential store) happens on the contributor's last day, not "eventually" — and is logged, so there's a record of when access actually ended.

## 4. NDAs — When to Use One

- **Always**, before sharing Tier 1.1 material with anyone outside the company (a potential investor's technical due-diligence reviewer, a security auditor, a potential enterprise customer's engineering team evaluating the product).
- **Usually**, before a serious hiring conversation that would involve discussing unreleased roadmap items or architecture in detail.
- **Not needed** for anything already public — don't ask someone to sign an NDA to see the marketing website.

## 5. Relationship to the Data Room Templates Feature

The product itself already has a real, built NDA-gating mechanism (Zero-Knowledge Data Room Templates, shipped in the Modular Enterprise Adoption Features SOW) — for sharing confidential *company* documents (this SOW's own subject) with an external party like a lawyer or investor, consider using that existing product feature rather than email attachments, both as a dogfooding exercise and because it produces the same audit trail (who accessed what, when) this framework recommends keeping anyway.

## 6. Review Cadence

Revisit this framework's Tier 1.1/1.2 classifications whenever a major feature ships (something that was "unreleased" becomes public) or whenever a new category of sensitive data appears (e.g., the first time real customer PII is handled at scale). It should not need a full rewrite often — mostly small, dated additions.
