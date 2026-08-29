use anchor_lang::prelude::*;

#[error_code]
pub enum BridgeError {
    #[msg("Bridge is paused")]
    Paused,
    #[msg("Caller is not the admin")]
    Unauthorized,
    #[msg("Too many validators (max 16)")]
    TooManyValidators,
    #[msg("Threshold must be > 0 and <= validator count")]
    InvalidThreshold,
    #[msg("Duplicate validator address in the set")]
    DuplicateValidator,
    #[msg("Destination chain does not match this program's configured chain id")]
    WrongDestinationChain,
    #[msg("Source chain is not registered/trusted")]
    ChainNotTrusted,
    #[msg("Amount must be greater than 0")]
    ZeroAmount,
    #[msg("Amount is too small to survive 18->9 decimal conversion (rounds to 0)")]
    AmountTooSmallAfterConversion,
    #[msg("Invalid action type in payload")]
    InvalidAction,
    #[msg("Invalid lock period -- must be 0, 30, or 90")]
    InvalidLockPeriod,
    #[msg("Message already processed (replay)")]
    AlreadyProcessed,
    #[msg("Nonce is beyond the replay-protection window -- deliver missing lower nonces first")]
    NonceOutOfWindow,
    #[msg("Not enough valid threshold signatures")]
    InsufficientSignatures,
    #[msg("A preceding instruction is not a valid secp256k1 program verification")]
    InvalidSecp256k1Instruction,
    #[msg("Recovered signer is not a registered validator")]
    UnknownValidatorSigner,
    #[msg("Solana may only originate a stake request, never receive one")]
    InvalidActionForReceive,
    #[msg("Payload could not be decoded")]
    PayloadDecodeError,
}
