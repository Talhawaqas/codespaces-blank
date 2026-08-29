#!/usr/bin/env bash
# Deploys the already-built program (run build.sh first) to Solana Devnet.
# Requires a funded devnet wallet at ~/.config/solana/id.json (solana-keygen new,
# then airdrop via https://faucet.solana.com or `solana airdrop`).
set -e
export PATH="/root/.local/share/solana/install/active_release/bin:/root/.avm/bin:/root/.cargo/bin:$PATH"
cd "$(dirname "$0")"
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet
