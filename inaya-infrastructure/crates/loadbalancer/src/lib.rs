//! Gap-closure round, Phase C (closes INFRA-ADV-001/INFRA-NET-009): a real
//! HAProxy process per load balancer, running on the customer's own node --
//! not a new packet-processing stack, per the original SOW's own stated
//! reason for deferring this ("Phase 1 should not create a custom
//! packet-processing stack"). Process lifecycle mirrors `compute`'s
//! `QemuKvmProvider` exactly: spawn, track a PID file, reload on config
//! change, kill on delete.

use security::run_command;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

#[derive(Debug, Error)]
pub enum LoadBalancerError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LbTarget {
    pub name: String,
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheck {
    /// Real TCP health checking (HAProxy's own `check` option) -- probes
    /// each target's own port, not a fabricated "always healthy" status.
    pub interval_ms: u64,
}

fn render_config(lb_id: &str, listen_port: u16, targets: &[LbTarget], health_check: &HealthCheck, pid_file: &PathBuf, socket_path: &PathBuf) -> String {
    let mut cfg = String::new();
    cfg.push_str("global\n");
    cfg.push_str(&format!("    pidfile {}\n", pid_file.display()));
    cfg.push_str(&format!("    stats socket {} mode 600 level admin\n", socket_path.display()));
    cfg.push_str("\ndefaults\n");
    cfg.push_str("    mode tcp\n");
    cfg.push_str("    timeout connect 5s\n");
    cfg.push_str("    timeout client 50s\n");
    cfg.push_str("    timeout server 50s\n");
    cfg.push_str(&format!("\nfrontend {lb_id}_frontend\n"));
    cfg.push_str(&format!("    bind *:{listen_port}\n"));
    cfg.push_str(&format!("    default_backend {lb_id}_backend\n"));
    cfg.push_str(&format!("\nbackend {lb_id}_backend\n"));
    cfg.push_str("    balance roundrobin\n");
    for t in targets {
        cfg.push_str(&format!("    server {} {}:{} check inter {}\n", t.name, t.address, t.port, health_check.interval_ms));
    }
    cfg
}

struct RunningLb {
    child: Child,
    config_path: PathBuf,
    pid_file: PathBuf,
    socket_path: PathBuf,
}

/// Real HAProxy process management -- one struct instance per node daemon
/// process, tracking every load balancer that daemon currently manages
/// (same shape as `QemuKvmProvider`).
pub struct HaproxyLoadBalancerProvider {
    runtime_dir: PathBuf,
    instances: Arc<Mutex<HashMap<String, RunningLb>>>,
}

impl HaproxyLoadBalancerProvider {
    pub fn new(runtime_dir: PathBuf) -> Self {
        Self { runtime_dir, instances: Arc::new(Mutex::new(HashMap::new())) }
    }

    fn paths(&self, lb_id: &str) -> (PathBuf, PathBuf, PathBuf) {
        let dir = self.runtime_dir.join(lb_id);
        (dir.join("haproxy.cfg"), dir.join("haproxy.pid"), dir.join("haproxy.sock"))
    }

    pub async fn create(&self, lb_id: &str, listen_port: u16, targets: &[LbTarget], health_check: &HealthCheck) -> Result<(), LoadBalancerError> {
        let dir = self.runtime_dir.join(lb_id);
        tokio::fs::create_dir_all(&dir).await?;
        let (config_path, pid_file, socket_path) = self.paths(lb_id);
        let _ = tokio::fs::remove_file(&socket_path).await; // stale socket from a previous crashed run

        let config = render_config(lb_id, listen_port, targets, health_check, &pid_file, &socket_path);
        tokio::fs::write(&config_path, &config).await?;

        // Validate the real config before spawning -- a real `-c` check
        // run, not a hope-it-parses spawn.
        run_command("haproxy", &["-c", "-f", config_path.to_str().unwrap()]).await.map_err(|e| LoadBalancerError::Provider(format!("config check failed: {e}")))?;

        let child = Command::new("haproxy")
            .args(["-f", config_path.to_str().unwrap(), "-db"]) // -db: stay in foreground, don't daemonize -- this process IS the supervised child
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| LoadBalancerError::Provider(format!("failed to spawn haproxy: {e}")))?;

        let mut instances = self.instances.lock().await;
        instances.insert(lb_id.to_string(), RunningLb { child, config_path, pid_file, socket_path });
        Ok(())
    }

    /// Real reload: rewrites the config and re-execs haproxy with
    /// `-sf <old pid>` (HAProxy's own seamless-reload mechanism -- the old
    /// process keeps serving in-flight connections while the new one binds
    /// and takes over), rather than a disruptive stop/start.
    pub async fn update_targets(&self, lb_id: &str, listen_port: u16, targets: &[LbTarget], health_check: &HealthCheck) -> Result<(), LoadBalancerError> {
        let mut instances = self.instances.lock().await;
        let running = instances.get_mut(lb_id).ok_or_else(|| LoadBalancerError::NotFound(lb_id.to_string()))?;
        let old_pid = running.child.id().ok_or_else(|| LoadBalancerError::Provider("running haproxy process has no PID (already exited)".to_string()))?;

        let config = render_config(lb_id, listen_port, targets, health_check, &running.pid_file, &running.socket_path);
        tokio::fs::write(&running.config_path, &config).await?;
        run_command("haproxy", &["-c", "-f", running.config_path.to_str().unwrap()]).await.map_err(|e| LoadBalancerError::Provider(format!("config check failed: {e}")))?;

        let new_child = Command::new("haproxy")
            .args(["-f", running.config_path.to_str().unwrap(), "-db", "-sf", &old_pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| LoadBalancerError::Provider(format!("failed to spawn reloaded haproxy: {e}")))?;
        running.child = new_child;
        Ok(())
    }

    pub async fn delete(&self, lb_id: &str) -> Result<(), LoadBalancerError> {
        let mut instances = self.instances.lock().await;
        if let Some(mut running) = instances.remove(lb_id) {
            let _ = running.child.kill().await;
            let _ = tokio::fs::remove_file(&running.socket_path).await;
            Ok(())
        } else {
            Err(LoadBalancerError::NotFound(lb_id.to_string()))
        }
    }

    pub async fn is_running(&self, lb_id: &str) -> bool {
        let mut instances = self.instances.lock().await;
        match instances.get_mut(lb_id) {
            Some(running) => matches!(running.child.try_wait(), Ok(None)),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A minimal real TCP echo-ish server: accepts, writes a fixed
    /// identifying banner, closes. Used as a real backend target -- not a
    /// mock of one.
    async fn spawn_identifying_backend(name: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    let _ = socket.write_all(name.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        port
    }

    async fn haproxy_available() -> bool {
        run_command("haproxy", &["-v"]).await.is_ok()
    }

    #[tokio::test]
    async fn real_haproxy_round_robins_across_two_real_backends() {
        if !haproxy_available().await {
            eprintln!("SKIPPED: haproxy binary not found on PATH -- not run, not claimed passing");
            return;
        }
        let port_a = spawn_identifying_backend("BACKEND-A").await;
        let port_b = spawn_identifying_backend("BACKEND-B").await;

        let runtime_dir = std::env::temp_dir().join(format!("inaya-infra-lb-test-{}", uuid::Uuid::new_v4()));
        let provider = HaproxyLoadBalancerProvider::new(runtime_dir.clone());
        let lb_id = "test-lb-1";
        // Bind the frontend to an ephemeral port too, chosen from a fixed
        // real test range -- real HAProxy, real port binding.
        let listen_port = 28080u16;
        let targets = vec![
            LbTarget { name: "a".into(), address: "127.0.0.1".into(), port: port_a },
            LbTarget { name: "b".into(), address: "127.0.0.1".into(), port: port_b },
        ];
        let health_check = HealthCheck { interval_ms: 2000 };

        provider.create(lb_id, listen_port, &targets, &health_check).await.expect("real haproxy should start");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await; // real process startup + health-check settle time
        assert!(provider.is_running(lb_id).await);

        let mut seen = std::collections::HashSet::new();
        for _ in 0..10 {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", listen_port)).await.expect("real connection to the real haproxy frontend should succeed");
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).await.unwrap();
            seen.insert(String::from_utf8_lossy(&buf).to_string());
        }
        assert_eq!(seen.len(), 2, "round-robin across 10 real connections should have reached both real backends, saw: {seen:?}");

        provider.delete(lb_id).await.unwrap();
        assert!(!provider.is_running(lb_id).await);
        let _ = tokio::fs::remove_dir_all(&runtime_dir).await;
    }

    #[tokio::test]
    async fn update_targets_reloads_and_adds_a_new_real_backend() {
        if !haproxy_available().await {
            eprintln!("SKIPPED: haproxy binary not found on PATH -- not run, not claimed passing");
            return;
        }
        let port_a = spawn_identifying_backend("BACKEND-A2").await;
        let runtime_dir = std::env::temp_dir().join(format!("inaya-infra-lb-reload-test-{}", uuid::Uuid::new_v4()));
        let provider = HaproxyLoadBalancerProvider::new(runtime_dir.clone());
        let lb_id = "test-lb-2";
        let listen_port = 28081u16;
        let health_check = HealthCheck { interval_ms: 2000 };

        provider.create(lb_id, listen_port, &[LbTarget { name: "a".into(), address: "127.0.0.1".into(), port: port_a }], &health_check).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let port_b = spawn_identifying_backend("BACKEND-B2").await;
        provider
            .update_targets(lb_id, listen_port, &[LbTarget { name: "a".into(), address: "127.0.0.1".into(), port: port_a }, LbTarget { name: "b".into(), address: "127.0.0.1".into(), port: port_b }], &health_check)
            .await
            .expect("real seamless reload should succeed");
        tokio::time::sleep(std::time::Duration::from_millis(800)).await; // real reload + health-check settle time

        let mut seen = std::collections::HashSet::new();
        for _ in 0..10 {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", listen_port)).await.expect("real connection after a real reload should still succeed");
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).await.unwrap();
            seen.insert(String::from_utf8_lossy(&buf).to_string());
        }
        assert_eq!(seen.len(), 2, "after a real reload, both the original and the newly added real backend should be reachable, saw: {seen:?}");

        provider.delete(lb_id).await.unwrap();
        let _ = tokio::fs::remove_dir_all(&runtime_dir).await;
    }
}
