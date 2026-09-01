/// Mirrors `InayaBridgeTypes.hashMessage` (EVM) / `message.rs` (Solana) / `message.move` (Aptos)
/// field-for-field -- see the Aptos version's doc comment for the full byte-layout rationale.
/// `sui::hash::keccak256` is genuine Keccak-256, distinct from `std::hash`'s SHA2/SHA3.
module inaya_bridge_sui::message;

use sui::hash;

/// keccak256("INAYA_CROSSCHAIN_V1") -- must stay identical across every chain's copy of this
/// constant (contracts/bridge/InayaBridgeTypes.sol, solana/.../constants.rs, aptos/.../message.move).
const DOMAIN_TAG: vector<u8> =
    x"0883616c060b879d70cded66a0fa1da9a014ee7e12d7a02eb61e049ea00952b6";

fun u64_to_be32(v: u64): vector<u8> {
    let mut out = vector::empty<u8>();
    let mut i = 0;
    while (i < 24) { out.push_back(0); i = i + 1; };
    let mut j = 0;
    while (j < 8) {
        let shift = ((7 - j) as u8) * 8;
        out.push_back((((v >> shift) & 0xff) as u8));
        j = j + 1;
    };
    out
}

fun u8_to_be32(v: u8): vector<u8> {
    let mut out = vector::empty<u8>();
    let mut i = 0;
    while (i < 31) { out.push_back(0); i = i + 1; };
    out.push_back(v);
    out
}

fun u128_to_be32(v: u128): vector<u8> {
    let mut out = vector::empty<u8>();
    let mut i = 0;
    while (i < 16) { out.push_back(0); i = i + 1; };
    let mut j = 0;
    while (j < 16) {
        let shift = ((15 - j) as u8) * 8;
        out.push_back((((v >> shift) & 0xff) as u8));
        j = j + 1;
    };
    out
}

/// `source_contract`/`dest_contract` must each already be exactly 32 bytes (a native Sui address
/// IS 32 bytes -- no left-padding trick needed, same reasoning as Solana/Aptos).
public fun message_hash(
    source_chain_id: u64,
    source_contract: vector<u8>,
    dest_chain_id: u64,
    dest_contract: vector<u8>,
    nonce: u64,
    msg_type: u8,
    payload: vector<u8>,
): vector<u8> {
    let payload_hash = hash::keccak256(&payload);

    let mut buf = vector::empty<u8>();
    buf.append(DOMAIN_TAG);
    buf.append(u64_to_be32(source_chain_id));
    buf.append(source_contract);
    buf.append(u64_to_be32(dest_chain_id));
    buf.append(dest_contract);
    buf.append(u64_to_be32(nonce));
    buf.append(u8_to_be32(msg_type));
    buf.append(payload_hash);

    hash::keccak256(&buf)
}

/// Builds the EXACT `abi.encode(uint8, bytes32, uint256, uint256)` layout
/// `InayaTokenBridgeHome.onMessage` decodes for a TOKEN_BURN_NOTICE.
public fun encode_burn_notice_payload(action: u8, recipient: vector<u8>, amount_evm18: u128, route_to_chain_id: u64): vector<u8> {
    let mut buf = vector::empty<u8>();
    buf.append(u8_to_be32(action));
    buf.append(recipient);
    buf.append(u128_to_be32(amount_evm18));
    buf.append(u64_to_be32(route_to_chain_id));
    buf
}

/// Decodes the EXACT `abi.encode(bytes32, uint256)` layout used for an inbound TOKEN_MINT: two
/// fixed-size 32-byte words, recipient (native 32-byte address) then amount (EVM 18dp).
public fun decode_token_mint_payload(payload: &vector<u8>): (vector<u8>, u128) {
    assert!(payload.length() == 64, 1);
    let mut recipient = vector::empty<u8>();
    let mut i = 0;
    while (i < 32) { recipient.push_back(payload[i]); i = i + 1; };
    let mut amount = 0u128;
    let mut j = 32;
    while (j < 64) {
        amount = (amount << 8) | (payload[j] as u128);
        j = j + 1;
    };
    (recipient, amount)
}

/// EIP-191 `personal_sign` prefix for a 32-byte message. Unlike Aptos (which pre-hashes the
/// digest itself before calling `ecdsa_recover`), Sui's `ecdsa_k1::secp256k1_ecrecover` takes the
/// RAW pre-image and a hash-function selector, hashing internally -- so the caller passes this
/// prefix concatenated with the raw messageId, with hash = KECCAK256 (0), and the same
/// `ethers.Wallet.signMessage()` output every EVM spoke's validator already produces verifies
/// directly, no chain-specific signing convention needed.
public fun eth_signed_message_prefix(message_id: vector<u8>): vector<u8> {
    let prefix = b"\x19Ethereum Signed Message:\n32";
    let mut buf = vector::empty<u8>();
    buf.append(prefix);
    buf.append(message_id);
    buf
}
