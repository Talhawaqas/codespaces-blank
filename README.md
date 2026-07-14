# Inaya Network

**Official repository for Inaya Network** — a client-side encrypted data custody protocol deployed on **BNB Chain (BNB Smart Chain / BSC Testnet)**.

## Deployment
- **Network:** BNB Smart Chain (BSC) Testnet — Chain ID `97`
- **RPC Endpoint:** `https://data-seed-prebsc-1-s1.binance.org:8545/`
- **Core Custody Contract (Verified):** `0x871229a40d58a89545270b8d059b8e0f481f1d55`
  https://testnet.bscscan.com/address/0x871229a40d58a89545270b8d059b8e0f481f1d55#code
- **$INAYA Token Contract (Verified):** `0x9da15c2908c9a87ac5af8c116d4092cb6569488e`
  https://testnet.bscscan.com/address/0x9da15c2908c9a87ac5af8c116d4092cb6569488e#code

## Repository Structure
The dApp source code is located in [`/inaya-network-dapp`](./inaya-network-dapp) — this is the primary and only application in this repository.

## Stack
Next.js (React), ethers.js, Solidity ^0.8.20, Web Crypto API (PBKDF2 / AES-GCM-256), IPFS — all integrated against BNB Smart Chain.

Live dApp: https://inaya-network.vercel.app/
