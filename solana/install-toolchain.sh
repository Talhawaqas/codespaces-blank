#!/usr/bin/env bash
set -e

echo "=== Installing Rust ==="
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version
cargo --version

echo "=== Installing Solana CLI ==="
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version

echo "=== Installing avm (Anchor Version Manager) ==="
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
echo 'export PATH="$HOME/.avm/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.avm/bin:$PATH"

echo "=== Installing Anchor CLI via avm ==="
avm install latest
avm use latest
anchor --version

echo "=== ALL DONE ==="
