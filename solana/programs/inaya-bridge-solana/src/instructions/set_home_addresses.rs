use crate::constants::SEED_BRIDGE_CONFIG;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetHomeAddresses<'info> {
    pub admin: Signer<'info>,

    #[account(mut, seeds = [SEED_BRIDGE_CONFIG], bump = bridge_config.bump, has_one = admin)]
    pub bridge_config: Account<'info, BridgeConfig>,
}

pub fn handler(ctx: Context<SetHomeAddresses>, home_bridge_address: [u8; 32], home_staking_gateway_address: [u8; 32]) -> Result<()> {
    ctx.accounts.bridge_config.home_bridge_address = home_bridge_address;
    ctx.accounts.bridge_config.home_staking_gateway_address = home_staking_gateway_address;
    Ok(())
}
