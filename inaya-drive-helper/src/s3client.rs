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

    pub fn delete_object(&self, bucket: &str, key: &str) -> Result<(), String> {
        let path = format!("/api/s3/{}/{}", bucket, key);
        let headers = self.signed_headers("DELETE", &path, &[], b"");
        let resp = self.client.delete(self.url_for(&format!("/{}/{}", bucket, key), &[])).headers(headers).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() && resp.status() != 204 { return Err(format!("DELETE failed: {}", resp.status())); }
        Ok(())
    }
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
