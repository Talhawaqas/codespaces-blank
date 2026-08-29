/// Must stay in sync with `contracts/bridge/ChainIds.sol` on the EVM side -- both sides hardcode
/// the same numeric values.
pub const BSC_TESTNET_CHAIN_ID: u64 = 97;
pub const ETH_SEPOLIA_CHAIN_ID: u64 = 11_155_111;
pub const POLYGON_AMOY_CHAIN_ID: u64 = 80_002;
pub const AVALANCHE_FUJI_CHAIN_ID: u64 = 43_113;
pub const SOLANA_MAINNET_CHAIN_ID: u64 = 1_000_000_001;
pub const SOLANA_DEVNET_CHAIN_ID: u64 = 1_000_000_002;

/// Must stay in sync with `contracts/bridge/InayaBridgeTypes.sol`'s MSG_* constants.
pub const MSG_TOKEN_MINT: u8 = 0;
pub const MSG_TOKEN_BURN_NOTICE: u8 = 1;
pub const MSG_STAKE_REQUEST: u8 = 2;

pub const BURN_ACTION_PLAIN: u8 = 0;
pub const BURN_ACTION_ROUTE: u8 = 1;

/// keccak256("INAYA_CROSSCHAIN_V1") -- precomputed (Solana has no const-eval keccak syscall),
/// identical to InayaBridgeTypes.sol's DOMAIN_TAG constant. Verify against the Solidity side
/// with `ethers.keccak256(ethers.toUtf8Bytes("INAYA_CROSSCHAIN_V1"))` if this file is ever
/// hand-edited.
pub const DOMAIN_TAG: [u8; 32] = [
    0x08, 0x83, 0x61, 0x6c, 0x06, 0x0b, 0x87, 0x9d, 0x70, 0xcd, 0xed, 0x66, 0xa0, 0xfa, 0x1d, 0xa9,
    0xa0, 0x14, 0xee, 0x7e, 0x12, 0xd7, 0xa0, 0x2e, 0xb6, 0x1e, 0x04, 0x9e, 0xa0, 0x09, 0x52, 0xb6,
];

pub const MAX_VALIDATORS: usize = 16;

/// Sliding-window replay-protection bitmap width per trusted source chain -- see
/// state/nonce_tracker.rs. 1024 nonces of slack is enormous headroom for any realistic relay
/// backlog while staying trivially rent-viable (128 bytes).
pub const NONCE_WINDOW_BITS: usize = 1024;
pub const NONCE_WINDOW_BYTES: usize = NONCE_WINDOW_BITS / 8;

/// Bridged SPL mint decimals. See message.rs's amount-conversion doc for the worked example of
/// why 9 (not 18, which would overflow SPL's u64 amount type for INAYA's 30M-token cap headroom).
pub const BRIDGED_MINT_DECIMALS: u8 = 9;
pub const EVM_TO_SOLANA_DECIMALS_DIVISOR: u128 = 1_000_000_000; // 10^(18-9)

pub const SEED_BRIDGE_CONFIG: &[u8] = b"bridge_config";
pub const SEED_VALIDATOR_SET: &[u8] = b"validator_set";
pub const SEED_TRUSTED_CHAIN: &[u8] = b"trusted_chain";
pub const SEED_NONCE_TRACKER: &[u8] = b"nonce_tracker";
pub const SEED_OUTBOUND_NONCE: &[u8] = b"outbound_nonce";
pub const SEED_BRIDGED_MINT: &[u8] = b"bridged_inaya_mint";
pub const SEED_MINT_AUTHORITY: &[u8] = b"mint_authority";
