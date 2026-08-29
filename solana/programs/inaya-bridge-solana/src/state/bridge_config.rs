use anchor_lang::prelude::*;

#[account]
pub struct BridgeConfig {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub self_chain_id: u64,
    /// Home's real EVM chainId (97 for BSC Testnet today) -- every outbound message from this
    /// program targets home directly, never another spoke, so this is the one `dest_chain_id`
    /// this program ever uses.
    pub home_chain_id: u64,
    /// Home's `InayaTokenBridgeHome` address, left-padded into 32 bytes -- the `dest_contract`
    /// this program addresses outbound TOKEN_BURN_NOTICE messages to.
    pub home_bridge_address: [u8; 32],
    /// Home's `InayaStakingGatewayHome` address, left-padded -- the `dest_contract` for outbound
    /// STAKE_REQUEST messages.
    pub home_staking_gateway_address: [u8; 32],
    pub paused: bool,
    pub bump: u8,
}

impl BridgeConfig {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 32 + 32 + 1 + 1;
}
