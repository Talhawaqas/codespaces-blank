// src/sigv4.rs
//
// AWS Signature Version 4 request SIGNING (the client side) -- a direct
// Rust port of this same repo's src/lib/s3-compat/sigv4.js VERIFICATION
// logic, run in reverse. Both sides implement the identical real AWS
// algorithm (canonical request -> string-to-sign -> derived signing key ->
// HMAC), so a request this module signs is verified by that same,
// already-tested server code with no new server-side trust surface.

use chrono::Utc;
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
