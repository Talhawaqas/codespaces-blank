use crate::constants::*;
use crate::errors::BridgeError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(init, payer = payer, space = BridgeConfig::SIZE, seeds = [SEED_BRIDGE_CONFIG], bump)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(init, payer = payer, space = ValidatorSet::SIZE, seeds = [SEED_VALIDATOR_SET], bump)]
    pub validator_set: Account<'info, ValidatorSet>,

    #[account(
        init,
        payer = payer,
        mint::decimals = BRIDGED_MINT_DECIMALS,
        mint::authority = mint_authority,
        seeds = [SEED_BRIDGED_MINT],
        bump
    )]
    pub mint: Account<'info, Mint>,

    /// Data-less PDA used purely as the mint's authority / a CPI signer -- never initialized as
    /// an account with its own data, only ever referenced by address.
    /// CHECK: never read/written, only used as a PDA signer/authority reference.
    #[account(seeds = [SEED_MINT_AUTHORITY], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(init, payer = payer, space = OutboundNonceCounter::SIZE, seeds = [SEED_OUTBOUND_NONCE], bump)]
    pub outbound_nonce_counter: Account<'info, OutboundNonceCounter>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    admin: Pubkey,
    self_chain_id: u64,
    home_chain_id: u64,
    threshold: u8,
    initial_validators: Vec<[u8; 20]>,
) -> Result<()> {
    require!(initial_validators.len() <= MAX_VALIDATORS, BridgeError::TooManyValidators);
    require!(threshold > 0 && (threshold as usize) <= initial_validators.len(), BridgeError::InvalidThreshold);
    for i in 0..initial_validators.len() {
        for j in (i + 1)..initial_validators.len() {
            require!(initial_validators[i] != initial_validators[j], BridgeError::DuplicateValidator);
        }
    }

    let config = &mut ctx.accounts.bridge_config;
    config.admin = admin;
    config.mint = ctx.accounts.mint.key();
    config.self_chain_id = self_chain_id;
    config.home_chain_id = home_chain_id;
    config.home_bridge_address = [0u8; 32];
    config.home_staking_gateway_address = [0u8; 32];
    config.paused = false;
    config.bump = ctx.bumps.bridge_config;

    let vs = &mut ctx.accounts.validator_set;
    vs.validators = [[0u8; 20]; MAX_VALIDATORS];
    for (i, v) in initial_validators.iter().enumerate() {
        vs.validators[i] = *v;
    }
    vs.validator_count = initial_validators.len() as u8;
    vs.threshold = threshold;
    vs.bump = ctx.bumps.validator_set;

    ctx.accounts.outbound_nonce_counter.next_nonce = 0;
    ctx.accounts.outbound_nonce_counter.bump = ctx.bumps.outbound_nonce_counter;

    Ok(())
}
