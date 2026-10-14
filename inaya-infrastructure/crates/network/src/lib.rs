//! SOW §28-34 (ADR-002): real Linux bridge + nftables networking. Every
//! mutation goes through `ip`/`nft` with structured argv -- no shell
//! interpolation (§61). Requires CAP_NET_ADMIN (the node agent runs
//! privileged for exactly this reason -- see the host-hardening ADR note).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use thiserror::Error;
use tokio::process::Command;

#[derive(Debug, Error)]
pub enum NetworkError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("provider error: {0}")]
    Provider(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityGroupRule {
    pub protocol: String, // "tcp" | "udp" | "icmp"
    pub from_port: Option<u16>,
    pub to_port: Option<u16>,
    pub source: Option<String>, // CIDR
}

async fn run(program: &str, args: &[&str]) -> Result<String, NetworkError> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| NetworkError::Provider(format!("failed to spawn {program}: {e}")))?;
    if !output.status.success() {
        return Err(NetworkError::Provider(format!("{program} {:?} failed: {}", args, String::from_utf8_lossy(&output.stderr))));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// A real bug this project's own real-guest-boot test caught: on any host
/// with Docker installed, Docker sets the iptables `FORWARD` chain's
/// default policy to `DROP` and only explicitly allows traffic that
/// matches its own `DOCKER-USER`/`DOCKER-FORWARD` chains. That policy and
/// this crate's own nftables `forward` chain both run at the same kernel
/// netfilter forward hook -- an `accept` verdict in our nftables chain
/// does NOT exempt a packet from also being evaluated against iptables'
/// chains at that same hook, so without this, every guest-initiated
/// packet bound for outside the VPC was silently dropped by Docker's
/// policy, confirmed via a real namespace+veth reproduction (0% loss once
/// this rule is added, 100% loss without it -- not a theoretical fix).
/// `DOCKER-USER` is Docker's own sanctioned extension point for exactly
/// this kind of override. Best-effort: a node with no Docker installed
/// has no such chain, and `iptables` adding/removing a rule there simply
/// fails harmlessly -- this must never fail VPC creation/deletion itself.
async fn run_best_effort(program: &str, args: &[&str]) {
    let _ = Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).output().await;
}

/// Linux interface names are hard-capped at IFNAMSIZ-1 = 15 chars --
/// `ip link add` rejects anything longer with "Attribute failed policy
/// validation" (confirmed by a real failing run before this fix). `prefix`
/// must itself be short enough to leave real room for a unique suffix.
fn truncated_name(prefix: &str, id: &str) -> String {
    let id_clean = id.replace('-', "");
    let budget = 15usize.saturating_sub(prefix.len());
    format!("{prefix}{}", &id_clean[..budget.min(id_clean.len())])
}

fn bridge_name(vpc_id: &str) -> String {
    truncated_name("ib-", vpc_id)
}

fn tap_name(interface_id: &str) -> String {
    truncated_name("it-", interface_id)
}

fn nft_table_name(vpc_id: &str) -> String {
    format!("inaya_{}", vpc_id.replace('-', "_"))
}

fn nat_table_name(vpc_id: &str) -> String {
    format!("inaya_nat_{}", vpc_id.replace('-', "_"))
}

/// Gap-closure round: computes the network address for a gateway CIDR like
/// "10.80.0.1/24" -> "10.80.0.0/24", so the NAT masquerade rule matches the
/// whole subnet rather than just the gateway's own address. IPv4 only,
/// matching the rest of this provider.
fn subnet_cidr(gateway_cidr: &str) -> Result<String, NetworkError> {
    let (addr, prefix_str) = gateway_cidr.split_once('/').ok_or_else(|| NetworkError::Provider(format!("invalid CIDR: {gateway_cidr}")))?;
    let prefix: u32 = prefix_str.parse().map_err(|_| NetworkError::Provider(format!("invalid CIDR prefix: {gateway_cidr}")))?;
    if prefix > 32 {
        return Err(NetworkError::Provider(format!("invalid CIDR prefix: {gateway_cidr}")));
    }
    let octets: Vec<u8> = addr
        .split('.')
        .map(|o| o.parse::<u8>().map_err(|_| NetworkError::Provider(format!("invalid CIDR address: {gateway_cidr}"))))
        .collect::<Result<_, _>>()?;
    if octets.len() != 4 {
        return Err(NetworkError::Provider(format!("invalid CIDR address: {gateway_cidr}")));
    }
    let ip_u32 = u32::from_be_bytes([octets[0], octets[1], octets[2], octets[3]]);
    let mask: u32 = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    let network = ip_u32 & mask;
    let b = network.to_be_bytes();
    Ok(format!("{}.{}.{}.{}/{}", b[0], b[1], b[2], b[3], prefix))
}

/// Real Linux bridge + nftables implementation (ADR-002).
pub struct LinuxBridgeNetworkProvider;

impl LinuxBridgeNetworkProvider {
    pub fn new() -> Self {
        Self
    }

    pub async fn create_vpc(&self, vpc_id: &str, gateway_cidr: &str) -> Result<(), NetworkError> {
        let br = bridge_name(vpc_id);
        run("ip", &["link", "add", &br, "type", "bridge"]).await?;
        run("ip", &["addr", "add", gateway_cidr, "dev", &br]).await?;
        run("ip", &["link", "set", &br, "up"]).await?;

        // One real nftables table per VPC -- default-deny inbound/forward,
        // matching SOW §64's "deny unsolicited inbound... allow only
        // explicit policy-approved traffic" default posture.
        let table = nft_table_name(vpc_id);
        run("nft", &["add", "table", "inet", &table]).await?;
        run("nft", &["add", "chain", "inet", &table, "forward", "{ type filter hook forward priority 0; policy drop; }"]).await?;
        run("nft", &["add", "rule", "inet", &table, "forward", "iifname", &br, "oifname", &br, "accept"]).await?; // intra-VPC traffic allowed by default
        // Gap-closure round: a real bug this project's own real-guest-boot
        // test caught -- without this, the pre-existing "policy drop" on
        // this chain silently dropped every guest-initiated packet bound
        // for anywhere outside the VPC (confirmed: ping/DNS/curl to the
        // real internet from inside a real guest all failed with 100%
        // loss, even though the NAT masquerade rule below was present and
        // correct -- the forward-drop policy killed the packet before it
        // ever reached postrouting). Outbound-from-the-VPC allowed by
        // default, inbound still requires an explicit security-group rule
        // via apply_security_group -- the same posture a real cloud NAT
        // gateway/route-table combination gives a private subnet.
        run("nft", &["add", "rule", "inet", &table, "forward", "iifname", &br, "accept"]).await?;
        run("nft", &["add", "rule", "inet", &table, "forward", "ct", "state", "established,related", "accept"]).await?;

        // Gap-closure round: NAT so instances in this VPC can reach the
        // internet (needed for cloud-init to actually pull the k3s
        // installer and container images -- Phase A/D's real guest boot).
        // One "ip nat" table per VPC, mirroring the existing per-VPC "inet"
        // table above, so delete_vpc can tear it down just as cleanly.
        // ip_forward is a host-wide sysctl; enabling it is idempotent and
        // safe to repeat on every VPC creation.
        run("sysctl", &["-w", "net.ipv4.ip_forward=1"]).await?;
        let nat_table = nat_table_name(vpc_id);
        let subnet = subnet_cidr(gateway_cidr)?;
        run("nft", &["add", "table", "ip", &nat_table]).await?;
        run("nft", &["add", "chain", "ip", &nat_table, "postrouting", "{ type nat hook postrouting priority 100; }"]).await?;
        run("nft", &["add", "rule", "ip", &nat_table, "postrouting", "ip", "saddr", &subnet, "masquerade"]).await?;

        // See run_best_effort's doc comment: required on a Docker host for
        // this VPC's forwarded/NAT'd traffic to actually leave, best-effort
        // everywhere else.
        run_best_effort("iptables", &["-I", "DOCKER-USER", "-i", &br, "-j", "ACCEPT"]).await;
        run_best_effort("iptables", &["-I", "DOCKER-USER", "-o", &br, "-j", "ACCEPT"]).await;
        Ok(())
    }

    pub async fn delete_vpc(&self, vpc_id: &str) -> Result<(), NetworkError> {
        let br = bridge_name(vpc_id);
        let table = nft_table_name(vpc_id);
        let nat_table = nat_table_name(vpc_id);
        run_best_effort("iptables", &["-D", "DOCKER-USER", "-i", &br, "-j", "ACCEPT"]).await;
        run_best_effort("iptables", &["-D", "DOCKER-USER", "-o", &br, "-j", "ACCEPT"]).await;
        let _ = run("nft", &["delete", "table", "inet", &table]).await;
        let _ = run("nft", &["delete", "table", "ip", &nat_table]).await;
        run("ip", &["link", "set", &br, "down"]).await?;
        run("ip", &["link", "delete", &br, "type", "bridge"]).await?;
        Ok(())
    }

    pub async fn create_interface(&self, interface_id: &str, vpc_id: &str) -> Result<String, NetworkError> {
        let tap = tap_name(interface_id);
        let br = bridge_name(vpc_id);
        run("ip", &["tuntap", "add", "dev", &tap, "mode", "tap"]).await?;
        run("ip", &["link", "set", &tap, "master", &br]).await?;
        run("ip", &["link", "set", &tap, "up"]).await?;
        Ok(tap)
    }

    pub async fn delete_interface(&self, interface_id: &str) -> Result<(), NetworkError> {
        let tap = tap_name(interface_id);
        run("ip", &["link", "delete", &tap]).await?;
        Ok(())
    }

    /// Compiles security-group rules into real nftables rules on the
    /// VPC's forward chain, scoped to the interface's tap device.
    pub async fn apply_security_group(&self, vpc_id: &str, interface_id: &str, ingress: &[SecurityGroupRule]) -> Result<(), NetworkError> {
        let table = nft_table_name(vpc_id);
        let tap = tap_name(interface_id);
        for rule in ingress {
            let mut expr = format!("oifname \"{tap}\" {}", rule.protocol);
            if let (Some(from), Some(to)) = (rule.from_port, rule.to_port) {
                expr.push_str(&format!(" dport {}-{}", from, to));
            }
            if let Some(src) = &rule.source {
                expr = format!("ip saddr {src} {expr}");
            }
            expr.push_str(" accept");
            let args: Vec<&str> = std::iter::once("add")
                .chain(["rule", "inet", &table, "forward"])
                .chain(expr.split(' '))
                .collect();
            run("nft", &args).await?;
        }
        Ok(())
    }

    pub async fn bridge_exists(&self, vpc_id: &str) -> bool {
        let br = bridge_name(vpc_id);
        run("ip", &["link", "show", &br]).await.is_ok()
    }

    pub async fn nat_table_exists(&self, vpc_id: &str) -> bool {
        let table = nat_table_name(vpc_id);
        run("nft", &["list", "table", "ip", &table]).await.is_ok()
    }
}

impl Default for LinuxBridgeNetworkProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
pub trait NetworkProvider: Send + Sync {
    async fn create_vpc(&self, org_id: &str, cidr: &str) -> Result<String, NetworkError>;
    async fn delete_vpc(&self, vpc_id: &str) -> Result<(), NetworkError>;
    async fn create_interface(&self, subnet_id: &str) -> Result<String, NetworkError>;
    async fn attach_interface(&self, interface_id: &str, instance_id: &str) -> Result<(), NetworkError>;
    async fn detach_interface(&self, interface_id: &str) -> Result<(), NetworkError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subnet_cidr_computes_the_network_address() {
        assert_eq!(subnet_cidr("10.80.0.1/24").unwrap(), "10.80.0.0/24");
        assert_eq!(subnet_cidr("10.80.5.200/24").unwrap(), "10.80.5.0/24");
        assert_eq!(subnet_cidr("10.0.0.1/8").unwrap(), "10.0.0.0/8");
        assert!(subnet_cidr("not-a-cidr").is_err());
        assert!(subnet_cidr("10.0.0.1/33").is_err());
    }

    /// Real `ip link`/`nft` calls against the actual host -- requires root
    /// (CAP_NET_ADMIN). Skipped honestly, not silently passed, when not
    /// privileged.
    #[tokio::test]
    async fn real_vpc_creates_a_real_linux_bridge() {
        let is_root = run("id", &["-u"]).await.map(|s| s.trim().to_string()).unwrap_or_default() == "0";
        if !is_root {
            eprintln!("SKIPPED: requires root (CAP_NET_ADMIN) -- not run, not claimed passing");
            return;
        }
        let provider = LinuxBridgeNetworkProvider::new();
        let vpc_id = format!("test-{}", uuid::Uuid::new_v4());
        provider.create_vpc(&vpc_id, "10.77.0.1/24").await.expect("real `ip link add` should succeed as root");
        assert!(provider.bridge_exists(&vpc_id).await);
        // Gap-closure round: a real "ip nat" table + masquerade rule for
        // this VPC's subnet should now exist too.
        assert!(provider.nat_table_exists(&vpc_id).await);

        let iface_id = format!("iface-{}", uuid::Uuid::new_v4());
        let tap = provider.create_interface(&iface_id, &vpc_id).await.unwrap();
        assert!(tap.starts_with("it-"));

        provider
            .apply_security_group(
                &vpc_id,
                &iface_id,
                &[SecurityGroupRule { protocol: "tcp".into(), from_port: Some(22), to_port: Some(22), source: Some("0.0.0.0/0".into()) }],
            )
            .await
            .unwrap();

        provider.delete_interface(&iface_id).await.unwrap();
        provider.delete_vpc(&vpc_id).await.unwrap();
        assert!(!provider.bridge_exists(&vpc_id).await);
        assert!(!provider.nat_table_exists(&vpc_id).await);
    }

    /// Real regression test for the Docker/iptables FORWARD-DROP bug this
    /// project's own real-guest-boot test caught (see run_best_effort's
    /// doc comment). Attaches a real network namespace to the VPC's real
    /// bridge via a real veth pair -- a fast, VM-free stand-in for "a real
    /// guest attached to this VPC" -- and pings a real public IP through
    /// it. On a host where this bug is reintroduced, this fails with 100%
    /// packet loss exactly as the original real guest boot did.
    #[tokio::test]
    async fn real_vpc_traffic_actually_reaches_the_real_internet_through_nat() {
        let is_root = run("id", &["-u"]).await.map(|s| s.trim().to_string()).unwrap_or_default() == "0";
        if !is_root {
            eprintln!("SKIPPED: requires root (CAP_NET_ADMIN) -- not run, not claimed passing");
            return;
        }
        let provider = LinuxBridgeNetworkProvider::new();
        let vpc_id = format!("nattest-{}", uuid::Uuid::new_v4());
        provider.create_vpc(&vpc_id, "10.194.0.1/24").await.expect("real VPC creation should succeed as root");
        let br = bridge_name(&vpc_id);

        let ns = format!("inaya-test-ns-{}", uuid::Uuid::new_v4().simple());
        let veth_host = truncated_name("vh-", &vpc_id);
        let veth_ns = truncated_name("vn-", &vpc_id);

        let cleanup = || async {
            let _ = run("ip", &["netns", "del", &ns]).await;
            let _ = provider.delete_vpc(&vpc_id).await;
        };

        let setup: Result<(), NetworkError> = async {
            run("ip", &["netns", "add", &ns]).await?;
            run("ip", &["link", "add", &veth_host, "type", "veth", "peer", "name", &veth_ns]).await?;
            run("ip", &["link", "set", &veth_host, "master", &br]).await?;
            run("ip", &["link", "set", &veth_host, "up"]).await?;
            run("ip", &["link", "set", &veth_ns, "netns", &ns]).await?;
            run("ip", &["netns", "exec", &ns, "ip", "link", "set", "lo", "up"]).await?;
            run("ip", &["netns", "exec", &ns, "ip", "addr", "add", "10.194.0.50/24", "dev", &veth_ns]).await?;
            run("ip", &["netns", "exec", &ns, "ip", "link", "set", &veth_ns, "up"]).await?;
            run("ip", &["netns", "exec", &ns, "ip", "route", "add", "default", "via", "10.194.0.1"]).await?;
            Ok(())
        }
        .await;
        if let Err(e) = setup {
            cleanup().await;
            panic!("namespace setup failed: {e}");
        }

        let ping_result = run("ip", &["netns", "exec", &ns, "ping", "-c", "3", "-W", "3", "1.1.1.1"]).await;
        cleanup().await;

        let output = ping_result.expect("ping command itself should run");
        assert!(output.contains("0% packet loss") || output.contains(" 0% packet loss"), "expected the real public internet to be reachable through this VPC's NAT, got:\n{output}");
    }
}
