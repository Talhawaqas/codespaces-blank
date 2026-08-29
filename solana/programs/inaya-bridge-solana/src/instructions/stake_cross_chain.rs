use crate::constants::*;
use crate::errors::BridgeError;
use crate::message::{encode_stake_request_payload, message_hash, BridgeMessage};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

#[event]
pub struct StakeRequestSent {
    pub message_hash: [u8; 32],
    pub source_chain_id: u64,
    pub source_contract: [u8; 32],
    pub dest_chain_id: u64,
    pub dest_contract: [u8; 32],
    pub nonce: u64,
    pub msg_type: u8,
    pub payload: Vec<u8>,
}

#[derive(Accounts)]
pub struct StakeCrossChain<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, constraint = user_token_account.owner == user.key(), constraint = user_token_account.mint == mint.key())]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut, seeds = [SEED_BRIDGED_MINT], bump)]
    pub mint: Account<'info, Mint>,

    #[account(seeds = [SEED_BRIDGE_CONFIG], bump = bridge_config.bump)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(mut, seeds = [SEED_OUTBOUND_NONCE], bump = outbound_nonce_counter.bump)]
    pub outbound_nonce_counter: Account<'info, OutboundNonceCounter>,

    pub token_program: Program<'info, Token>,
}

/// Burns the caller's bridged INAYA and requests home credit `evm_beneficiary` in the ONE
/// canonical `InayaStaking` ledger. Solana can only ORIGINATE a stake request, never receive
/// one -- home is the sole source of truth, so there is no `receive_message` path for
/// MSG_STAKE_REQUEST on this program. `evm_beneficiary` is required because InayaStaking's
/// ledger is address-keyed; a native Solana pubkey cannot itself be the ledger key.
pub fn handler(ctx: Context<StakeCrossChain>, evm_beneficiary: [u8; 20], amount_evm18: u128, lock_period_days: u64) -> Result<()> {
    require!(!ctx.accounts.bridge_config.paused, BridgeError::Paused);
    require!(amount_evm18 > 0, BridgeError::ZeroAmount);
    require!(
        lock_period_days == 0 || lock_period_days == 30 || lock_period_days == 90,
        BridgeError::InvalidLockPeriod
    );

    let amount_solana: u64 = (amount_evm18 / EVM_TO_SOLANA_DECIMALS_DIVISOR)
        .try_into()
        .map_err(|_| error!(BridgeError::AmountTooSmallAfterConversion))?;
    require!(amount_solana > 0, BridgeError::AmountTooSmallAfterConversion);

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_solana,
    )?;

    let self_chain_id = ctx.accounts.bridge_config.self_chain_id;
    let payload = encode_stake_request_payload(evm_beneficiary, amount_evm18, lock_period_days, self_chain_id);

    let counter = &mut ctx.accounts.outbound_nonce_counter;
    counter.next_nonce += 1;
    let nonce = counter.next_nonce;

    let message = BridgeMessage {
        source_chain_id: self_chain_id,
        source_contract: crate::ID.to_bytes(),
        dest_chain_id: ctx.accounts.bridge_config.home_chain_id,
        dest_contract: ctx.accounts.bridge_config.home_staking_gateway_address,
        nonce,
        msg_type: MSG_STAKE_REQUEST,
        payload,
    };
    let hash = message_hash(&message);

    emit!(StakeRequestSent {
        message_hash: hash,
        source_chain_id: message.source_chain_id,
        source_contract: message.source_contract,
        dest_chain_id: message.dest_chain_id,
        dest_contract: message.dest_contract,
        nonce: message.nonce,
        msg_type: message.msg_type,
        payload: message.payload,
    });

    Ok(())
}
