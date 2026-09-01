/// Inaya Network cross-chain bridge -- Sui (non-EVM) spoke, mirroring the Solana/Aptos spokes in
/// shape: home (BSC Testnet) locks real $INAYA, this module mint/burns an 8-decimal wrapped Coin
/// 1:1 backed by that lock, verified against the SAME M-of-N secp256k1 validator committee as
/// every other spoke using Sui's native `sui::ecdsa_k1::secp256k1_ecrecover`.
///
/// Validators are tracked here by their 33-byte COMPRESSED secp256k1 public key (what
/// `secp256k1_ecrecover` actually returns), not an Ethereum-style 20-byte address -- Sui gives no
/// reason to reconstruct that EVM-specific derivation, so this chain's validator set is
/// registered directly in the form the recovery call already produces. The off-chain relayer
/// supplies each validator's compressed public key (`ethers.SigningKey.compressedPublicKey`)
/// once, at `initialize` time.
module inaya_bridge_sui::bridge;

use sui::coin::{Self, Coin, TreasuryCap};
use sui::ecdsa_k1;
use sui::table::{Self, Table};
use sui::event;
use sui::address;
use inaya_bridge_sui::message;

/// Bridged-coin decimals. 8dp mirrors Aptos's reasoning: 30_000_000 * 10^8 comfortably fits u64.
const BRIDGED_DECIMALS: u8 = 8;
const EVM_TO_SUI_DECIMALS_DIVISOR: u128 = 10_000_000_000; // 10^(18-8)
const KECCAK256: u8 = 0;

const MSG_TOKEN_MINT: u8 = 0;
const MSG_TOKEN_BURN_NOTICE: u8 = 1;
const BURN_ACTION_PLAIN: u8 = 0;
const BURN_ACTION_ROUTE: u8 = 1;

const E_NOT_ADMIN: u64 = 1;
const E_PAUSED: u64 = 2;
const E_WRONG_DEST_CHAIN: u64 = 3;
const E_UNTRUSTED_SOURCE: u64 = 4;
const E_ALREADY_EXECUTED: u64 = 5;
const E_INSUFFICIENT_SIGNATURES: u64 = 6;
const E_INVALID_MSG_TYPE: u64 = 7;
const E_ZERO_AMOUNT: u64 = 8;
const E_INVALID_THRESHOLD: u64 = 9;

/// One-time witness for the wrapped-INAYA Coin type -- must be an all-caps version of the
/// module's own name, per Sui's OTW rule.
public struct BRIDGE has drop {}

public struct BridgeState has key {
    id: UID,
    admin: address,
    self_chain_id: u64,
    home_chain_id: u64,
    home_bridge_address: vector<u8>, // 32 bytes
    threshold: u8,
    validators: vector<vector<u8>>,  // each a 33-byte compressed secp256k1 pubkey
    paused: bool,
    processed_messages: Table<vector<u8>, bool>, // messageId -> true, replay protection
    outbound_nonce: Table<address, u64>,
    treasury_cap: TreasuryCap<BRIDGE>,
}

public struct MessageReceived has copy, drop {
    message_id: vector<u8>,
    source_chain_id: u64,
    nonce: u64,
    recipient: address,
    amount: u64,
}

public struct BridgedToHome has copy, drop {
    from: address,
    recipient: vector<u8>,
    amount: u64,
    message_id: vector<u8>,
}

/// Runs once, automatically, at publish. Mints the currency's capabilities and hands them to the
/// publisher -- real bridge configuration (validators/threshold/home address) happens in
/// `initialize`, a separate call, since `init` cannot take custom arguments.
fun init(otw: BRIDGE, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        otw,
        BRIDGED_DECIMALS,
        b"INAYA",
        b"Wrapped INAYA (Bridged)",
        b"",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury_cap, ctx.sender());
}

public entry fun initialize(
    treasury_cap: TreasuryCap<BRIDGE>,
    self_chain_id: u64,
    home_chain_id: u64,
    home_bridge_address: vector<u8>,
    threshold: u8,
    validators: vector<vector<u8>>,
    ctx: &mut TxContext,
) {
    assert!(threshold > 0 && (threshold as u64) <= validators.length(), E_INVALID_THRESHOLD);
    let state = BridgeState {
        id: object::new(ctx),
        admin: ctx.sender(),
        self_chain_id,
        home_chain_id,
        home_bridge_address,
        threshold,
        validators,
        paused: false,
        processed_messages: table::new(ctx),
        outbound_nonce: table::new(ctx),
        treasury_cap,
    };
    transfer::share_object(state);
}

// ------------------------------------------------------------
// INBOUND -- the only message type this module ever receives (TOKEN_MINT), threshold-signed by
// the shared validator committee, permissionless submission.
// ------------------------------------------------------------
public entry fun receive_message(
    state: &mut BridgeState,
    source_chain_id: u64,
    source_contract: vector<u8>,
    dest_chain_id: u64,
    dest_contract: vector<u8>,
    nonce: u64,
    msg_type: u8,
    payload: vector<u8>,
    signatures: vector<vector<u8>>, // 65-byte (r,s,v) per validator, ethers' Signature.serialized
    ctx: &mut TxContext,
) {
    assert!(!state.paused, E_PAUSED);
    assert!(dest_chain_id == state.self_chain_id, E_WRONG_DEST_CHAIN);
    assert!(source_chain_id == state.home_chain_id, E_UNTRUSTED_SOURCE);
    assert!(source_contract == state.home_bridge_address, E_UNTRUSTED_SOURCE);
    assert!(msg_type == MSG_TOKEN_MINT, E_INVALID_MSG_TYPE);

    let message_id = message::message_hash(source_chain_id, source_contract, dest_chain_id, dest_contract, nonce, msg_type, payload);
    assert!(!state.processed_messages.contains(message_id), E_ALREADY_EXECUTED);

    let signed_prefix = message::eth_signed_message_prefix(message_id);

    let mut distinct: vector<vector<u8>> = vector::empty();
    let mut i = 0;
    let n = signatures.length();
    while (i < n) {
        let sig = &signatures[i];
        let pubkey = ecdsa_k1::secp256k1_ecrecover(sig, &signed_prefix, KECCAK256);
        if (state.validators.contains(&pubkey) && !distinct.contains(&pubkey)) {
            distinct.push_back(pubkey);
        };
        i = i + 1;
    };
    assert!((distinct.length() as u8) >= state.threshold, E_INSUFFICIENT_SIGNATURES);

    state.processed_messages.add(message_id, true);

    let (recipient_bytes, amount_evm18) = message::decode_token_mint_payload(&payload);
    let recipient_addr = address::from_bytes(recipient_bytes);
    let amount = ((amount_evm18 / EVM_TO_SUI_DECIMALS_DIVISOR) as u64);
    assert!(amount > 0, E_ZERO_AMOUNT);

    let coin = coin::mint(&mut state.treasury_cap, amount, ctx);
    transfer::public_transfer(coin, recipient_addr);

    event::emit(MessageReceived { message_id, source_chain_id, nonce, recipient: recipient_addr, amount });
}

// ------------------------------------------------------------
// OUTBOUND -- burns the caller's wrapped INAYA Coin object and records the message home's
// relayer picks up (via the Sui event stream).
// ------------------------------------------------------------
public entry fun bridge_to_home(
    state: &mut BridgeState,
    payment: Coin<BRIDGE>,
    recipient: vector<u8>, // 32 bytes -- home decodes per its own per-destination convention
    route_to_chain_id: u64,
    ctx: &mut TxContext,
) {
    assert!(!state.paused, E_PAUSED);
    let amount = payment.value();
    assert!(amount > 0, E_ZERO_AMOUNT);

    coin::burn(&mut state.treasury_cap, payment);

    let amount_evm18 = (amount as u128) * EVM_TO_SUI_DECIMALS_DIVISOR;
    let action = if (route_to_chain_id == 0) { BURN_ACTION_PLAIN } else { BURN_ACTION_ROUTE };
    let payload = message::encode_burn_notice_payload(action, recipient, amount_evm18, route_to_chain_id);

    let sender = ctx.sender();
    let nonce = next_outbound_nonce(state, sender);
    let message_id = message::message_hash(
        state.self_chain_id,
        address::to_bytes(state.id.to_address()), // the shared BridgeState object's own unique
        // address as source_contract -- unlike `state.admin` (just whoever called `initialize`),
        // this is a stable identity for THIS bridge deployment, the Sui analogue of a contract
        // address on EVM / a program pubkey on Solana. This is the value that must be registered
        // as the trusted remote source on BSC home's InayaChainRegistry when wiring Sui in.
        state.home_chain_id,
        state.home_bridge_address,
        nonce,
        MSG_TOKEN_BURN_NOTICE,
        payload,
    );

    event::emit(BridgedToHome { from: sender, recipient, amount, message_id });
}

fun next_outbound_nonce(state: &mut BridgeState, sender: address): u64 {
    if (!state.outbound_nonce.contains(sender)) {
        state.outbound_nonce.add(sender, 0);
    };
    let n = &mut state.outbound_nonce[sender];
    *n = *n + 1;
    *n
}

// ------------------------------------------------------------
// ADMIN
// ------------------------------------------------------------
public entry fun add_validator(state: &mut BridgeState, new_validator: vector<u8>, ctx: &TxContext) {
    assert!(ctx.sender() == state.admin, E_NOT_ADMIN);
    assert!(!state.validators.contains(&new_validator), E_ALREADY_EXECUTED);
    state.validators.push_back(new_validator);
}

public entry fun set_threshold(state: &mut BridgeState, new_threshold: u8, ctx: &TxContext) {
    assert!(ctx.sender() == state.admin, E_NOT_ADMIN);
    assert!(new_threshold > 0 && (new_threshold as u64) <= state.validators.length(), E_INVALID_THRESHOLD);
    state.threshold = new_threshold;
}

public entry fun set_paused(state: &mut BridgeState, paused: bool, ctx: &TxContext) {
    assert!(ctx.sender() == state.admin, E_NOT_ADMIN);
    state.paused = paused;
}
