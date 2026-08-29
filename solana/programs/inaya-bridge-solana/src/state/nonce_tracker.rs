use crate::constants::{NONCE_WINDOW_BITS, NONCE_WINDOW_BYTES};
use crate::errors::BridgeError;
use anchor_lang::prelude::*;

/// Replay protection for inbound messages FROM one specific source chain: a high-water-mark
/// plus a sliding bitmap covering the next NONCE_WINDOW_BITS nonces above it. Tolerates
/// realistic out-of-order relay delivery without an unbounded on-chain "seen set" -- a message
/// that can never be delivered stalls only nonces within its own 1024-wide window (an explicit,
/// bounded, recoverable failure mode), never silent data loss for anything else.
#[account]
pub struct NonceTracker {
    pub chain_id: u64,
    pub high_water_mark: u64,
    pub bitmap: [u8; NONCE_WINDOW_BYTES],
    pub bump: u8,
}

impl NonceTracker {
    pub const SIZE: usize = 8 + 8 + 8 + NONCE_WINDOW_BYTES + 1;

    /// Marks `nonce` processed, or errors if it's a replay or beyond the window. Compacts the
    /// window forward afterward (bounded per call as a compute-budget guard -- a set bit stays
    /// set, so partial compaction across multiple calls is never lossy).
    pub fn check_and_mark(&mut self, nonce: u64) -> Result<()> {
        require!(nonce > self.high_water_mark, BridgeError::AlreadyProcessed);

        let offset = (nonce - self.high_water_mark - 1) as usize;
        require!(offset < NONCE_WINDOW_BITS, BridgeError::NonceOutOfWindow);

        let byte_idx = offset / 8;
        let bit_idx = offset % 8;
        let mask = 1u8 << bit_idx;
        require!(self.bitmap[byte_idx] & mask == 0, BridgeError::AlreadyProcessed);
        self.bitmap[byte_idx] |= mask;

        let mut iterations = 0u32;
        while iterations < 256 && self.bitmap[0] & 1 != 0 {
            self.shift_right_one_bit();
            self.high_water_mark += 1;
            iterations += 1;
        }
        Ok(())
    }

    fn shift_right_one_bit(&mut self) {
        let len = self.bitmap.len();
        for i in 0..len {
            let next_bit = if i + 1 < len { self.bitmap[i + 1] & 1 } else { 0 };
            self.bitmap[i] = (self.bitmap[i] >> 1) | (next_bit << 7);
        }
    }
}
