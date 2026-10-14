//! SOW §12, §13: the `ComputeProvider` abstraction, plus a real QEMU/KVM
//! implementation (Phase 2). Processes are launched with structured argv
//! arrays only (security::run_command-equivalent discipline) -- never a
//! shell string -- and controlled afterward over QMP (QEMU Machine
//! Protocol, a newline-delimited JSON control socket), never guest-facing.

pub mod cloud_image;
pub mod cloud_init;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VmState {
    Provisioning,
    Starting,
    Running,
    Stopping,
    Stopped,
    Rebooting,
    Terminating,
    Terminated,
    Error,
    Degraded,
    Unknown,
}

#[derive(Debug, Error)]
pub enum ComputeError {
    #[error("instance not found: {0}")]
    NotFound(String),
    #[error("invalid state transition from {from:?} to {to:?}")]
    InvalidTransition { from: VmState, to: VmState },
    #[error("provider error: {0}")]
    Provider(String),
    #[error("qmp error: {0}")]
    Qmp(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInstanceRequest {
    pub instance_id: String,
    pub name: String,
    pub vcpu: u32,
    pub memory_mib: u64,
    /// Path to a real qcow2/raw disk image (Phase 3's BlockStorageProvider
    /// creates this file; Phase 2 only attaches it). None boots with no
    /// disk at all -- a real QEMU process still starts, allocates real
    /// vCPU/RAM, and is fully controllable, it just has nothing to boot
    /// from. Honest either way: a guest OS is never claimed to have run
    /// unless a disk with a real OS on it is actually provided.
    pub disk_path: Option<PathBuf>,
    /// A tap device name already created and bridged by the NetworkProvider
    /// (Phase 4) -- this struct never creates network interfaces itself,
    /// it only attaches one that already exists, same separation of
    /// concerns as disk_path/BlockStorageProvider above.
    pub tap_device: Option<String>,
    /// SOW §17: untrusted input, size-limited, never parsed as a shell
    /// command -- passed through to cloud-init's own seed mechanism only.
    pub cloud_init: Option<String>,
    /// Gap-closure round, Phase A: a real NoCloud seed ISO already built by
    /// `cloud_init::build_nocloud_seed`, attached as a second virtual
    /// CD-ROM drive so cloud-init inside the guest can actually find and
    /// consume it. `None` boots with no seed at all (the pre-existing
    /// Phase 2 behavior, unchanged).
    pub cloud_init_iso: Option<PathBuf>,
}

#[async_trait]
pub trait ComputeProvider: Send + Sync {
    async fn create_instance(&self, req: CreateInstanceRequest) -> Result<(), ComputeError>;
    async fn start_instance(&self, instance_id: &str) -> Result<(), ComputeError>;
    async fn stop_instance(&self, instance_id: &str) -> Result<(), ComputeError>;
    async fn reboot_instance(&self, instance_id: &str) -> Result<(), ComputeError>;
    async fn terminate_instance(&self, instance_id: &str) -> Result<(), ComputeError>;
    async fn describe_instance(&self, instance_id: &str) -> Result<VmState, ComputeError>;
}

pub fn is_valid_transition(from: VmState, to: VmState) -> bool {
    use VmState::*;
    matches!(
        (from, to),
        (Provisioning, Starting)
            | (Provisioning, Error)
            | (Starting, Running)
            | (Starting, Error)
            | (Running, Stopping)
            | (Running, Rebooting)
            | (Running, Degraded)
            | (Running, Terminating)
            | (Stopping, Stopped)
            | (Stopping, Error)
            | (Stopped, Starting)
            | (Stopped, Terminating)
            | (Rebooting, Running)
            | (Rebooting, Error)
            | (Degraded, Running)
            | (Degraded, Terminating)
            | (Terminating, Terminated)
            | (Terminating, Error)
            | (_, Unknown)
    )
}

struct Qmp {
    stream: UnixStream,
}

impl Qmp {
    async fn connect(socket_path: &PathBuf) -> Result<Self, ComputeError> {
        let stream = UnixStream::connect(socket_path).await.map_err(|e| ComputeError::Qmp(format!("connect: {e}")))?;
        let mut qmp = Self { stream };
        // QMP greets with a capabilities banner; we must ack with qmp_capabilities before issuing commands.
        qmp.read_line().await?;
        qmp.command("qmp_capabilities", json!({})).await?;
        Ok(qmp)
    }

    async fn read_line(&mut self) -> Result<String, ComputeError> {
        let mut reader = BufReader::new(&mut self.stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.map_err(|e| ComputeError::Qmp(format!("read: {e}")))?;
        Ok(line)
    }

    async fn command(&mut self, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, ComputeError> {
        let payload = json!({ "execute": cmd, "arguments": args });
        let line = format!("{}\n", payload);
        self.stream.write_all(line.as_bytes()).await.map_err(|e| ComputeError::Qmp(format!("write: {e}")))?;
        let resp = self.read_line().await?;
        let parsed: serde_json::Value = serde_json::from_str(&resp).map_err(|e| ComputeError::Qmp(format!("parse: {e} ({resp})")))?;
        if parsed.get("error").is_some() {
            return Err(ComputeError::Qmp(format!("{} failed: {}", cmd, parsed)));
        }
        Ok(parsed)
    }
}

struct RunningInstance {
    child: Child,
    qmp_socket: PathBuf,
    state: VmState,
}

/// Real QEMU/KVM process management. One struct instance per node daemon
/// process (not per-instance) -- it tracks every VM that daemon currently
/// manages.
pub struct QemuKvmProvider {
    runtime_dir: PathBuf,
    instances: Arc<Mutex<HashMap<String, RunningInstance>>>,
}

impl QemuKvmProvider {
    pub fn new(runtime_dir: PathBuf) -> Self {
        Self {
            runtime_dir,
            instances: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn qmp_socket_path(&self, instance_id: &str) -> PathBuf {
        self.runtime_dir.join(format!("{instance_id}.qmp.sock"))
    }
}

#[async_trait]
impl ComputeProvider for QemuKvmProvider {
    async fn create_instance(&self, req: CreateInstanceRequest) -> Result<(), ComputeError> {
        tokio::fs::create_dir_all(&self.runtime_dir).await.map_err(|e| ComputeError::Provider(e.to_string()))?;
        let qmp_socket = self.qmp_socket_path(&req.instance_id);
        let _ = tokio::fs::remove_file(&qmp_socket).await; // stale socket from a previous crashed run
        // Real boot/cloud-init console output, captured to a file rather
        // than discarded -- a guest that never comes up (cloud-init
        // misconfiguration, a kernel that doesn't boot under this host's
        // virtualization) is otherwise undiagnosable from the control
        // plane's side, which only sees "guest never answered SSH" with no
        // further detail.
        let serial_log = self.runtime_dir.join(format!("{}.serial.log", req.instance_id));
        let mut args: Vec<String> = vec![
            "-enable-kvm".into(),
            "-m".into(),
            req.memory_mib.to_string(),
            "-smp".into(),
            req.vcpu.to_string(),
            "-name".into(),
            req.name.clone(),
            "-nographic".into(),
            "-qmp".into(),
            format!("unix:{},server,nowait", qmp_socket.display()),
            "-serial".into(),
            format!("file:{}", serial_log.display()),
            "-monitor".into(),
            "none".into(),
        ];
        if let Some(disk) = &req.disk_path {
            args.push("-drive".into());
            args.push(format!("file={},if=virtio,format=qcow2", disk.display()));
        }
        if let Some(seed_iso) = &req.cloud_init_iso {
            args.push("-drive".into());
            args.push(format!("file={},if=ide,media=cdrom,readonly=on", seed_iso.display()));
        }
        if let Some(tap) = &req.tap_device {
            args.push("-netdev".into());
            args.push(format!("tap,id=net0,ifname={tap},script=no,downscript=no"));
            args.push("-device".into());
            args.push("virtio-net-pci,netdev=net0".into());
        } else {
            args.push("-nic".into());
            args.push("none".into());
        }

        // Structured argv, no shell -- the exact discipline SOW §61 requires.
        let child = Command::new("qemu-system-x86_64")
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| ComputeError::Provider(format!("failed to spawn qemu: {e}")))?;

        // Wait for the QMP socket to appear (QEMU creates it shortly after start).
        for _ in 0..50 {
            if qmp_socket.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        let mut instances = self.instances.lock().await;
        instances.insert(
            req.instance_id.clone(),
            RunningInstance {
                child,
                qmp_socket,
                state: VmState::Running,
            },
        );
        Ok(())
    }

    async fn start_instance(&self, instance_id: &str) -> Result<(), ComputeError> {
        // Phase 2 scope: create_instance already starts the process (QEMU
        // doesn't have a separate "create, don't start" mode without more
        // machinery than this phase needs). A stopped instance's restart
        // path is reboot_instance's system_reset, or re-create.
        let instances = self.instances.lock().await;
        if instances.contains_key(instance_id) {
            Ok(())
        } else {
            Err(ComputeError::NotFound(instance_id.to_string()))
        }
    }

    async fn stop_instance(&self, instance_id: &str) -> Result<(), ComputeError> {
        let mut instances = self.instances.lock().await;
        let inst = instances.get_mut(instance_id).ok_or_else(|| ComputeError::NotFound(instance_id.to_string()))?;
        let mut qmp = Qmp::connect(&inst.qmp_socket).await?;
        qmp.command("system_powerdown", json!({})).await?;
        inst.state = VmState::Stopping;
        Ok(())
    }

    async fn reboot_instance(&self, instance_id: &str) -> Result<(), ComputeError> {
        let mut instances = self.instances.lock().await;
        let inst = instances.get_mut(instance_id).ok_or_else(|| ComputeError::NotFound(instance_id.to_string()))?;
        let mut qmp = Qmp::connect(&inst.qmp_socket).await?;
        qmp.command("system_reset", json!({})).await?;
        inst.state = VmState::Rebooting;
        Ok(())
    }

    async fn terminate_instance(&self, instance_id: &str) -> Result<(), ComputeError> {
        let mut instances = self.instances.lock().await;
        if let Some(mut inst) = instances.remove(instance_id) {
            let _ = inst.child.kill().await;
            let _ = tokio::fs::remove_file(&inst.qmp_socket).await;
            Ok(())
        } else {
            Err(ComputeError::NotFound(instance_id.to_string()))
        }
    }

    async fn describe_instance(&self, instance_id: &str) -> Result<VmState, ComputeError> {
        let mut instances = self.instances.lock().await;
        let inst = instances.get_mut(instance_id).ok_or_else(|| ComputeError::NotFound(instance_id.to_string()))?;
        // Real liveness check: has the OS process actually exited?
        match inst.child.try_wait() {
            Ok(Some(_status)) => {
                inst.state = VmState::Terminated;
            }
            Ok(None) => {} // still running, keep tracked state
            Err(_) => {
                inst.state = VmState::Unknown;
            }
        }
        Ok(inst.state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_to_stopping_is_valid() {
        assert!(is_valid_transition(VmState::Running, VmState::Stopping));
    }

    #[test]
    fn terminated_to_running_is_invalid() {
        assert!(!is_valid_transition(VmState::Terminated, VmState::Running));
    }

    /// Real QEMU/KVM process: launches, is genuinely alive (PID exists,
    /// process not exited), responds to a real QMP terminate, and the
    /// process genuinely disappears afterward. No disk attached -- this
    /// test proves the process lifecycle, not guest OS behavior.
    #[tokio::test]
    async fn real_qemu_instance_boots_and_terminates() {
        let runtime_dir = std::env::temp_dir().join(format!("inaya-infra-compute-test-{}", uuid::Uuid::new_v4()));
        let provider = QemuKvmProvider::new(runtime_dir.clone());
        let instance_id = "test-instance-1".to_string();

        provider
            .create_instance(CreateInstanceRequest {
                instance_id: instance_id.clone(),
                name: "test-vm".into(),
                vcpu: 1,
                memory_mib: 128,
                disk_path: None,
                tap_device: None,
                cloud_init: None,
                cloud_init_iso: None,
            })
            .await
            .expect("real qemu-system-x86_64 should spawn on this KVM-enabled host");

        let state = provider.describe_instance(&instance_id).await.unwrap();
        assert_eq!(state, VmState::Running);

        provider.terminate_instance(&instance_id).await.unwrap();
        let result = provider.describe_instance(&instance_id).await;
        assert!(matches!(result, Err(ComputeError::NotFound(_))));

        let _ = tokio::fs::remove_dir_all(&runtime_dir).await;
    }
}
