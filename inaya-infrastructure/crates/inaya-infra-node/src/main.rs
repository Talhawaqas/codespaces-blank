use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser)]
#[command(name = "inaya-infra-node", about = "Inaya Sovereign Infrastructure Fabric node agent daemon")]
struct Args {
    #[arg(long, env = "INAYA_CONTROL_PLANE_URL")]
    control_plane_url: String,

    #[arg(long, env = "INAYA_INFRA_DATA_DIR", default_value = "/var/lib/inaya-infra")]
    data_dir: PathBuf,

    #[arg(long, default_value = "30")]
    heartbeat_interval_secs: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let args = Args::parse();

    let identity = inaya_infra_node::local_identity(&args.data_dir)?;
    tracing::info!(node_id = %identity.node_id, data_dir = ?args.data_dir, "starting inaya-infra-node");

    inaya_infra_node::run_heartbeat_loop(args.control_plane_url, args.data_dir, Duration::from_secs(args.heartbeat_interval_secs)).await
}
