// SOW §131: the inaya-infra operator CLI. Phase 1 scope: `doctor`,
// `node enroll`, `node status`. `cluster`/`compute`/`volume`/`network`
// subcommands are added in their respective phases (see
// docs/infrastructure/IMPLEMENTATION-LEDGER.md).

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "inaya-infra", about = "Inaya Sovereign Infrastructure Fabric operator CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// SOW §227: run every real-hardware readiness check on this host.
    Doctor,
    #[command(subcommand)]
    Node(NodeCommand),
}

#[derive(Subcommand)]
enum NodeCommand {
    /// Enroll this host with a cluster using a one-time enrollment token
    /// minted by an org admin (POST /api/orgs/infrastructure/clusters/{id}/enrollment-tokens).
    Enroll {
        #[arg(long)]
        control_plane_url: String,
        #[arg(long)]
        token: String,
        #[arg(long, default_value_t = default_hostname())]
        hostname: String,
        #[arg(long, default_value = "/var/lib/inaya-infra")]
        data_dir: PathBuf,
    },
    /// Show this host's local node identity and current doctor status.
    Status {
        #[arg(long, default_value = "/var/lib/inaya-infra")]
        data_dir: PathBuf,
    },
}

fn default_hostname() -> String {
    hostname::get().ok().and_then(|h| h.into_string().ok()).unwrap_or_else(|| "unknown-host".to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let cli = Cli::parse();

    match cli.command {
        Command::Doctor => {
            let results = inaya_infra_node::doctor().await;
            print_doctor_results(&results);
        }
        Command::Node(NodeCommand::Enroll { control_plane_url, token, hostname, data_dir }) => {
            let identity = inaya_infra_node::enroll(&control_plane_url, &token, &hostname, data_dir).await?;
            println!("Enrolled. node_id = {}", identity.node_id);
        }
        Command::Node(NodeCommand::Status { data_dir }) => {
            match inaya_infra_node::local_identity(&data_dir) {
                Ok(identity) => {
                    println!("node_id:   {}", identity.node_id);
                    println!("issued_at: {:?}", identity.issued_at);
                }
                Err(e) => println!("No local identity: {e}"),
            }
            let results = inaya_infra_node::doctor().await;
            print_doctor_results(&results);
        }
    }

    Ok(())
}

fn print_doctor_results(results: &[api_types::DoctorCheckResult]) {
    for r in results {
        let marker = match r.status {
            api_types::DoctorStatus::Ok => "OK  ",
            api_types::DoctorStatus::Warn => "WARN",
            api_types::DoctorStatus::Fail => "FAIL",
        };
        println!("[{marker}] {:<20} {}", r.check, r.detail);
        if let Some(remediation) = &r.remediation {
            println!("       -> {remediation}");
        }
    }
}
