//! `inaya-infra-node`: the node agent daemon (SOW §40). Phase 1 scope:
//! enrollment, local identity storage, heartbeat. Compute/block/network
//! command handling is wired in starting Phase 2.

mod operations;
pub use operations::OperationExecutor;

use anyhow::{bail, Context, Result};
use api_types::DoctorCheckResult;
use certificates::{generate_csr, sign_auth_token, NodeIdentityStore, StoredIdentity};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Serialize)]
struct EnrollRequestBody {
    #[serde(rename = "enrollmentToken")]
    enrollment_token: String,
    hostname: String,
    #[serde(rename = "csrPem")]
    csr_pem: String,
}

#[derive(Debug, Deserialize)]
pub struct EnrollResponseBody {
    #[serde(rename = "nodeId")]
    node_id: String,
    status: String,
    #[serde(rename = "certificatePem")]
    certificate_pem: String,
    #[serde(rename = "caCertificatePem")]
    ca_certificate_pem: String,
}

#[derive(Debug, Serialize)]
struct HeartbeatRequestBody<'a> {
    #[serde(rename = "signedToken")]
    signed_token: String,
    capacity: &'a api_types::NodeCapacity,
    #[serde(rename = "runtimeVersion")]
    runtime_version: &'a str,
    #[serde(rename = "kernelVersion")]
    kernel_version: &'a str,
    #[serde(rename = "qemuVersion")]
    qemu_version: Option<&'a str>,
    #[serde(rename = "clockOffsetMs")]
    clock_offset_ms: i64,
}

pub struct ControlPlaneClient {
    base_url: String,
    http: reqwest::Client,
}

impl ControlPlaneClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn enroll(&self, enrollment_token: &str, hostname: &str, csr_pem: &str) -> Result<EnrollResponseBody> {
        let url = format!("{}/api/infrastructure/nodes/enroll", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&EnrollRequestBody {
                enrollment_token: enrollment_token.to_string(),
                hostname: hostname.to_string(),
                csr_pem: csr_pem.to_string(),
            })
            .send()
            .await
            .context("enrollment request failed to send")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("enrollment rejected by control plane ({status}): {body}");
        }
        resp.json::<EnrollResponseBody>().await.context("could not parse enrollment response")
    }

    pub async fn heartbeat(&self, signed_token: String, capacity: &api_types::NodeCapacity, runtime_version: &str, kernel_version: &str, qemu_version: Option<&str>) -> Result<()> {
        let url = format!("{}/api/infrastructure/nodes/heartbeat", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&HeartbeatRequestBody {
                signed_token,
                capacity,
                runtime_version,
                kernel_version,
                qemu_version,
                clock_offset_ms: 0, // real clock-sync measurement is Phase 6 (offline/edge) work
            })
            .send()
            .await
            .context("heartbeat request failed to send")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("heartbeat rejected by control plane ({status}): {body}");
        }
        Ok(())
    }
}

/// SOW §42's enrollment flow, node side: generate a keypair + CSR locally
/// (the private key never leaves this function's caller), submit it with
/// the one-time enrollment token, store the signed identity on disk.
pub async fn enroll(control_plane_url: &str, enrollment_token: &str, hostname: &str, data_dir: PathBuf) -> Result<StoredIdentity> {
    let store = NodeIdentityStore::new(&data_dir);
    if store.exists() {
        bail!("a node identity already exists at {data_dir:?} -- refusing to overwrite an existing enrollment");
    }

    let pending = generate_csr("pending-enrollment")?;
    let client = ControlPlaneClient::new(control_plane_url);
    let response = client.enroll(enrollment_token, hostname, &pending.csr_pem).await?;

    tracing::info!(node_id = %response.node_id, status = %response.status, "enrolled with control plane");

    let identity = StoredIdentity {
        node_id: response.node_id,
        cluster_id: String::new(), // the control plane knows it; not required locally for Phase 1's heartbeat path
        certificate_pem: response.certificate_pem,
        ca_certificate_pem: response.ca_certificate_pem,
        issued_at: Some(chrono::Utc::now()),
    };
    store.save(&pending.key_pair, &identity)?;
    Ok(identity)
}

/// Sends one heartbeat using the locally stored identity. Returns the
/// identity so callers (the daemon loop, or a one-shot CLI command) don't
/// have to reload it from disk every time.
pub async fn send_one_heartbeat(control_plane_url: &str, data_dir: &PathBuf) -> Result<()> {
    let store = NodeIdentityStore::new(data_dir);
    let (key_pair, identity) = store.load().context("no local node identity -- run `inaya-infra-cli node enroll` first")?;

    let capacity = telemetry::current_capacity().await;
    let kernel_version = telemetry::kernel_version();
    let signed_token = sign_auth_token(&key_pair, &identity.node_id)?;

    let client = ControlPlaneClient::new(control_plane_url);
    client.heartbeat(signed_token, &capacity, env!("CARGO_PKG_VERSION"), &kernel_version, None).await?;
    tracing::info!(node_id = %identity.node_id, "heartbeat sent");
    Ok(())
}

fn signed_token_fn(data_dir: PathBuf) -> impl Fn() -> Result<String, anyhow::Error> {
    move || {
        let store = NodeIdentityStore::new(&data_dir);
        let (key_pair, identity) = store.load()?;
        Ok(sign_auth_token(&key_pair, &identity.node_id)?)
    }
}

/// The daemon's main loop (SOW §40: heartbeat is a standing responsibility,
/// not a one-shot action). Each cycle: send a heartbeat, then poll for and
/// execute any pending compute/block operations (SOW §71-75) -- the same
/// interval covers both, since Phase 1-3's traffic volume doesn't justify
/// two separate timers yet.
pub async fn run_heartbeat_loop(control_plane_url: String, data_dir: PathBuf, interval: Duration) -> Result<()> {
    let executor = OperationExecutor::new(data_dir.join("runtime"));
    let token_fn = signed_token_fn(data_dir.clone());
    loop {
        if let Err(e) = send_one_heartbeat(&control_plane_url, &data_dir).await {
            tracing::warn!(error = %e, "heartbeat failed, will retry on next interval");
        }
        match executor.poll_and_execute_once(&control_plane_url, &token_fn).await {
            Ok(n) if n > 0 => tracing::info!(count = n, "executed pending operations"),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "operation poll failed, will retry on next interval"),
        }
        tokio::time::sleep(interval).await;
    }
}

pub async fn doctor() -> Vec<DoctorCheckResult> {
    telemetry::run_doctor_checks().await
}

pub fn local_identity(data_dir: &PathBuf) -> Result<StoredIdentity> {
    let store = NodeIdentityStore::new(data_dir);
    let (_key, identity) = store.load().context("no local node identity -- run `inaya-infra-cli node enroll` first")?;
    Ok(identity)
}
