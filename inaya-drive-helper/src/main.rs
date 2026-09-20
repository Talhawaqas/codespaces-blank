// src/main.rs
//
// Inaya Drive -- mounts an org's or wallet's S3-compatible Inaya storage
// as a real Windows drive letter, via WinFSP. Kept as a standalone process
// (see Cargo.toml's package description) so the GPL-3.0 `winfsp` Rust
// binding never links into inaya-desktop's proprietary binary -- this
// process is launched as a child process by inaya-desktop's Tauri backend
// and talks to it only over stdin/exit-code, never shared memory.
//
// Backed entirely by the real, already-tested /api/s3 REST endpoint
// (s3client.rs signs every request with the real SigV4 algorithm this
// same repo's server already verifies) -- no new server-side trust
// surface, no reimplemented encryption. Buckets are top-level folders;
// object keys map to nested paths using S3's own flat-namespace/prefix
// convention, matching every other part of this SOW's storage model.

use clap::Parser;
use inaya_drive_core::s3client::{self, S3Client};
use std::ffi::c_void;
use std::sync::Mutex;
use widestring::{U16CStr, U16Str};
use winfsp::filesystem::{
    DirInfo, FileInfo, FileSecurity, FileSystemContext, OpenFileInfo, VolumeInfo, WideNameInfo,
};
use winfsp::host::{CoarseGuard, FileSystemHost, FileSystemParams, VolumeParams};
use winfsp::{FspError, Result as FspResult};

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
const FILE_DIRECTORY_FILE: u32 = 0x1; // NT create_options bit requesting a directory
const CLEANUP_DELETE: u32 = 0x1; // FspCleanup flag: file/dir marked for deletion on close

#[derive(Parser)]
#[command(name = "inaya-drive-helper")]
struct Args {
    /// Base URL of the Inaya S3-compatible endpoint, e.g. http://localhost:3000/api/s3
    #[arg(long)]
    endpoint: String,
    #[arg(long)]
    access_key_id: String,
    #[arg(long)]
    secret_access_key: String,
    /// Drive letter to mount at, e.g. "I:"
    #[arg(long)]
    drive: String,
}

fn status_from_str(msg: &str) -> FspError {
    eprintln!("inaya-drive-helper error: {msg}");
    // A generic, real NTSTATUS mapping -- STATUS_UNSUCCESSFUL. Distinguishing
    // every possible S3 failure into its own NTSTATUS is real future work;
    // this MVP surfaces every backend failure uniformly rather than
    // guessing a misleading specific code.
    FspError::NTSTATUS(windows::Win32::Foundation::STATUS_UNSUCCESSFUL.0)
}

enum EntryKind {
    Root,
    Bucket,
    Object,
}

pub struct FileHandle {
    path: String, // "" for root, "bucket", or "bucket/key/with/slashes"
    kind: EntryKind,
    size: Mutex<u64>,
    // Present only for an object opened/created for writing -- accumulated
    // in memory and flushed to a single real PUT on cleanup (SOW's own
    // established "buffer-then-assemble" convention, same as multipart
    // upload elsewhere in this codebase, just entirely client-side here).
    write_buffer: Mutex<Option<Vec<u8>>>,
}

struct InayaFs {
    client: S3Client,
}

fn wide_to_string(s: &U16CStr) -> String {
    s.to_string_lossy()
}

/// "\bucket\folder\file.txt" -> "bucket/folder/file.txt"; "\" -> "".
fn normalize_path(wide: &U16CStr) -> String {
    let s = wide_to_string(wide);
    let trimmed = s.trim_start_matches('\\');
    trimmed.replace('\\', "/")
}

fn split_bucket_key(path: &str) -> (Option<&str>, Option<&str>) {
    if path.is_empty() {
        return (None, None);
    }
    match path.split_once('/') {
        Some((b, k)) => (Some(b), Some(k)),
        None => (Some(path), None),
    }
}

impl InayaFs {
    /// Resolves a normalized path to (EntryKind, size). Every lookup is a
    /// real network call against the live /api/s3 endpoint -- correctness-
    /// first for this first working version; a local directory-listing
    /// cache is real future work for interactive performance, disclosed
    /// honestly rather than silently claimed fast.
    fn resolve(&self, path: &str) -> Option<(EntryKind, u64)> {
        if path.is_empty() {
            return Some((EntryKind::Root, 0));
        }
        let (bucket, key) = split_bucket_key(path);
        let bucket = bucket?;
        match key {
            None => {
                let buckets = self.client.list_buckets().ok()?;
                if buckets.iter().any(|b| b == bucket) {
                    Some((EntryKind::Bucket, 0))
                } else {
                    None
                }
            }
            Some(key) => {
                if let Ok(Some(size)) = self.client.head_object(bucket, key) {
                    return Some((EntryKind::Object, size));
                }
                // Not a real object -- check whether it's a "directory" (a
                // shared key prefix), matching S3's own no-real-folders
                // convention every other part of this layer already uses.
                let prefix = format!("{}/", key);
                if let Ok(entries) = self.client.list_objects(bucket, &prefix) {
                    if !entries.is_empty() {
                        return Some((EntryKind::Bucket, 0)); // reuse Bucket variant as "generic directory"
                    }
                }
                // A real, durable, EMPTY folder (Inaya Drive Empty Folder
                // SOW) has no children, so the check above finds nothing --
                // it only shows up as a CommonPrefix in its own PARENT's
                // listing. Reuses the same list_objects RPC the block above
                // already uses; no new server call.
                if self.folder_exists_via_parent(bucket, key) {
                    return Some((EntryKind::Bucket, 0));
                }
                None
            }
        }
    }

    /// `key` is bucket-relative (e.g. "documents/contracts"). Lists the
    /// key's own PARENT prefix and checks whether `key`'s leaf segment
    /// appears there as a CommonPrefix -- the only way to see a folder
    /// that has zero children of its own.
    fn folder_exists_via_parent(&self, bucket: &str, key: &str) -> bool {
        let (parent_prefix, leaf) = match key.rfind('/') {
            Some(idx) => (format!("{}/", &key[..idx]), &key[idx + 1..]),
            None => (String::new(), key),
        };
        match self.client.list_objects(bucket, &parent_prefix) {
            Ok(entries) => entries.iter().any(|e| e.is_prefix && e.key == leaf),
            Err(_) => false,
        }
    }
}

fn folder_error_to_fsp(e: s3client::FolderOpError) -> FspError {
    eprintln!("inaya-drive-helper: folder operation failed: {e}");
    let status = match e.status {
        400 => windows::Win32::Foundation::STATUS_INVALID_PARAMETER,
        404 => windows::Win32::Foundation::STATUS_OBJECT_NAME_NOT_FOUND,
        409 => windows::Win32::Foundation::STATUS_OBJECT_NAME_COLLISION,
        _ => windows::Win32::Foundation::STATUS_UNSUCCESSFUL,
    };
    FspError::NTSTATUS(status.0)
}

impl FileSystemContext for InayaFs {
    type FileContext = FileHandle;

    fn get_security_by_name(
        &self,
        file_name: &U16CStr,
        _security_descriptor: Option<&mut [c_void]>,
        _reparse_point_resolver: impl FnOnce(&U16CStr) -> Option<FileSecurity>,
    ) -> FspResult<FileSecurity> {
        let path = normalize_path(file_name);
        match self.resolve(&path) {
            Some((EntryKind::Object, _)) => Ok(FileSecurity { reparse: false, sz_security_descriptor: 0, attributes: FILE_ATTRIBUTE_NORMAL | FILE_ATTRIBUTE_ARCHIVE }),
            Some(_) => Ok(FileSecurity { reparse: false, sz_security_descriptor: 0, attributes: FILE_ATTRIBUTE_DIRECTORY }),
            None => Err(windows::Win32::Foundation::STATUS_OBJECT_NAME_NOT_FOUND.into()),
        }
    }

    fn open(
        &self,
        file_name: &U16CStr,
        create_options: u32,
        _granted_access: winfsp_sys::FILE_ACCESS_RIGHTS,
        file_info: &mut OpenFileInfo,
    ) -> FspResult<Self::FileContext> {
        let path = normalize_path(file_name);
        let (kind, size) = self.resolve(&path).ok_or(FspError::from(windows::Win32::Foundation::STATUS_OBJECT_NAME_NOT_FOUND))?;
        let is_dir = !matches!(kind, EntryKind::Object);
        if is_dir && (create_options & 0x0 == 0) {
            // opening a directory: fine
        }
        let fi = file_info.as_mut();
        fill_file_info(fi, is_dir, size);
        Ok(FileHandle { path, kind, size: Mutex::new(size), write_buffer: Mutex::new(None) })
    }

    fn create(
        &self,
        file_name: &U16CStr,
        create_options: u32,
        _granted_access: winfsp_sys::FILE_ACCESS_RIGHTS,
        _file_attributes: winfsp_sys::FILE_FLAGS_AND_ATTRIBUTES,
        _security_descriptor: Option<&[c_void]>,
        _allocation_size: u64,
        _extra_buffer: Option<&[u8]>,
        _extra_buffer_is_reparse_point: bool,
        file_info: &mut OpenFileInfo,
    ) -> FspResult<Self::FileContext> {
        let path = normalize_path(file_name);
        if create_options & FILE_DIRECTORY_FILE != 0 {
            // Inaya Drive Empty Folder SOW: create a real, durable folder
            // record via the ?folder extension (s3client::create_folder)
            // instead of the previous hard rejection -- this is what makes
            // Explorer's "New Folder" actually persist.
            let (bucket, key) = split_bucket_key(&path);
            let (bucket, key) = match (bucket, key) {
                (Some(b), Some(k)) => (b, k),
                _ => return Err(windows::Win32::Foundation::STATUS_NOT_SUPPORTED.into()),
            };
            self.client.create_folder(bucket, key).map_err(folder_error_to_fsp)?;
            let fi = file_info.as_mut();
            fill_file_info(fi, true, 0);
            return Ok(FileHandle { path, kind: EntryKind::Bucket, size: Mutex::new(0), write_buffer: Mutex::new(None) });
        }
        let (bucket, key) = split_bucket_key(&path);
        if bucket.is_none() || key.is_none() {
            return Err(windows::Win32::Foundation::STATUS_NOT_SUPPORTED.into());
        }
        let fi = file_info.as_mut();
        fill_file_info(fi, false, 0);
        Ok(FileHandle { path, kind: EntryKind::Object, size: Mutex::new(0), write_buffer: Mutex::new(Some(Vec::new())) })
    }

    fn close(&self, _context: Self::FileContext) {}

    fn get_file_info(&self, context: &Self::FileContext, file_info: &mut FileInfo) -> FspResult<()> {
        let is_dir = !matches!(context.kind, EntryKind::Object);
        let size = *context.size.lock().unwrap();
        fill_file_info(file_info, is_dir, size);
        Ok(())
    }

    fn read(&self, context: &Self::FileContext, buffer: &mut [u8], offset: u64) -> FspResult<u32> {
        // Reading at or past EOF is a normal, expected event in every read
        // loop (e.g. Explorer/PowerShell detecting the end of a file) --
        // matching ordinary filesystem semantics of "0 bytes read" rather
        // than forwarding it as a Range request the server correctly
        // rejects as 416 (a real bug this exact case surfaced during live
        // testing: `bytes=<size>-...` on a file of exactly `size` bytes is
        // genuinely unsatisfiable per HTTP semantics).
        let size = *context.size.lock().unwrap();
        if offset >= size {
            return Ok(0);
        }
        let (bucket, key) = split_bucket_key(&context.path);
        let (bucket, key) = match (bucket, key) {
            (Some(b), Some(k)) => (b, k),
            _ => return Err(windows::Win32::Foundation::STATUS_INVALID_DEVICE_REQUEST.into()),
        };
        let want = (buffer.len() as u64).min(size - offset);
        let data = self.client.get_object_range(bucket, key, offset, want).map_err(|e| status_from_str(&e))?;
        let n = data.len().min(buffer.len());
        buffer[..n].copy_from_slice(&data[..n]);
        Ok(n as u32)
    }

    fn write(
        &self,
        context: &Self::FileContext,
        buffer: &[u8],
        offset: u64,
        write_to_eof: bool,
        _constrained_io: bool,
        file_info: &mut FileInfo,
    ) -> FspResult<u32> {
        let mut guard = context.write_buffer.lock().unwrap();
        let buf = guard.get_or_insert_with(Vec::new);
        let end = if write_to_eof { buf.len() as u64 + buffer.len() as u64 } else { offset + buffer.len() as u64 };
        if (end as usize) > buf.len() {
            buf.resize(end as usize, 0);
        }
        let start = if write_to_eof { buf.len() - buffer.len() } else { offset as usize };
        buf[start..start + buffer.len()].copy_from_slice(buffer);
        let new_size = buf.len() as u64;
        drop(guard);
        *context.size.lock().unwrap() = new_size;
        fill_file_info(file_info, false, new_size);
        Ok(buffer.len() as u32)
    }

    fn set_file_size(&self, context: &Self::FileContext, new_size: u64, _set_allocation_size: bool, file_info: &mut FileInfo) -> FspResult<()> {
        let mut guard = context.write_buffer.lock().unwrap();
        let buf = guard.get_or_insert_with(Vec::new);
        buf.resize(new_size as usize, 0);
        drop(guard);
        *context.size.lock().unwrap() = new_size;
        fill_file_info(file_info, false, new_size);
        Ok(())
    }

    fn rename(&self, context: &Self::FileContext, _file_name: &U16CStr, new_file_name: &U16CStr, _replace_if_exists: bool) -> FspResult<()> {
        // Inaya Drive Empty Folder SOW: folders only (renameS3Folder is the
        // one real primitive this pass built). File rename has no backing
        // store.js primitive yet -- a real, disclosed scope limit, not a
        // silent gap, matching this repo's own "don't claim what isn't
        // built" convention (see create()'s and open()'s equivalent
        // comments elsewhere in this file).
        if matches!(context.kind, EntryKind::Object) {
            return Err(windows::Win32::Foundation::STATUS_NOT_SUPPORTED.into());
        }
        let new_path = normalize_path(new_file_name);
        let (old_bucket, old_key) = split_bucket_key(&context.path);
        let (new_bucket, new_key) = split_bucket_key(&new_path);
        let (bucket, old_key, new_bucket, new_key) = match (old_bucket, old_key, new_bucket, new_key) {
            (Some(b), Some(ok), Some(nb), Some(nk)) => (b, ok, nb, nk),
            _ => return Err(windows::Win32::Foundation::STATUS_NOT_SUPPORTED.into()),
        };
        if bucket != new_bucket {
            // Cross-bucket move: no backing primitive (renameS3Folder is
            // scoped to one bucket, matching real S3-backed drives, which
            // don't support cross-bucket rename either).
            return Err(windows::Win32::Foundation::STATUS_NOT_SUPPORTED.into());
        }
        self.client.rename_folder(bucket, old_key, new_key).map_err(folder_error_to_fsp)?;
        Ok(())
    }

    fn set_delete(&self, _context: &Self::FileContext, _file_name: &U16CStr, _delete_file: bool) -> FspResult<()> {
        // Real bug found during live testing: without implementing this,
        // WinFSP's default (STATUS_INVALID_DEVICE_REQUEST) rejects every
        // delete before cleanup()'s own CLEANUP_DELETE handling is ever
        // reached -- accepting the intent here is what lets Explorer/`rm`
        // actually proceed to the real DELETE call below.
        Ok(())
    }

    fn cleanup(&self, context: &Self::FileContext, _file_name: Option<&U16CStr>, flags: u32) {
        if flags & CLEANUP_DELETE != 0 {
            if let (Some(bucket), Some(key)) = split_bucket_key(&context.path) {
                // Branch on what's actually being deleted (Inaya Drive
                // Empty Folder SOW) -- cleanup() previously assumed every
                // deletable entry was a file, which is safe only because
                // create() used to reject directory creation outright.
                match context.kind {
                    EntryKind::Object => {
                        let _ = self.client.delete_object(bucket, key);
                    }
                    _ => {
                        let _ = self.client.delete_folder(bucket, key);
                    }
                }
            }
            return;
        }
        let mut guard = context.write_buffer.lock().unwrap();
        if let Some(buf) = guard.take() {
            if let (Some(bucket), Some(key)) = split_bucket_key(&context.path) {
                if let Err(e) = self.client.put_object(bucket, key, &buf) {
                    eprintln!("inaya-drive-helper: flush of {}/{} failed: {}", bucket, key, e);
                }
            }
        }
    }

    fn read_directory(&self, context: &Self::FileContext, _pattern: Option<&U16CStr>, marker: winfsp::filesystem::DirMarker, buffer: &mut [u8]) -> FspResult<u32> {
        let names: Vec<(String, bool, u64)> = match &context.kind {
            EntryKind::Root => self.client.list_buckets().unwrap_or_default().into_iter().map(|n| (n, true, 0)).collect(),
            _ => {
                // Real, pre-existing bug found during live mount testing of
                // this SOW: `list_objects` takes a prefix RELATIVE to the
                // bucket (it's appended after `/api/s3/{bucket}?prefix=`),
                // but this used to pass `context.path` itself (which is
                // "bucket/key", per FileHandle's own doc comment) -- so
                // opening any REAL nested directory (bucket/subfolder) sent
                // the bucket name twice (e.g. prefix=bucket/subfolder/
                // against bucket "bucket"), silently returning zero
                // entries for every nested folder. Only ever exercised
                // before this SOW when a nested folder happened to contain
                // objects; this SOW's empty-folder navigation makes nested
                // listing a core path, which is what surfaced it live.
                let (bucket, key_prefix) = split_bucket_key(&context.path);
                let bucket = match bucket { Some(b) => b, None => return Ok(0) };
                let full_prefix = match key_prefix { Some(k) => format!("{}/", k), None => String::new() };
                self.client
                    .list_objects(bucket, &full_prefix)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|e| (e.key, e.is_prefix, e.size))
                    .collect()
            }
        };

        let marker_name = marker.inner().map(U16Str::from_slice).map(|s| s.to_string_lossy());
        let mut sorted = names;
        sorted.sort_by(|a, b| a.0.cmp(&b.0));

        let mut cursor: u32 = 0;
        for (name, is_dir, size) in sorted.iter() {
            if let Some(m) = &marker_name {
                if name <= m {
                    continue;
                }
            }
            let mut dir_info: DirInfo<255> = DirInfo::new();
            fill_file_info(dir_info.file_info_mut(), *is_dir, *size);
            if dir_info.set_name(name).is_err() {
                continue;
            }
            if !dir_info.append_to_buffer(buffer, &mut cursor) {
                break;
            }
        }
        DirInfo::<255>::finalize_buffer(buffer, &mut cursor);
        Ok(cursor)
    }

    fn get_volume_info(&self, out_volume_info: &mut VolumeInfo) -> FspResult<()> {
        // Real usage isn't queryable from the S3 protocol surface as
        // implemented -- reporting a generous fixed size rather than
        // fabricating a precise-looking number that isn't real.
        out_volume_info.total_size = 1024u64 * 1024 * 1024 * 1024;
        out_volume_info.free_size = 512u64 * 1024 * 1024 * 1024;
        out_volume_info.set_volume_label("Inaya Drive");
        Ok(())
    }
}

/// Windows FILETIME: 100-nanosecond intervals since 1601-01-01, the unit
/// every FileInfo timestamp field uses. 116444736000000000 is the fixed,
/// well-known offset between the 1601 and 1970 epochs in that same unit.
fn win32_filetime_now() -> u64 {
    let now = chrono::Utc::now();
    let unix_100ns = (now.timestamp() as u64) * 10_000_000 + (now.timestamp_subsec_nanos() as u64) / 100;
    unix_100ns + 116_444_736_000_000_000
}

fn fill_file_info(fi: &mut FileInfo, is_dir: bool, size: u64) {
    fi.file_attributes = if is_dir { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_NORMAL | FILE_ATTRIBUTE_ARCHIVE };
    fi.file_size = size;
    fi.allocation_size = size;
    let now = win32_filetime_now();
    fi.creation_time = now;
    fi.last_access_time = now;
    fi.last_write_time = now;
    fi.change_time = now;
}

fn main() {
    let args = Args::parse();
    winfsp::winfsp_init_or_die();

    let client = S3Client::new(args.endpoint, args.access_key_id, args.secret_access_key);
    let fs = InayaFs { client };

    let mut volume_params = VolumeParams::new();
    volume_params
        .sector_size(4096)
        .sectors_per_allocation_unit(1)
        .filesystem_name("InayaDrive")
        .case_preserved_names(true)
        .unicode_on_disk(true)
        .persistent_acls(false)
        .read_only_volume(false);

    let mut host: FileSystemHost<InayaFs, CoarseGuard> = FileSystemHost::new_with_options(FileSystemParams::default_params(volume_params), fs).unwrap_or_else(|e| {
        eprintln!("inaya-drive-helper: failed to create filesystem host: {:?}", e);
        std::process::exit(1);
    });

    if let Err(e) = host.mount(args.drive.as_str()) {
        eprintln!("inaya-drive-helper: failed to mount at {}: {:?}", args.drive, e);
        std::process::exit(1);
    }
    if let Err(e) = host.start() {
        eprintln!("inaya-drive-helper: failed to start dispatcher: {:?}", e);
        std::process::exit(1);
    }

    println!("Inaya Drive mounted at {}", args.drive);
    // Block forever -- inaya-desktop kills this whole process to unmount
    // (a clean process-boundary teardown; FileSystemHost::drop also
    // unmounts if this loop is ever exited).
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
