// solana/tests/inaya-bridge.ts
//
// Run with `anchor test` once a real toolchain is available (see lib.rs's top-level doc comment
// for why this hasn't been executed in this session). Illustrative core scenarios, not
// exhaustive -- extend with the out-of-order-nonce/dust/pause cases noted in the design doc
// once a real validator is running.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Secp256k1Program, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { keccak_256 } from "@noble/hashes/sha3"; // if unavailable, swap for ethers.keccak256 in a real run
import * as secp from "@noble/secp256k1";

describe("inaya-bridge-solana", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.InayaBridgeSolana as Program<any>;

  const HOME_CHAIN_ID = 97;
  const SOLANA_DEVNET_CHAIN_ID = 1_000_000_002;

  let validator1: Uint8Array, validator2: Uint8Array; // secp256k1 private keys
  let ethAddr1: Buffer, ethAddr2: Buffer;

  function ethAddressFromPrivateKey(pk: Uint8Array): Buffer {
    const pub = secp.getPublicKey(pk, false).slice(1); // drop 0x04 prefix
    const hash = keccak_256(pub);
    return Buffer.from(hash.slice(-20));
  }

  before(() => {
    validator1 = secp.utils.randomPrivateKey();
    validator2 = secp.utils.randomPrivateKey();
    ethAddr1 = ethAddressFromPrivateKey(validator1);
    ethAddr2 = ethAddressFromPrivateKey(validator2);
  });

  function pda(seeds: (Buffer | Uint8Array)[]) {
    return PublicKey.findProgramAddressSync(seeds, program.programId);
  }

  it("initializes with a 2-of-2 validator set", async () => {
    const [bridgeConfig] = pda([Buffer.from("bridge_config")]);
    const [validatorSet] = pda([Buffer.from("validator_set")]);
    const [mint] = pda([Buffer.from("bridged_inaya_mint")]);
    const [mintAuthority] = pda([Buffer.from("mint_authority")]);
    const [outboundNonce] = pda([Buffer.from("outbound_nonce")]);

    await program.methods
      .initialize(
        provider.wallet.publicKey,
        new anchor.BN(SOLANA_DEVNET_CHAIN_ID),
        new anchor.BN(HOME_CHAIN_ID),
        2,
        [Array.from(ethAddr1), Array.from(ethAddr2)]
      )
      .accounts({
        payer: provider.wallet.publicKey,
        bridgeConfig,
        validatorSet,
        mint,
        mintAuthority,
        outboundNonceCounter: outboundNonce,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const config = await program.account.bridgeConfig.fetch(bridgeConfig);
    expect(config.selfChainId.toNumber()).to.equal(SOLANA_DEVNET_CHAIN_ID);
    expect(config.paused).to.equal(false);

    const vs = await program.account.validatorSet.fetch(validatorSet);
    expect(vs.threshold).to.equal(2);
    expect(vs.validatorCount).to.equal(2);
  });

  it("registers BSC Testnet as a trusted source chain", async () => {
    const [bridgeConfig] = pda([Buffer.from("bridge_config")]);
    const [trustedChain] = pda([Buffer.from("trusted_chain"), new anchor.BN(HOME_CHAIN_ID).toArrayLike(Buffer, "le", 8)]);
    const [nonceTracker] = pda([Buffer.from("nonce_tracker"), new anchor.BN(HOME_CHAIN_ID).toArrayLike(Buffer, "le", 8)]);

    await program.methods
      .addTrustedChain(new anchor.BN(HOME_CHAIN_ID), true)
      .accounts({ admin: provider.wallet.publicKey, bridgeConfig, trustedChain, nonceTracker, systemProgram: SystemProgram.programId })
      .rpc();

    const tc = await program.account.trustedChain.fetch(trustedChain);
    expect(tc.isActive).to.equal(true);
  });

  // A full valid-threshold-signed receive_message test needs: building the exact BridgeMessage
  // the EVM home side would produce, computing message_hash identically (see message.rs), then
  // constructing two Secp256k1Program.createInstructionWithEthAddress instructions (one per
  // validator) immediately before the receive_message call in the SAME transaction, per the
  // ordering receive_message.rs's handler expects. Sketch:
  //
  //   const messageHash = /* keccak256(abi.encode(DOMAIN_TAG, ...)) computed exactly as message.rs does */;
  //   const sig1 = secp.signSync(messageHash, validator1, { recovered: true });
  //   const ix1 = Secp256k1Program.createInstructionWithPrivateKey({ privateKey: validator1, message: messageHash });
  //   const ix2 = Secp256k1Program.createInstructionWithPrivateKey({ privateKey: validator2, message: messageHash });
  //   await program.methods.receiveMessage(message, 2).accounts({...}).preInstructions([ix1, ix2]).rpc();
  //
  // Left as a sketch rather than a runnable test: it depends on getting message_hash's Rust and
  // TS implementations byte-identical, which is exactly the thing that needs a real toolchain
  // run (not a hand-simulation) to trust -- see lib.rs's top-level doc.
  it.skip("valid 2-of-2 threshold-signed TOKEN_MINT mints the correct converted amount (needs a real toolchain run)", async () => {});
  it.skip("rejects insufficient signatures", async () => {});
  it.skip("rejects a replayed nonce", async () => {});
  it.skip("rejects an untrusted source chain", async () => {});
  it.skip("pause blocks bridge_to_home/stake_cross_chain/receive_message", async () => {});
});
