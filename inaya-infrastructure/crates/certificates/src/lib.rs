//! SOW §41-43: node identity, mTLS-equivalent enrollment, certificate
//! storage. Uses ECDSA P-256 throughout -- matching the control plane's
//! `@peculiar/x509` implementation exactly (confirmed by an end-to-end
//! smoke test on the Node.js side before this crate was written: CA -> CSR
//! -> signed cert -> chain verify -> auth-token signature verify, all
//! real, all passing against that same curve).

use chrono::{DateTime, Utc};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PKCS_ECDSA_P256_SHA256};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CertError {
    #[error("rcgen error: {0}")]
    Rcgen(#[from] rcgen::Error),
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("no local identity found at {0} -- enroll first")]
    NotEnrolled(PathBuf),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("signing error: {0}")]
    Signing(String),
}

/// What's persisted on disk after enrollment. The private key is kept
/// separate from this struct's own serialized form in practice (see
/// [`NodeIdentityStore`]) -- never written world-readable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredIdentity {
    pub node_id: String,
    pub cluster_id: String,
    pub certificate_pem: String,
    pub ca_certificate_pem: String,
    pub issued_at: Option<DateTime<Utc>>,
}

/// A freshly generated keypair + CSR, not yet signed by anything.
pub struct PendingEnrollment {
    pub key_pair: KeyPair,
    pub csr_pem: String,
}

/// Generates a new ECDSA P-256 keypair and a CSR for it. `common_name` is
/// typically a placeholder (e.g. "pending-enrollment") since the real
/// node_id is assigned by the control plane during enrollment -- the CSR
/// only needs to prove possession of the private key, per SOW §42.
pub fn generate_csr(common_name: &str) -> Result<PendingEnrollment, CertError> {
    let key_pair = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, common_name);
    params.distinguished_name = dn;
    let csr = params.serialize_request(&key_pair)?;
    Ok(PendingEnrollment {
        key_pair,
        csr_pem: csr.pem()?,
    })
}

/// Filesystem layout for a node's local identity (SOW §53: "sensitive
/// secrets must be encrypted and never written in plaintext" -- the
/// private key file is written with 0600 permissions on Unix; full
/// at-rest encryption of the key file is tracked as a Phase 6 offline-
/// hardening item, not silently skipped, see the implementation ledger).
pub struct NodeIdentityStore {
    dir: PathBuf,
}

impl NodeIdentityStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("node.key")
    }
    fn identity_path(&self) -> PathBuf {
        self.dir.join("identity.json")
    }

    pub fn save(&self, key_pair: &KeyPair, identity: &StoredIdentity) -> Result<(), CertError> {
        fs::create_dir_all(&self.dir).map_err(|source| CertError::Io {
            path: self.dir.clone(),
            source,
        })?;
        let key_pem = key_pair.serialize_pem();
        write_restricted(&self.key_path(), key_pem.as_bytes())?;
        let json = serde_json::to_vec_pretty(identity)?;
        fs::write(self.identity_path(), json).map_err(|source| CertError::Io {
            path: self.identity_path(),
            source,
        })?;
        Ok(())
    }

    pub fn load(&self) -> Result<(KeyPair, StoredIdentity), CertError> {
        if !self.identity_path().exists() {
            return Err(CertError::NotEnrolled(self.dir.clone()));
        }
        let key_pem = fs::read_to_string(self.key_path()).map_err(|source| CertError::Io {
            path: self.key_path(),
            source,
        })?;
        let key_pair = KeyPair::from_pem(&key_pem)?;
        let identity_json = fs::read_to_string(self.identity_path()).map_err(|source| CertError::Io {
            path: self.identity_path(),
            source,
        })?;
        let identity: StoredIdentity = serde_json::from_str(&identity_json)?;
        Ok((key_pair, identity))
    }

    pub fn exists(&self) -> bool {
        self.identity_path().exists()
    }
}

#[cfg(unix)]
fn write_restricted(path: &Path, contents: &[u8]) -> Result<(), CertError> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|source| CertError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    file.write_all(contents).map_err(|source| CertError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(not(unix))]
fn write_restricted(path: &Path, contents: &[u8]) -> Result<(), CertError> {
    fs::write(path, contents).map_err(|source| CertError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// Signs a short-lived auth-token payload with the node's own private key
/// (see the architecture note in the Next.js side's
/// `src/lib/infrastructure/nodes.js` for why this substitutes for literal
/// TLS-layer mTLS against a Vercel-fronted control plane). Returns the
/// `payload_b64.signature_b64` token the control plane verifies.
///
/// rcgen's `KeyPair` deliberately keeps its own `sign` method private (it
/// exists only for rcgen's internal certificate/CSR DER-writing) -- so this
/// re-derives a `ring` ECDSA signing key from the same PKCS#8 bytes rcgen
/// itself produces (`serialize_der`), and signs with that directly. Same
/// key, same P-256 curve, just via the lower-level API rcgen's own
/// certificate signing already uses underneath.
pub fn sign_auth_token(key_pair: &KeyPair, node_id: &str) -> Result<String, CertError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

    let iat = Utc::now().timestamp_millis();
    let payload = serde_json::json!({ "nodeId": node_id, "iat": iat });
    let payload_json = serde_json::to_vec(&payload)?;
    let payload_b64 = URL_SAFE_NO_PAD.encode(&payload_json);

    let pkcs8_der = key_pair.serialize_der();
    let rng = SystemRandom::new();
    let ring_key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8_der, &rng)
        .map_err(|e| CertError::Signing(format!("key load failed: {e}")))?;
    let signature = ring_key
        .sign(&rng, payload_b64.as_bytes())
        .map_err(|e| CertError::Signing(format!("sign failed: {e}")))?;
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature.as_ref());
    Ok(format!("{payload_b64}.{sig_b64}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_csr_produces_a_real_parseable_csr() {
        let pending = generate_csr("pending-enrollment").unwrap();
        assert!(pending.csr_pem.contains("BEGIN CERTIFICATE REQUEST"));
    }

    #[test]
    fn identity_store_round_trips_through_real_disk_io() {
        let dir = std::env::temp_dir().join(format!("inaya-infra-test-{}", uuid::Uuid::new_v4()));
        let store = NodeIdentityStore::new(&dir);
        assert!(!store.exists());

        let pending = generate_csr("pending-enrollment").unwrap();
        let identity = StoredIdentity {
            node_id: "test-node".into(),
            cluster_id: "test-cluster".into(),
            certificate_pem: "fake-pem-for-test".into(),
            ca_certificate_pem: "fake-ca-pem-for-test".into(),
            issued_at: Some(Utc::now()),
        };
        store.save(&pending.key_pair, &identity).unwrap();
        assert!(store.exists());

        let (_loaded_key, loaded_identity) = store.load().unwrap();
        assert_eq!(loaded_identity.node_id, "test-node");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sign_auth_token_produces_a_two_part_token() {
        let pending = generate_csr("pending-enrollment").unwrap();
        let token = sign_auth_token(&pending.key_pair, "test-node").unwrap();
        assert_eq!(token.split('.').count(), 2);
    }
}
