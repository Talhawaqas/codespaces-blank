// src/s3client.rs
//
// A minimal real S3 client -- calls this repo's own, already-tested
// /api/s3 REST endpoint (SigV4-authenticated) exactly the way the real AWS
// CLI already does. No new server-side surface: this is the same protocol
// every existing test in test/s3-compat-store.test.mjs and the earlier
// live AWS CLI session already verified end-to-end.

use crate::sigv4;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::time::Duration;

pub struct S3Client {
    pub endpoint: String, // e.g. "http://localhost:3000/api/s3"
    pub host: String,     // e.g. "localhost:3000" -- must match endpoint's authority exactly
    pub access_key_id: String,
    pub secret_access_key: String,
    client: Client,
}

#[derive(Debug, Clone)]
pub struct ObjectEntry {
    pub key: String,
    pub size: u64,
    pub is_prefix: bool, // a "directory" (S3 CommonPrefix), not a real object
}

/// Folder-operation failure carrying the real HTTP status the /api/s3
/// ?folder routes returned (409/400/404/...), so main.rs can map each one
/// to its own NTSTATUS instead of one generic "device failure" -- the
/// SOW's own explicit error-handling requirement.
#[derive(Debug)]
pub struct FolderOpError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for FolderOpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.status)
    }
}

impl S3Client {
    pub fn new(endpoint: String, access_key_id: String, secret_access_key: String) -> Self {
        let host = endpoint
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or("localhost:3000")
            .to_string();
        S3Client {
            endpoint,
            host,
            access_key_id,
            secret_access_key,
            client: Client::builder().timeout(Duration::from_secs(30)).build().expect("reqwest client"),
        }
    }

    fn signed_headers(&self, method: &str, path: &str, query: &[(String, String)], body: &[u8]) -> HeaderMap {
        let signed = sigv4::sign(method, &self.host, path, query, &self.access_key_id, &self.secret_access_key, body);
        let mut map = HeaderMap::new();
        for (k, v) in signed.headers {
            map.insert(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(&v).unwrap());
        }
        map
    }

    fn url_for(&self, path: &str, query: &[(String, String)]) -> String {
        let base = self.endpoint.trim_end_matches('/');
        let qs: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", k, urlencode(v))).collect();
        if qs.is_empty() {
            format!("{}{}", base, path)
        } else {
            format!("{}{}?{}", base, path, qs.join("&"))
        }
    }

    pub fn list_buckets(&self) -> Result<Vec<String>, String> {
        let path = "/api/s3".to_string();
        let headers = self.signed_headers("GET", &path, &[], b"");
        let resp = self.client.get(self.url_for("", &[])).headers(headers).send().map_err(|e| e.to_string())?;
        let text = resp.text().map_err(|e| e.to_string())?;
        Ok(extract_all(&text, "Name"))
    }

    pub fn list_objects(&self, bucket: &str, prefix: &str) -> Result<Vec<ObjectEntry>, String> {
        let path = format!("/api/s3/{}", bucket);
        let query = vec![
            ("prefix".to_string(), prefix.to_string()),
            ("delimiter".to_string(), "/".to_string()),
        ];
        let headers = self.signed_headers("GET", &path, &query, b"");
        let resp = self.client.get(self.url_for(&format!("/{}", bucket), &query)).headers(headers).send().map_err(|e| e.to_string())?;
        let text = resp.text().map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for full_key in extract_all(&text, "Key") {
            let name = full_key.strip_prefix(prefix).unwrap_or(&full_key).to_string();
            if name.is_empty() { continue; }
            let size = extract_sibling_u64(&text, "Key", &full_key, "Size").unwrap_or(0);
            entries.push(ObjectEntry { key: name, size, is_prefix: false });
        }
        for cp in extract_all(&text, "Prefix") {
            if cp == prefix { continue; }
            let name = cp.strip_prefix(prefix).unwrap_or(&cp).trim_end_matches('/').to_string();
            if name.is_empty() { continue; }
            entries.push(ObjectEntry { key: name, size: 0, is_prefix: true });
        }
        Ok(entries)
    }

    /// Real byte-range GET, using the exact Range-aware GetObject the S3
    /// route already implements -- lets the filesystem serve large files
    /// without downloading the whole object for every small read.
    pub fn get_object_range(&self, bucket: &str, key: &str, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let headers_base = self.signed_headers("GET", &path, &[], b"");
        let mut headers = headers_base;
        headers.insert("Range", HeaderValue::from_str(&format!("bytes={}-{}", offset, offset + len.saturating_sub(1))).unwrap());
        let resp = self.client.get(self.url_for(&format!("/{}/{}", bucket, key), &[])).headers(headers).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("GET failed: {}", resp.status()));
        }
        resp.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
    }

    pub fn head_object(&self, bucket: &str, key: &str) -> Result<Option<u64>, String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let headers = self.signed_headers("HEAD", &path, &[], b"");
        let resp = self.client.head(self.url_for(&format!("/{}/{}", bucket, key), &[])).headers(headers).send().map_err(|e| e.to_string())?;
        if resp.status() == 404 { return Ok(None); }
        let len = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        Ok(Some(len))
    }

    pub fn put_object(&self, bucket: &str, key: &str, body: &[u8]) -> Result<(), String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let headers = self.signed_headers("PUT", &path, &[], body);
        let resp = self.client.put(self.url_for(&format!("/{}/{}", bucket, key), &[])).headers(headers).body(body.to_vec()).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() { return Err(format!("PUT failed: {}", resp.status())); }
        Ok(())
    }

    /// A time-limited, shareable download link for one object ("Create Secure Link"). Pure signing, no network call: the server
    /// verifies it exactly like any SigV4 presigned URL. `expires_secs` is capped at the 7 days S3 allows.
    pub fn presigned_get_url(&self, bucket: &str, key: &str, expires_secs: u32) -> Result<String, String> {
        if bucket.is_empty() || key.is_empty() { return Err("A bucket and an object key are required.".to_string()); }
        if expires_secs == 0 || expires_secs > 7 * 24 * 3600 { return Err("A link must expire between 1 second and 7 days from now.".to_string()); }
        let path = format!("/api/s3/{}/{}", bucket, key);
        let query = sigv4::presign_query("GET", &self.host, &path, expires_secs, &self.access_key_id, &self.secret_access_key);
        let base = self.endpoint.trim_end_matches('/');
        let encoded_path = format!("/{}/{}", bucket, key).split('/').map(urlencode_path).collect::<Vec<_>>().join("/");
        Ok(format!("{}{}?{}", base, encoded_path, sigv4::encode_query(&query)))
    }

    // ------------------------------------------------------------------ multipart (resumable uploads)

    /// Starts a multipart upload; returns the uploadId. Parts are uploaded one at a time with upload_part() and the upload is
    /// finished with complete_multipart(). A caller that remembers the uploadId and the finished part ETags can resume after a crash.
    pub fn create_multipart(&self, bucket: &str, key: &str) -> Result<String, String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let query = vec![("uploads".to_string(), "".to_string())];
        let headers = self.signed_headers("POST", &path, &query, b"");
        let resp = self.client.post(self.url_for(&format!("/{}/{}", bucket, key), &query)).headers(headers).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() { return Err(format!("CreateMultipartUpload failed: {}", resp.status())); }
        let text = resp.text().map_err(|e| e.to_string())?;
        extract_all(&text, "UploadId").into_iter().next().ok_or_else(|| "The server did not return an UploadId.".to_string())
    }

    /// Uploads one part (1-based) and returns its ETag. A 404 means the upload no longer exists on the server (aborted or
    /// expired): the error text starts with "NoSuchUpload" so the caller knows to start over.
    pub fn upload_part(&self, bucket: &str, key: &str, upload_id: &str, part_number: u32, body: &[u8]) -> Result<String, String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let query = vec![("partNumber".to_string(), part_number.to_string()), ("uploadId".to_string(), upload_id.to_string())];
        let headers = self.signed_headers("PUT", &path, &query, body);
        let resp = self.client.put(self.url_for(&format!("/{}/{}", bucket, key), &query)).headers(headers).body(body.to_vec()).timeout(Duration::from_secs(180)).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        if status == 404 { return Err("NoSuchUpload: the multipart upload is gone on the server.".to_string()); }
        if !status.is_success() { return Err(format!("UploadPart {} failed: {}", part_number, status)); }
        Ok(resp.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").trim_matches('"').to_string())
    }

    /// Completing is where the server does the heavy work for the whole object (assemble, encrypt, shard, store), so it gets a much
    /// longer timeout than the client-wide 30 s default; a part upload gets a moderate one.
    pub fn complete_multipart(&self, bucket: &str, key: &str, upload_id: &str, parts: &[(u32, String)]) -> Result<(), String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let query = vec![("uploadId".to_string(), upload_id.to_string())];
        let mut xml = String::from("<CompleteMultipartUpload>");
        for (n, etag) in parts { xml.push_str(&format!("<Part><PartNumber>{}</PartNumber><ETag>\"{}\"</ETag></Part>", n, etag)); }
        xml.push_str("</CompleteMultipartUpload>");
        let headers = self.signed_headers("POST", &path, &query, xml.as_bytes());
        let resp = self.client.post(self.url_for(&format!("/{}/{}", bucket, key), &query)).headers(headers).body(xml).timeout(Duration::from_secs(600)).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        if status == 404 { return Err("NoSuchUpload: the multipart upload is gone on the server.".to_string()); }
        if !status.is_success() { return Err(format!("CompleteMultipartUpload failed: {}", status)); }
        Ok(())
    }

    pub fn abort_multipart(&self, bucket: &str, key: &str, upload_id: &str) -> Result<(), String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let query = vec![("uploadId".to_string(), upload_id.to_string())];
        let headers = self.signed_headers("DELETE", &path, &query, b"");
        let resp = self.client.delete(self.url_for(&format!("/{}/{}", bucket, key), &query)).headers(headers).send().map_err(|e| e.to_string())?;
        if resp.status().is_success() || resp.status() == 404 { Ok(()) } else { Err(format!("AbortMultipartUpload failed: {}", resp.status())) }
    }

    pub fn delete_object(&self, bucket: &str, key: &str) -> Result<(), String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let headers = self.signed_headers("DELETE", &path, &[], b"");
        let resp = self.client.delete(self.url_for(&format!("/{}/{}", bucket, key), &[])).headers(headers).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() && resp.status() != 204 { return Err(format!("DELETE failed: {}", resp.status())); }
        Ok(())
    }

    /// Creates a real, durable, empty-safe folder record at `folder_path`
    /// (Inaya's own `?folder` extension -- not part of the real S3
    /// protocol; see the server route's own comment). This is what makes
    /// Explorer's "New Folder" durable instead of the previous hard
    /// rejection.
    pub fn create_folder(&self, bucket: &str, folder_path: &str) -> Result<(), FolderOpError> {
        let path = format!("/api/s3/{}/{}", bucket, folder_path);
        let query = vec![("folder".to_string(), "".to_string())];
        let headers = self.signed_headers("PUT", &path, &query, b"");
        let resp = self.client.put(self.url_for(&format!("/{}/{}", bucket, folder_path), &query)).headers(headers).send()
            .map_err(|e| FolderOpError { status: 0, message: e.to_string() })?;
        folder_result(resp, &[200])
    }

    pub fn delete_folder(&self, bucket: &str, folder_path: &str) -> Result<(), FolderOpError> {
        let path = format!("/api/s3/{}/{}", bucket, folder_path);
        let query = vec![("folder".to_string(), "".to_string())];
        let headers = self.signed_headers("DELETE", &path, &query, b"");
        let resp = self.client.delete(self.url_for(&format!("/{}/{}", bucket, folder_path), &query)).headers(headers).send()
            .map_err(|e| FolderOpError { status: 0, message: e.to_string() })?;
        folder_result(resp, &[204])
    }

    pub fn rename_folder(&self, bucket: &str, old_folder_path: &str, new_folder_path: &str) -> Result<(), FolderOpError> {
        let path = format!("/api/s3/{}/{}", bucket, old_folder_path);
        let query = vec![("folder".to_string(), "".to_string()), ("to".to_string(), new_folder_path.to_string())];
        let headers = self.signed_headers("POST", &path, &query, b"");
        let resp = self.client.post(self.url_for(&format!("/{}/{}", bucket, old_folder_path), &query)).headers(headers).send()
            .map_err(|e| FolderOpError { status: 0, message: e.to_string() })?;
        folder_result(resp, &[200])
    }
}

fn folder_result(resp: reqwest::blocking::Response, ok_statuses: &[u16]) -> Result<(), FolderOpError> {
    let status = resp.status().as_u16();
    if ok_statuses.contains(&status) {
        return Ok(());
    }
    let message = resp.text().unwrap_or_default();
    Err(FolderOpError { status, message })
}

/// Percent-encodes one path segment the way SigV4 canonicalises it (so the URL path and the signed path agree).
fn urlencode_path(seg: &str) -> String {
    let mut out = String::new();
    for byte in seg.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') { out.push(c); } else { out.push_str(&format!("%{:02X}", byte)); }
    }
    out
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

// Pragmatic regex-free tag extraction -- the S3-compat layer's own XML
// responses (xml.js) are small, fixed, single-namespace shapes (matching
// this codebase's own established "not a full XML parser" convention used
// server-side for parseCompleteMultipartBody). Good enough for the real,
// bounded response shapes this endpoint actually returns.
fn extract_all(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        if let Some(end) = after.find(&close) {
            out.push(after[..end].to_string());
            rest = &after[end + close.len()..];
        } else {
            break;
        }
    }
    out
}

fn extract_sibling_u64(xml: &str, anchor_tag: &str, anchor_value: &str, sibling_tag: &str) -> Option<u64> {
    let anchor = format!("<{}>{}</{}>", anchor_tag, anchor_value, anchor_tag);
    let pos = xml.find(&anchor)?;
    let after = &xml[pos..];
    let open = format!("<{}>", sibling_tag);
    let close = format!("</{}>", sibling_tag);
    let start = after.find(&open)? + open.len();
    let end = after[start..].find(&close)? + start;
    after[start..end].parse::<u64>().ok()
}

/// Why an S3Client call failed, recovered from the error text it returned. The client's object calls report failures as plain
/// strings ("PUT failed: 403 Forbidden", a reqwest transport error, ...); changing those signatures would break every crate that
/// links this one, so the cause is parsed here instead. Platform helpers (the WinFSP drive maps it to an NTSTATUS) use this to
/// report a specific cause rather than one generic "device failure".
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ErrorCause {
    /// The server answered with this HTTP status.
    Http(u16),
    /// The request did not finish in time.
    Timeout,
    /// The server could not be reached (DNS, refused, reset, offline).
    Network,
    /// Anything else (a local I/O problem, an unexpected response shape).
    Other,
}

pub fn classify_error(msg: &str) -> ErrorCause {
    // "<what> failed: 403 Forbidden"  /  "UploadPart 2 failed: 503 Service Unavailable"
    if let Some(rest) = msg.split(" failed: ").nth(1) {
        if let Some(code) = rest.split_whitespace().next().and_then(|t| t.parse::<u16>().ok()) {
            if (100..600).contains(&code) { return ErrorCause::Http(code); }
        }
    }
    if msg.starts_with("NoSuchUpload") { return ErrorCause::Http(404); }
    let lower = msg.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") { return ErrorCause::Timeout; }
    if lower.contains("error sending request") || lower.contains("connection") || lower.contains("dns error") || lower.contains("tcp connect") {
        return ErrorCause::Network;
    }
    ErrorCause::Other
}

#[cfg(test)]
mod cause_tests {
    use super::*;

    #[test]
    fn classifies_http_status_timeout_and_network_failures() {
        assert_eq!(classify_error("PUT failed: 403 Forbidden"), ErrorCause::Http(403));
        assert_eq!(classify_error("GET failed: 404 Not Found"), ErrorCause::Http(404));
        assert_eq!(classify_error("UploadPart 2 failed: 503 Service Unavailable"), ErrorCause::Http(503));
        assert_eq!(classify_error("DELETE failed: 413 Payload Too Large"), ErrorCause::Http(413));
        assert_eq!(classify_error("NoSuchUpload: the multipart upload is gone on the server."), ErrorCause::Http(404));
        assert_eq!(classify_error("error sending request for url (http://x/y): operation timed out"), ErrorCause::Timeout);
        assert_eq!(classify_error("error sending request for url (http://localhost:3000/api/s3/b/k)"), ErrorCause::Network);
        assert_eq!(classify_error("tcp connect error: Connection refused (os error 10061)"), ErrorCause::Network);
        assert_eq!(classify_error("the file is locked by another process"), ErrorCause::Other);
        assert_eq!(classify_error("PUT failed: banana"), ErrorCause::Other, "a non-numeric status is not misread");
        assert_eq!(classify_error("x failed: 99999 weird"), ErrorCause::Other);
    }
}
