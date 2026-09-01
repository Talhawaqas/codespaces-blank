/// Inaya Network cross-chain bridge -- Aptos (non-EVM) spoke, mirroring the Solana spoke
/// (solana/programs/inaya-bridge-solana) in shape: home (BSC Testnet) locks real $INAYA, this
/// module mint/burns an 8-decimal wrapped Fungible Asset 1:1 backed by that lock, verified
/// against the SAME M-of-N secp256k1 validator committee as every other spoke using Aptos's
/// native `aptos_std::secp256k1`/`aptos_std::aptos_hash::keccak256` -- both well-documented,
/// no hidden hashing quirk (see message.move's `eth_signed_message_hash` doc for why this chain
/// can reuse the plain EVM validator-signing convention directly, unlike Solana).
module inaya_bridge::bridge {
    use std::signer;
    use std::vector;
    use std::option;
    use std::string;
    use aptos_framework::event;
    use aptos_framework::object::{Self, Object};
    use aptos_framework::fungible_asset::{Self, MintRef, BurnRef, Metadata};
    use aptos_framework::primary_fungible_store;
    use aptos_std::table::{Self, Table};
    use aptos_std::secp256k1;
    use aptos_std::aptos_hash;
    use aptos_std::from_bcs;
    use inaya_bridge::message;

    /// Bridged-asset decimals. Aptos FA amounts are u64 -- 8 decimals mirrors Solana's reasoning
    /// (EVM's 18dp would overflow u64 well before INAYA's 30M-token cap does at 8dp: 30_000_000 *
    /// 10^8 = 3e15, comfortably under u64::MAX).
    const BRIDGED_DECIMALS: u8 = 8;
    const EVM_TO_APTOS_DECIMALS_DIVISOR: u128 = 10_000_000_000; // 10^(18-8)

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
    const E_MISMATCHED_SIG_ARRAYS: u64 = 9;
    const E_ALREADY_INITIALIZED: u64 = 10;
    const E_INVALID_THRESHOLD: u64 = 11;

    struct BridgeState has key {
        admin: address,
        self_chain_id: u64,
        home_chain_id: u64,
        home_bridge_address: vector<u8>, // 32 bytes
        threshold: u8,
        validators: vector<vector<u8>>,  // each a 20-byte eth address
        paused: bool,
        processed_messages: Table<vector<u8>, bool>, // messageId -> true, replay protection
        outbound_nonce: Table<address, u64>,          // per-sender outbound nonce
        mint_ref: MintRef,
        burn_ref: BurnRef,
        metadata: Object<Metadata>,
    }

    #[event]
    struct MessageReceived has drop, store {
        message_id: vector<u8>,
        source_chain_id: u64,
        nonce: u64,
        recipient: address,
        amount: u64,
    }

    #[event]
    struct BridgedToHome has drop, store {
        from: address,
        recipient: vector<u8>,
        amount: u64,
        message_id: vector<u8>,
    }

    inline fun assert_admin(state: &BridgeState, caller: &signer) {
        assert!(signer::address_of(caller) == state.admin, E_NOT_ADMIN);
    }

    public entry fun initialize(
        admin: &signer,
        self_chain_id: u64,
        home_chain_id: u64,
        home_bridge_address: vector<u8>,
        threshold: u8,
        validators: vector<vector<u8>>,
        name: vector<u8>,
        symbol: vector<u8>,
    ) {
        let admin_addr = signer::address_of(admin);
        assert!(!exists<BridgeState>(admin_addr), E_ALREADY_INITIALIZED);
        assert!(threshold > 0 && (threshold as u64) <= vector::length(&validators), E_INVALID_THRESHOLD);

        let ctor_ref = object::create_named_object(admin, b"inaya_bridge_wrapped_inaya");
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &ctor_ref,
            option::none(),
            string::utf8(name),
            string::utf8(symbol),
            BRIDGED_DECIMALS,
            string::utf8(b""),
            string::utf8(b""),
        );

        let mint_ref = fungible_asset::generate_mint_ref(&ctor_ref);
        let burn_ref = fungible_asset::generate_burn_ref(&ctor_ref);
        let metadata = object::object_from_constructor_ref<Metadata>(&ctor_ref);

        move_to(admin, BridgeState {
            admin: admin_addr,
            self_chain_id,
            home_chain_id,
            home_bridge_address,
            threshold,
            validators,
            paused: false,
            processed_messages: table::new(),
            outbound_nonce: table::new(),
            mint_ref,
            burn_ref,
            metadata,
        });
    }

    // ------------------------------------------------------------
    // INBOUND -- the only message type this module ever receives (TOKEN_MINT), threshold-signed
    // by the shared validator committee, permissionless submission (same "validity comes from
    // what's checked, not from who calls" model as every other spoke).
    // ------------------------------------------------------------
    public entry fun receive_message(
        _relayer: &signer,
        bridge_admin: address,
        source_chain_id: u64,
        source_contract: vector<u8>,
        dest_chain_id: u64,
        dest_contract: vector<u8>,
        nonce: u64,
        msg_type: u8,
        payload: vector<u8>,
        signatures: vector<vector<u8>>, // 64-byte r||s per validator, same slice ethers produces
        recovery_ids: vector<u8>,       // 0/1 per signature (ethers' yParity)
    ) acquires BridgeState {
        let state = borrow_global_mut<BridgeState>(bridge_admin);
        assert!(!state.paused, E_PAUSED);
        assert!(dest_chain_id == state.self_chain_id, E_WRONG_DEST_CHAIN);
        assert!(source_chain_id == state.home_chain_id, E_UNTRUSTED_SOURCE);
        assert!(source_contract == state.home_bridge_address, E_UNTRUSTED_SOURCE);
        assert!(msg_type == MSG_TOKEN_MINT, E_INVALID_MSG_TYPE);

        let message_id = message::message_hash(source_chain_id, source_contract, dest_chain_id, dest_contract, nonce, msg_type, payload);
        assert!(!table::contains(&state.processed_messages, message_id), E_ALREADY_EXECUTED);

        assert!(vector::length(&signatures) == vector::length(&recovery_ids), E_MISMATCHED_SIG_ARRAYS);
        let eth_digest = message::eth_signed_message_hash(message_id);

        let distinct: vector<vector<u8>> = vector::empty();
        let i = 0;
        let n = vector::length(&signatures);
        while (i < n) {
            let sig_bytes = *vector::borrow(&signatures, i);
            let rid = *vector::borrow(&recovery_ids, i);
            let sig = secp256k1::ecdsa_signature_from_bytes(sig_bytes);
            let pk_opt = secp256k1::ecdsa_recover(eth_digest, rid, &sig);
            if (option::is_some(&pk_opt)) {
                let pk = option::extract(&mut pk_opt);
                let pk_bytes = secp256k1::ecdsa_raw_public_key_to_bytes(&pk);
                let addr = eth_address_from_pubkey(pk_bytes);
                if (contains_bytes(&state.validators, &addr) && !contains_bytes(&distinct, &addr)) {
                    vector::push_back(&mut distinct, addr);
                };
            };
            i = i + 1;
        };
        assert!((vector::length(&distinct) as u8) >= state.threshold, E_INSUFFICIENT_SIGNATURES);

        table::add(&mut state.processed_messages, message_id, true);

        let (recipient_bytes, amount_evm18) = message::decode_token_mint_payload(&payload);
        let recipient_addr = from_bcs::to_address(recipient_bytes);
        let amount = ((amount_evm18 / EVM_TO_APTOS_DECIMALS_DIVISOR) as u64);
        assert!(amount > 0, E_ZERO_AMOUNT);

        let fa = fungible_asset::mint(&state.mint_ref, amount);
        primary_fungible_store::deposit(recipient_addr, fa);

        event::emit(MessageReceived { message_id, source_chain_id, nonce, recipient: recipient_addr, amount });
    }

    // ------------------------------------------------------------
    // OUTBOUND -- burns the caller's wrapped INAYA and records the message home's relayer picks
    // up (via the Aptos event stream, the same "watch for the event, collect validator sigs,
    // submit on the other side" shape as every existing cron relayer).
    // ------------------------------------------------------------
    public entry fun bridge_to_home(
        caller: &signer,
        bridge_admin: address,
        recipient: vector<u8>, // 32 bytes -- home decodes per its own per-destination convention
        amount: u64,
        route_to_chain_id: u64,
    ) acquires BridgeState {
        let state = borrow_global_mut<BridgeState>(bridge_admin);
        assert!(!state.paused, E_PAUSED);
        assert!(amount > 0, E_ZERO_AMOUNT);

        let fa = primary_fungible_store::withdraw(caller, state.metadata, amount);
        fungible_asset::burn(&state.burn_ref, fa);

        let amount_evm18 = (amount as u128) * EVM_TO_APTOS_DECIMALS_DIVISOR;
        let action = if (route_to_chain_id == 0) { BURN_ACTION_PLAIN } else { BURN_ACTION_ROUTE };
        let payload = message::encode_burn_notice_payload(action, recipient, amount_evm18, route_to_chain_id);

        let caller_addr = signer::address_of(caller);
        let nonce = next_outbound_nonce(state, caller_addr);
        let message_id = message::message_hash(
            state.self_chain_id,
            address_to_bytes32(bridge_admin),
            state.home_chain_id,
            state.home_bridge_address,
            nonce,
            MSG_TOKEN_BURN_NOTICE,
            payload,
        );

        event::emit(BridgedToHome { from: caller_addr, recipient, amount, message_id });
    }

    fun next_outbound_nonce(state: &mut BridgeState, sender: address): u64 {
        if (!table::contains(&state.outbound_nonce, sender)) {
            table::add(&mut state.outbound_nonce, sender, 0);
        };
        let n = table::borrow_mut(&mut state.outbound_nonce, sender);
        *n = *n + 1;
        *n
    }

    fun address_to_bytes32(addr: address): vector<u8> {
        std::bcs::to_bytes(&addr)
    }

    /// Ethereum-style address derivation: keccak256(64-byte raw pubkey)'s LAST 20 bytes.
    fun eth_address_from_pubkey(pubkey: vector<u8>): vector<u8> {
        let full_hash = aptos_hash::keccak256(pubkey);
        let addr = vector::empty<u8>();
        let i = 12;
        while (i < 32) { vector::push_back(&mut addr, *vector::borrow(&full_hash, i)); i = i + 1; };
        addr
    }

    fun contains_bytes(haystack: &vector<vector<u8>>, needle: &vector<u8>): bool {
        let i = 0;
        let n = vector::length(haystack);
        while (i < n) {
            if (vector::borrow(haystack, i) == needle) { return true };
            i = i + 1;
        };
        false
    }

    // ------------------------------------------------------------
    // ADMIN
    // ------------------------------------------------------------
    public entry fun add_validator(admin: &signer, new_validator: vector<u8>) acquires BridgeState {
        let state = borrow_global_mut<BridgeState>(signer::address_of(admin));
        assert_admin(state, admin);
        assert!(!contains_bytes(&state.validators, &new_validator), E_ALREADY_INITIALIZED);
        vector::push_back(&mut state.validators, new_validator);
    }

    public entry fun set_threshold(admin: &signer, new_threshold: u8) acquires BridgeState {
        let state = borrow_global_mut<BridgeState>(signer::address_of(admin));
        assert_admin(state, admin);
        assert!(new_threshold > 0 && (new_threshold as u64) <= vector::length(&state.validators), E_INVALID_THRESHOLD);
        state.threshold = new_threshold;
    }

    public entry fun set_paused(admin: &signer, paused: bool) acquires BridgeState {
        let state = borrow_global_mut<BridgeState>(signer::address_of(admin));
        assert_admin(state, admin);
        state.paused = paused;
    }

    #[view]
    public fun wrapped_balance(bridge_admin: address, account: address): u64 acquires BridgeState {
        let state = borrow_global<BridgeState>(bridge_admin);
        primary_fungible_store::balance(account, state.metadata)
    }
}
