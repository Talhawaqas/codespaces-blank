//! SOW §37-39, ADR-003 (NATS + JetStream): the message fabric wrapper.
//!
//! HONEST SCOPE NOTE: Phase 1 (node enrollment, heartbeat, `doctor`) does
//! not use NATS at all -- it only needs simple request/reply between one
//! node and the control plane, which plain HTTPS already does correctly
//! and more simply (and is what's actually implemented, in
//! `inaya-infra-node`'s `control_plane_client` module). NATS earns its
//! keep starting Phase 2, when the control plane needs to dispatch
//! commands to potentially many nodes and receive async results/telemetry
//! at scale -- durable JetStream delivery for commands, ephemeral pub/sub
//! for heartbeats. Wiring up `async-nats` here before there's a real
//! multi-node command-dispatch need to test it against would mean standing
//! up infrastructure this phase doesn't yet exercise, which is exactly the
//! kind of unverified claim SOW §328 forbids. This crate holds the real,
//! stable part that doesn't depend on that -- the subject-naming
//! convention (§38) -- so Phase 2's NATS wiring has one source of truth to
//! build against instead of inventing subject strings ad hoc.

/// SOW §38's suggested subject tree, finalized as the actual naming used
/// once the message fabric is wired up (Phase 2).
pub mod subjects {
    pub const COMPUTE_CREATE: &str = "inaya.compute.create";
    pub const COMPUTE_START: &str = "inaya.compute.start";
    pub const COMPUTE_STOP: &str = "inaya.compute.stop";
    pub const COMPUTE_REBOOT: &str = "inaya.compute.reboot";
    pub const COMPUTE_TERMINATE: &str = "inaya.compute.terminate";
    pub const COMPUTE_DESCRIBE: &str = "inaya.compute.describe";

    pub const BLOCK_CREATE: &str = "inaya.block.create";
    pub const BLOCK_ATTACH: &str = "inaya.block.attach";
    pub const BLOCK_DETACH: &str = "inaya.block.detach";
    pub const BLOCK_SNAPSHOT: &str = "inaya.block.snapshot";

    pub const NETWORK_VPC_CREATE: &str = "inaya.network.vpc.create";
    pub const NETWORK_SUBNET_CREATE: &str = "inaya.network.subnet.create";
    pub const NETWORK_SECURITY_GROUP_CREATE: &str = "inaya.network.security-group.create";
    pub const NETWORK_INTERFACE_CREATE: &str = "inaya.network.interface.create";

    pub const NODE_HEARTBEAT: &str = "inaya.node.heartbeat";
    pub const NODE_CAPACITY: &str = "inaya.node.capacity";
    pub const NODE_HEALTH: &str = "inaya.node.health";
    pub const NODE_RECONCILE: &str = "inaya.node.reconcile";

    pub const AUDIT_EVENT: &str = "inaya.audit.event";
}
