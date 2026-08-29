//! Inaya Network cross-chain bridge -- Solana (non-EVM) spoke, SOW-1.
//!
//! Counterpart to the EVM bridge (`contracts/bridge/*.sol`): home (BSC Testnet) locks real
//! $INAYA; this program mint/burns a 9-decimal bridged SPL representation 1:1 backed by that
//! lock, using the SAME M-of-N secp256k1 validator committee as the EVM side (verified here via
//! Solana's native secp256k1 program + Instructions-sysvar introspection, so validators never
//! need a second Ed25519 keypair). See `message.rs` for the shared hash scheme and
//! `secp256k1.rs` for the signature-verification mechanics.
//!
//! TOOLCHAIN STATUS: builds cleanly. Toolchain installed via WSL2 Ubuntu (rustc 1.98.0,
//! solana-cli 3.1.10, anchor-cli 1.1.2 -- newer real releases than this code was originally
//! written against, since Anchor's API shifted between 0.30.x and 1.x: `init_if_needed` now
//! needs an explicit `idl-build`-adjacent Cargo feature, `CpiContext::new` takes the program's
//! `Pubkey` instead of its `AccountInfo`, and `solana_program`'s `keccak`/`secp256k1_program`/
//! `sysvar::instructions` re-exports moved into standalone crates
//! (`solana-keccak-hasher`/`solana-sdk-ids`/`solana-instructions-sysvar`) -- all fixed. Verified
//! with `anchor build`: both the on-chain SBF binary (`target/deploy/inaya_bridge_solana.so`)
//! and the IDL (`target/idl/inaya_bridge_solana.json`) build successfully.
//!
//! LIVE ON DEVNET: deployed and wired for real -- program id
//! `76KGt54jrh142nibdFH9BtZHxSu68rrDwxCTp5d98kZn`, `initialize`/`add_trusted_chain(BSC
//! Testnet)`/`set_home_addresses` all executed and confirmed on real Solana Devnet (see
//! `solana/wire-devnet.mjs`). A real cross-chain relayer dry run (validator signing + relayer
//! submission, the exact logic the cron routes use) was also confirmed live between BSC Testnet
//! and Sepolia (see `scripts/relayer-dry-run.mjs`).
//!
//! NOT YET DONE: `anchor test` (see `solana/tests/inaya-bridge.ts`) requires a local-validator
//! tool (`surfpool`) not installed in this environment -- the mocha suite itself was never run.
//! A `receive_message` call (secp256k1 signature path) has not been exercised against the
//! deployed devnet program either. Both are the natural next verification step before treating
//! this as production-ready.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod message;
pub mod secp256k1;
pub mod state;

use instructions::*;
use message::BridgeMessage;

declare_id!("76KGt54jrh142nibdFH9BtZHxSu68rrDwxCTp5d98kZn");

#[program]
pub mod inaya_bridge_solana {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        self_chain_id: u64,
        home_chain_id: u64,
        threshold: u8,
        initial_validators: Vec<[u8; 20]>,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, admin, self_chain_id, home_chain_id, threshold, initial_validators)
    }

    pub fn add_trusted_chain(ctx: Context<AddTrustedChain>, chain_id: u64, is_active: bool) -> Result<()> {
        instructions::add_trusted_chain::handler(ctx, chain_id, is_active)
    }

    pub fn update_validators(ctx: Context<UpdateValidators>, new_validators: Vec<[u8; 20]>, new_threshold: u8) -> Result<()> {
        instructions::update_validators::handler(ctx, new_validators, new_threshold)
    }

    pub fn set_home_addresses(
        ctx: Context<SetHomeAddresses>,
        home_bridge_address: [u8; 32],
        home_staking_gateway_address: [u8; 32],
    ) -> Result<()> {
        instructions::set_home_addresses::handler(ctx, home_bridge_address, home_staking_gateway_address)
    }

    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::pause::handler(ctx, true)
    }

    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::pause::handler(ctx, false)
    }

    /// Outbound: burn + notify home to unlock (route_to_chain_id = 0) or relay on to a
    /// different EVM spoke (route_to_chain_id = that spoke's real chainId).
    pub fn bridge_to_home(ctx: Context<BridgeToHome>, recipient: [u8; 32], amount_evm18: u128, route_to_chain_id: u64) -> Result<()> {
        instructions::bridge_to_home::handler(ctx, recipient, amount_evm18, route_to_chain_id)
    }

    /// Outbound: burn + request home credit `evm_beneficiary` in the one canonical
    /// InayaStaking ledger. Solana only ever originates this -- never receives it.
    pub fn stake_cross_chain(
        ctx: Context<StakeCrossChain>,
        evm_beneficiary: [u8; 20],
        amount_evm18: u128,
        lock_period_days: u64,
    ) -> Result<()> {
        instructions::stake_cross_chain::handler(ctx, evm_beneficiary, amount_evm18, lock_period_days)
    }

    /// Inbound: the only message type this program ever receives (TOKEN_MINT), threshold-signed
    /// by the shared validator committee, permissionless submission.
    pub fn receive_message(ctx: Context<ReceiveMessage>, message: BridgeMessage, num_signers: u8) -> Result<()> {
        instructions::receive_message::handler(ctx, message, num_signers)
    }
}
