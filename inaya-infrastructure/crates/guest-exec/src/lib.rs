//! Gap-closure round, Phase A: a real SSH client the node daemon uses to
//! run commands inside a guest VM it just booted (no shelling out to a
//! system `ssh` binary -- a pure-Rust client via `russh`, matching this
//! workspace's own "structured, in-process control, not a wrapped shell
//! tool" discipline already set by `compute`'s QMP client). Intentionally
//! general-purpose, not k3s-specific: this is the one guest-exec channel
//! everything downstream (the k3s install, reading back its join token and
//! kubeconfig) is built on.
//!
//! Host-key handling is deliberately simplified for this use case: the
//! node daemon is connecting to a VM it itself just created on its own
//! bridge network, not an arbitrary external host, so there is no
//! separate, trusted channel to have pre-shared a host key over. The
//! handler here accepts the guest's first-presented key outright
//! (trust-on-first-use for an ephemeral, locally-provisioned guest) --
//! this is not a general-purpose SSH client and must not be reused for
//! connecting to anything the node does not itself control.

use russh::client::{self, Handler};
pub use russh::keys::key::KeyPair;
use russh::keys::key::PublicKey;
use russh::keys::PublicKeyBase64;
use russh::ChannelMsg;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GuestExecError {
    #[error("ssh connection failed: {0}")]
    Connect(String),
    #[error("ssh authentication failed")]
    AuthFailed,
    #[error("ssh channel error: {0}")]
    Channel(String),
    #[error("guest did not become reachable within {0:?}")]
    Timeout(Duration),
    #[error("remote command exited with status {status}: {stderr}")]
    NonZeroExit { status: u32, stderr: String },
}

/// Generates a real ed25519 keypair for the node to use when provisioning
/// guests. The public half is injected into each guest's cloud-init
/// `ssh_authorized_keys`; the private half never leaves the node.
pub fn generate_node_ssh_keypair() -> anyhow::Result<KeyPair> {
    KeyPair::generate_ed25519().ok_or_else(|| anyhow::anyhow!("ed25519 keypair generation failed"))
}

/// OpenSSH `authorized_keys`-line format (`"ssh-ed25519 <base64>"`), for
/// embedding directly in cloud-init's `ssh_authorized_keys` list.
pub fn public_key_openssh_line(key: &KeyPair) -> anyhow::Result<String> {
    Ok(format!("{} {}", key.name(), key.public_key_base64()))
}

struct AcceptAnyServerKey;

#[async_trait::async_trait]
impl Handler for AcceptAnyServerKey {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        // See module doc: trust-on-first-use against a guest the node
        // itself just provisioned, never a general-purpose default.
        Ok(true)
    }
}

pub struct GuestSession {
    handle: client::Handle<AcceptAnyServerKey>,
}

pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: u32,
}

impl GuestSession {
    /// Retries the TCP+SSH handshake with backoff until the guest answers
    /// or `total_timeout` elapses. Real guest boots take tens of seconds
    /// (BIOS, kernel, cloud-init's own network bring-up) -- this is the
    /// real "wait for the VM to be ready" step, not a fixed sleep.
    pub async fn connect_with_retry(host: &str, port: u16, username: &str, key: &KeyPair, total_timeout: Duration) -> Result<Self, GuestExecError> {
        let config = Arc::new(client::Config::default());
        let deadline = tokio::time::Instant::now() + total_timeout;
        let mut last_err = None;
        while tokio::time::Instant::now() < deadline {
            match client::connect(config.clone(), (host, port), AcceptAnyServerKey).await {
                Ok(mut handle) => {
                    let auth = handle.authenticate_publickey(username, Arc::new(key.clone())).await;
                    match auth {
                        Ok(true) => return Ok(Self { handle }),
                        Ok(false) => return Err(GuestExecError::AuthFailed),
                        Err(e) => last_err = Some(format!("auth error: {e}")),
                    }
                }
                Err(e) => last_err = Some(format!("connect error: {e}")),
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        Err(GuestExecError::Timeout(total_timeout)).map_err(|e| {
            tracing::warn!(last_error = ?last_err, "guest never became reachable");
            e
        })
    }

    /// Runs one real command over a real SSH exec channel, collecting
    /// stdout/stderr and the real remote exit status.
    pub async fn exec(&mut self, command: &str) -> Result<CommandOutput, GuestExecError> {
        let mut channel = self.handle.channel_open_session().await.map_err(|e| GuestExecError::Channel(e.to_string()))?;
        channel.exec(true, command.as_bytes()).await.map_err(|e| GuestExecError::Channel(e.to_string()))?;

        // Real bug this project's own real-k3s testing caught: the SSH
        // protocol does not guarantee Eof arrives after ExitStatus -- for
        // a short response both can land in the same read and appear to
        // work by luck, but for a larger response (a multi-KB kubeconfig,
        // as opposed to a one-line node-token) the server legitimately
        // sends Eof (no more data) *before* the exit-status channel
        // request that follows it. Breaking the loop on Eof discarded
        // that still-to-arrive ExitStatus every time, silently producing
        // the u32::MAX "unknown" sentinel on anything past a few hundred
        // bytes of output -- confirmed via a real guest where the same
        // code reliably read a short file and reliably failed to read a
        // larger one. Only `Close` (the channel's actual end) is a safe
        // place to stop.
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status = None;
        loop {
            let Some(msg) = channel.wait().await else { break };
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        let exit_status = exit_status.unwrap_or(u32::MAX);
        Ok(CommandOutput { stdout, stderr, exit_status })
    }

    /// Runs a command and returns only stdout as a UTF-8 string, erroring
    /// honestly on a non-zero remote exit instead of returning partial or
    /// empty output silently.
    pub async fn exec_text(&mut self, command: &str) -> Result<String, GuestExecError> {
        let out = self.exec(command).await?;
        if out.exit_status != 0 {
            return Err(GuestExecError::NonZeroExit { status: out.exit_status, stderr: String::from_utf8_lossy(&out.stderr).to_string() });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// Reads a real remote file's bytes via `cat` over the same exec
    /// channel -- sufficient for the text artifacts this crate exists to
    /// retrieve (k3s's node-token, k3s.yaml), without the added complexity
    /// of a separate SFTP subsystem. Uses `sudo cat`, not plain `cat` --
    /// a real bug this project's own real-k3s testing caught: k3s writes
    /// both `/var/lib/rancher/k3s/server/node-token` and
    /// `/etc/rancher/k3s/k3s.yaml` root-only (0600), and the provisioning
    /// user this crate connects as is deliberately non-root (cloud-init
    /// grants it passwordless sudo for exactly this kind of real,
    /// narrowly-scoped read, not broad shell access). Confirmed via a
    /// real guest where k3s.service was genuinely `active (running)` the
    /// entire time this function kept returning nothing readable.
    pub async fn read_remote_file(&mut self, path: &str) -> Result<String, GuestExecError> {
        self.exec_text(&format!("sudo cat {}", shell_quote(path))).await
    }
}

/// Single-quotes a path for safe inclusion in the one and only place this
/// crate ever builds a remote shell command string itself (reading back a
/// known, node-generated file path) -- every other command this crate runs
/// is supplied verbatim by its caller, which owns responsibility for that
/// command's own safety (cloud-init's runcmd works the same way).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_real_ed25519_keypair_with_a_parseable_openssh_public_line() {
        let key = generate_node_ssh_keypair().expect("real ed25519 key generation should succeed");
        let line = public_key_openssh_line(&key).expect("should format as a real OpenSSH authorized_keys line");
        assert!(line.starts_with("ssh-ed25519 "), "unexpected format: {line}");
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("/var/lib/rancher/k3s/server/node-token"), "'/var/lib/rancher/k3s/server/node-token'");
        assert_eq!(shell_quote("it's/a/path"), "'it'\\''s/a/path'");
    }
}
