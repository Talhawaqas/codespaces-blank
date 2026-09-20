# inaya-drive-helper-linux

Mounts Inaya storage as a real Linux filesystem via FUSE (the `fuser` crate, MIT-licensed). Shares the real, already-tested S3 client and SigV4 signer with the Windows helper via `inaya-drive-core` — no second client implementation.

## Status: Linux — real, tested

Built and live-tested end-to-end on a genuine Linux kernel (WSL2 Ubuntu 26.04). Verified for real:

- Mount / clean unmount
- Directory listing (buckets and objects)
- File read (byte-range) and write
- **Empty folder creation** (`mkdir`) — the same `create_folder` the Windows helper's Explorer integration uses
- Folder rename/move
- File and folder delete
- **Persistence across a full helper-process restart** (kill the process, start a fresh one, confirm content survives) — the strongest test this SOW series names explicitly

Known, disclosed limitation: file rename has no backing server primitive yet (same as the Windows helper) and returns `ENOSYS`. Cross-bucket folder move is also unsupported (`ENOSYS`), matching real S3-backed mounts generally.

## Status: macOS — architecture only, not compiled or tested

`fuser` documents support for macOS via macFUSE using the same `Filesystem` trait this file already implements, so this source is *intended* to also build there with little or no change. It has **not** been compiled, linked, or run on macOS in this environment — no macOS hardware, Xcode command-line tools, or macFUSE installation is available here. Per this SOW's own §3.4/§7.4: macOS remains **Experimental / Pending Hardware Validation** until someone with real Mac hardware builds and tests it. Do not present this as macOS-supported until that happens.

## Build

```bash
# Requires: libfuse3-dev (Linux) and a C compiler.
cargo build
./target/debug/inaya-drive-helper-linux \
  --endpoint http://<inaya-host>/api/s3 \
  --access-key-id <key> \
  --secret-access-key <secret> \
  --mountpoint /path/to/mount
```
