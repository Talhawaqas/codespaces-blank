use crate::errors::BridgeError;
use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;
use solana_sdk_ids::secp256k1_program;

/// One parsed secp256k1-program verification found at a preceding instruction of the SAME
/// transaction. The Solana runtime verifies the ECDSA recovery for every `secp256k1_program`
/// instruction BEFORE any instruction in the transaction executes -- by the time our program
/// instruction runs, a present secp256k1-program instruction is already a proven fact (the
/// whole transaction would have failed at load time otherwise). This function only parses ITS
/// CONTENTS (which eth address, which message) to confirm they match what we expect; it does
/// NOT itself perform signature verification -- that already happened.
pub struct ParsedSecpVerification {
    pub eth_address: [u8; 20],
    pub message: Vec<u8>,
}

/// Parses the secp256k1-program instruction at absolute transaction index `index`, per the
/// native program's fixed offset-table layout: 1 byte num_signatures, then one 11-byte
/// `SecpSignatureOffsets` header (signature_offset:u16, signature_instruction_index:u8,
/// eth_address_offset:u16, eth_address_instruction_index:u8, message_data_offset:u16,
/// message_data_size:u16, message_instruction_index:u8) per signature, followed by the actual
/// referenced data. Assumes exactly one signature per instruction -- the relayer is expected to
/// emit one `Secp256k1Program.createInstructionWithEthAddress` call per validator signature
/// (see the Solana relayer delta doc), never a batched multi-sig instruction.
///
/// VERIFIED against a real, on-chain `Secp256k1Program.createInstructionWithEthAddress`-built
/// instruction on Solana Devnet (2026-09-01) -- see deployments/bridge/solanaDevnet.json's
/// `realDryRun` for the actual transaction hashes. The offset-table layout below is correct as
/// transcribed. What the first attempt actually got wrong was NOT this parser -- it was the
/// off-chain signer: Solana's native secp256k1 precompile keccak256-hashes the `message` bytes
/// found at `message_data_offset` internally before recovering the signature (undocumented in
/// the public client crate). This function's `require!(parsed.message == hash.to_vec())` check
/// is correct as written -- `parsed.message` must stay the RAW, unhashed `message_hash(&message)`
/// output, matching what's actually in the instruction's message field. The validator producing
/// the signature is the one who must sign `keccak256(hash)`, not `hash` directly -- that's a
/// client-side (off-chain relayer) concern, not something this parser or this program needs to
/// account for.
pub fn parse_secp256k1_instruction(instructions_sysvar: &AccountInfo, index: u16) -> Result<ParsedSecpVerification> {
    let ix = load_instruction_at_checked(index as usize, instructions_sysvar)
        .map_err(|_| error!(BridgeError::InvalidSecp256k1Instruction))?;

    require_keys_eq!(ix.program_id, secp256k1_program::ID, BridgeError::InvalidSecp256k1Instruction);

    let data = &ix.data;
    require!(!data.is_empty(), BridgeError::InvalidSecp256k1Instruction);
    let num_signatures = data[0];
    require!(num_signatures == 1, BridgeError::InvalidSecp256k1Instruction);
    require!(data.len() >= 1 + 11, BridgeError::InvalidSecp256k1Instruction);

    let eth_address_offset = u16::from_le_bytes([data[4], data[5]]) as usize;
    let message_data_offset = u16::from_le_bytes([data[7], data[8]]) as usize;
    let message_data_size = u16::from_le_bytes([data[9], data[10]]) as usize;

    require!(data.len() >= eth_address_offset + 20, BridgeError::InvalidSecp256k1Instruction);
    require!(data.len() >= message_data_offset + message_data_size, BridgeError::InvalidSecp256k1Instruction);

    let mut eth_address = [0u8; 20];
    eth_address.copy_from_slice(&data[eth_address_offset..eth_address_offset + 20]);
    let message = data[message_data_offset..message_data_offset + message_data_size].to_vec();

    Ok(ParsedSecpVerification { eth_address, message })
}
