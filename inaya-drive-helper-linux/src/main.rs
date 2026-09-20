// src/main.rs -- Inaya Drive, Linux (FUSE)
//
// Enterprise Adoption & Market Reach Expansion SOW, Workstream D. Mounts
// the same real, already-tested /api/s3 endpoint as a Linux mount point,
// using `fuser` (MIT) instead of WinFSP. Shares the real S3 client and
// SigV4 signer with the Windows helper via inaya-drive-core -- this file
// is the FUSE-specific translation layer, not a second storage client.
//
// FUSE is inode-based, not path-based (unlike WinFSP's FileSystemContext,
// which hands every callback a full path) -- S3 has no inode concept at
// all, so this maintains an in-memory inode<->path table, populated
// lazily as paths are discovered via lookup/readdir, exactly the same
// technique every other network-storage FUSE filesystem (s3fs-fuse,
// goofys, rclone mount) uses. Root inode is always 1 (FUSE convention).
//
// Same disclosed, deliberate limitations as the Windows helper: no local
// metadata caching (every lookup/readdir is a real network call --
// correctness first, per this whole SOW series' own convention), and file
// rename has no backing primitive (folders do, via the same
// rename_folder the Windows helper uses).

use clap::Parser;
use fuser::{FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyWrite, Request};
use inaya_drive_core::s3client::S3Client;
use libc::{EACCES, EEXIST, EINVAL, EIO, ENOENT, ENOSYS};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

const TTL: Duration = Duration::from_secs(0); // no attribute caching -- correctness first, matching the Windows helper
const ROOT_INO: u64 = 1;

#[derive(Parser)]
#[command(name = "inaya-drive-helper-linux")]
struct Args {
    #[arg(long)]
    endpoint: String,
    #[arg(long)]
    access_key_id: String,
    #[arg(long)]
    secret_access_key: String,
    /// Local directory to mount at, e.g. /mnt/inaya
    #[arg(long)]
    mountpoint: String,
}

#[derive(Clone, Debug)]
enum EntryKind {
    Root,
    Bucket,
    Directory, // a real or prefix-derived "folder" within a bucket
    Object(u64), // known size in bytes
}

struct Inodes {
    path_of: HashMap<u64, String>, // "" for root, "bucket", or "bucket/key/with/slashes"
    ino_of: HashMap<String, u64>,
    next: u64,
}

impl Inodes {
    fn new() -> Self {
        let mut path_of = HashMap::new();
        let mut ino_of = HashMap::new();
        path_of.insert(ROOT_INO, String::new());
        ino_of.insert(String::new(), ROOT_INO);
        Inodes { path_of, ino_of, next: 2 }
    }
    fn ino_for(&mut self, path: &str) -> u64 {
        if let Some(&ino) = self.ino_of.get(path) {
            return ino;
        }
        let ino = self.next;
        self.next += 1;
        self.path_of.insert(ino, path.to_string());
        self.ino_of.insert(path.to_string(), ino);
        ino
    }
    fn path_for(&self, ino: u64) -> Option<String> {
        self.path_of.get(&ino).cloned()
    }
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

fn join_path(parent: &str, name: &str) -> String {
    if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") }
}

fn now_ts() -> SystemTime {
    SystemTime::now()
}

fn dir_attr(ino: u64) -> FileAttr {
    let now = now_ts();
    FileAttr {
        ino, size: 0, blocks: 0, atime: now, mtime: now, ctime: now, crtime: now,
        kind: FileType::Directory, perm: 0o755, nlink: 2, uid: unsafe { libc::getuid() }, gid: unsafe { libc::getgid() },
        rdev: 0, blksize: 4096, flags: 0,
    }
}
fn file_attr(ino: u64, size: u64) -> FileAttr {
    let now = now_ts();
    FileAttr {
        ino, size, blocks: (size + 511) / 512, atime: now, mtime: now, ctime: now, crtime: now,
        kind: FileType::RegularFile, perm: 0o644, nlink: 1, uid: unsafe { libc::getuid() }, gid: unsafe { libc::getgid() },
        rdev: 0, blksize: 4096, flags: 0,
    }
}

struct InayaFs {
    client: S3Client,
    inodes: Mutex<Inodes>,
    write_buffers: Mutex<HashMap<u64, Vec<u8>>>, // fh -> buffered bytes, flushed on release (same pattern as the Windows helper's write_buffer)
    next_fh: Mutex<u64>,
}

impl InayaFs {
    /// Resolves a bucket-relative path to (EntryKind), or None if nothing
    /// real exists there. Every real empty-folder detection here mirrors
    /// the Windows helper's own resolve() logic exactly, including the
    /// Inaya Drive Empty Folder SOW's parent-prefix CommonPrefixes check.
    fn resolve(&self, path: &str) -> Option<EntryKind> {
        if path.is_empty() {
            return Some(EntryKind::Root);
        }
        let (bucket, key) = split_bucket_key(path);
        let bucket = bucket?;
        match key {
            None => {
                let buckets = self.client.list_buckets().ok()?;
                if buckets.iter().any(|b| b == bucket) { Some(EntryKind::Bucket) } else { None }
            }
            Some(key) => {
                if let Ok(Some(size)) = self.client.head_object(bucket, key) {
                    return Some(EntryKind::Object(size));
                }
                let prefix = format!("{key}/");
                if let Ok(entries) = self.client.list_objects(bucket, &prefix) {
                    if !entries.is_empty() {
                        return Some(EntryKind::Directory);
                    }
                }
                if self.folder_exists_via_parent(bucket, key) {
                    return Some(EntryKind::Directory);
                }
                None
            }
        }
    }

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

    fn attr_for(&self, ino: u64, kind: &EntryKind) -> FileAttr {
        match kind {
            EntryKind::Object(size) => file_attr(ino, *size),
            _ => dir_attr(ino),
        }
    }
}

impl Filesystem for InayaFs {
    fn lookup(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let parent_path = match self.inodes.lock().unwrap().path_for(parent) {
            Some(p) => p,
            None => return reply.error(ENOENT),
        };
        let name = match name.to_str() {
            Some(n) => n,
            None => return reply.error(EINVAL),
        };
        let path = join_path(&parent_path, name);
        match self.resolve(&path) {
            Some(kind) => {
                let ino = self.inodes.lock().unwrap().ino_for(&path);
                reply.entry(&TTL, &self.attr_for(ino, &kind), 0);
            }
            None => reply.error(ENOENT),
        }
    }

    fn getattr(&mut self, _req: &Request, ino: u64, reply: ReplyAttr) {
        let path = match self.inodes.lock().unwrap().path_for(ino) {
            Some(p) => p,
            None => return reply.error(ENOENT),
        };
        match self.resolve(&path) {
            Some(kind) => reply.attr(&TTL, &self.attr_for(ino, &kind)),
            None => reply.error(ENOENT),
        }
    }

    fn readdir(&mut self, _req: &Request, ino: u64, _fh: u64, offset: i64, mut reply: ReplyDirectory) {
        let path = match self.inodes.lock().unwrap().path_for(ino) {
            Some(p) => p,
            None => return reply.error(ENOENT),
        };
        let names: Vec<(String, bool, u64)> = if path.is_empty() {
            self.client.list_buckets().unwrap_or_default().into_iter().map(|n| (n, true, 0)).collect()
        } else {
            let (bucket, key_prefix) = split_bucket_key(&path);
            let bucket = match bucket { Some(b) => b, None => return reply.error(ENOENT) };
            let full_prefix = match key_prefix { Some(k) => format!("{k}/"), None => String::new() };
            self.client.list_objects(bucket, &full_prefix).unwrap_or_default().into_iter().map(|e| (e.key, e.is_prefix, e.size)).collect()
        };

        let mut entries: Vec<(u64, FileType, String)> = vec![
            (ino, FileType::Directory, ".".to_string()),
            (ino, FileType::Directory, "..".to_string()),
        ];
        for (name, is_dir, _size) in &names {
            let child_path = join_path(&path, name);
            let child_ino = self.inodes.lock().unwrap().ino_for(&child_path);
            entries.push((child_ino, if *is_dir { FileType::Directory } else { FileType::RegularFile }, name.clone()));
        }

        for (i, (ino, kind, name)) in entries.into_iter().enumerate().skip(offset as usize) {
            if reply.add(ino, (i + 1) as i64, kind, &name) {
                break; // reply buffer full -- fuser will call readdir again with the right offset
            }
        }
        reply.ok();
    }

    fn open(&mut self, _req: &Request, ino: u64, _flags: i32, reply: ReplyOpen) {
        if self.inodes.lock().unwrap().path_for(ino).is_none() {
            return reply.error(ENOENT);
        }
        let mut next_fh = self.next_fh.lock().unwrap();
        let fh = *next_fh;
        *next_fh += 1;
        reply.opened(fh, 0);
    }

    fn read(&mut self, _req: &Request, ino: u64, _fh: u64, offset: i64, size: u32, _flags: i32, _lock: Option<u64>, reply: ReplyData) {
        let path = match self.inodes.lock().unwrap().path_for(ino) {
            Some(p) => p,
            None => return reply.error(ENOENT),
        };
        let (bucket, key) = match split_bucket_key(&path) {
            (Some(b), Some(k)) => (b, k),
            _ => return reply.error(EINVAL),
        };
        match self.client.get_object_range(bucket, key, offset as u64, size as u64) {
            Ok(data) => reply.data(&data),
            Err(_) => reply.error(EIO),
        }
    }

    fn create(&mut self, _req: &Request, parent: u64, name: &OsStr, _mode: u32, _umask: u32, _flags: i32, reply: fuser::ReplyCreate) {
        let parent_path = match self.inodes.lock().unwrap().path_for(parent) {
            Some(p) => p,
            None => return reply.error(ENOENT),
        };
        let name = match name.to_str() { Some(n) => n, None => return reply.error(EINVAL) };
        let path = join_path(&parent_path, name);
        if split_bucket_key(&path).1.is_none() {
            return reply.error(EACCES); // creating a top-level "bucket" via a plain file create isn't supported, matching the Windows helper's own scope
        }
        let ino = self.inodes.lock().unwrap().ino_for(&path);
        let fh = {
            let mut next_fh = self.next_fh.lock().unwrap();
            let fh = *next_fh;
            *next_fh += 1;
            fh
        };
        self.write_buffers.lock().unwrap().insert(fh, Vec::new());
        reply.created(&TTL, &file_attr(ino, 0), 0, fh, 0);
    }

    fn write(&mut self, _req: &Request, _ino: u64, fh: u64, offset: i64, data: &[u8], _write_flags: u32, _flags: i32, _lock: Option<u64>, reply: ReplyWrite) {
        let mut buffers = self.write_buffers.lock().unwrap();
        let buf = buffers.entry(fh).or_insert_with(Vec::new);
        let end = offset as usize + data.len();
        if end > buf.len() {
            buf.resize(end, 0);
        }
        buf[offset as usize..end].copy_from_slice(data);
        reply.written(data.len() as u32);
    }

    fn release(&mut self, _req: &Request, ino: u64, fh: u64, _flags: i32, _lock_owner: Option<u64>, _flush: bool, reply: ReplyEmpty) {
        if let Some(buf) = self.write_buffers.lock().unwrap().remove(&fh) {
            if let Some(path) = self.inodes.lock().unwrap().path_for(ino) {
                if let (Some(bucket), Some(key)) = split_bucket_key(&path) {
                    if let Err(e) = self.client.put_object(bucket, key, &buf) {
                        eprintln!("inaya-drive-helper-linux: flush of {bucket}/{key} failed: {e}");
                        return reply.error(EIO);
                    }
                }
            }
        }
        reply.ok();
    }

    fn unlink(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let parent_path = match self.inodes.lock().unwrap().path_for(parent) {
            Some(p) => p,
            None => return reply.error(ENOENT),
        };
        let name = match name.to_str() { Some(n) => n, None => return reply.error(EINVAL) };
        let path = join_path(&parent_path, name);
        match split_bucket_key(&path) {
            (Some(bucket), Some(key)) => match self.client.delete_object(bucket, key) {
                Ok(()) => reply.ok(),
                Err(_) => reply.error(EIO),
            },
            _ => reply.error(EACCES),
        }
    }

    // Inaya Drive Empty Folder SOW, ported to Linux: mkdir now creates a
    // real, durable, empty-safe folder record via the exact same
    // create_folder() the Windows helper's create() calls -- this is the
    // Linux equivalent of Explorer's right-click New Folder now working.
    fn mkdir(&mut self, _req: &Request, parent: u64, name: &OsStr, _mode: u32, _umask: u32, reply: ReplyEntry) {
        let parent_path = match self.inodes.lock().unwrap().path_for(parent) {
            Some(p) => p,
            None => return reply.error(ENOENT),
        };
        let name = match name.to_str() { Some(n) => n, None => return reply.error(EINVAL) };
        let path = join_path(&parent_path, name);
        let (bucket, key) = match split_bucket_key(&path) {
            (Some(b), Some(k)) => (b, k),
            _ => return reply.error(EACCES), // top-level "bucket" creation via mkdir is out of scope, matching the Windows helper
        };
        match self.client.create_folder(bucket, key) {
            Ok(()) => {
                let ino = self.inodes.lock().unwrap().ino_for(&path);
                reply.entry(&TTL, &dir_attr(ino), 0);
            }
            Err(e) => reply.error(match e.status { 409 => EEXIST, 400 => EINVAL, _ => EIO }),
        }
    }

    fn rmdir(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let parent_path = match self.inodes.lock().unwrap().path_for(parent) {
            Some(p) => p,
            None => return reply.error(ENOENT),
        };
        let name = match name.to_str() { Some(n) => n, None => return reply.error(EINVAL) };
        let path = join_path(&parent_path, name);
        let (bucket, key) = match split_bucket_key(&path) {
            (Some(b), Some(k)) => (b, k),
            _ => return reply.error(EACCES),
        };
        match self.client.delete_folder(bucket, key) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(if e.status == 404 { ENOENT } else { EIO }),
        }
    }

    fn rename(&mut self, _req: &Request, parent: u64, name: &OsStr, newparent: u64, newname: &OsStr, _flags: u32, reply: ReplyEmpty) {
        let parent_path = match self.inodes.lock().unwrap().path_for(parent) { Some(p) => p, None => return reply.error(ENOENT) };
        let newparent_path = match self.inodes.lock().unwrap().path_for(newparent) { Some(p) => p, None => return reply.error(ENOENT) };
        let (name, newname) = match (name.to_str(), newname.to_str()) { (Some(a), Some(b)) => (a, b), _ => return reply.error(EINVAL) };
        let old_path = join_path(&parent_path, name);
        let new_path = join_path(&newparent_path, newname);

        let (bucket, old_key) = match split_bucket_key(&old_path) { (Some(b), Some(k)) => (b, k), _ => return reply.error(EACCES) };
        let (new_bucket, new_key) = match split_bucket_key(&new_path) { (Some(b), Some(k)) => (b, k), _ => return reply.error(EACCES) };
        if bucket != new_bucket {
            return reply.error(ENOSYS); // cross-bucket move: no backing primitive, same as the Windows helper
        }

        match self.resolve(&old_path) {
            Some(EntryKind::Object(_)) => reply.error(ENOSYS), // file rename: no backing primitive yet, disclosed same as Windows
            Some(_) => match self.client.rename_folder(bucket, old_key, new_key) {
                Ok(()) => reply.ok(),
                Err(e) => reply.error(match e.status { 409 => EEXIST, 404 => ENOENT, _ => EIO }),
            },
            None => reply.error(ENOENT),
        }
    }

    fn setattr(&mut self, _req: &Request, ino: u64, _mode: Option<u32>, _uid: Option<u32>, _gid: Option<u32>, size: Option<u64>, _atime: Option<fuser::TimeOrNow>, _mtime: Option<fuser::TimeOrNow>, _ctime: Option<SystemTime>, _fh: Option<u64>, _crtime: Option<SystemTime>, _chgtime: Option<SystemTime>, _bkuptime: Option<SystemTime>, _flags: Option<u32>, reply: ReplyAttr) {
        // Only truncate-to-empty (the common "open with O_TRUNC" case) is
        // handled specially; other attribute changes (mode/uid/gid/times)
        // are accepted as no-ops -- there's no real Unix permission model
        // to persist server-side, matching the Windows helper's own
        // "accept the intent, the backend has no equivalent concept" style
        // (see set_delete there).
        let path = match self.inodes.lock().unwrap().path_for(ino) { Some(p) => p, None => return reply.error(ENOENT) };
        let reported_size = if size == Some(0) {
            if let (Some(bucket), Some(key)) = split_bucket_key(&path) {
                let _ = self.client.put_object(bucket, key, &[]);
            }
            0
        } else {
            match self.resolve(&path) {
                Some(EntryKind::Object(s)) => s,
                _ => 0,
            }
        };
        reply.attr(&TTL, &file_attr(ino, reported_size));
    }
}

fn main() {
    let args = Args::parse();
    let client = S3Client::new(args.endpoint, args.access_key_id, args.secret_access_key);
    let fs = InayaFs { client, inodes: Mutex::new(Inodes::new()), write_buffers: Mutex::new(HashMap::new()), next_fh: Mutex::new(1) };

    let options = vec![MountOption::RW, MountOption::FSName("inaya-drive".to_string())];
    if let Err(e) = fuser::mount2(fs, &args.mountpoint, &options) {
        eprintln!("inaya-drive-helper-linux: failed to mount at {}: {:?}", args.mountpoint, e);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_bucket_key_handles_root_bucket_and_nested_key() {
        assert_eq!(split_bucket_key(""), (None, None));
        assert_eq!(split_bucket_key("bucket"), (Some("bucket"), None));
        assert_eq!(split_bucket_key("bucket/key.txt"), (Some("bucket"), Some("key.txt")));
        assert_eq!(split_bucket_key("bucket/dir/key.txt"), (Some("bucket"), Some("dir/key.txt")));
    }

    #[test]
    fn join_path_handles_root_and_nested_parents() {
        assert_eq!(join_path("", "bucket"), "bucket");
        assert_eq!(join_path("bucket", "dir"), "bucket/dir");
        assert_eq!(join_path("bucket/dir", "file.txt"), "bucket/dir/file.txt");
    }

    #[test]
    fn inodes_root_is_always_inode_1() {
        let inodes = Inodes::new();
        assert_eq!(inodes.path_for(ROOT_INO), Some(String::new()));
    }

    #[test]
    fn inodes_allocates_a_new_inode_per_distinct_path_and_reuses_it_for_the_same_path() {
        let mut inodes = Inodes::new();
        let a1 = inodes.ino_for("bucket/a.txt");
        let b = inodes.ino_for("bucket/b.txt");
        let a2 = inodes.ino_for("bucket/a.txt");
        assert_ne!(a1, b, "distinct paths must get distinct inodes");
        assert_eq!(a1, a2, "the same path looked up twice must resolve to the SAME inode -- a real filesystem never reassigns an inode for a path it has already seen in this session");
        assert_ne!(a1, ROOT_INO);
        assert_ne!(b, ROOT_INO);
    }

    #[test]
    fn inodes_path_for_returns_none_for_an_unknown_inode() {
        let inodes = Inodes::new();
        assert_eq!(inodes.path_for(9999), None);
    }
}
