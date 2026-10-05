---
slug: secure-collaboration
title: Secure Collaboration
description: End-to-end encrypted chat, notes and sharing inside Inaya, with the controls an organization needs to run them safely.
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, it-admin, security-team, auditor]
status: beta
version: current
tags: [chat, notes, sharing, governance, dlp, devices, compliance, desktop]
lastVerifiedAt: "2026-10-05"
relatedDocs: [business-workspace, security-layer, s3-compatible-storage]
---

## What it is

Secure Collaboration adds private team communication and controlled file sharing to the Business Workspace without giving Inaya access to what people write. Every feature below is **off by default**; an owner or administrator turns each one on for the organization from the beta-features panel.

## Secure Chat and Notes

- **Chat** is end-to-end encrypted with the MLS group-messaging standard. Messages are scrambled on each person's device; the server stores and delivers only ciphertext. Removing someone stops them reading anything sent afterwards, and a person added later does not see earlier messages.
- **Contacts, groups, organization-wide chats, mute, archive, unread counts, typing and presence** work as in a normal chat product. People outside your organization can only be added if the owner allows it, a purpose is stated, and they accept.
- **Attachments** are encrypted on the device first. You can also attach a reference to a Secure Note or to an Inaya document; the people in the chat still need their own access to open it.
- **Drafts** are saved on your device only. **Search** runs over what your device has already decrypted.
- **Notes** are encrypted notes with history, sharing and tags.
- **Honest limit:** an administrator cannot read chat or notes. The chat uses an open-source implementation of the standard that has not had a formal independent audit.

## Sharing and governance

Share links can expire, limit openings, require a password, restrict by network or domain, show a watermark and be revoked at any time. File requests let outsiders upload to you securely. File locks, data-loss rules, classification, retention and legal hold are managed from Governance. A secure viewer shows protected documents without handing over a copy; it cannot stop someone photographing a screen.

## Devices, desktop and administration

- The device list shows every device and lets an administrator trust, block, sign out or revoke it. Chat devices can be revoked separately.
- In the desktop app, chat can open in its own window, only one window runs it at a time, and alerts show only a count, never names or text. Owners choose what happens to chat data at sign-out: keep it, erase message history, or revoke the device.
- The Admin Dashboard shows storage, shares, devices, backups and, for administrators and auditors, privacy-safe usage counts. Nothing in those counts contains message text, file names or email addresses.

## Compliance readiness

Compliance Readiness is a checklist based on NIST SP 800-53 Rev. 5 with owners, evidence and exceptions, and a downloadable evidence package. It reports technical readiness only. It is **not** a certification, and Inaya does not claim FedRAMP authorization or FIPS validation.
