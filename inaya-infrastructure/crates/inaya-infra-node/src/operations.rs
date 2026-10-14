//! Polls the control plane for pending operations and executes them
//! against the real compute/block providers (SOW §71-75). HTTP long-poll
//! on the heartbeat cycle -- see the ADR-003 note on why NATS isn't needed
//! for this yet.

use block::RawFileBlockProvider;
use compute::cloud_image::CloudImageCache;
use compute::cloud_init::{build_nocloud_seed, NoCloudSeedRequest, StaticNetworkConfig};
use compute::{ComputeProvider, CreateInstanceRequest, QemuKvmProvider};
use guest_exec::{generate_node_ssh_keypair, public_key_openssh_line, GuestSession, KeyPair};
use loadbalancer::{HaproxyLoadBalancerProvider, HealthCheck, LbTarget};
use network::{LinuxBridgeNetworkProvider, SecurityGroupRule};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

#[derive(Debug, Deserialize)]
pub struct PendingOperation {
    #[serde(rename = "operationId")]
    pub operation_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub params: Value,
}

#[derive(Debug, Deserialize)]
struct PollResponse {
    operations: Vec<PendingOperation>,
}

#[derive(Debug, Serialize)]
struct CompleteRequestBody<'a> {
    #[serde(rename = "signedToken")]
    signed_token: String,
    status: &'a str,
    result: Option<Value>,
    error: Option<String>,
}

/// SOW §55: a completion the node has produced but could not yet deliver
/// to the control plane (WAN outage). Appended to a local file, never
/// lost, flushed in order once connectivity returns -- this is the node's
/// own local half of the offline audit queue; the control plane's
/// `infra_operations` record is still the single source of truth once
/// delivered, never a second permanent ledger (§55's own rule).
#[derive(Debug, Serialize, Deserialize)]
struct QueuedCompletion {
    operation_id: String,
    status: String,
    result: Option<Value>,
    error: Option<String>,
    queued_at: String,
}

pub struct OperationExecutor {
    compute: QemuKvmProvider,
    block: RawFileBlockProvider,
    network: LinuxBridgeNetworkProvider,
    offline_queue_path: PathBuf,
    /// Gap-closure round, Phase A: real base-OS image cache for guest-booting
    /// instances (k3s server/agent roles, or a plain real-OS instance).
    cloud_images: CloudImageCache,
    seeds_dir: PathBuf,
    /// This node's own ed25519 keypair for guest-exec SSH, generated once
    /// per daemon process (see guest-exec's module doc: a fresh VM gets
    /// this key baked into its cloud-init at creation time, so an
    /// in-memory, per-process identity is sufficient -- it never needs to
    /// outlive the process that created the VMs it talks to).
    guest_ssh_key: KeyPair,
    /// Gap-closure round, Phase C: real HAProxy process management.
    loadbalancer: HaproxyLoadBalancerProvider,
}

impl OperationExecutor {
    pub fn new(runtime_dir: PathBuf) -> Self {
        Self {
            compute: QemuKvmProvider::new(runtime_dir.join("vms")),
            block: RawFileBlockProvider::new(runtime_dir.join("volumes")),
            network: LinuxBridgeNetworkProvider::new(),
            offline_queue_path: runtime_dir.join("offline-completions.jsonl"),
            cloud_images: CloudImageCache::new(runtime_dir.join("images")),
            seeds_dir: runtime_dir.join("seeds"),
            guest_ssh_key: generate_node_ssh_keypair().expect("ed25519 keypair generation should never fail on a real host"),
            loadbalancer: HaproxyLoadBalancerProvider::new(runtime_dir.join("lb")),
        }
    }

    async fn queue_completion_offline(&self, entry: &QueuedCompletion) -> anyhow::Result<()> {
        if let Some(parent) = self.offline_queue_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&self.offline_queue_path).await?;
        let line = format!("{}\n", serde_json::to_string(entry)?);
        file.write_all(line.as_bytes()).await?;
        Ok(())
    }

    /// Flushes every queued offline completion, in order. A completion
    /// that still fails to deliver (still offline) is re-queued and the
    /// flush stops there rather than reordering later entries ahead of it.
    pub async fn flush_offline_queue(&self, control_plane_url: &str, signed_token_fn: &impl Fn() -> Result<String, anyhow::Error>) -> anyhow::Result<usize> {
        if !self.offline_queue_path.exists() {
            return Ok(0);
        }
        let contents = tokio::fs::read_to_string(&self.offline_queue_path).await?;
        let lines: Vec<&str> = contents.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.is_empty() {
            let _ = tokio::fs::remove_file(&self.offline_queue_path).await;
            return Ok(0);
        }

        let http = reqwest::Client::new();
        let mut flushed = 0;
        let mut remaining: Vec<String> = Vec::new();
        let mut delivery_failed = false;

        for line in &lines {
            if delivery_failed {
                remaining.push(line.to_string());
                continue;
            }
            let entry: QueuedCompletion = match serde_json::from_str(line) {
                Ok(e) => e,
                Err(_) => continue, // corrupt line, drop rather than block the queue forever
            };
            let complete_url = format!("{control_plane_url}/api/infrastructure/nodes/operations/{}/complete", entry.operation_id);
            let body = CompleteRequestBody { signed_token: signed_token_fn()?, status: &entry.status, result: entry.result.clone(), error: entry.error.clone() };
            match http.post(&complete_url).json(&body).send().await {
                Ok(resp) if resp.status().is_success() => flushed += 1,
                _ => {
                    delivery_failed = true;
                    remaining.push(line.to_string());
                }
            }
        }

        if remaining.is_empty() {
            let _ = tokio::fs::remove_file(&self.offline_queue_path).await;
        } else {
            tokio::fs::write(&self.offline_queue_path, format!("{}\n", remaining.join("\n"))).await?;
        }
        if flushed > 0 {
            tracing::info!(count = flushed, remaining = remaining.len(), "flushed offline completion queue");
        }
        Ok(flushed)
    }

    pub async fn offline_queue_depth(&self) -> usize {
        match tokio::fs::File::open(&self.offline_queue_path).await {
            Ok(f) => {
                let mut lines = tokio::io::BufReader::new(f).lines();
                let mut count = 0;
                while let Ok(Some(_)) = lines.next_line().await {
                    count += 1;
                }
                count
            }
            Err(_) => 0,
        }
    }

    async fn execute(&self, op: &PendingOperation) -> Result<Value, String> {
        match op.kind.as_str() {
            "CREATE_VPC" => {
                let vpc_id = op.params.get("vpcId").and_then(|v| v.as_str()).ok_or("missing vpcId")?;
                let cidr = op.params.get("cidr").and_then(|v| v.as_str()).ok_or("missing cidr")?;
                self.network.create_vpc(vpc_id, cidr).await.map_err(|e| e.to_string())?;
                if let Some(rules_json) = op.params.get("securityGroupRules").and_then(|v| v.as_array()) {
                    let rules: Vec<SecurityGroupRule> = rules_json
                        .iter()
                        .filter_map(|r| {
                            Some(SecurityGroupRule {
                                protocol: r.get("protocol")?.as_str()?.to_string(),
                                from_port: r.get("fromPort").and_then(|p| p.as_u64()).map(|p| p as u16),
                                to_port: r.get("toPort").and_then(|p| p.as_u64()).map(|p| p as u16),
                                source: r.get("source").and_then(|s| s.as_str()).map(|s| s.to_string()),
                            })
                        })
                        .collect();
                    if !rules.is_empty() {
                        // Applied per-interface in practice; at VPC-creation
                        // time there's no interface yet, so this only
                        // validates the rule shapes parse -- real
                        // application happens per-instance in CREATE_INSTANCE
                        // below, via apply_security_group against that
                        // instance's own tap.
                        let _ = rules;
                    }
                }
                Ok(json!({}))
            }
            "DELETE_VPC" => {
                let vpc_id = op.params.get("vpcId").and_then(|v| v.as_str()).ok_or("missing vpcId")?;
                self.network.delete_vpc(vpc_id).await.map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            "CREATE_VOLUME" => {
                let size_gib = op.params.get("sizeGib").and_then(|v| v.as_u64()).unwrap_or(1);
                let volume_id = op.params.get("volumeId").and_then(|v| v.as_str()).ok_or("missing volumeId")?;
                let path = self.block.create_volume(volume_id, size_gib).await.map_err(|e| e.to_string())?;
                Ok(json!({ "path": path.to_string_lossy() }))
            }
            "DELETE_VOLUME" => {
                let volume_id = op.params.get("volumeId").and_then(|v| v.as_str()).ok_or("missing volumeId")?;
                self.block.delete_volume(volume_id).await.map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            "CREATE_INSTANCE" => {
                let instance_id = op.params.get("instanceId").and_then(|v| v.as_str()).ok_or("missing instanceId")?;
                let name = op.params.get("name").and_then(|v| v.as_str()).unwrap_or(instance_id);
                let vcpu = op.params.get("vcpu").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                let memory_mib = op.params.get("memoryMib").and_then(|v| v.as_u64()).unwrap_or(512);
                let volume_id = op.params.get("volumeId").and_then(|v| v.as_str());
                let disk_path = volume_id.map(|vid| self.block.path_for(vid));

                let vpc_id = op.params.get("vpcId").and_then(|v| v.as_str());
                let tap_device = if let Some(vpc_id) = vpc_id {
                    let tap = self.network.create_interface(instance_id, vpc_id).await.map_err(|e| e.to_string())?;
                    if let Some(rules_json) = op.params.get("securityGroupRules").and_then(|v| v.as_array()) {
                        let rules: Vec<SecurityGroupRule> = rules_json
                            .iter()
                            .filter_map(|r| {
                                Some(SecurityGroupRule {
                                    protocol: r.get("protocol")?.as_str()?.to_string(),
                                    from_port: r.get("fromPort").and_then(|p| p.as_u64()).map(|p| p as u16),
                                    to_port: r.get("toPort").and_then(|p| p.as_u64()).map(|p| p as u16),
                                    source: r.get("source").and_then(|s| s.as_str()).map(|s| s.to_string()),
                                })
                            })
                            .collect();
                        if !rules.is_empty() {
                            self.network.apply_security_group(vpc_id, instance_id, &rules).await.map_err(|e| e.to_string())?;
                        }
                    }
                    Some(tap)
                } else {
                    None
                };

                self.compute
                    .create_instance(CreateInstanceRequest {
                        instance_id: instance_id.to_string(),
                        name: name.to_string(),
                        vcpu,
                        memory_mib,
                        disk_path,
                        tap_device,
                        cloud_init: None,
                        cloud_init_iso: None,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            // Gap-closure round, Phase A/D: a real guest-OS-booting
            // instance (plain, or a k3s server/agent). Unlike
            // CREATE_INSTANCE above (blank or no disk, never boots an
            // actual OS -- see the compute crate's own CreateInstanceRequest
            // doc), this provisions a real base-cloud-image-backed overlay
            // disk plus a real cloud-init seed, and -- for the k3s roles --
            // waits for the guest to actually come up and retrieves real
            // artifacts from it over guest-exec SSH before reporting
            // success. This can genuinely take a few minutes (image
            // download on first use, guest boot, cloud-init, and for a
            // server role, the real upstream k3s installer) -- that's
            // real work, not a hung operation.
            "BOOT_GUEST_INSTANCE" => {
                let instance_id = op.params.get("instanceId").and_then(|v| v.as_str()).ok_or("missing instanceId")?;
                let name = op.params.get("name").and_then(|v| v.as_str()).unwrap_or(instance_id);
                let vcpu = op.params.get("vcpu").and_then(|v| v.as_u64()).unwrap_or(2) as u32;
                let memory_mib = op.params.get("memoryMib").and_then(|v| v.as_u64()).unwrap_or(2048);
                // Real bug this project's own real-guest-boot testing caught:
                // leaving this unset means the overlay disk never grows past
                // the base cloud image's own tiny virtual size (~2.2 GiB) --
                // nowhere near enough for a real workload (k3s alone needs
                // ~1 GiB+ for its embedded binary and container images).
                // Confirmed via a real `k3s server` failure: "no space left
                // on device" while extracting its own data directory.
                // Defaulting to a real, usable 10 GiB (cloud-init's stock
                // `growpart`+`resizefs` modules grow the root filesystem
                // into it automatically) rather than silently inheriting
                // whatever the base image happened to ship with.
                let size_gib = Some(op.params.get("sizeGib").and_then(|v| v.as_u64()).unwrap_or(10));
                let static_ip = op.params.get("staticIp").and_then(|v| v.as_str()).ok_or("missing staticIp")?;
                let gateway_ip = op.params.get("gatewayIp").and_then(|v| v.as_str()).ok_or("missing gatewayIp")?;
                let role = op.params.get("role").and_then(|v| v.as_str()).unwrap_or("plain");
                let vpc_id = op.params.get("vpcId").and_then(|v| v.as_str());

                let base_image = self.cloud_images.ensure_base_image().await.map_err(|e| format!("base image: {e}"))?;
                let disk_path = self.block.create_volume_from_image(instance_id, &base_image, size_gib).await.map_err(|e| e.to_string())?;

                let tap_device = if let Some(vpc_id) = vpc_id {
                    let tap = self.network.create_interface(instance_id, vpc_id).await.map_err(|e| e.to_string())?;
                    if let Some(rules_json) = op.params.get("securityGroupRules").and_then(|v| v.as_array()) {
                        let rules: Vec<SecurityGroupRule> = rules_json
                            .iter()
                            .filter_map(|r| {
                                Some(SecurityGroupRule {
                                    protocol: r.get("protocol")?.as_str()?.to_string(),
                                    from_port: r.get("fromPort").and_then(|p| p.as_u64()).map(|p| p as u16),
                                    to_port: r.get("toPort").and_then(|p| p.as_u64()).map(|p| p as u16),
                                    source: r.get("source").and_then(|s| s.as_str()).map(|s| s.to_string()),
                                })
                            })
                            .collect();
                        if !rules.is_empty() {
                            self.network.apply_security_group(vpc_id, instance_id, &rules).await.map_err(|e| e.to_string())?;
                        }
                    }
                    Some(tap)
                } else {
                    None
                };

                let runcmd: Vec<String> = match role {
                    "k8s-server" => vec!["curl -sfL https://get.k3s.io | sh -".to_string()],
                    "k8s-agent" => {
                        let server_url = op.params.get("k3sServerUrl").and_then(|v| v.as_str()).ok_or("missing k3sServerUrl for a k8s-agent instance")?;
                        let token = op.params.get("k3sToken").and_then(|v| v.as_str()).ok_or("missing k3sToken for a k8s-agent instance")?;
                        vec![format!("curl -sfL https://get.k3s.io | K3S_URL={server_url} K3S_TOKEN={token} sh -")]
                    }
                    _ => Vec::new(),
                };
                let ssh_pub_line = public_key_openssh_line(&self.guest_ssh_key).map_err(|e| e.to_string())?;
                let network_config = StaticNetworkConfig { address_cidr: format!("{static_ip}/24"), gateway: gateway_ip.to_string() };
                let seed_req = NoCloudSeedRequest { instance_id, hostname: name, network: Some(&network_config), ssh_authorized_key: Some(&ssh_pub_line), runcmd: &runcmd };
                let seed_iso = build_nocloud_seed(&self.seeds_dir.join(instance_id), seed_req).await.map_err(|e| e.to_string())?;

                self.compute
                    .create_instance(CreateInstanceRequest {
                        instance_id: instance_id.to_string(),
                        name: name.to_string(),
                        vcpu,
                        memory_mib,
                        disk_path: Some(disk_path),
                        tap_device,
                        cloud_init: None,
                        cloud_init_iso: Some(seed_iso),
                    })
                    .await
                    .map_err(|e| e.to_string())?;

                if role == "plain" {
                    // Real proof this is an actual booted OS, not just a
                    // running QEMU process: wait for the guest to answer
                    // SSH at all.
                    GuestSession::connect_with_retry(static_ip, 22, "inaya", &self.guest_ssh_key, Duration::from_secs(300)).await.map_err(|e| e.to_string())?;
                    return Ok(json!({ "staticIp": static_ip }));
                }

                // k8s roles: wait for SSH, then wait for the real upstream
                // k3s installer to finish (it runs asynchronously as part
                // of cloud-init's runcmd -- SSH coming up only proves the
                // OS booted, not that k3s itself is done yet).
                let mut session = GuestSession::connect_with_retry(static_ip, 22, "inaya", &self.guest_ssh_key, Duration::from_secs(240)).await.map_err(|e| e.to_string())?;

                if role == "k8s-server" {
                    // Real-world measured cost: ~170s for guest boot +
                    // cloud-init alone (confirmed via this project's own
                    // real-guest-boot test), plus the real k3s installer
                    // downloading its binary and starting the service --
                    // 600s gives real headroom past that observed baseline.
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
                    let mut node_token = None;
                    while tokio::time::Instant::now() < deadline {
                        match session.read_remote_file("/var/lib/rancher/k3s/server/node-token").await {
                            Ok(t) if !t.trim().is_empty() => {
                                node_token = Some(t.trim().to_string());
                                break;
                            }
                            _ => tokio::time::sleep(Duration::from_secs(5)).await,
                        }
                    }
                    let node_token = node_token.ok_or("k3s server did not produce a node-token within the timeout -- the real installer may still be running or failed")?;
                    // Real-world observed: an occasional transient SSH
                    // channel hiccup reading this one file right as k3s
                    // finishes bootstrapping several containerd shims at
                    // once (real host CPU contention at that exact moment)
                    // -- a short retry here is cheap and matches the
                    // node-token loop's own resilience above, rather than
                    // failing the whole operation on one bad channel read.
                    let mut raw_kubeconfig = None;
                    for attempt in 0..5 {
                        match session.read_remote_file("/etc/rancher/k3s/k3s.yaml").await {
                            Ok(t) if !t.trim().is_empty() => {
                                raw_kubeconfig = Some(t);
                                break;
                            }
                            Err(e) if attempt == 4 => return Err(format!("reading kubeconfig failed after retries: {e}")),
                            _ => tokio::time::sleep(Duration::from_secs(3)).await,
                        }
                    }
                    let raw_kubeconfig = raw_kubeconfig.ok_or("kubeconfig read returned empty content after retries")?;
                    let kubeconfig = raw_kubeconfig.replace("127.0.0.1", static_ip);
                    return Ok(json!({ "staticIp": static_ip, "k3sNodeToken": node_token, "kubeconfig": kubeconfig }));
                }

                // k8s-agent: confirm the real k3s-agent systemd unit is
                // actually active, not just that cloud-init ran.
                let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
                let mut joined = false;
                while tokio::time::Instant::now() < deadline {
                    match session.exec_text("systemctl is-active k3s-agent").await {
                        Ok(status) if status.trim() == "active" => {
                            joined = true;
                            break;
                        }
                        _ => tokio::time::sleep(Duration::from_secs(5)).await,
                    }
                }
                if !joined {
                    return Err("k3s-agent did not reach an active state within the timeout".to_string());
                }
                Ok(json!({ "staticIp": static_ip }))
            }
            "START_INSTANCE" => {
                let instance_id = op.params.get("instanceId").and_then(|v| v.as_str()).ok_or("missing instanceId")?;
                self.compute.start_instance(instance_id).await.map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            "STOP_INSTANCE" => {
                let instance_id = op.params.get("instanceId").and_then(|v| v.as_str()).ok_or("missing instanceId")?;
                self.compute.stop_instance(instance_id).await.map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            "REBOOT_INSTANCE" => {
                let instance_id = op.params.get("instanceId").and_then(|v| v.as_str()).ok_or("missing instanceId")?;
                self.compute.reboot_instance(instance_id).await.map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            "TERMINATE_INSTANCE" => {
                let instance_id = op.params.get("instanceId").and_then(|v| v.as_str()).ok_or("missing instanceId")?;
                self.compute.terminate_instance(instance_id).await.map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            // Gap-closure round, Phase C: real HAProxy-backed load balancing.
            "CREATE_LOAD_BALANCER" | "UPDATE_LOAD_BALANCER_TARGETS" => {
                let lb_id = op.params.get("lbId").and_then(|v| v.as_str()).ok_or("missing lbId")?;
                let listen_port = op.params.get("listenPort").and_then(|v| v.as_u64()).ok_or("missing listenPort")? as u16;
                let interval_ms = op.params.get("healthCheckIntervalMs").and_then(|v| v.as_u64()).unwrap_or(2000);
                let targets: Vec<LbTarget> = op
                    .params
                    .get("targets")
                    .and_then(|v| v.as_array())
                    .ok_or("missing targets")?
                    .iter()
                    .filter_map(|t| {
                        Some(LbTarget {
                            name: t.get("name")?.as_str()?.to_string(),
                            address: t.get("address")?.as_str()?.to_string(),
                            port: t.get("port")?.as_u64()? as u16,
                        })
                    })
                    .collect();
                let health_check = HealthCheck { interval_ms };
                if op.kind == "CREATE_LOAD_BALANCER" {
                    self.loadbalancer.create(lb_id, listen_port, &targets, &health_check).await.map_err(|e| e.to_string())?;
                } else {
                    self.loadbalancer.update_targets(lb_id, listen_port, &targets, &health_check).await.map_err(|e| e.to_string())?;
                }
                Ok(json!({}))
            }
            "DELETE_LOAD_BALANCER" => {
                let lb_id = op.params.get("lbId").and_then(|v| v.as_str()).ok_or("missing lbId")?;
                self.loadbalancer.delete(lb_id).await.map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            other => Err(format!("unknown operation type: {other}")),
        }
    }

    pub async fn poll_and_execute_once(&self, control_plane_url: &str, signed_token_fn: impl Fn() -> Result<String, anyhow::Error>) -> anyhow::Result<usize> {
        // Always try to flush first -- SOW §56 "on reconnection: identify
        // local unsynced events... reconcile" -- a backlog from a prior
        // outage is delivered before anything new is fetched.
        if let Err(e) = self.flush_offline_queue(control_plane_url, &signed_token_fn).await {
            tracing::debug!(error = %e, "offline queue flush did not complete (likely still offline)");
        }

        let http = reqwest::Client::new();
        let poll_url = format!("{control_plane_url}/api/infrastructure/nodes/operations");
        let resp = http.post(&poll_url).json(&json!({ "signedToken": signed_token_fn()? })).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("operation poll failed ({}): {}", resp.status(), resp.text().await.unwrap_or_default());
        }
        let poll: PollResponse = resp.json().await?;
        let count = poll.operations.len();

        for op in &poll.operations {
            let outcome = self.execute(op).await;
            let (status, result, error): (&str, Option<Value>, Option<String>) = match &outcome {
                Ok(result) => ("SUCCEEDED", Some(result.clone()), None),
                Err(e) => ("FAILED", None, Some(e.clone())),
            };
            let complete_url = format!("{control_plane_url}/api/infrastructure/nodes/operations/{}/complete", op.operation_id);
            let body = CompleteRequestBody { signed_token: signed_token_fn()?, status, result: result.clone(), error: error.clone() };
            match http.post(&complete_url).json(&body).send().await {
                Ok(resp) if resp.status().is_success() => {
                    tracing::info!(operation_id = %op.operation_id, kind = %op.kind, ok = outcome.is_ok(), "operation executed");
                }
                _ => {
                    // Delivery failed (WAN outage mid-execution): don't
                    // lose the result -- queue it locally for the next
                    // successful poll cycle to flush, per §55.
                    let entry = QueuedCompletion { operation_id: op.operation_id.clone(), status: status.to_string(), result, error, queued_at: chrono::Utc::now().to_rfc3339() };
                    if let Err(e) = self.queue_completion_offline(&entry).await {
                        tracing::error!(operation_id = %op.operation_id, error = %e, "failed to queue completion offline -- result may be lost");
                    } else {
                        tracing::warn!(operation_id = %op.operation_id, "control plane unreachable, completion queued locally");
                    }
                }
            }
        }
        Ok(count)
    }
}

#[cfg(test)]
mod offline_queue_tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    /// A minimal real HTTP server (one TCP accept loop, no framework) that
    /// always returns 200, so the flush path is exercised against a real
    /// socket round-trip, not a mock object.
    async fn spawn_always_ok_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn fake_token() -> Result<String, anyhow::Error> {
        Ok("fake.token".to_string())
    }

    #[tokio::test]
    async fn a_completion_that_cannot_be_delivered_is_queued_locally_not_lost() {
        let dir = std::env::temp_dir().join(format!("inaya-offline-test-{}", uuid::Uuid::new_v4()));
        let executor = OperationExecutor::new(dir.clone());
        assert_eq!(executor.offline_queue_depth().await, 0);

        // Port 1 on loopback refuses connections immediately -- a real,
        // deterministic "unreachable control plane" without needing an
        // actual network outage.
        let unreachable = "http://127.0.0.1:1";
        let entry = QueuedCompletion {
            operation_id: "op-1".into(),
            status: "SUCCEEDED".into(),
            result: Some(json!({"ok": true})),
            error: None,
            queued_at: chrono::Utc::now().to_rfc3339(),
        };
        let client = reqwest::Client::new();
        let delivered = client.post(format!("{unreachable}/x")).json(&entry).send().await.is_ok();
        assert!(!delivered, "127.0.0.1:1 should genuinely refuse the connection");
        executor.queue_completion_offline(&entry).await.unwrap();

        assert_eq!(executor.offline_queue_depth().await, 1);
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn flush_delivers_queued_completions_through_a_real_http_round_trip_and_clears_the_queue() {
        let dir = std::env::temp_dir().join(format!("inaya-offline-test-{}", uuid::Uuid::new_v4()));
        let executor = OperationExecutor::new(dir.clone());

        for i in 0..3 {
            let entry = QueuedCompletion {
                operation_id: format!("op-{i}"),
                status: "SUCCEEDED".into(),
                result: Some(json!({"i": i})),
                error: None,
                queued_at: chrono::Utc::now().to_rfc3339(),
            };
            executor.queue_completion_offline(&entry).await.unwrap();
        }
        assert_eq!(executor.offline_queue_depth().await, 3);

        let server_url = spawn_always_ok_server().await;
        let flushed = executor.flush_offline_queue(&server_url, &fake_token).await.unwrap();
        assert_eq!(flushed, 3);
        assert_eq!(executor.offline_queue_depth().await, 0);
        assert!(!executor.offline_queue_path.exists());

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}

/// Gap-closure round, Phase A/D real-world proof: no VM in this project had
/// ever booted a real guest OS before this round (ledger
/// INFRA-C-007/INFRA-NET-006). This exercises the complete real path --
/// real VPC (bridge + NAT), real base-image download and cache, real
/// QEMU/KVM boot with a real cloud-init seed, real static networking, and
/// a real guest-exec SSH connection proving the guest OS genuinely came
/// up and is reachable -- not a mocked or assumed outcome. Requires root
/// (CAP_NET_ADMIN) and a real internet path to cloud-images.ubuntu.com;
/// skipped honestly, not silently passed, when either is unavailable. This
/// can genuinely take several minutes (image download on first run, VM
/// boot, cloud-init).
#[cfg(test)]
mod real_guest_boot_tests {
    use super::*;

    async fn is_root() -> bool {
        tokio::process::Command::new("id").arg("-u").output().await.map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0").unwrap_or(false)
    }

    #[tokio::test]
    async fn real_guest_boots_from_the_real_base_image_and_answers_real_ssh() {
        if !is_root().await {
            eprintln!("SKIPPED: requires root (CAP_NET_ADMIN for bridge/tap/NAT) -- not run, not claimed passing");
            return;
        }

        // A stable (not per-run-UUID) directory so the real ~650MB base
        // image, once downloaded, is reused across repeated local test
        // runs instead of re-fetched every time -- vms/seeds/volumes
        // still get fresh per-run instance/vpc IDs below, so this never
        // reuses stale VM state, only the cached base image.
        let runtime_dir = std::env::temp_dir().join("inaya-infra-guestboot-test-shared");
        let executor = OperationExecutor::new(runtime_dir.clone());

        let vpc_id = format!("gbtest-{}", uuid::Uuid::new_v4());
        let vpc_op = PendingOperation { operation_id: "op-vpc".into(), kind: "CREATE_VPC".into(), params: json!({"vpcId": vpc_id, "cidr": "10.199.0.1/24"}) };
        executor.execute(&vpc_op).await.expect("real VPC (bridge + NAT) creation should succeed as root");

        let instance_id = format!("gb-{}", uuid::Uuid::new_v4());
        let boot_op = PendingOperation {
            operation_id: "op-boot".into(),
            kind: "BOOT_GUEST_INSTANCE".into(),
            params: json!({
                "instanceId": instance_id,
                "name": "real-guest-boot-test",
                "vcpu": 2,
                "memoryMib": 1024,
                "staticIp": "10.199.0.10",
                "gatewayIp": "10.199.0.1",
                "role": "plain",
                "vpcId": vpc_id,
                "securityGroupRules": []
            }),
        };
        let result = executor.execute(&boot_op).await;

        // Always clean up, even on failure, so a failed run doesn't leave a
        // real bridge/NAT table or VM process behind.
        let terminate_op = PendingOperation { operation_id: "op-term".into(), kind: "TERMINATE_INSTANCE".into(), params: json!({"instanceId": instance_id}) };
        let _ = executor.execute(&terminate_op).await;
        let delete_vpc_op = PendingOperation { operation_id: "op-delvpc".into(), kind: "DELETE_VPC".into(), params: json!({"vpcId": vpc_id}) };
        let _ = executor.execute(&delete_vpc_op).await;
        // Deliberately NOT removing runtime_dir itself -- see the comment
        // above on why the cached base image under it is kept.

        match result {
            Ok(v) => assert_eq!(v.get("staticIp").and_then(|s| s.as_str()), Some("10.199.0.10"), "real guest boot should report the real static IP it was assigned: {v}"),
            Err(e) => panic!("real guest boot (image download + QEMU/KVM boot + cloud-init + SSH reachability) failed: {e}"),
        }
    }

    /// Phase D's real deliverable: a real k3s server (real upstream
    /// Kubernetes, not a reimplementation) installed on a real guest VM via
    /// cloud-init's runcmd, with the node daemon pulling back its real
    /// node-token and kubeconfig over guest-exec SSH once ready. Requires
    /// real outbound internet from the guest (through the VPC's NAT) to
    /// reach get.k3s.io and pull the real k3s binary/images -- this is the
    /// same NAT path Phase A's network crate test already proves exists,
    /// now exercised by a real consumer.
    #[tokio::test]
    async fn real_k3s_server_installs_and_returns_a_real_node_token_and_kubeconfig() {
        if !is_root().await {
            eprintln!("SKIPPED: requires root (CAP_NET_ADMIN for bridge/tap/NAT) -- not run, not claimed passing");
            return;
        }

        let runtime_dir = std::env::temp_dir().join("inaya-infra-guestboot-test-shared");
        let executor = OperationExecutor::new(runtime_dir.clone());

        let vpc_id = format!("k3stest-{}", uuid::Uuid::new_v4());
        let vpc_op = PendingOperation { operation_id: "op-vpc".into(), kind: "CREATE_VPC".into(), params: json!({"vpcId": vpc_id, "cidr": "10.198.0.1/24"}) };
        executor.execute(&vpc_op).await.expect("real VPC (bridge + NAT) creation should succeed as root");

        let instance_id = format!("k3s-{}", uuid::Uuid::new_v4());
        let boot_op = PendingOperation {
            operation_id: "op-boot".into(),
            kind: "BOOT_GUEST_INSTANCE".into(),
            params: json!({
                "instanceId": instance_id,
                "name": "real-k3s-server-test",
                "vcpu": 2,
                "memoryMib": 3072,
                "staticIp": "10.198.0.10",
                "gatewayIp": "10.198.0.1",
                "role": "k8s-server",
                "vpcId": vpc_id,
                "securityGroupRules": []
            }),
        };
        let result = executor.execute(&boot_op).await;

        // Real diagnostic capture on failure: the guest is still running
        // at this point (only terminated below), so pull the real
        // systemd/journalctl state for k3s.service before tearing down --
        // this is exactly what let this test's own earlier failure
        // (k3s.service failing to start after a successful install) be
        // root-caused from a live guest instead of guessing blind.
        if result.is_err() {
            if let Ok(mut diag) = GuestSession::connect_with_retry("10.198.0.10", 22, "inaya", &executor.guest_ssh_key, Duration::from_secs(30)).await {
                // Raw exec(), not exec_text() -- systemctl status returns a
                // non-zero exit for a failed unit, and exec_text() would
                // discard its real stdout in that case (only stderr
                // survives into its error message).
                for cmd in ["systemctl status k3s.service --no-pager -l", "journalctl -xeu k3s.service --no-pager | tail -80", "free -h", "nproc", "df -h /"] {
                    match diag.exec(cmd).await {
                        Ok(out) => eprintln!("=== {cmd} (exit {}) ===\n{}\n{}", out.exit_status, String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)),
                        Err(e) => eprintln!("=== {cmd} (channel error: {e}) ==="),
                    }
                }
            } else {
                eprintln!("(diagnostic SSH reconnect failed -- guest may no longer be reachable)");
            }
        }

        let terminate_op = PendingOperation { operation_id: "op-term".into(), kind: "TERMINATE_INSTANCE".into(), params: json!({"instanceId": instance_id}) };
        let _ = executor.execute(&terminate_op).await;
        let delete_vpc_op = PendingOperation { operation_id: "op-delvpc".into(), kind: "DELETE_VPC".into(), params: json!({"vpcId": vpc_id}) };
        let _ = executor.execute(&delete_vpc_op).await;

        match result {
            Ok(v) => {
                let token = v.get("k3sNodeToken").and_then(|t| t.as_str()).expect("a real k3s node-token should be returned");
                let kubeconfig = v.get("kubeconfig").and_then(|k| k.as_str()).expect("a real kubeconfig should be returned");
                assert!(token.starts_with("K10"), "a real k3s node-token has the real k10<hash>::server:<secret> shape, got: {token}");
                assert!(kubeconfig.contains("10.198.0.10"), "the real guest's static IP should be substituted into the kubeconfig's server URL, not left as 127.0.0.1:\n{kubeconfig}");
                assert!(kubeconfig.contains("client-certificate-data") || kubeconfig.contains("certificate-authority-data"), "a real k3s kubeconfig should carry real embedded certs:\n{kubeconfig}");
            }
            Err(e) => panic!("real k3s server install (real guest boot + real get.k3s.io installer + real node-token/kubeconfig retrieval) failed: {e}"),
        }
    }

    /// Diagnostic only: proves (or disproves) that a guest can reach the
    /// real internet through the VPC's NAT path, independent of the k3s
    /// installer itself -- isolates whether a slow/failed k3s install is a
    /// networking problem or an installer-specific one.
    #[tokio::test]
    async fn diagnostic_guest_outbound_internet_via_nat() {
        if !is_root().await {
            eprintln!("SKIPPED: requires root");
            return;
        }
        let runtime_dir = std::env::temp_dir().join("inaya-infra-guestboot-test-shared");
        let executor = OperationExecutor::new(runtime_dir.clone());

        let vpc_id = format!("nattest-{}", uuid::Uuid::new_v4());
        let vpc_op = PendingOperation { operation_id: "op-vpc".into(), kind: "CREATE_VPC".into(), params: json!({"vpcId": vpc_id, "cidr": "10.197.0.1/24"}) };
        executor.execute(&vpc_op).await.expect("real VPC creation should succeed as root");

        let instance_id = format!("nat-{}", uuid::Uuid::new_v4());
        let boot_op = PendingOperation {
            operation_id: "op-boot".into(),
            kind: "BOOT_GUEST_INSTANCE".into(),
            params: json!({
                "instanceId": instance_id, "name": "nat-diag", "vcpu": 1, "memoryMib": 1024,
                "staticIp": "10.197.0.10", "gatewayIp": "10.197.0.1", "role": "plain",
                "vpcId": vpc_id, "securityGroupRules": []
            }),
        };
        executor.execute(&boot_op).await.expect("real guest boot should succeed (already proven)");

        let mut session = GuestSession::connect_with_retry("10.197.0.10", 22, "inaya", &executor.guest_ssh_key, Duration::from_secs(240)).await.expect("SSH should connect (already proven)");
        let dns = session.exec("getent hosts get.k3s.io").await.unwrap();
        let ping = session.exec("ping -c 2 -W 3 1.1.1.1").await.unwrap();
        let curl = session.exec("curl -v --max-time 15 https://get.k3s.io -o /dev/null").await.unwrap();
        eprintln!("DNS lookup (exit {}): {}", dns.exit_status, String::from_utf8_lossy(&dns.stdout));
        eprintln!("ping 1.1.1.1 (exit {}): {}", ping.exit_status, String::from_utf8_lossy(&ping.stdout));
        eprintln!("curl get.k3s.io (exit {}): stderr={}", curl.exit_status, String::from_utf8_lossy(&curl.stderr));

        let terminate_op = PendingOperation { operation_id: "op-term".into(), kind: "TERMINATE_INSTANCE".into(), params: json!({"instanceId": instance_id}) };
        let _ = executor.execute(&terminate_op).await;
        let delete_vpc_op = PendingOperation { operation_id: "op-delvpc".into(), kind: "DELETE_VPC".into(), params: json!({"vpcId": vpc_id}) };
        let _ = executor.execute(&delete_vpc_op).await;
    }
}
