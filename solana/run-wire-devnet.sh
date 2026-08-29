#!/usr/bin/env bash
export PATH="/root/.local/share/solana/install/active_release/bin:$PATH"
export NODE_OPTIONS="--dns-result-order=ipv4first"
cd /mnt/d/Codespace-blank/codespaces-blank-main/codespaces-blank-main/solana
node wire-devnet.mjs
