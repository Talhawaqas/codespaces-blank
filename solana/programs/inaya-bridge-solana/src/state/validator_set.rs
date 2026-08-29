use crate::constants::MAX_VALIDATORS;
use anchor_lang::prelude::*;

#[account]
pub struct ValidatorSet {
    /// Ethereum-style addresses (secp256k1 pubkey -> keccak -> last 20 bytes), same keys the
    /// EVM-side InayaValidatorSet trusts -- one shared validator committee across every chain,
    /// EVM or Solana.
    pub validators: [[u8; 20]; MAX_VALIDATORS],
    pub validator_count: u8,
    pub threshold: u8,
    pub bump: u8,
}

impl ValidatorSet {
    pub const SIZE: usize = 8 + (20 * MAX_VALIDATORS) + 1 + 1 + 1;

    pub fn is_validator(&self, addr: &[u8; 20]) -> bool {
        self.validators[..self.validator_count as usize].iter().any(|v| v == addr)
    }
}
