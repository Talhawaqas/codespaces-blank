use crate::constants::*;
use crate::errors::BridgeError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateValidators<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [SEED_BRIDGE_CONFIG], bump = bridge_config.bump, has_one = admin)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(mut, seeds = [SEED_VALIDATOR_SET], bump = validator_set.bump)]
    pub validator_set: Account<'info, ValidatorSet>,
}

pub fn handler(ctx: Context<UpdateValidators>, new_validators: Vec<[u8; 20]>, new_threshold: u8) -> Result<()> {
    require!(new_validators.len() <= MAX_VALIDATORS, BridgeError::TooManyValidators);
    require!(new_threshold > 0 && (new_threshold as usize) <= new_validators.len(), BridgeError::InvalidThreshold);
    for i in 0..new_validators.len() {
        for j in (i + 1)..new_validators.len() {
            require!(new_validators[i] != new_validators[j], BridgeError::DuplicateValidator);
        }
    }

    let vs = &mut ctx.accounts.validator_set;
    vs.validators = [[0u8; 20]; MAX_VALIDATORS];
    for (i, v) in new_validators.iter().enumerate() {
        vs.validators[i] = *v;
    }
    vs.validator_count = new_validators.len() as u8;
    vs.threshold = new_threshold;

    Ok(())
}
