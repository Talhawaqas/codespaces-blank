// src/lib.rs -- inaya-drive-core
//
// Extracted from inaya-drive-helper (Enterprise Adoption SOW, Workstream
// D): s3client.rs and sigv4.rs had zero Windows/WinFSP dependencies to
// begin with, so duplicating them into a second, Linux-specific crate
// would have been exactly the "don't rebuild what's already proven"
// violation this whole SOW series exists to avoid. Every Inaya Drive
// helper -- Windows/WinFSP today, Linux/FUSE as of this SOW, macOS/FUSE
// architecture also in this SOW -- links this one crate and gets the
// same real, already-tested S3 client and signer, not a per-platform copy.

pub mod s3client;
pub mod sigv4;
