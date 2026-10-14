//! Shared request/response types for the Sovereign Infrastructure Fabric.
//!
//! These structs are the Rust side of the wire contract with the Next.js
//! control plane (`src/app/api/orgs/infrastructure/*`). Kept in lockstep
//! with `docsApiReference.js`'s `API_ENDPOINTS` entries by hand (SOW §321:
//! "no feature is complete without a ledger entry" applies here too --
//! changing a shape here without updating the matching API route/doc entry
//! is a defect, not a style choice).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// SOW §39: every infrastructure request must carry or derive this. The
/// receiving daemon never trusts `org_id` solely because it's present here
/// -- it's independently verified against the sender's mTLS-authenticated
/// node identity before any action is taken.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageMetadata {
    pub org_id: String,
    pub actor_identity_id: String,
    pub request_id: Uuid,
    pub trace_id: Uuid,
    pub cluster_id: String,
    pub resource_id: Option<String>,
    pub policy_version: Option<String>,
    pub timestamp: DateTime<Utc>,
}

/// SOW §41: per-node identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeIdentity {
    pub cluster_id: String,
    pub node_id: String,
    /// PEM-encoded certificate. The private key never leaves the node --
    /// it is generated locally and only the public certificate (and the
    /// CSR during enrollment) ever crosses the wire.
    pub certificate_pem: String,
    pub certificate_serial: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// SOW §42 enrollment flow states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NodeEnrollmentStatus {
    Pending,
    Active,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrollmentRequest {
    /// The one-time enrollment token the cluster issued (SOW §42: "cluster
    /// creates enrollment token" -> "node proves possession").
    pub enrollment_token: String,
    pub cluster_id: String,
    pub hostname: String,
    /// PKCS#10 CSR, PEM-encoded. The node generates its own keypair
    /// locally (rcgen) and only ever sends the public CSR.
    pub csr_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrollmentResponse {
    pub node_id: String,
    pub status: NodeEnrollmentStatus,
    pub certificate_pem: Option<String>,
    pub ca_certificate_pem: Option<String>,
}

/// SOW §15: host capacity manager fields.
///
/// Pre-existing bug fixed in the gap-closure round: this struct had no
/// `rename_all`, so it serialized as snake_case (`host_vcpu`, ...) over the
/// wire (`HeartbeatRequestBody.capacity` in inaya-infra-node, which embeds
/// it without its own rename). Every JS-side reader -- `nodes.js`'s
/// `scheduleNode()` and `InfrastructureView.js`'s capacity display -- was
/// already written assuming camelCase (`hostVcpu`, ...), matching this
/// project's own convention everywhere else a Rust wire type crosses into
/// JS (see `HeartbeatRequestBody`'s own per-field renames in the same
/// heartbeat call). The mismatch meant those reads were always `undefined`:
/// `scheduleNode()`'s "most free memory wins" comparison degraded to
/// `NaN < NaN`, silently falling back to insertion order instead of
/// genuinely comparing nodes' free capacity, and the Nodes tab's vCPU/GiB
/// numbers rendered blank. `rename_all = "camelCase"` here is the fix --
/// one place, not two call sites each reinterpreting the wire shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeCapacity {
    pub host_vcpu: u32,
    pub host_memory_mib: u64,
    pub reserved_vcpu: u32,
    pub reserved_memory_mib: u64,
    pub allocated_vcpu: u32,
    pub allocated_memory_mib: u64,
    pub host_gpu: u32,
    pub reserved_gpu: u32,
    pub allocated_gpu: u32,
    pub storage_overhead_gib: u64,
    pub network_overhead: Option<String>,
    /// Gap-closure round, INFRA-ADV-008: real `/dev/tpm0`/`/dev/tpmrm0`
    /// presence only -- detection, never a hardware-attested identity
    /// claim. Same honesty bar as `host_gpu`: an absent TPM reports
    /// `false`, never fabricated.
    #[serde(default)]
    pub host_tpm_present: bool,
    #[serde(default)]
    pub host_tpm_version: Option<String>,
    /// Gap-closure round, INFRA-ADV-007: real CPU flags only
    /// (`sev`/`sev_es`/`tdx` from `/proc/cpuinfo`). Presence of a flag
    /// means the CPU advertises the feature -- it is never upgraded to an
    /// "enabled" or "attested" claim, since no encrypted-VM boot is
    /// attempted against it.
    #[serde(default)]
    pub host_confidential_compute_flags: Vec<String>,
}

/// SOW §40: heartbeat payload, carries capacity + a terse health summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeHeartbeat {
    pub node_id: String,
    pub cluster_id: String,
    pub sent_at: DateTime<Utc>,
    pub capacity: NodeCapacity,
    pub runtime_version: String,
    pub kernel_version: String,
    pub qemu_version: Option<String>,
    /// SOW §107: clock-skew tracking.
    pub clock_offset_ms: i64,
}

/// SOW §227: `inaya-infra doctor` check result. One row per check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DoctorStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorCheckResult {
    pub check: String,
    pub status: DoctorStatus,
    pub detail: String,
    pub remediation: Option<String>,
}

/// SOW §329: real physical-capability markers. Never upgraded to "verified"
/// without the specific test named in each marker's own definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhysicalCapability {
    QemuKvmReal,
    BlockAttachReal,
    NetworkBridgeReal,
    GpuDetectionReal,
    GpuPassthroughVerified,
    TpmDetectionReal,
    ConfidentialComputeFlagDetectionReal,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for the camelCase/snake_case wire-shape bug fixed
    /// in the gap-closure round: `nodes.js`'s `scheduleNode()` and
    /// `InfrastructureView.js` both read `capacity.hostVcpu` etc, so the
    /// real serialized JSON this struct produces must actually use those
    /// keys -- not just compile, but genuinely serialize that way.
    #[test]
    fn node_capacity_serializes_as_camel_case_on_the_wire() {
        let capacity = NodeCapacity {
            host_vcpu: 8,
            host_memory_mib: 16384,
            reserved_vcpu: 0,
            reserved_memory_mib: 0,
            allocated_vcpu: 2,
            allocated_memory_mib: 4096,
            host_gpu: 1,
            reserved_gpu: 0,
            allocated_gpu: 0,
            storage_overhead_gib: 0,
            network_overhead: None,
            host_tpm_present: false,
            host_tpm_version: None,
            host_confidential_compute_flags: vec![],
        };
        let json = serde_json::to_value(&capacity).unwrap();
        for key in ["hostVcpu", "hostMemoryMib", "allocatedVcpu", "allocatedMemoryMib", "hostGpu", "hostTpmPresent", "hostConfidentialComputeFlags"] {
            assert!(json.get(key).is_some(), "expected camelCase key {key:?} in {json}");
        }
        for key in ["host_vcpu", "host_memory_mib", "allocated_vcpu"] {
            assert!(json.get(key).is_none(), "snake_case key {key:?} should not appear on the wire: {json}");
        }
    }
}
