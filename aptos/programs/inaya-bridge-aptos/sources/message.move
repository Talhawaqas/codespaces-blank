/// Mirrors `InayaBridgeTypes.hashMessage` (EVM) / `message.rs` (Solana) field-for-field. Every
/// field is fixed-size (u64/u8 left-padded to 32 bytes, the two 32-byte contract fields as-is)
/// and the one dynamic field (`payload`) is pre-hashed to 32 bytes BEFORE the outer hash -- so
/// the whole thing is just eight concatenated 32-byte words, real Keccak-256 both times
/// (`aptos_std::aptos_hash::keccak256` is genuine Keccak-256, NOT SHA3-256 -- Aptos's stdlib
/// ships both, and they differ). No dynamic head/tail ABI logic needed on any side.
module inaya_bridge::message {
    use std::vector;
    use aptos_std::aptos_hash;

    /// keccak256("INAYA_CROSSCHAIN_V1") -- must stay identical to InayaBridgeTypes.sol's
    /// DOMAIN_TAG and solana/.../constants.rs's DOMAIN_TAG. Re-derive with
    /// `ethers.keccak256(ethers.toUtf8Bytes("INAYA_CROSSCHAIN_V1"))` if this is ever hand-edited.
    const DOMAIN_TAG: vector<u8> = x"0883616c060b879d70cded66a0fa1da9a014ee7e12d7a02eb61e049ea00952b6";

    public fun domain_tag(): vector<u8> { DOMAIN_TAG }

    fun u64_to_be32(v: u64): vector<u8> {
        let out = vector::empty<u8>();
        let i = 0;
        while (i < 24) { vector::push_back(&mut out, 0); i = i + 1; };
        let be8 = u64_to_be8(v);
        vector::append(&mut out, be8);
        out
    }

    fun u64_to_be8(v: u64): vector<u8> {
        let out = vector::empty<u8>();
        let i = 0;
        while (i < 8) {
            let shift = ((7 - i) as u8) * 8;
            vector::push_back(&mut out, (((v >> shift) & 0xff) as u8));
            i = i + 1;
        };
        out
    }

    fun u8_to_be32(v: u8): vector<u8> {
        let out = vector::empty<u8>();
        let i = 0;
        while (i < 31) { vector::push_back(&mut out, 0); i = i + 1; };
        vector::push_back(&mut out, v);
        out
    }

    /// `source_contract`/`dest_contract` must each already be exactly 32 bytes (a native Aptos
    /// address IS 32 bytes -- no left-padding trick needed, same reasoning as the Solana side).
    public fun message_hash(
        source_chain_id: u64,
        source_contract: vector<u8>,
        dest_chain_id: u64,
        dest_contract: vector<u8>,
        nonce: u64,
        msg_type: u8,
        payload: vector<u8>,
    ): vector<u8> {
        let payload_hash = aptos_hash::keccak256(payload);

        let buf = vector::empty<u8>();
        vector::append(&mut buf, DOMAIN_TAG);
        vector::append(&mut buf, u64_to_be32(source_chain_id));
        vector::append(&mut buf, source_contract);
        vector::append(&mut buf, u64_to_be32(dest_chain_id));
        vector::append(&mut buf, dest_contract);
        vector::append(&mut buf, u64_to_be32(nonce));
        vector::append(&mut buf, u8_to_be32(msg_type));
        vector::append(&mut buf, payload_hash);

        aptos_hash::keccak256(buf)
    }

    fun u128_to_be32(v: u128): vector<u8> {
        let out = vector::empty<u8>();
        let i = 0;
        while (i < 16) { vector::push_back(&mut out, 0); i = i + 1; };
        let j = 0;
        while (j < 16) {
            let shift = ((15 - j) as u8) * 8;
            vector::push_back(&mut out, (((v >> shift) & 0xff) as u8));
            j = j + 1;
        };
        out
    }

    /// Builds the EXACT `abi.encode(uint8, bytes32, uint256, uint256)` layout
    /// `InayaTokenBridgeHome.onMessage` decodes for a TOKEN_BURN_NOTICE.
    public fun encode_burn_notice_payload(action: u8, recipient: vector<u8>, amount_evm18: u128, route_to_chain_id: u64): vector<u8> {
        let buf = vector::empty<u8>();
        vector::append(&mut buf, u8_to_be32(action));
        vector::append(&mut buf, recipient);
        vector::append(&mut buf, u128_to_be32(amount_evm18));
        vector::append(&mut buf, u64_to_be32(route_to_chain_id));
        buf
    }

    /// Decodes the EXACT `abi.encode(bytes32, uint256)` layout used for an inbound TOKEN_MINT:
    /// two fixed-size 32-byte words, recipient (native 32-byte address) then amount (EVM 18dp).
    public fun decode_token_mint_payload(payload: &vector<u8>): (vector<u8>, u128) {
        assert!(vector::length(payload) == 64, 1);
        let recipient = vector::empty<u8>();
        let i = 0;
        while (i < 32) { vector::push_back(&mut recipient, *vector::borrow(payload, i)); i = i + 1; };
        let amount = 0u128;
        let j = 32;
        while (j < 64) {
            amount = (amount << 8) | (*vector::borrow(payload, j) as u128);
            j = j + 1;
        };
        (recipient, amount)
    }

    /// EIP-191 `personal_sign` digest for a 32-byte message: keccak256("\x19Ethereum Signed
    /// Message:\n32" || messageId). Lets the SAME validator-signing code every EVM spoke already
    /// uses (`ethers.Wallet.signMessage`) sign for Aptos too -- Aptos's native `secp256k1::ecdsa_recover`
    /// applies no hidden hashing of its own (unlike Solana's precompile), so this chain gets to pick
    /// the convention outright rather than reverse-engineer one.
    public fun eth_signed_message_hash(message_id: vector<u8>): vector<u8> {
        let prefix = b"\x19Ethereum Signed Message:\n32";
        let buf = vector::empty<u8>();
        vector::append(&mut buf, prefix);
        vector::append(&mut buf, message_id);
        aptos_hash::keccak256(buf)
    }
}
