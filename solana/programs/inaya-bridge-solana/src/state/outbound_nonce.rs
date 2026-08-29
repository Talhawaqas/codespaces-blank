use anchor_lang::prelude::*;

/// Solana is the single source of truth for its own outbound nonce -- no window/reordering
/// concern the way inbound NonceTracker has, since only this program assigns these.
#[account]
pub struct OutboundNonceCounter {
    pub next_nonce: u64,
    pub bump: u8,
}

impl OutboundNonceCounter {
    pub const SIZE: usize = 8 + 8 + 1;
}
