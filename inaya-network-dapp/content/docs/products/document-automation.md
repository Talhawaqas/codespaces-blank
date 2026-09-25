---
slug: document-automation
title: Document & Invoice Automation
description: Turn your Finance, CRM and Procurement records into official, numbered, encrypted, verifiable documents — with approval, secure delivery and a full evidence trail.
product: Business Workspace
category: guide
contentType: Product Guide
audience: [finance-team, business-admin, auditor]
status: live
version: current
tags: [invoices, documents, pdf, approval, evidence, verification]
lastVerifiedAt: "2026-09-25"
relatedDocs: [business-workspace, s3-compatible-storage]
---

## What it does

Pick a record — an invoice, a purchase order, a deal, a payment, a customer, or a reporting period — and Inaya produces a professional PDF: **numbered** without gaps or duplicates, **calculated exactly**, **approved** by a second person when the amount requires it, **encrypted and stored** in your sovereign storage, and **shared** through a time-limited link or an identity-verified Data Room. Every step is recorded in a tamper-evident chain, and anyone holding the PDF can check that it is exactly the document Inaya finalized.

No Word, SharePoint, OneDrive or Outlook is involved, and no temporary copy of the document ever exists outside encrypted storage.

## Documents you can generate

| Document | Built from | Approval by default |
|---|---|---|
| Invoice (standard or professional layout) | A Finance invoice and its CRM customer | At or above 10,000 |
| Purchase order | An **approved** procurement purchase order | At or above 10,000 |
| Quotation | A CRM deal (its value, or lines you enter) | At or above 25,000 |
| Receipt | An **approved** incoming payment against an invoice | No |
| Customer statement | A customer, over a period, across every invoice you can see | No |
| Credit note | An issued invoice plus the lines being credited — can never exceed the invoice | At or above 1,000 |
| Debit note | An issued invoice plus additional charges | At or above 1,000 |
| Delivery note | An issued invoice, with quantities delivered | No |
| Business report | Your permission-scoped Business Insights for a period | No |

Thresholds, and whether approval is forced or waived for a type, are yours to set in **Document Automation → Settings**. A credit or debit note is a document that references a real invoice; Inaya's Finance module has no credit ledger, so issuing one does not change the invoice's recorded balance.

## The flow

1. **Create** — choose a type and a record, add any options (lines for a quotation, a reason for a credit note, a period for a statement).
2. **Review** — the server shows the calculation, every validation check (with the rule behind it), whether approval will be needed, and a watermarked preview. A preview never uses a number and stores nothing.
3. **Generate** — the document gets its official number, is rendered, encrypted and stored, and its evidence chain begins. Generating twice (a double click, a retry) returns the same document.
4. **Approve** (when required) — a different authorized person sees the exact version, the calculation, the source snapshot, what changed since the previous version, and whether the source data has changed since. Approval binds to that version; it is refused if the version is superseded, the source has changed, the request has gone stale, or the approver is the person who generated it.
5. **Finalize** — the stored bytes are re-verified, the approval stamp is added, a manifest of fingerprints is sealed, and the object is locked against deletion for your retention period.
6. **Share** — a secure link (anyone with the link, until it expires or is revoked) or a Data Room delivery (the recipient must prove control of their email). Email only ever carries the link.
7. **Verify** — recipients can verify any copy at `/verify-document`; you can run a full check (including decrypting the stored copy) and export a **Document Passport**.

## Versions, numbers and corrections

A correction is a **new version under the same number**. The previous version and its evidence are kept; when the new version is finalized the old one is marked superseded and its links stop working — a link never silently opens a newer version. Numbers are allocated atomically per organization, document type and fiscal year, are never reused, and a cancelled or voided document keeps its number, recorded in the number ledger with the reason.

## Templates, languages and layout

Ten templates ship ready to use (standard and professional invoice, purchase order, quotation, receipt, statement, credit note, debit note, delivery note, business report). An owner or admin can clone any of them into a versioned template of their own, preview it against a real record, and publish it. Published versions are immutable; every document records the exact template version and hash it was made with. Documents can be A4 or Letter, with your logo, brand colour, address and tax details, in English, French, German, Spanish, **Arabic and Urdu (right-to-left)**, in USD, EUR, GBP, AED and PKR — each currency with its correct number of decimals.

## What you can see and trust

- **Evidence chain** — every material event (source selected, calculation, template version, generation, validation, approval, finalization, storage, delivery, each view and download, revocation, supersession) is a hash-linked node, also written to your organization's cryptographic audit chain and linked into the Evidence Graph.
- **Document Passport** — a portable, sealed export proving Data → Calculation → Template → Document → Approval → Storage → Delivery. An *external* passport omits customers, amounts and source records.
- **Health** — failed or incomplete documents are shown as such (never as complete), retried automatically, and surfaced in the Brief, Activity Center and trust-health views.

## Honest limits

- Signatures are an approval stamp naming the approver and time, not a PKI/e-signature certificate.
- Scripts outside Latin, Greek, Cyrillic and Arabic script (for example Chinese or Hebrew) are flagged and may print blank until more fonts are bundled.
- A secure link is bearer access; only the Data Room delivery verifies the recipient's identity.
- Byte-identical re-rendering is guaranteed on the same runtime; the runtime (Node/ICU) is recorded because date and number text can differ between ICU versions.
