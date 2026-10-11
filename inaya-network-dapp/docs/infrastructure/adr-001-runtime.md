# ADR-001: Node runtime language — Rust

Status: Accepted, 2026-10-10.

## Context

§298 requires this choice before any code is written. The new `inaya-infra-node` daemon runs on customer-owned bare metal with direct access to `/dev/kvm`, raw block devices, and host networking — a genuine systems-programming surface, not an application surface.

## Decision

Rust.

## Reasoning

- **House precedent.** Every other native/host-level component in this codebase is already Rust: `inaya-desktop`'s Tauri backend, `inaya-drive-core`, `inaya-drive-helper` (and its Linux variant). Go exists in this monorepo in exactly one place — `terraform-provider-inaya`, because the HashiCorp Terraform Plugin Framework is Go-only by the framework's own design, not a house-language choice. Introducing Go as a second systems language for a brand-new component would fragment tooling (two toolchains, two dependency-audit processes, two sets of host-hardening conventions) where Rust already covers this exact role.
- **Memory safety where it matters most.** This process parses untrusted cloud-init/user-data (§17 — "treated as untrusted input"), constructs QEMU process arguments from API-supplied values (§61 — "no shell interpolation," structured argument arrays only), and holds mTLS private key material (§41). Rust's ownership model removes a whole class of memory-corruption bugs in exactly this kind of code, at zero runtime cost.
- **Confirmed tooling.** Rust 1.97 is already installed and on PATH in this environment (`cargo 1.97.1`), so this decision carries no environment-setup cost.
- **Ecosystem fit.** `tokio` (async runtime), `rustls`/`rcgen` (mTLS, certificate generation — no OpenSSL FFI needed), `serde`/`serde_json` (wire format), `async-nats` (the official async NATS client), and `nix` (safe wrappers over Linux syscalls for namespaces/cgroups/device access) together cover every Phase 1-3 requirement without reaching for unsafe FFI.

## Consequences

- A second Cargo workspace (`inaya-infrastructure/`) joins `inaya-desktop`, `inaya-drive-core`, `inaya-drive-helper`, `inaya-drive-helper-linux`, `solana` as Rust code in this organization — consistent, not novel.
- The Next.js control plane and the Rust node runtime communicate over the message fabric (ADR-003) and a typed HTTP API, never by sharing code directly — this was already the plan regardless of language choice (§7, "architectural separation").
- QEMU itself is invoked as an external process (§60 — "no arbitrary user-provided command line... use parameterized process execution"), not linked as a library, so the language choice does not couple this project to any particular QEMU binding crate's maturity.
