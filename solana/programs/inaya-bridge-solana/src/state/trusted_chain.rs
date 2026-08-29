use anchor_lang::prelude::*;

#[account]
pub struct TrustedChain {
    pub chain_id: u64,
    pub is_active: bool,
    pub bump: u8,
}

impl TrustedChain {
    pub const SIZE: usize = 8 + 8 + 1 + 1;
}
