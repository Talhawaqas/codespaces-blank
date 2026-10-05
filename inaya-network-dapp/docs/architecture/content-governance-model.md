# Content governance model

Governance (Competitive Expansion SOW workstream D) is built from four parts that share one rule: **governance can only restrict, never grant.** Every enforcement point runs after the normal permission check, and no rule can bypass it. Everything is behind feature flags (default off; an owner or admin opts an organization in under Settings, Beta features): `FEATURE_FILE_GOVERNANCE`, `FEATURE_DLP`, `FEATURE_SMART_CLASSIFICATION`.

## 1. Versioned policies (`governance_policies`)

One row per version. States: draft, pending_approval, published, retired. A published or retired row is never modified: every write filters on the state it allows. Changing a policy means creating a new draft version from it; publishing the new version retires the old one. A policy can require a second admin to approve before it takes effect (the submitter cannot approve). Policies have scope (department, path prefix, role, email, group), precedence, priority, effective and expiry dates, and every transition is written to the org audit chain (`GOV_POLICY`).

Types: dlp, classification, external_sharing, public_links, download_limits, upload_types, external_domain, classification_required, retention, archival, deletion, legal_hold, device_access, versioning, file_locking, residency, guest_restrictions. Enforced today: dlp, classification (evaluated by the classifier), external_sharing, public_links, download_limits and external_domain (when a share link is created), upload_types (S3/Azure and file-request uploads). The remaining types are stored and versioned and are not yet wired to an enforcement point; the UI says so.

## 2. DLP (`src/lib/governance/dlp.js`)

A pure evaluator over a rich context: user, role, group, department, IP/CIDR, device and posture, path prefix, file type, classification, sensitivity, action, destination type and domain, share type, link policy, download count, size, time window (UTC), legal hold and retention state. First matching rule wins (policy precedence, then rule order). Decisions: ALLOW, DENY, REQUIRE_APPROVAL, REQUIRE_STRONGER_AUTH, LOG_ONLY, QUARANTINE. Everything except a plain ALLOW writes a structured event (`dlp_events`, IP masked to /24 or /48). REQUIRE_APPROVAL creates one pending request per person, action and file; an admin (never the requester) approves it; one matching request then passes within 24 hours. REQUIRE_STRONGER_AUTH has no step-up primitive to call yet, so it is enforced as a refusal unless the caller proves a strong session.

Wired into: share creation, share open, share download, S3 and Azure download and upload. The older `policy-engine.js` is untouched and still serves the export center.

## 3. Upload governance (`src/lib/governance/uploads.js`)

Extension allow and deny lists, size, per-person volume, content sniffing (an executable renamed to a document, a PDF that is not a PDF), a SHA-256 block list, zip inspection (bombs, nesting depth, entry count, encrypted members, unsafe paths), antivirus through the existing scanner (`src/lib/support/scanner.js`), then DLP for the upload action. When the content is end-to-end encrypted before it reaches Inaya (file requests) only metadata checks are possible and the result says `contentInspected: false`. Refusals are recorded; clean files are not.

## 4. Metadata and classification

Typed metadata fields (text, number, boolean, date, email, phone, controlled vocabulary), the SOW's named governance fields as built-ins, organization-defined fields, and sets that group fields for files matching a path, type or department. Visibility and edit rights are per field (manager-only fields are hidden from everyone who cannot manage the document). Share links and file-request visitors never receive metadata.

Classification rules are published `classification` policies evaluated by a pure function that also runs in a browser: metadata rules (file name, type, path, department, source, metadata values), content rules (patterns, terms, personal-data detection through the existing PII detector) only when content is supplied, with the most sensitive matching level winning and an explanation recorded. A rule either suggests or applies. History records the source, confidence, rule versions, explanation and reason. A person's classification always requires a reason and blocks later automatic changes; reclassification over it is an explicit action.

**Privacy.** Inaya never decrypts private content to classify it. Three paths exist: metadata rules on the server; content rules on the server only for objects it holds in readable form (S3/Azure compatibility objects); and the client or a customer-controlled scanner evaluating content rules locally (rules are downloadable) and reporting a verdict, which the server validates against the published rule ids and records with source "client". AI assistance goes through the AI Security Gateway, only suggests, caps confidence at 0.9, and is refused for end-to-end encrypted files.

## Workflow integration

Governance announces `file.uploaded`, `file.upload_blocked`, `file.classified`, `file.classification_suggested`, `file.dlp_blocked`, `file.shared` and `file.share_opened` as workflow events (identifiers and decisions, never content), usable by an existing event trigger. The `action.file_governance` node can classify a document, set metadata, or revoke its share links as the workflow owner; it never deletes or moves data.

## Honest limits

- Regex rules are checked with a heuristic for catastrophic backtracking and run over at most 400,000 characters; an attacker-supplied pattern cannot reach the evaluator because only admins publish rules.
- Content sniffing and archive inspection need the bytes; encrypted uploads get metadata checks only.
- Antivirus beyond the built-in static checks needs ClamAV or Cloudmersive configured; with `requireScan: engine_required` and no engine, uploads are refused.
- Classification does not change who can open a file by itself (the existing classification access layer is unchanged); DLP rules are how a level restricts actions.
- Retention, legal hold and the other stored policy types are not yet enforced from this model; legal hold and retention locks remain enforced at the storage layer as before.
