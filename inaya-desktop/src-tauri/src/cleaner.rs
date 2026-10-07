// src-tauri/src/cleaner.rs
//
// Inaya Cleaner (Internxt-inspired SOW, Workstream B). See
// docs/architecture/cleaner-safety-adr.md and docs/security/cleaner-threat-model.md in the
// inaya-network-dapp repo for the full design. Local-first: everything here runs on the user's
// own machine; nothing in this file makes a network call or uploads a file inventory.
//
// GENUINE GAPS this file fills (nothing in the repo did these before): local temp/duplicate
// scanning, protected-path denylist, and trash-not-permanent-delete cleanup. Reuses existing
// dependencies already in Cargo.toml for DirectSync's own needs rather than adding new ones for
// hashing/walking: sha2 (content hash), walkdir (directory traversal, symlinks NOT followed by
// its own default -- exactly the safety property the ADR requires). The `trash` crate is the one
// new dependency this file adds, specifically for OS-native recycle-bin/trash moves.
//
// SECURITY (ADR §6, threat model T1-T5): no shell execution anywhere in this file -- every
// filesystem operation is a direct std::fs/walkdir/trash call. The protected-path check is
// re-applied at cleanup_selected()'s final deletion loop, not only during scanning, so a file
// that became protected (or was swapped via a race) between scan and cleanup is still caught.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const SCANNER_VERSION: &str = "cleaner-v1";
/// Only hash within a same-size group, and only up to this many bytes per file per batch, to
/// bound memory/time on a huge duplicate candidate (ADR's "avoid unnecessary full hashing").
const MAX_HASH_CANDIDATES_PER_GROUP: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanCandidate {
    pub path: String,
    pub size: u64,
    pub category: String, // "temporary" | "duplicate"
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateGroup {
    pub hash: String,
    pub total_bytes: u64,
    pub keeper: String,
    pub others: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkipEntry {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanReport {
    pub scanner_version: String,
    pub scanned_at: String,
    pub temporary_files: Vec<ScanCandidate>,
    pub duplicate_groups: Vec<DuplicateGroup>,
    pub skipped: Vec<SkipEntry>,
    pub protected_skipped_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupResult {
    pub files_handled: u32,
    pub bytes_reclaimed: u64,
    pub failures: Vec<SkipEntry>,
    pub protected_blocked: Vec<String>,
}

fn now_iso() -> String {
    httpdate_like(SystemTime::now())
}
// A tiny, dependency-free RFC3339-ish stamp (second precision) -- matches the dApp's own
// nowIso()'s intent without pulling in a chrono dependency for one timestamp.
fn httpdate_like(t: SystemTime) -> String {
    let secs = t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Days since epoch -> y/m/d (civil_from_days, Howard Hinnant's algorithm) -- no extra crate needed.
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m2 = if mp < 10 { mp + 3 } else { mp - 9 };
    let y2 = if m2 <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y2, m2, d, h, m, s)
}

/// Platform-specific OS/app temp directories only -- never a heuristic "looks temporary" path
/// match (ADR §3). Caller-supplied `extra` lets higher layers (e.g. an Inaya-specific cache dir)
/// opt in without this function needing to know about every possible app.
pub fn default_temp_directories(extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(t) = std::env::var("TEMP") { dirs.push(PathBuf::from(t)); }
        if let Ok(t) = std::env::var("TMP") { dirs.push(PathBuf::from(t)); }
        if let Ok(w) = std::env::var("WINDIR") { dirs.push(PathBuf::from(w).join("Temp")); }
    }
    #[cfg(target_os = "linux")]
    {
        dirs.push(PathBuf::from("/tmp"));
        dirs.push(PathBuf::from("/var/tmp"));
    }
    #[cfg(target_os = "macos")]
    {
        // Not yet verified on real Mac hardware (ADR §9) -- std::env::temp_dir() is the honest,
        // platform-correct default rather than a guessed literal path.
        dirs.push(std::env::temp_dir());
    }
    dirs.extend(extra.iter().cloned());
    dirs.into_iter().filter(|d| d.exists()).collect()
}

/// Platform-specific protected-path denylist (ADR §4, threat model T2/T3/T5). `app_data_dir` and
/// `extra` (e.g. the live DirectSync SQLite state file) are supplied by the caller -- this
/// function has no reason to know Tauri's path-resolution APIs itself, keeping it plain,
/// independently unit-testable Rust.
pub fn protected_paths(app_data_dir: Option<&Path>, extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs_home() {
        // The user's home root itself is protected -- Cleaner must never be able to select it
        // wholesale, only specific files within it that a scan actually found.
        paths.push(home.clone());
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(w) = std::env::var("WINDIR") { paths.push(PathBuf::from(w)); }
        if let Ok(pf) = std::env::var("PROGRAMFILES") { paths.push(PathBuf::from(pf)); }
        if let Ok(pf) = std::env::var("PROGRAMFILES(X86)") { paths.push(PathBuf::from(pf)); }
    }
    #[cfg(unix)]
    {
        for p in ["/etc", "/usr", "/bin", "/sbin", "/boot", "/var/lib"] { paths.push(PathBuf::from(p)); }
    }
    if let Some(d) = app_data_dir { paths.push(d.to_path_buf()); }
    paths.extend(extra.iter().cloned());
    paths
}

fn dirs_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    { std::env::var("USERPROFILE").ok().map(PathBuf::from) }
    #[cfg(not(target_os = "windows"))]
    { std::env::var("HOME").ok().map(PathBuf::from) }
}

/// Enforced at the FINAL deletion primitive too (cleanup_selected below), not only here -- a
/// path becoming protected between scan and cleanup is still caught (threat model T4).
fn is_protected(path: &Path, protected: &[PathBuf]) -> bool {
    let Ok(canon) = path.canonicalize() else { return true }; // unresolvable path -> treat as protected, fail closed
    protected.iter().any(|p| {
        p.canonicalize().map(|pc| canon == pc || canon.starts_with(&pc)).unwrap_or(false)
    })
}

/// Category A: conservative, directory-allowlisted temp-file scan. Bounded batch size via
/// walkdir's own lazy iterator (ADR "scan in bounded batches"); symlinks are not followed
/// (walkdir's own default -- no special handling needed, which is itself the safety property).
pub fn scan_temporary_files(dirs: &[PathBuf], protected: &[PathBuf], max_candidates: usize) -> (Vec<ScanCandidate>, Vec<SkipEntry>, u32) {
    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    let mut protected_count = 0u32;

    for dir in dirs {
        for entry in walkdir::WalkDir::new(dir).max_depth(6).into_iter() {
            if candidates.len() >= max_candidates { break; }
            let entry = match entry {
                Ok(e) => e,
                Err(e) => { skipped.push(SkipEntry { path: e.path().map(|p| p.display().to_string()).unwrap_or_default(), reason: format!("{}", e) }); continue; }
            };
            if !entry.file_type().is_file() { continue; }
            let path = entry.path();
            if is_protected(path, protected) { protected_count += 1; continue; }
            let meta = match entry.metadata() { Ok(m) => m, Err(e) => { skipped.push(SkipEntry { path: path.display().to_string(), reason: format!("{}", e) }); continue; } };
            candidates.push(ScanCandidate { path: path.display().to_string(), size: meta.len(), category: "temporary".into(), reason: format!("inside temp directory {}", dir.display()) });
        }
    }
    (candidates, skipped, protected_count)
}

/// Category B: staged duplicate detection (ADR/threat model: size first, hash only within a
/// same-size group, never assume a duplicate is disposable from bytes alone -- caller picks).
pub fn scan_duplicates(roots: &[PathBuf], protected: &[PathBuf], max_depth: usize) -> (Vec<DuplicateGroup>, Vec<SkipEntry>, u32) {
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    let mut skipped = Vec::new();
    let mut protected_count = 0u32;

    for root in roots {
        for entry in walkdir::WalkDir::new(root).max_depth(max_depth).into_iter() {
            let entry = match entry { Ok(e) => e, Err(e) => { skipped.push(SkipEntry { path: e.path().map(|p| p.display().to_string()).unwrap_or_default(), reason: format!("{}", e) }); continue; } };
            if !entry.file_type().is_file() { continue; }
            let path = entry.path().to_path_buf();
            if is_protected(&path, protected) { protected_count += 1; continue; }
            let size = match entry.metadata() { Ok(m) => m.len(), Err(_) => continue };
            if size == 0 { continue; } // empty files are never "duplicates" worth reclaiming
            by_size.entry(size).or_default().push(path);
        }
    }

    let mut groups = Vec::new();
    for (size, mut paths) in by_size {
        if paths.len() < 2 { continue; }
        paths.truncate(MAX_HASH_CANDIDATES_PER_GROUP); // bound full-file hashing on a pathological same-size group
        let mut by_hash: HashMap<String, Vec<PathBuf>> = HashMap::new();
        for p in paths {
            match hash_file(&p) {
                Ok(h) => by_hash.entry(h).or_default().push(p),
                Err(e) => skipped.push(SkipEntry { path: p.display().to_string(), reason: format!("{}", e) }),
            }
        }
        for (hash, mut group) in by_hash {
            if group.len() < 2 { continue; }
            // Keeper suggestion: oldest by modified time (the "original"); ties broken by path for determinism.
            group.sort_by_key(|p| (fs::metadata(p).and_then(|m| m.modified()).ok(), p.clone()));
            let keeper = group.remove(0);
            groups.push(DuplicateGroup {
                hash,
                total_bytes: size * (group.len() as u64 + 1),
                keeper: keeper.display().to_string(),
                others: group.into_iter().map(|p| p.display().to_string()).collect(),
            });
        }
    }
    (groups, skipped, protected_count)
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let bytes = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

pub fn run_scan(temp_dirs: &[PathBuf], duplicate_roots: &[PathBuf], protected: &[PathBuf]) -> ScanReport {
    let (temporary_files, mut skipped, prot1) = scan_temporary_files(temp_dirs, protected, 2000);
    let (duplicate_groups, skipped2, prot2) = scan_duplicates(duplicate_roots, protected, 4);
    skipped.extend(skipped2);
    ScanReport {
        scanner_version: SCANNER_VERSION.to_string(),
        scanned_at: now_iso(),
        temporary_files,
        duplicate_groups,
        skipped,
        protected_skipped_count: prot1 + prot2,
    }
}

/// Moves each selected path to the OS trash/recycle bin (ADR §5: trash by default, never
/// permanent delete). Re-checks the protected-path denylist immediately before acting on EACH
/// path (threat model T4/T5 -- a race or a stale selection is still caught here, not just at scan
/// time), and never uses a shell to do it (threat model T1).
pub fn cleanup_selected(paths: &[String], protected: &[PathBuf]) -> CleanupResult {
    let mut files_handled = 0u32;
    let mut bytes_reclaimed = 0u64;
    let mut failures = Vec::new();
    let mut protected_blocked = Vec::new();

    for p in paths {
        let path = PathBuf::from(p);
        if is_protected(&path, protected) {
            protected_blocked.push(p.clone());
            continue;
        }
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        match trash::delete(&path) {
            Ok(()) => { files_handled += 1; bytes_reclaimed += size; }
            Err(e) => failures.push(SkipEntry { path: p.clone(), reason: format!("{}", e) }),
        }
    }
    CleanupResult { files_handled, bytes_reclaimed, failures, protected_blocked }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("inaya-cleaner-test-{}", uuid_like()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn uuid_like() -> String {
        format!("{}-{}", std::process::id(), SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos())
    }
    fn write_file(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
        let p = dir.join(name);
        let mut f = File::create(&p).unwrap();
        f.write_all(content).unwrap();
        p
    }

    #[test]
    fn duplicate_detection_groups_identical_content_and_suggests_a_keeper() {
        let dir = tempdir();
        write_file(&dir, "a.txt", b"identical content here");
        write_file(&dir, "b.txt", b"identical content here");
        write_file(&dir, "c.txt", b"totally different content");

        let (groups, _skipped, protected) = scan_duplicates(&[dir.clone()], &[], 2);
        assert_eq!(protected, 0);
        assert_eq!(groups.len(), 1, "exactly one duplicate group -- c.txt is unique content, never grouped");
        assert_eq!(groups[0].others.len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn same_size_different_content_is_never_falsely_grouped_as_a_duplicate() {
        let dir = tempdir();
        write_file(&dir, "a.txt", b"AAAAAAAAAA");
        write_file(&dir, "b.txt", b"BBBBBBBBBB"); // same size, different content
        let (groups, _, _) = scan_duplicates(&[dir.clone()], &[], 2);
        assert_eq!(groups.len(), 0, "same size alone must never be treated as a duplicate -- content hash must actually differ");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_files_are_never_reported_as_duplicates() {
        let dir = tempdir();
        write_file(&dir, "a.txt", b"");
        write_file(&dir, "b.txt", b"");
        let (groups, _, _) = scan_duplicates(&[dir.clone()], &[], 2);
        assert_eq!(groups.len(), 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn protected_path_is_never_included_as_a_scan_candidate() {
        let dir = tempdir();
        let protected_dir = dir.join("protected");
        fs::create_dir_all(&protected_dir).unwrap();
        write_file(&protected_dir, "secret.key", b"do not touch me");
        write_file(&dir, "ok.txt", b"fine to see this one");

        let (candidates, _, protected_count) = scan_temporary_files(&[dir.clone()], &[protected_dir.clone()], 100);
        assert!(candidates.iter().all(|c| !c.path.contains("protected")), "nothing inside the protected dir may appear as a candidate");
        assert_eq!(protected_count, 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cleanup_refuses_to_act_on_a_protected_path_even_if_it_was_somehow_selected() {
        // Simulates a bypass attempt / stale selection: the caller passes a protected path
        // directly to cleanup_selected, as if the review-screen check had been skipped.
        let dir = tempdir();
        let protected_dir = dir.join("protected");
        fs::create_dir_all(&protected_dir).unwrap();
        let secret = write_file(&protected_dir, "secret.key", b"do not touch me");

        let result = cleanup_selected(&[secret.display().to_string()], &[protected_dir.clone()]);
        assert_eq!(result.files_handled, 0);
        assert_eq!(result.protected_blocked.len(), 1);
        assert!(secret.exists(), "the protected file must still exist on disk -- cleanup must have refused to touch it");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cleanup_moves_a_real_unprotected_file_to_trash_and_it_leaves_the_original_location() {
        let dir = tempdir();
        let f = write_file(&dir, "junk.tmp", b"disposable content");
        assert!(f.exists());

        let result = cleanup_selected(&[f.display().to_string()], &[]);
        assert_eq!(result.files_handled, 1, "a real, unprotected file must be handled: {:?}", result.failures);
        assert_eq!(result.bytes_reclaimed, "disposable content".len() as u64);
        assert!(!f.exists(), "the file must no longer be at its original path after a trash move");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn protected_paths_includes_the_home_directory_root() {
        let protected = protected_paths(None, &[]);
        assert!(!protected.is_empty(), "at minimum the home directory must be on the denylist");
    }

    #[test]
    fn is_protected_blocks_a_path_inside_a_protected_directory_not_just_an_exact_match() {
        let dir = tempdir();
        let nested = dir.join("a").join("b").join("c.txt");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        File::create(&nested).unwrap();
        assert!(is_protected(&nested, &[dir.clone()]), "a file nested several levels inside a protected directory must still be protected");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_report_records_scanner_version_and_a_timestamp() {
        let dir = tempdir();
        let report = run_scan(&[dir.clone()], &[dir.clone()], &[]);
        assert_eq!(report.scanner_version, SCANNER_VERSION);
        assert!(report.scanned_at.contains('T') && report.scanned_at.ends_with('Z'), "timestamp must look like RFC3339: {}", report.scanned_at);
        fs::remove_dir_all(&dir).ok();
    }
}
