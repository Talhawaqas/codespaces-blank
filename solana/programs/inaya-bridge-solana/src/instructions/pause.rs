use crate::constants::SEED_BRIDGE_CONFIG;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,

    #[account(mut, seeds = [SEED_BRIDGE_CONFIG], bump = bridge_config.bump, has_one = admin)]
    pub bridge_config: Account<'info, BridgeConfig>,
}

pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.bridge_config.paused = paused;
    Ok(())
}
