---
slug: inaya-drive
title: Inaya Drive
description: Mount your organization's Inaya storage as a real drive letter on Windows or a real mount point on Linux.
product: Storage
category: guide
contentType: Product Guide
audience: [developer, enterprise-it]
status: live
version: current
tags: [drive, windows, linux, macos]
lastVerifiedAt: "2026-09-21"
relatedDocs: [storage, s3-compatible-storage]
---

## Overview

Inaya Drive mounts your organization's S3-compatible storage as an ordinary drive in your file explorer or finder — real folders, real read/write/rename/delete, syncing through to Inaya's storage immediately with the same encryption/sharding pipeline underneath every other Inaya storage product uses.

## Platform status

| Platform | Status |
|---|---|
| Windows (WinFSP) | Live and tested — a real drive letter, proven to survive a full mount-process restart. |
| Linux (FUSE) | Live and tested, including on WSL2, with a full helper-process kill-and-restart persistence proof. |
| macOS | Written, but not yet compiled or tested on real Mac hardware — not claimed live until it is. |

## Getting started

1. From Business Workspace's download page, get the Inaya Drive helper for your operating system.
2. Configure it with your S3-compatible Access Key ID / Secret Access Key (see [S3-Compatible Storage](/docs/products/s3-compatible-storage) for how to issue one).
3. Mount — the helper mounts your organization's storage as a real drive letter (Windows) or mount point (Linux).
4. Use it like any drive.

## Related

- [S3-Compatible Storage](/docs/products/s3-compatible-storage)
- [Inaya Storage](/docs/products/storage)
