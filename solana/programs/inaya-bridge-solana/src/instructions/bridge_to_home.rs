use crate::constants::*;
use crate::errors::BridgeError;
use crate::message::{encode_burn_notice_payload, message_hash, BridgeMessage};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

/// Carries the full BridgeMessage (not just its hash) so the off-chain relayer can reconstruct
/// it byte-for-byte from transaction logs alone and sign/submit it to home -- the Solana
/// equivalent of the EVM side's full-struct `MessageSent` event.
#[event]
pub struct MessageSent {
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
pub struct BridgeToHome<'info> {
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

/// Burns the caller's bridged INAYA and requests home unlock/relay it. `route_to_chain_id` of 0
/// means "unlock straight to `recipient` on home" (BURN_ACTION_PLAIN); any other real EVM
/// chainId routes the equivalent lock on through home to that spoke (BURN_ACTION_ROUTE) --
/// mirroring the EVM spokes' own bridgeToHome/bridgeToSpoke split. Solana never bridges
/// directly to another spoke; only home decides routing, for every chain in the topology.
pub fn handler(ctx: Context<BridgeToHome>, recipient: [u8; 32], amount_evm18: u128, route_to_chain_id: u64) -> Result<()> {
    require!(!ctx.accounts.bridge_config.paused, BridgeError::Paused);
    require!(amount_evm18 > 0, BridgeError::ZeroAmount);

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

    let action = if route_to_chain_id == 0 { BURN_ACTION_PLAIN } else { BURN_ACTION_ROUTE };
    let payload = encode_burn_notice_payload(action, recipient, amount_evm18, route_to_chain_id);

    let counter = &mut ctx.accounts.outbound_nonce_counter;
    counter.next_nonce += 1;
    let nonce = counter.next_nonce;

    let message = BridgeMessage {
        source_chain_id: ctx.accounts.bridge_config.self_chain_id,
        source_contract: crate::ID.to_bytes(),
        dest_chain_id: ctx.accounts.bridge_config.home_chain_id,
        dest_contract: ctx.accounts.bridge_config.home_bridge_address,
        nonce,
        msg_type: MSG_TOKEN_BURN_NOTICE,
        payload,
    };
    let hash = message_hash(&message);

    emit!(MessageSent {
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
