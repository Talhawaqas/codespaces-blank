use crate::constants::*;
use crate::errors::BridgeError;
use crate::message::{decode_token_mint_payload, message_hash, BridgeMessage};
use crate::secp256k1::parse_secp256k1_instruction;
use crate::state::*;
use anchor_lang::prelude::*;
use solana_instructions_sysvar::{self as ix_sysvar, load_current_index_checked};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

#[event]
pub struct MessageReceived {
    pub message_hash: [u8; 32],
    pub source_chain_id: u64,
    pub nonce: u64,
    pub recipient: Pubkey,
    pub amount_solana: u64,
}

#[derive(Accounts)]
#[instruction(message: BridgeMessage)]
pub struct ReceiveMessage<'info> {
    /// Fee payer only -- security comes from the threshold signatures checked in the handler,
    /// never from who submits this transaction. Permissionless by design, same as
    /// InayaMessenger.executeMessage on the EVM side.
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(seeds = [SEED_BRIDGE_CONFIG], bump = bridge_config.bump)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(seeds = [SEED_VALIDATOR_SET], bump = validator_set.bump)]
    pub validator_set: Account<'info, ValidatorSet>,

    /// Seeds are derived from `message.source_chain_id` (an instruction argument, not a
    /// client-supplied account) -- a malicious relayer cannot substitute a fake trusted-chain
    /// account for a different chain id than the one actually in `message`.
    #[account(seeds = [SEED_TRUSTED_CHAIN, &message.source_chain_id.to_le_bytes()], bump = trusted_chain.bump)]
    pub trusted_chain: Account<'info, TrustedChain>,

    #[account(mut, seeds = [SEED_NONCE_TRACKER, &message.source_chain_id.to_le_bytes()], bump = nonce_tracker.bump)]
    pub nonce_tracker: Account<'info, NonceTracker>,

    #[account(mut, seeds = [SEED_BRIDGED_MINT], bump)]
    pub mint: Account<'info, Mint>,

    /// CHECK: data-less PDA, only used as the mint CPI signer.
    #[account(seeds = [SEED_MINT_AUTHORITY], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = relayer,
        associated_token::mint = mint,
        associated_token::authority = recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// CHECK: only used to derive/own `recipient_token_account`'s ATA; never read/written
    /// directly. Its 32 bytes come straight from `message.payload`, decoded in the handler --
    /// Anchor's `associated_token::authority` constraint just needs *an* AccountInfo here.
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: verified by address against the Instructions sysvar ID in the handler.
    #[account(address = ix_sysvar::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ReceiveMessage>, message: BridgeMessage, num_signers: u8) -> Result<()> {
    require!(!ctx.accounts.bridge_config.paused, BridgeError::Paused);
    require!(message.dest_chain_id == ctx.accounts.bridge_config.self_chain_id, BridgeError::WrongDestinationChain);
    require!(ctx.accounts.trusted_chain.is_active, BridgeError::ChainNotTrusted);

    // Never trust a client-supplied hash -- the program recomputes it itself from the fields it
    // was given.
    let hash = message_hash(&message);

    // Walk backward through `num_signers` preceding instructions, each expected to be a native
    // secp256k1-program verification (already checked by the runtime before this instruction
    // ever ran) over this exact `hash`.
    let current_index = load_current_index_checked(&ctx.accounts.instructions_sysvar.to_account_info())?;
    require!(num_signers as usize <= current_index as usize, BridgeError::InsufficientSignatures);

    let mut distinct_signers: Vec<[u8; 20]> = Vec::with_capacity(num_signers as usize);
    for i in 1..=num_signers as u16 {
        let ix_index = current_index - i;
        let parsed = parse_secp256k1_instruction(&ctx.accounts.instructions_sysvar.to_account_info(), ix_index)?;
        require!(parsed.message == hash.to_vec(), BridgeError::InvalidSecp256k1Instruction);
        require!(ctx.accounts.validator_set.is_validator(&parsed.eth_address), BridgeError::UnknownValidatorSigner);
        if !distinct_signers.contains(&parsed.eth_address) {
            distinct_signers.push(parsed.eth_address);
        }
    }
    require!(distinct_signers.len() >= ctx.accounts.validator_set.threshold as usize, BridgeError::InsufficientSignatures);

    // Replay/out-of-window check, keyed to the source chain (account derivation above already
    // pins this to message.source_chain_id).
    ctx.accounts.nonce_tracker.check_and_mark(message.nonce)?;

    // Solana can only ever RECEIVE a credit -- TOKEN_MINT covers a completed transfer, an
    // unstake payout, and a reward-claim payout alike (the receiving side never needs to know
    // which). STAKE_REQUEST/TOKEN_BURN_NOTICE are outbound-only from this program.
    require!(message.msg_type == MSG_TOKEN_MINT, BridgeError::InvalidActionForReceive);

    let (recipient_bytes, amount_evm18) = decode_token_mint_payload(&message.payload).ok_or(error!(BridgeError::PayloadDecodeError))?;
    let recipient_pubkey = Pubkey::new_from_array(recipient_bytes);
    require_keys_eq!(recipient_pubkey, ctx.accounts.recipient.key(), BridgeError::PayloadDecodeError);

    let amount_solana: u64 = (amount_evm18 / EVM_TO_SOLANA_DECIMALS_DIVISOR)
        .try_into()
        .map_err(|_| error!(BridgeError::AmountTooSmallAfterConversion))?;
    require!(amount_solana > 0, BridgeError::AmountTooSmallAfterConversion);

    let mint_authority_bump = ctx.bumps.mint_authority;
    let seeds: &[&[u8]] = &[SEED_MINT_AUTHORITY, &[mint_authority_bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount_solana,
    )?;

    emit!(MessageReceived {
        message_hash: hash,
        source_chain_id: message.source_chain_id,
        nonce: message.nonce,
        recipient: recipient_pubkey,
        amount_solana,
    });

    Ok(())
}
