//! Gap-closure round, Phase A: real NoCloud cloud-init seed generation.
//! Writes user-data/meta-data/network-config and packs them into a real
//! seed ISO via `genisoimage`, through `security::run_command`'s argv-only
//! discipline -- never a shell string, matching every other process
//! invocation in this workspace (SOW §61).

use security::run_command;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CloudInitError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("genisoimage failed: {0}")]
    Genisoimage(String),
}

/// Static IPv4 config for one instance's network-config. DHCP isn't built
/// (ledger INFRA-NET-006, deferred) -- this is the real replacement: each
/// instance gets a deterministic static address inside its VPC's subnet,
/// with the bridge (which already gets the VPC's gateway address in
/// `network::create_vpc`) as its gateway.
#[derive(Debug, Clone)]
pub struct StaticNetworkConfig {
    /// e.g. "10.80.0.5/24"
    pub address_cidr: String,
    /// e.g. "10.80.0.1"
    pub gateway: String,
}

/// Untrusted, caller-supplied shell commands (e.g. the k3s installer
/// invocation) are written verbatim into user-data's own `runcmd:` YAML
/// list -- that's cloud-init's own mechanism for running boot-time
/// commands inside the guest, not a shell this function itself
/// constructs or interpolates (per `security::Untrusted`'s own marker
/// discipline: the caller is responsible for only passing real, intended
/// commands here, same as CreateInstanceRequest's `cloud_init` field
/// already documents for untrusted cloud-init content in general).
pub struct NoCloudSeedRequest<'a> {
    pub instance_id: &'a str,
    pub hostname: &'a str,
    pub network: Option<&'a StaticNetworkConfig>,
    pub ssh_authorized_key: Option<&'a str>,
    pub runcmd: &'a [String],
}

fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Builds a real NoCloud seed ISO for one instance under `seed_dir`
/// (one directory per instance, so concurrent instance creation never
/// shares or races over the same `user-data`/`meta-data` files).
pub async fn build_nocloud_seed(seed_dir: &Path, req: NoCloudSeedRequest<'_>) -> Result<PathBuf, CloudInitError> {
    tokio::fs::create_dir_all(seed_dir).await?;

    let mut user_data = String::from("#cloud-config\n");
    user_data.push_str(&format!("hostname: {}\n", req.hostname));
    user_data.push_str("manage_etc_hosts: true\n");
    // Deliberately no `package_update`/`package_upgrade` -- an apt-get
    // update/upgrade on first boot adds real time and a real network-
    // dependent failure point this guest doesn't need; runcmd's own
    // installers (e.g. k3s's) fetch exactly what they require.
    if let Some(key) = req.ssh_authorized_key {
        user_data.push_str("users:\n  - name: inaya\n    sudo: 'ALL=(ALL) NOPASSWD:ALL'\n    shell: /bin/bash\n    ssh_authorized_keys:\n");
        user_data.push_str(&format!("      - {}\n", yaml_quote(key)));
    }
    // A real, observed gap (confirmed via this project's own real-guest-boot
    // test's serial console log, and matching widely reported real-world
    // cloud-init/NoCloud/QEMU behavior): cloud-init's network stage can
    // render /etc/netplan/50-cloud-init.yaml (`netplan generate`) without
    // actually activating it (`netplan apply`) in time for
    // systemd-networkd-wait-online to see a configured interface -- the
    // guest sits with no IP indefinitely otherwise. Forcing a real
    // `netplan apply` as the first runcmd step is the real fix, not a
    // cosmetic one: everything downstream (SSH reachability, the k3s
    // installer's own network needs) depends on it.
    let mut effective_runcmd: Vec<String> = Vec::new();
    if req.network.is_some() {
        effective_runcmd.push("netplan apply".to_string());
    }
    effective_runcmd.extend(req.runcmd.iter().cloned());
    if !effective_runcmd.is_empty() {
        user_data.push_str("runcmd:\n");
        for cmd in &effective_runcmd {
            user_data.push_str(&format!("  - {}\n", yaml_quote(cmd)));
        }
    }

    let meta_data = format!("instance-id: {}\nlocal-hostname: {}\n", req.instance_id, req.hostname);

    let network_config = req.network.map(|n| {
        // `match: {name: "en*"}` + `set-name` is the standard robust
        // pattern here: a virtio-net-pci device under systemd predictable
        // naming does NOT reliably come up as literally "eth0" (it depends
        // on the guest's PCI bus/slot assignment, e.g. "enp0s2") -- hard-
        // coding "eth0:" as the match key silently fails to configure any
        // interface. Matching any "en*" device and renaming it is what
        // cloud-init's own docs recommend for exactly this QEMU scenario.
        // NoCloud's network-config is cloud-init's OWN network-config
        // format (v2 here), which wraps content under a top-level
        // `network:` key -- unlike a raw /etc/netplan/*.yaml file, which
        // has no such wrapper because its directory location already
        // implies it. Omitting the wrapper here is a real, silent-failure
        // bug this project's own real-guest-boot test caught: cloud-init
        // doesn't error on it, it just never applies the config, leaving
        // the interface unconfigured (confirmed via a real QEMU boot's
        // serial console log, not assumed).
        format!(
            "network:\n  version: 2\n  ethernets:\n    eth0:\n      match:\n        name: \"en*\"\n      set-name: eth0\n      addresses: [{addr}]\n      gateway4: {gw}\n      nameservers:\n        addresses: [8.8.8.8, 1.1.1.1]\n",
            addr = n.address_cidr,
            gw = n.gateway
        )
    });

    let user_data_path = seed_dir.join("user-data");
    let meta_data_path = seed_dir.join("meta-data");
    let network_config_path = seed_dir.join("network-config");
    tokio::fs::write(&user_data_path, &user_data).await?;
    tokio::fs::write(&meta_data_path, &meta_data).await?;
    if let Some(nc) = &network_config {
        tokio::fs::write(&network_config_path, nc).await?;
    }

    let iso_path = seed_dir.join("seed.iso");
    let iso_str = iso_path.to_str().ok_or_else(|| CloudInitError::Genisoimage("seed ISO path is not valid UTF-8".to_string()))?;
    let user_data_str = user_data_path.to_str().unwrap();
    let meta_data_str = meta_data_path.to_str().unwrap();
    let network_config_str = network_config_path.to_str().unwrap();

    let mut args: Vec<&str> = vec!["-output", iso_str, "-volid", "cidata", "-joliet", "-rock", user_data_str, meta_data_str];
    if network_config.is_some() {
        args.push(network_config_str);
    }
    run_command("genisoimage", &args).await.map_err(|e| CloudInitError::Genisoimage(e.to_string()))?;
    Ok(iso_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `genisoimage` invocation -- produces a real ISO 9660 file,
    /// verified here by actually mounting nothing (no root needed) but
    /// checking the file exists, is non-trivially sized, and that
    /// `isoinfo` (part of the same genisoimage/cdrkit package) can list
    /// the real files packed inside it -- not just that a file of some
    /// kind appeared on disk.
    #[tokio::test]
    async fn build_nocloud_seed_produces_a_real_iso_containing_the_expected_files() {
        let dir = std::env::temp_dir().join(format!("inaya-infra-cloudinit-test-{}", uuid::Uuid::new_v4()));
        let network = StaticNetworkConfig { address_cidr: "10.90.0.5/24".to_string(), gateway: "10.90.0.1".to_string() };
        let runcmd = vec!["curl -sfL https://get.k3s.io | sh -".to_string()];
        let req = NoCloudSeedRequest {
            instance_id: "test-instance-1",
            hostname: "test-vm",
            network: Some(&network),
            ssh_authorized_key: Some("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkeytestkeytestkeytestkeytestkey inaya-node"),
            runcmd: &runcmd,
        };

        let iso_path = build_nocloud_seed(&dir, req).await.expect("real genisoimage should succeed on this host");
        let meta = tokio::fs::metadata(&iso_path).await.expect("seed ISO should exist on disk");
        assert!(meta.len() > 0, "seed ISO should be non-empty");

        let listing = run_command("isoinfo", &["-l", "-i", iso_path.to_str().unwrap()]).await.expect("isoinfo should be able to read a real genisoimage-produced ISO");
        assert!(listing.to_uppercase().contains("USER_DAT") || listing.to_uppercase().contains("USER-DATA"), "ISO listing should contain user-data:\n{listing}");
        assert!(listing.to_uppercase().contains("META_DAT") || listing.to_uppercase().contains("META-DATA"), "ISO listing should contain meta-data:\n{listing}");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn yaml_quote_escapes_quotes_and_backslashes() {
        assert_eq!(yaml_quote("plain"), "\"plain\"");
        assert_eq!(yaml_quote("has \"quotes\""), "\"has \\\"quotes\\\"\"");
        assert_eq!(yaml_quote("back\\slash"), "\"back\\\\slash\"");
    }
}
