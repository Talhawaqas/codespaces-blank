//! SOW §60-63: safe host-command execution and guest-isolation helpers.
//!
//! The single rule this crate exists to enforce in code, not just in
//! review: §61's "no shell interpolation... use parameterized process
//! execution." Every call into QEMU, nftables, or any other host binary
//! anywhere in this workspace goes through [`run_command`] below, never
//! through `std::process::Command::new("sh").arg("-c").arg(format!(...))`.
//! A string-concatenated shell command is the exact command-injection shape
//! this function exists to make structurally impossible to write by
//! accident.

use std::process::Stdio;
use thiserror::Error;
use tokio::process::Command;

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("failed to spawn {program}: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{program} exited with status {status}: {stderr}")]
    NonZeroExit {
        program: String,
        status: i32,
        stderr: String,
    },
}

/// Run a host binary with a fixed program path and a structured argument
/// array -- never a shell string. `args` are passed to the OS exec syscall
/// as separate argv entries; there is no shell to interpolate into, so
/// nothing in `args` (including attacker-influenced VM names, tags, or
/// cloud-init content per SOW §61) can break out of its own argument.
pub async fn run_command(program: &str, args: &[&str]) -> Result<String, CommandError> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|source| CommandError::Spawn {
            program: program.to_string(),
            source,
        })?;

    if !output.status.success() {
        return Err(CommandError::NonZeroExit {
            program: program.to_string(),
            status: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// SOW §18: a value from the instance-metadata service, cloud-init, a tag,
/// or any other caller-supplied string must never be treated as trusted.
/// This is a marker type, not a sanitizer -- it exists so a function
/// signature can require the caller to have acknowledged a value's
/// untrusted origin (e.g. `fn set_hostname(name: Untrusted<String>)`)
/// rather than silently accepting a bare `String` from anywhere.
#[derive(Debug, Clone)]
pub struct Untrusted<T>(pub T);

impl<T> Untrusted<T> {
    pub fn new(value: T) -> Self {
        Self(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_command_executes_real_binary() {
        // Real process execution, not mocked -- `echo` is present on every
        // Linux host this is meant to run on.
        let out = run_command("echo", &["hello", "world"]).await.unwrap();
        assert_eq!(out.trim(), "hello world");
    }

    #[tokio::test]
    async fn shell_metacharacters_in_an_argument_never_execute() {
        // If this were `sh -c format!("echo {}", arg)`, this payload would
        // run a second command. Through run_command's argv array, it is
        // just a literal string.
        let payload = "; rm -rf /tmp/should-not-run ; echo injected";
        let out = run_command("echo", &[payload]).await.unwrap();
        assert_eq!(out.trim(), payload);
    }

    #[tokio::test]
    async fn non_zero_exit_is_surfaced_as_an_error() {
        let result = run_command("false", &[]).await;
        assert!(matches!(result, Err(CommandError::NonZeroExit { .. })));
    }
}
