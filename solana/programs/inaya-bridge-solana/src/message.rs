use crate::constants::DOMAIN_TAG;
use anchor_lang::prelude::*;
use solana_keccak_hasher as keccak;

/// Mirrors `InayaBridgeTypes.Message` on the EVM side field-for-field. `source_contract`/
/// `dest_contract` identify the sending/receiving MODULE -- a Solana program's own 32-byte
/// address fits `[u8; 32]` natively (no left-padding tricks needed, unlike a 20-byte EVM
/// address). End-user recipient/amount live inside opaque `payload`.
#[derive(Clone, Debug, AnchorSerialize, AnchorDeserialize)]
pub struct BridgeMessage {
    pub source_chain_id: u64,
    pub source_contract: [u8; 32],
    pub dest_chain_id: u64,
    pub dest_contract: [u8; 32],
    pub nonce: u64,
    pub msg_type: u8,
    pub payload: Vec<u8>,
}

fn u64_to_be32(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..32].copy_from_slice(&v.to_be_bytes());
    out
}

fn u8_to_be32(v: u8) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[31] = v;
    out
}

/// Reproduces `InayaBridgeTypes.hashMessage`'s exact byte layout. Every field in that Solidity
/// function is fixed-size (uint64/uint8 left-padded to 32 bytes, bytes32 as-is) and the one
/// dynamic field (`payload`) is pre-hashed to a bytes32 BEFORE the outer `abi.encode` -- so the
/// whole thing is just eight concatenated 32-byte words hashed with real Keccak-256
/// (`solana_program::keccak` is the genuine Keccak-256 syscall, matching Solidity's
/// `keccak256` -- NOT the NIST SHA3-256 variant some Rust crates implement under the same name).
/// No dynamic head/tail ABI logic is needed on either side.
pub fn message_hash(m: &BridgeMessage) -> [u8; 32] {
    let payload_hash = keccak::hash(&m.payload).to_bytes();

    let mut buf = Vec::with_capacity(32 * 8);
    buf.extend_from_slice(&DOMAIN_TAG);
    buf.extend_from_slice(&u64_to_be32(m.source_chain_id));
    buf.extend_from_slice(&m.source_contract);
    buf.extend_from_slice(&u64_to_be32(m.dest_chain_id));
    buf.extend_from_slice(&m.dest_contract);
    buf.extend_from_slice(&u64_to_be32(m.nonce));
    buf.extend_from_slice(&u8_to_be32(m.msg_type));
    buf.extend_from_slice(&payload_hash);

    keccak::hash(&buf).to_bytes()
}

/// Builds the EXACT `abi.encode(uint8, bytes32, uint256, uint256)` byte layout
/// `InayaTokenBridgeHome.onMessage` decodes for a TOKEN_BURN_NOTICE -- four fixed-size fields,
/// each a 32-byte word, concatenated in order. No dynamic-ABI logic needed.
pub fn encode_burn_notice_payload(action: u8, recipient: [u8; 32], amount_evm18: u128, route_to_chain_id: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * 4);
    buf.extend_from_slice(&u8_to_be32(action));
    buf.extend_from_slice(&recipient);
    buf.extend_from_slice(&u128_to_be32(amount_evm18));
    buf.extend_from_slice(&u64_to_be32(route_to_chain_id));
    buf
}

/// Builds the EXACT `abi.encode(address, uint256, uint256, uint256)` layout
/// `InayaStakingGatewayHome.onMessage` decodes for a STAKE_REQUEST. `evm_beneficiary` is the
/// EVM address the caller wants their home-chain stake credited to -- InayaStaking's ledger is
/// address-keyed, so a Solana-originated stake must nominate an explicit EVM beneficiary; there
/// is no way to represent a native Solana pubkey as the ledger key.
pub fn encode_stake_request_payload(evm_beneficiary: [u8; 20], amount_evm18: u128, lock_period_days: u64, origin_chain_id: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * 4);
    let mut addr32 = [0u8; 32];
    addr32[12..32].copy_from_slice(&evm_beneficiary);
    buf.extend_from_slice(&addr32);
    buf.extend_from_slice(&u128_to_be32(amount_evm18));
    buf.extend_from_slice(&u64_to_be32(lock_period_days));
    buf.extend_from_slice(&u64_to_be32(origin_chain_id));
    buf
}

/// Decodes the EXACT `abi.encode(bytes32, uint256)` layout `InayaTokenBridgeSpoke.onMessage`
/// (and this program's own receive_message) uses for an inbound TOKEN_MINT: two fixed-size
/// 32-byte words, recipient then amount.
pub fn decode_token_mint_payload(payload: &[u8]) -> Option<([u8; 32], u128)> {
    if payload.len() != 64 {
        return None;
    }
    let mut recipient = [0u8; 32];
    recipient.copy_from_slice(&payload[0..32]);
    let amount = be32_to_u128(&payload[32..64])?;
    Some((recipient, amount))
}

fn u128_to_be32(v: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..32].copy_from_slice(&v.to_be_bytes());
    out
}

fn be32_to_u128(bytes: &[u8]) -> Option<u128> {
    if bytes.len() != 32 || bytes[0..16].iter().any(|b| *b != 0) {
        return None; // a genuine uint256 value beyond u128 range is not representable here --
                      // never realistic for INAYA's 30M-token cap, but rejected explicitly
                      // rather than silently truncated.
    }
    let mut arr = [0u8; 16];
    arr.copy_from_slice(&bytes[16..32]);
    Some(u128::from_be_bytes(arr))
}
