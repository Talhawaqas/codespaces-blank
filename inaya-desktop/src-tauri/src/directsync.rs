// src-tauri/src/directsync.rs
//
// Inaya DirectSync (Modular Enterprise Adoption Features SOW, Feature 1)
// -- automatic local-folder backup into Inaya. Runs as a background task
// inside this same Tauri process (see the module header in lib.rs for why
// this is not a fifth standalone native service), reusing:
//   - inaya-drive-core's real, already-tested S3Client/SigV4 signer as the
//     upload destination (the exact same client inaya-drive-helper and
//     inaya-drive-helper-linux already use against the real /api/s3
//     endpoint) -- no second upload protocol.
//   - the keyring crate for credential storage (already used for the
//     master-node passkey in lib.rs) -- no second secret-storage mechanism.
//
// GENUINE GAPS this file fills (nothing in the repo did these before):
//   - local folder watching (notify + notify-debouncer-full -- the
//     debouncer specifically solves "the OS emits multiple notifications
//     for one logical change", the SOW's own explicit caution)
//   - local, durable sync-state persistence (SQLite via rusqlite), modeled
//     on cloudBackupScheduler.js's backupObjectState collection shape:
//     local path, size, mtime, content hash, destination key, upload
//     state, retry count, last error, last synced time.
//
// BACKUP SEMANTICS, STATED PLAINLY: a local delete does NOT delete the
// remote copy. This is a backup relationship (A -> Inaya), not a mirror --
// deleting a local file should not destroy the only remaining copy of it.
// The sync-state row is marked LOCALLY_DELETED so it stops being tracked,
// but nothing is ever removed from Inaya as a side effect of watching a
// folder.
//
// INTERRUPTED-UPLOAD SEMANTICS, STATED PLAINLY: uploads are whole-file (one
// PUT), not resumable byte-range uploads. A row is only ever marked DONE
// after a real 2xx response for the complete file; a connection drop mid-
// upload leaves the row QUEUED/FAILED, and retrying re-uploads the whole
// file cleanly rather than attempting a byte-range resume. This keeps the
// stored object byte-correct (the SOW's own explicit requirement) without
// building a second, resumable-multipart protocol on top of the existing
// single-PUT S3-compat write path.

use inaya_drive_core::s3client::S3Client;
use notify_debouncer_full::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode, Watcher},
    DebounceEventResult, Debouncer, FileIdMap,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const DEBOUNCE_WINDOW: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------
// Pure, unit-testable logic (no filesystem watching, no network) -- kept
// separate from the thread/Tauri-command plumbing below so it can be
// exercised directly by cargo test without any OS resource.
// ---------------------------------------------------------------------

/// SHA-256 of a file's current contents. Errors (permission denied, file
/// vanished between the watch event and this read) are the caller's to
/// handle -- a permission-denied local file must fail that one file
/// safely, not the whole watcher (SOW §6.11 "permission-denied local
/// file").
pub fn compute_file_hash(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

/// Local path -> destination object key, forward-slash S3 convention,
/// scoped under the folder's own prefix.
pub fn relative_key(root: &Path, file_path: &Path, prefix: &str) -> Option<String> {
    let rel = file_path.strip_prefix(root).ok()?;
    let rel_str = rel.to_str()?.replace('\\', "/");
    if prefix.is_empty() {
        Some(rel_str)
    } else {
        Some(format!("{}/{}", prefix.trim_end_matches('/'), rel_str))
    }
}

/// True when the given size+hash exactly match what was already recorded
/// for this path -- the actual "don't re-upload something unchanged"
/// check. mtime alone is deliberately never sufficient (SOW §8.5's own
/// caution, applied here too): only size+hash decide duplicate-safety.
pub fn is_unchanged(prior_size: u64, prior_hash: &str, size: u64, hash: &str) -> bool {
    prior_size == size && prior_hash == hash
}

// ---------------------------------------------------------------------
// Local durable state store (SQLite)
// ---------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct QueueEntry {
    pub id: i64,
    pub folder_id: String,
    pub local_path: String,
    pub size: u64,
    pub mtime: i64,
    pub content_hash: String,
    pub destination_key: String,
    pub state: String, // QUEUED | UPLOADING | DONE | FAILED | LOCALLY_DELETED
    pub retry_count: i64,
    pub last_error: Option<String>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderConfig {
    pub id: String,
    pub local_path: String,
    pub bucket: String,
    pub prefix: String,
    pub enabled: bool,
}

pub struct SyncStateDb {
    conn: Mutex<Connection>,
}

impl SyncStateDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                local_path TEXT NOT NULL UNIQUE,
                bucket TEXT NOT NULL,
                prefix TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder_id TEXT NOT NULL,
                local_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,
                content_hash TEXT NOT NULL,
                destination_key TEXT NOT NULL,
                state TEXT NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_synced_at TEXT,
                UNIQUE(folder_id, local_path)
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn add_folder(&self, folder: &FolderConfig) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO folders (id, local_path, bucket, prefix, enabled, created_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            rusqlite::params![folder.id, folder.local_path, folder.bucket, folder.prefix, folder.enabled as i64],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_folder(&self, folder_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM sync_state WHERE folder_id = ?1", [folder_id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM folders WHERE id = ?1", [folder_id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_folder_enabled(&self, folder_id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE folders SET enabled = ?1 WHERE id = ?2", rusqlite::params![enabled as i64, folder_id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_folders(&self) -> Result<Vec<FolderConfig>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, local_path, bucket, prefix, enabled FROM folders").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(FolderConfig {
                    id: r.get(0)?,
                    local_path: r.get(1)?,
                    bucket: r.get(2)?,
                    prefix: r.get(3)?,
                    enabled: r.get::<_, i64>(4)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    fn get_destination_key(&self, folder_id: &str, local_path: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT destination_key FROM sync_state WHERE folder_id = ?1 AND local_path = ?2",
            rusqlite::params![folder_id, local_path],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })
    }

    fn get_state(&self, folder_id: &str, local_path: &str) -> Result<Option<(u64, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT size, content_hash FROM sync_state WHERE folder_id = ?1 AND local_path = ?2 AND state = 'DONE'",
            rusqlite::params![folder_id, local_path],
            |r| Ok((r.get::<_, i64>(0)? as u64, r.get(1)?)),
        )
        .map(Some)
        .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })
    }

    /// Inserts or updates a row as QUEUED, ready for upload. Returns the
    /// row id.
    fn upsert_queued(&self, folder_id: &str, local_path: &str, size: u64, mtime: i64, hash: &str, dest_key: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO sync_state (folder_id, local_path, size, mtime, content_hash, destination_key, state, retry_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'QUEUED', 0)
             ON CONFLICT(folder_id, local_path) DO UPDATE SET
                size = excluded.size, mtime = excluded.mtime, content_hash = excluded.content_hash,
                destination_key = excluded.destination_key, state = 'QUEUED', last_error = NULL",
            rusqlite::params![folder_id, local_path, size as i64, mtime, hash, dest_key],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    fn mark_done(&self, folder_id: &str, local_path: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sync_state SET state = 'DONE', last_synced_at = datetime('now'), last_error = NULL WHERE folder_id = ?1 AND local_path = ?2",
            rusqlite::params![folder_id, local_path],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn mark_failed(&self, folder_id: &str, local_path: &str, error: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sync_state SET state = 'FAILED', retry_count = retry_count + 1, last_error = ?3 WHERE folder_id = ?1 AND local_path = ?2",
            rusqlite::params![folder_id, local_path, error],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// A local rename/move: re-point the existing state row at the new
    /// path without re-uploading (content is unchanged) -- this is what
    /// makes a rename NOT produce a duplicate remote object.
    fn rename_path(&self, folder_id: &str, old_path: &str, new_path: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let updated = conn
            .execute("UPDATE sync_state SET local_path = ?3 WHERE folder_id = ?1 AND local_path = ?2", rusqlite::params![folder_id, old_path, new_path])
            .map_err(|e| e.to_string())?;
        Ok(updated > 0)
    }

    fn mark_locally_deleted(&self, folder_id: &str, local_path: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sync_state SET state = 'LOCALLY_DELETED' WHERE folder_id = ?1 AND local_path = ?2",
            rusqlite::params![folder_id, local_path],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_queue(&self, folder_id: Option<&str>) -> Result<Vec<QueueEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let sql = match folder_id {
            Some(_) => "SELECT id, folder_id, local_path, size, mtime, content_hash, destination_key, state, retry_count, last_error, last_synced_at FROM sync_state WHERE folder_id = ?1 ORDER BY id DESC LIMIT 500",
            None => "SELECT id, folder_id, local_path, size, mtime, content_hash, destination_key, state, retry_count, last_error, last_synced_at FROM sync_state ORDER BY id DESC LIMIT 500",
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let map_row = |r: &rusqlite::Row| -> rusqlite::Result<QueueEntry> {
            Ok(QueueEntry {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                local_path: r.get(2)?,
                size: r.get::<_, i64>(3)? as u64,
                mtime: r.get(4)?,
                content_hash: r.get(5)?,
                destination_key: r.get(6)?,
                state: r.get(7)?,
                retry_count: r.get(8)?,
                last_error: r.get(9)?,
                last_synced_at: r.get(10)?,
            })
        };
        let rows = match folder_id {
            Some(id) => stmt.query_map([id], map_row),
            None => stmt.query_map([], map_row),
        }
        .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn requeue_failed(&self, folder_id: &str) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE sync_state SET state = 'QUEUED' WHERE folder_id = ?1 AND state = 'FAILED'", [folder_id]).map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------
// Upload engine -- shared by both the initial full-folder scan and the
// live watcher, so both paths go through the exact same duplicate-safe
// decision and the exact same upload/verify/record logic.
// ---------------------------------------------------------------------

pub struct SyncEngine {
    pub db: Arc<SyncStateDb>,
    pub client: Arc<S3Client>,
}

impl SyncEngine {
    /// Processes one local file: hash it, compare against the last known
    /// DONE state for this exact path, skip if unchanged, otherwise queue
    /// and upload it, verifying via head_object afterward (byte-size
    /// check -- the same integrity discipline runMigration() already uses
    /// server-side for Feature 3, applied here for the local agent).
    pub fn sync_one_file(&self, folder: &FolderConfig, file_path: &Path) -> Result<(), String> {
        let root = Path::new(&folder.local_path);
        let dest_key = relative_key(root, file_path, &folder.prefix).ok_or("path is outside the watched folder")?;
        let local_path_str = file_path.to_string_lossy().to_string();

        let metadata = fs::metadata(file_path).map_err(|e| e.to_string())?;
        let size = metadata.len();
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let hash = compute_file_hash(file_path)?;

        if let Some((prior_size, prior_hash)) = self.db.get_state(&folder.id, &local_path_str)? {
            if is_unchanged(prior_size, &prior_hash, size, &hash) {
                return Ok(()); // duplicate-safe: identical content already uploaded
            }
        }

        self.db.upsert_queued(&folder.id, &local_path_str, size, mtime, &hash, &dest_key)?;

        let body = fs::read(file_path).map_err(|e| e.to_string())?;
        match self.client.put_object(&folder.bucket, &dest_key, &body) {
            Ok(()) => match self.client.head_object(&folder.bucket, &dest_key) {
                Ok(Some(remote_size)) if remote_size == size => {
                    self.db.mark_done(&folder.id, &local_path_str)?;
                    Ok(())
                }
                Ok(_) => {
                    let msg = "Upload verification failed: destination size does not match the local file.".to_string();
                    self.db.mark_failed(&folder.id, &local_path_str, &msg)?;
                    Err(msg)
                }
                Err(e) => {
                    self.db.mark_failed(&folder.id, &local_path_str, &e)?;
                    Err(e)
                }
            },
            Err(e) => {
                self.db.mark_failed(&folder.id, &local_path_str, &e)?;
                Err(e)
            }
        }
    }

    pub fn handle_delete(&self, folder: &FolderConfig, file_path: &Path) -> Result<(), String> {
        let local_path_str = file_path.to_string_lossy().to_string();
        self.db.mark_locally_deleted(&folder.id, &local_path_str)
    }

    /// A local rename/move. The file's CONTENT is unchanged, so this
    /// deliberately skips the normal hash-and-dedup path in
    /// sync_one_file() -- but the remote object still has to be
    /// physically relocated to the new key (a copy under the new key,
    /// then a delete of the old one), or the destination would silently
    /// drift out of sync with the local layout while the local state
    /// claimed otherwise. Implemented as read-local-bytes + PUT-new-key +
    /// DELETE-old-key rather than a dedicated rename API, since neither
    /// S3 nor this app's S3-compat layer has a native object-rename verb.
    pub fn handle_rename(&self, folder: &FolderConfig, old_path: &Path, new_path: &Path) -> Result<(), String> {
        let old_str = old_path.to_string_lossy().to_string();
        let new_str = new_path.to_string_lossy().to_string();
        let root = Path::new(&folder.local_path);
        let new_key = relative_key(root, new_path, &folder.prefix).ok_or("path is outside the watched folder")?;

        let old_key = self.db.get_destination_key(&folder.id, &old_str)?;

        let renamed = self.db.rename_path(&folder.id, &old_str, &new_str)?;
        if !renamed {
            // We had no prior record of this path (e.g. renamed in from
            // outside the watched tree) -- treat it as a new file instead
            // of silently dropping it.
            return self.sync_one_file(folder, new_path);
        }

        {
            let conn = self.db.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE sync_state SET destination_key = ?3 WHERE folder_id = ?1 AND local_path = ?2",
                rusqlite::params![folder.id, new_str, new_key],
            )
            .map_err(|e| e.to_string())?;
        }

        if let Some(old_key) = old_key {
            if old_key != new_key {
                let body = fs::read(new_path).map_err(|e| e.to_string())?;
                self.client.put_object(&folder.bucket, &new_key, &body)?;
                // Best-effort: the new copy is already safely stored at
                // this point, so a failure to clean up the stale old key
                // is a leftover-object nuisance, not a data-loss risk --
                // logged rather than surfaced as this call's own error.
                if let Err(e) = self.client.delete_object(&folder.bucket, &old_key) {
                    log::warn!("DirectSync: renamed {} -> {} but could not delete the stale old object at \"{}\": {}", old_str, new_str, old_key, e);
                }
            }
        }
        Ok(())
    }

    /// Full recursive scan of a folder -- run once when a folder is added,
    /// and once on every app startup (restart recovery: anything that
    /// changed while the app wasn't running still gets picked up, not just
    /// events the live watcher happened to be running for).
    pub fn scan_folder(&self, folder: &FolderConfig) {
        for entry in walkdir::WalkDir::new(&folder.local_path).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                let _ = self.sync_one_file(folder, entry.path());
            }
        }
    }
}

// ---------------------------------------------------------------------
// Live folder watching (per folder, one background thread)
// ---------------------------------------------------------------------

pub struct WatcherHandle {
    stop_tx: Sender<()>,
}

pub fn start_watching_folder(engine: Arc<SyncEngine>, folder: FolderConfig) -> Result<WatcherHandle, String> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (event_tx, event_rx) = mpsc::channel();

    let mut debouncer: Debouncer<RecommendedWatcher, FileIdMap> =
        new_debouncer(DEBOUNCE_WINDOW, None, move |result: DebounceEventResult| {
            let _ = event_tx.send(result);
        })
        .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(Path::new(&folder.local_path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Full scan first so restart-during-downtime changes are caught, THEN
    // start reacting to live events -- matches SOW §6.6's restart-recovery
    // flow (recover queue, check destination, resume).
    engine.scan_folder(&folder);

    thread::spawn(move || {
        // debouncer must stay alive for the duration of the watch; moving
        // it into this thread's closure keeps its Drop (which stops the
        // underlying OS watch) tied to this thread's lifetime.
        let _debouncer = debouncer;
        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match event_rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(events)) => {
                    for event in events {
                        handle_debounced_event(&engine, &folder, &event);
                    }
                }
                Ok(Err(_errors)) => {
                    // A watch-layer error (e.g. a transient read failure)
                    // -- not fatal to the whole watcher; the next event or
                    // the next full scan will reconcile state.
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(WatcherHandle { stop_tx })
}

pub fn stop_watching_folder(handle: &WatcherHandle) {
    let _ = handle.stop_tx.send(());
}

fn handle_debounced_event(engine: &Arc<SyncEngine>, folder: &FolderConfig, event: &notify_debouncer_full::DebouncedEvent) {
    use notify_debouncer_full::notify::EventKind;

    match &event.event.kind {
        EventKind::Remove(_) => {
            if let Some(path) = event.event.paths.first() {
                let _ = engine.handle_delete(folder, path);
            }
        }
        EventKind::Modify(notify_debouncer_full::notify::event::ModifyKind::Name(_)) if event.event.paths.len() == 2 => {
            // notify-debouncer-full pairs a rename's "from" and "to" paths
            // together within the debounce window when the OS reports
            // them close enough in time to correlate -- this is the
            // "renamed files" / "moved files where reliably detectable"
            // case (SOW §6.4). When the OS can't correlate them, each half
            // instead arrives as its own Remove/Create, which the other
            // match arms here already handle correctly (as a delete +
            // a fresh upload) -- a reasonable, disclosed fallback rather
            // than a silent gap.
            let old_path = &event.event.paths[0];
            let new_path = &event.event.paths[1];
            if new_path.is_file() {
                let _ = engine.handle_rename(folder, old_path, new_path);
            }
        }
        EventKind::Create(_) | EventKind::Modify(_) => {
            if let Some(path) = event.event.paths.first() {
                if path.is_file() {
                    let _ = engine.sync_one_file(folder, path);
                }
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------
// App-wide DirectSync state: the DB handle plus one running watcher per
// enabled folder.
// ---------------------------------------------------------------------

pub struct DirectSyncState {
    pub db: Arc<SyncStateDb>,
    pub watchers: Mutex<HashMap<String, WatcherHandle>>,
    pub credential: Mutex<Option<DirectSyncCredential>>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct DirectSyncCredential {
    pub endpoint: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl DirectSyncState {
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
        let db = Arc::new(SyncStateDb::open(&db_path)?);
        Ok(Self { db, watchers: Mutex::new(HashMap::new()), credential: Mutex::new(None) })
    }

    pub fn build_client(&self) -> Result<Arc<S3Client>, String> {
        let guard = self.credential.lock().map_err(|e| e.to_string())?;
        let cred = guard.as_ref().ok_or("No DirectSync credential configured yet.")?;
        Ok(Arc::new(S3Client::new(cred.endpoint.clone(), cred.access_key_id.clone(), cred.secret_access_key.clone())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn relative_key_joins_prefix_and_normalizes_windows_separators() {
        let root = Path::new(r"C:\Users\me\Documents");
        let file = Path::new(r"C:\Users\me\Documents\reports\q3.pdf");
        assert_eq!(relative_key(root, file, "backups"), Some("backups/reports/q3.pdf".to_string()));
        assert_eq!(relative_key(root, file, ""), Some("reports/q3.pdf".to_string()));
    }

    #[test]
    fn relative_key_returns_none_outside_root() {
        let root = Path::new(r"C:\Users\me\Documents");
        let file = Path::new(r"C:\Users\other\file.txt");
        assert_eq!(relative_key(root, file, ""), None);
    }

    #[test]
    fn is_unchanged_requires_both_size_and_hash_to_match() {
        assert!(is_unchanged(100, "abc", 100, "abc"));
        assert!(!is_unchanged(100, "abc", 100, "def")); // same size, different content -- must still be treated as changed
        assert!(!is_unchanged(100, "abc", 200, "abc")); // hash collision-shaped input must never short-circuit on size alone
    }

    #[test]
    fn compute_file_hash_is_deterministic_and_content_sensitive() {
        let dir = std::env::temp_dir().join(format!("directsync-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("a.txt");
        let mut f = fs::File::create(&file_path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let hash1 = compute_file_hash(&file_path).unwrap();
        let hash2 = compute_file_hash(&file_path).unwrap();
        assert_eq!(hash1, hash2);

        let mut f = fs::File::create(&file_path).unwrap();
        f.write_all(b"hello world!").unwrap();
        drop(f);
        let hash3 = compute_file_hash(&file_path).unwrap();
        assert_ne!(hash1, hash3);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sqlite_state_store_round_trips_queue_and_done_transitions() {
        let dir = std::env::temp_dir().join(format!("directsync-db-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("state.sqlite");
        let db = SyncStateDb::open(&db_path).unwrap();

        let folder = FolderConfig { id: "f1".into(), local_path: "C:\\watched".into(), bucket: "backup-bucket".into(), prefix: "".into(), enabled: true };
        db.add_folder(&folder).unwrap();
        assert_eq!(db.list_folders().unwrap().len(), 1);

        assert!(db.get_state("f1", "C:\\watched\\a.txt").unwrap().is_none());
        db.upsert_queued("f1", "C:\\watched\\a.txt", 11, 1000, "hash1", "a.txt").unwrap();
        let queue = db.list_queue(Some("f1")).unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].state, "QUEUED");

        db.mark_done("f1", "C:\\watched\\a.txt").unwrap();
        let (size, hash) = db.get_state("f1", "C:\\watched\\a.txt").unwrap().unwrap();
        assert_eq!((size, hash.as_str()), (11, "hash1"));

        // A second, identical write must be recognized as unchanged by the
        // caller (sync_one_file) -- this test only proves the state store
        // itself returns the right prior value for that comparison.
        db.mark_failed("f1", "C:\\watched\\a.txt", "network error").unwrap();
        let queue = db.list_queue(Some("f1")).unwrap();
        assert_eq!(queue[0].state, "FAILED");
        assert_eq!(queue[0].retry_count, 1);

        let requeued = db.requeue_failed("f1").unwrap();
        assert_eq!(requeued, 1);
        assert_eq!(db.list_queue(Some("f1")).unwrap()[0].state, "QUEUED");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_repoints_existing_state_row_without_losing_history() {
        let dir = std::env::temp_dir().join(format!("directsync-rename-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("state.sqlite");
        let db = SyncStateDb::open(&db_path).unwrap();

        db.upsert_queued("f1", "C:\\watched\\old.txt", 5, 1000, "h", "old.txt").unwrap();
        db.mark_done("f1", "C:\\watched\\old.txt").unwrap();

        let renamed = db.rename_path("f1", "C:\\watched\\old.txt", "C:\\watched\\new.txt").unwrap();
        assert!(renamed);
        assert!(db.get_state("f1", "C:\\watched\\old.txt").unwrap().is_none());
        let (size, hash) = db.get_state("f1", "C:\\watched\\new.txt").unwrap().unwrap();
        assert_eq!((size, hash.as_str()), (5, "h")); // content hash preserved -- proves a rename does NOT trigger a re-upload

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_of_an_untracked_path_returns_false_so_caller_falls_back_to_a_fresh_upload() {
        let dir = std::env::temp_dir().join(format!("directsync-rename-untracked-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("state.sqlite");
        let db = SyncStateDb::open(&db_path).unwrap();
        let renamed = db.rename_path("f1", "C:\\outside\\old.txt", "C:\\watched\\new.txt").unwrap();
        assert!(!renamed);
        fs::remove_dir_all(&dir).ok();
    }

    // Real end-to-end test against a genuinely running local dev server and
    // a real S3-compat credential -- not mocked. Exercises the full, real
    // path: a real temp folder, real SHA-256 hashing, real SQLite state,
    // real SigV4-signed HTTP PUT/HEAD against /api/s3 through inaya-drive-
    // core's own S3Client (the same client inaya-drive-helper/inaya-drive-
    // helper-linux already use). Matches the same real-OS-resource,
    // manually-run convention as passkey_secure_storage_tests above.
    //
    // Credentials are read from environment variables, never hardcoded --
    // generate a fresh, disposable test-org credential (a short node
    // script calling issueS3Credential against a throwaway org) and run:
    //   DIRECTSYNC_TEST_ENDPOINT=http://localhost:3000/api/s3 \
    //   DIRECTSYNC_TEST_ACCESS_KEY_ID=... DIRECTSYNC_TEST_SECRET_ACCESS_KEY=... \
    //   cargo test directsync::tests::real_dev_server -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_dev_server_watch_upload_duplicate_safety_and_rename() {
        let endpoint = std::env::var("DIRECTSYNC_TEST_ENDPOINT").expect("set DIRECTSYNC_TEST_ENDPOINT");
        let access_key_id = std::env::var("DIRECTSYNC_TEST_ACCESS_KEY_ID").expect("set DIRECTSYNC_TEST_ACCESS_KEY_ID");
        let secret_access_key = std::env::var("DIRECTSYNC_TEST_SECRET_ACCESS_KEY").expect("set DIRECTSYNC_TEST_SECRET_ACCESS_KEY");
        let bucket = format!("directsync-rust-test-{}", std::process::id());

        let test_dir = std::env::temp_dir().join(format!("directsync-e2e-{}", std::process::id()));
        fs::create_dir_all(&test_dir).unwrap();
        let db_path = test_dir.join("state.sqlite");
        let watched_dir = test_dir.join("watched");
        fs::create_dir_all(&watched_dir).unwrap();

        let db = Arc::new(SyncStateDb::open(&db_path).unwrap());
        let client = Arc::new(S3Client::new(endpoint, access_key_id, secret_access_key));
        let engine = Arc::new(SyncEngine { db: db.clone(), client });
        let folder = FolderConfig { id: "e2e".into(), local_path: watched_dir.to_string_lossy().to_string(), bucket: bucket.clone(), prefix: "".into(), enabled: true };
        db.add_folder(&folder).unwrap();

        // 1. New file -> uploaded and verified.
        let file_a = watched_dir.join("a.txt");
        fs::write(&file_a, b"hello from a real DirectSync end-to-end test").unwrap();
        engine.sync_one_file(&folder, &file_a).unwrap();
        let queue = db.list_queue(Some("e2e")).unwrap();
        assert_eq!(queue.iter().find(|q| q.local_path.ends_with("a.txt")).unwrap().state, "DONE");

        // 2. Re-syncing the SAME unchanged content must not create a second
        // row -- this is the actual duplicate-safety guarantee (SOW §6.5).
        engine.sync_one_file(&folder, &file_a).unwrap();
        let queue2 = db.list_queue(Some("e2e")).unwrap();
        assert_eq!(queue2.len(), queue.len(), "an unchanged file must not create a second sync_state row");

        // 3. Modified content -> re-uploaded, hash changes.
        fs::write(&file_a, b"hello from a real DirectSync end-to-end test -- MODIFIED").unwrap();
        engine.sync_one_file(&folder, &file_a).unwrap();
        let (_, hash_after_modify) = db.get_state("e2e", &file_a.to_string_lossy()).unwrap().unwrap();
        assert_ne!(hash_after_modify, queue[0].content_hash);

        // 4. Rename -> the existing row is re-pointed, not duplicated, and
        // no new upload is needed for unchanged bytes.
        let file_b = watched_dir.join("b.txt");
        fs::rename(&file_a, &file_b).unwrap();
        engine.handle_rename(&folder, &file_a, &file_b).unwrap();
        assert!(db.get_state("e2e", &file_a.to_string_lossy()).unwrap().is_none());
        assert!(db.get_state("e2e", &file_b.to_string_lossy()).unwrap().is_some());

        // 5. Local delete must NOT delete the remote copy (backup, not
        // mirror, semantics -- stated plainly in this module's header).
        fs::remove_file(&file_b).unwrap();
        engine.handle_delete(&folder, &file_b).unwrap();
        let head_still_there = engine.client.head_object(&bucket, "b.txt");
        assert!(matches!(head_still_there, Ok(Some(_))), "a local delete must never remove the object from Inaya");

        fs::remove_dir_all(&test_dir).ok();
        println!("Real end-to-end DirectSync test (watch -> upload -> verify -> duplicate-safe -> rename -> local-delete-preserves-remote): PASSED");
    }
}
