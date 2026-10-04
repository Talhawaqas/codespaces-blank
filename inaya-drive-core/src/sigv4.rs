// src/sigv4.rs
//
// AWS Signature Version 4 request SIGNING (the client side) -- a direct
// Rust port of this same repo's src/lib/s3-compat/sigv4.js VERIFICATION
// logic, run in reverse. Both sides implement the identical real AWS
// algorithm (canonical request -> string-to-sign -> derived signing key ->
// HMAC), so a request this module signs is verified by that same,
// already-tested server code with no new server-side trust surface.

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hex::encode(hasher.finalize())
}

fn hmac_bytes(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

// Percent-encodes a single path segment exactly as sigv4.js's own
// sigv4UriEncode does -- matching the server's canonicalUri() byte for
// byte is required, or the signature the server recomputes will not match.
fn sigv4_uri_encode(s: &str, encode_slash: bool) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        let c = byte as char;
        let unreserved = c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~');
        if unreserved {
            out.push(c);
        } else if c == '/' && !encode_slash {
            out.push('/');
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn canonical_uri(path: &str) -> String {
    let encoded: Vec<String> = path.split('/').map(|seg| sigv4_uri_encode(seg, false)).collect();
    let joined = encoded.join("/");
    if joined.is_empty() { "/".to_string() } else { joined }
}

/// SigV4 query-string signing ("presigned URL"): the same HMAC chain as header signing with the signature parameters in the
/// query string and an UNSIGNED-PAYLOAD body hash, exactly what the server's verifySigV4PresignedRequest() checks (and what
/// every AWS SDK's presigner produces). Only the host header is signed. Returns the FULL query (parameters + signature),
/// ready to append after `?`. `now` is injectable so the output can be pinned in a known-answer test.
pub fn presign_query_at(
    now: DateTime<Utc>,
    method: &str,
    host: &str,
    path: &str,
    expires_secs: u32,
    access_key_id: &str,
    secret_access_key: &str,
) -> Vec<(String, String)> {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let region = "inaya";
    let service = "s3";
    let credential_scope = format!("{}/{}/{}/aws4_request", date_stamp, region, service);

    let mut query: Vec<(String, String)> = vec![
        ("X-Amz-Algorithm".to_string(), "AWS4-HMAC-SHA256".to_string()),
        ("X-Amz-Credential".to_string(), format!("{}/{}", access_key_id, credential_scope)),
        ("X-Amz-Date".to_string(), amz_date.clone()),
        ("X-Amz-Expires".to_string(), expires_secs.to_string()),
        ("X-Amz-SignedHeaders".to_string(), "host".to_string()),
    ];
    query.sort();
    let canonical_query_string = encode_query(&query);
    let canonical_request = format!(
        "{}\n{}\n{}\nhost:{}\n\nhost\nUNSIGNED-PAYLOAD",
        method.to_uppercase(),
        canonical_uri(path),
        canonical_query_string,
        host
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );
    let k_date = hmac_bytes(format!("AWS4{}", secret_access_key).as_bytes(), &date_stamp);
    let k_region = hmac_bytes(&k_date, region);
    let k_service = hmac_bytes(&k_region, service);
    let k_signing = hmac_bytes(&k_service, "aws4_request");
    query.push(("X-Amz-Signature".to_string(), hex::encode(hmac_bytes(&k_signing, &string_to_sign))));
    query
}

pub fn presign_query(method: &str, host: &str, path: &str, expires_secs: u32, access_key_id: &str, secret_access_key: &str) -> Vec<(String, String)> {
    presign_query_at(Utc::now(), method, host, path, expires_secs, access_key_id, secret_access_key)
}

/// Query-string encoding that matches what the signature was computed over (the signed canonical query and the URL a client
/// requests must agree byte for byte). Pairs are emitted in the order given; presign_query_at() returns them already sorted
/// with the signature last, which S3 accepts.
pub fn encode_query(pairs: &[(String, String)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", sigv4_uri_encode(k, true), sigv4_uri_encode(v, true))).collect::<Vec<_>>().join("&")
}

pub struct SignedRequest {
    pub headers: Vec<(String, String)>,
}

/// Signs one S3 REST request. `path` must already be the raw request path
/// (e.g. "/bucket/key/with/slashes"), `query_pairs` pre-sorted-by-caller is
/// NOT required -- this function sorts them itself, matching the server's
/// own canonicalQueryString(). `payload` is the raw request body.
pub fn sign(
    method: &str,
    host: &str,
    path: &str,
    query_pairs: &[(String, String)],
    access_key_id: &str,
    secret_access_key: &str,
    payload: &[u8],
) -> SignedRequest {
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let region = "inaya";
    let service = "s3";

    let payload_hash = sha256_hex(payload);

    let mut sorted_query = query_pairs.to_vec();
    sorted_query.sort();
    let canonical_query_string = sorted_query
        .iter()
        .map(|(k, v)| format!("{}={}", sigv4_uri_encode(k, true), sigv4_uri_encode(v, true)))
        .collect::<Vec<_>>()
        .join("&");

    // Only host + x-amz-date + x-amz-content-sha256 are signed -- the
    // minimal signed-header set the server's own verifySigV4Request()
    // accepts, since it recomputes canonicalHeaders() over exactly the
    // headers named in SignedHeaders, not a fixed larger set.
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host, payload_hash, amz_date
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        canonical_uri(path),
        canonical_query_string,
        canonical_headers,
        signed_headers,
        payload_hash
    );

    let credential_scope = format!("{}/{}/{}/aws4_request", date_stamp, region, service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_bytes(format!("AWS4{}", secret_access_key).as_bytes(), &date_stamp);
    let k_region = hmac_bytes(&k_date, region);
    let k_service = hmac_bytes(&k_region, service);
    let k_signing = hmac_bytes(&k_service, "aws4_request");
    let signature = hex::encode(hmac_bytes(&k_signing, &string_to_sign));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key_id, credential_scope, signed_headers, signature
    );

    // Deliberately does NOT include an explicit "Host" header here: reqwest
    // (like most HTTP clients) sets Host itself from the request URL and
    // treats it as a reserved header, so trying to also set it manually
    // risks a value that silently doesn't match what's actually put on the
    // wire. The `host` PARAMETER above is only used to compute the
    // signature's canonical_headers string -- as long as callers pass the
    // exact host:port of the URL they're about to request, the signature
    // matches what the server actually receives, with no separate header
    // needed on the wire.
    SignedRequest {
        headers: vec![
            ("Authorization".to_string(), authorization),
            ("x-amz-date".to_string(), amz_date),
            ("x-amz-content-sha256".to_string(), payload_hash),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // Known-answer vector: test/s3-rust-presign-vector.test.mjs feeds this exact URL to the server's own
    // verifySigV4PresignedRequest() (itself proven against real AWS SDK presigned URLs). If this signer or that verifier
    // ever drifts, one of the two tests fails.
    const VECTOR_AKID: &str = "AKIAEXAMPLEKEY12345";
    const VECTOR_SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const VECTOR_QUERY: &str = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLEKEY12345%2F20261003%2Finaya%2Fs3%2Faws4_request&X-Amz-Date=20261003T123456Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=9e403ec49d142ae31d6d1e62a9c82c8381622cded4f4e78afc34b2154952d85a";

    #[test]
    fn presign_known_answer_vector() {
        let now = Utc.with_ymd_and_hms(2026, 10, 3, 12, 34, 56).unwrap();
        let q = presign_query_at(now, "GET", "127.0.0.1:3000", "/api/s3/my-bucket/folder/hello world.txt", 900, VECTOR_AKID, VECTOR_SECRET);
        println!("VECTOR_QUERY={}", encode_query(&q));
        assert_eq!(q.last().unwrap().0, "X-Amz-Signature");
        assert_eq!(q.last().unwrap().1.len(), 64);
        assert!(q.iter().any(|(k, v)| k == "X-Amz-Expires" && v == "900"));
        assert!(q.iter().any(|(k, v)| k == "X-Amz-Credential" && v == "AKIAEXAMPLEKEY12345/20261003/inaya/s3/aws4_request"));
        assert_eq!(encode_query(&q), VECTOR_QUERY);
    }

    #[test]
    fn presign_changes_with_method_path_and_expiry() {
        let now = Utc.with_ymd_and_hms(2026, 10, 3, 12, 34, 56).unwrap();
        let sig = |m: &str, p: &str, e: u32| presign_query_at(now, m, "h:1", p, e, VECTOR_AKID, VECTOR_SECRET).last().unwrap().1.clone();
        let base = sig("GET", "/api/s3/b/k", 60);
        assert_ne!(base, sig("PUT", "/api/s3/b/k", 60), "a GET link cannot be replayed as a PUT");
        assert_ne!(base, sig("GET", "/api/s3/b/other", 60), "a link cannot be re-aimed at another key");
        assert_ne!(base, sig("GET", "/api/s3/b/k", 61));
        assert_eq!(base, sig("GET", "/api/s3/b/k", 60), "deterministic for a fixed time");
    }
}
