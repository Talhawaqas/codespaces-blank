use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(chain_id: u64)]
pub struct AddTrustedChain<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [SEED_BRIDGE_CONFIG], bump = bridge_config.bump, has_one = admin)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init_if_needed,
        payer = admin,
        space = TrustedChain::SIZE,
        seeds = [SEED_TRUSTED_CHAIN, &chain_id.to_le_bytes()],
        bump
    )]
    pub trusted_chain: Account<'info, TrustedChain>,

    #[account(
        init_if_needed,
        payer = admin,
        space = NonceTracker::SIZE,
        seeds = [SEED_NONCE_TRACKER, &chain_id.to_le_bytes()],
        bump
    )]
    pub nonce_tracker: Account<'info, NonceTracker>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AddTrustedChain>, chain_id: u64, is_active: bool) -> Result<()> {
    let tc = &mut ctx.accounts.trusted_chain;
    tc.chain_id = chain_id;
    tc.is_active = is_active;
    tc.bump = ctx.bumps.trusted_chain;

    // Only initialize the nonce tracker's mutable state the first time this chain is added --
    // re-running add_trusted_chain (e.g. just to flip is_active) must never reset progress.
    let nt = &mut ctx.accounts.nonce_tracker;
    if nt.chain_id == 0 {
        nt.chain_id = chain_id;
        nt.high_water_mark = 0;
        nt.bitmap = [0u8; NONCE_WINDOW_BYTES];
        nt.bump = ctx.bumps.nonce_tracker;
    }

    Ok(())
}
