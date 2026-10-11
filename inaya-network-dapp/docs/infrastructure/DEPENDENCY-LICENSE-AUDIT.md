# Dependency license audit — Sovereign Infrastructure Fabric

Per §8/§204. Every new third-party dependency this SOW introduces, its license, linking model, and commercial-use status. Updated as each phase actually adds a dependency — a crate is added here in the same commit that adds it to a `Cargo.toml`, never after the fact.

## Rule this audit enforces (§8)

Spinifex (`github.com/mulgadc/spinifex`) is AGPL-3.0, with a commercial license stated as available. **No Spinifex source is copied, vendored, or imported as a runtime dependency anywhere in this project.** Everything below is either independently authored or an unrelated, permissively-licensed third-party package.

## Rust workspace (`inaya-infrastructure/`)

| Dependency | Version (pinned) | License | Linking model | Commercial-use status | Notes |
|---|---|---|---|---|---|
| `tokio` | latest stable at time of adoption | MIT | Source dependency (Cargo), statically compiled into the binary | Unrestricted | Async runtime — de facto standard, used by `inaya-desktop` already |
| `async-nats` | latest stable | Apache-2.0 | Source dependency | Unrestricted | Official async Rust client for NATS |
| `serde` / `serde_json` | latest stable | MIT OR Apache-2.0 | Source dependency | Unrestricted | Wire format |
| `rustls` | latest stable | MIT OR Apache-2.0 OR ISC | Source dependency | Unrestricted | mTLS — no OpenSSL FFI/system dependency |
| `rcgen` | latest stable | MIT OR Apache-2.0 | Source dependency | Unrestricted | Certificate generation for node enrollment (§42) |
| `nix` | latest stable | MIT | Source dependency | Unrestricted | Safe wrappers over Linux syscalls (namespaces, device access) |
| `clap` | latest stable | MIT OR Apache-2.0 | Source dependency | Unrestricted | `inaya-infra-cli` argument parsing |

Exact versions are locked in `inaya-infrastructure/Cargo.lock` once the workspace is scaffolded (Phase 1) — this table is updated with the actual locked versions at that point, not left as "latest stable" placeholders past Phase 1.

## External binaries invoked as separate processes (not linked dependencies)

| Binary | License | How it's used | Notes |
|---|---|---|---|
| QEMU (`qemu-system-x86_64`) | GPL-2.0 (the QEMU project itself) | Invoked as a subprocess with structured, parameterized arguments (§61) — never linked into `inaya-infra-node`'s binary, never modified, never redistributed by this project | GPL-2.0 governs QEMU's own source; invoking an unmodified GPL binary as a subprocess does not place GPL obligations on the calling code, which is the same relationship every hypervisor management tool (libvirt, Proxmox, etc.) has with QEMU |
| `nftables` (`nft` CLI / netlink) | GPL-2.0 (kernel-side) | Netlink calls via the kernel's own ABI (not linking GPL userspace code) or shelling out to the `nft` binary with parameterized arguments, same relationship as QEMU above | |
| NATS server | Apache-2.0 | Run as a separate process/container, communicated with over its documented client protocol | Confirmed permissive, no concern |

## Node.js / Next.js side (`inaya-network-dapp`)

No new npm dependencies are required for the control-plane work in Phases 0/7/8/10 — everything needed (MongoDB driver, Next.js routing, existing crypto/audit/evidence libraries) is already in `package.json`. This row is updated if that changes in a later phase.

## Go side (`terraform-provider-inaya/`)

No new Go dependencies beyond what the existing `terraform-plugin-framework`-based provider already uses — new resource files (`resource_compute_instance.go`, etc.) follow the existing `resource_storage_resource.go` pattern using the same already-audited dependency set.
