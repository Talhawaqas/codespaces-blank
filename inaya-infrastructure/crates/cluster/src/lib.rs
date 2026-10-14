//! SOW §44-50, §91-96: cluster membership, scheduler, leases, reconciliation.
//! This crate currently holds only the cluster mode enum (used by the
//! control-plane-facing shape in api-types-adjacent code) -- the scheduler,
//! lease manager, and reconciliation engine are Phase 5 work (see
//! docs/infrastructure/IMPLEMENTATION-LEDGER.md -- INFRA-CL-001 through
//! INFRA-CL-007, currently PLANNED). This crate exists now so the
//! workspace has a real place for that code to land without a later
//! restructure, not because any of it is built yet.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClusterMode {
    Development,
    SingleNode,
    Edge,
    Ha,
    AirGapped,
    Regulated,
    AiGpu,
}
