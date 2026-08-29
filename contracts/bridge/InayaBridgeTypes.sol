// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// Shared cross-chain message format for the Inaya bridge.
//
// One struct, one hash scheme, used identically by every chain (EVM or not)
// in the bridge topology. `sourceContract`/`destContract` identify the
// sending/receiving MODULE (a bridge or staking-gateway contract), not the
// end user -- the end user's address/amount/etc. live inside the opaque
// `payload`, decoded only by the specific handler for `msgType`. Keeping the
// outer struct's dynamic content limited to a single `bytes payload` (rather
// than several dynamic fields) means a non-EVM chain reproducing this hash
// only needs to hash the raw payload bytes it already has and reproduce one
// fixed-shape 8-field `abi.encode` -- not a general dynamic multi-field ABI
// encoder.
// ============================================================
library InayaBridgeTypes {
    // Namespaces this signature scheme from any other use of the same
    // validator keys. Identical on every chain/deployment.
    bytes32 internal constant DOMAIN_TAG = keccak256("INAYA_CROSSCHAIN_V1");

    // Every message is exactly one of these three types.
    uint8 internal constant MSG_TOKEN_MINT = 0;        // dest-bound credit: transfer completion, unstake payout, or reward-claim payout
    uint8 internal constant MSG_TOKEN_BURN_NOTICE = 1; // spoke -> home only
    uint8 internal constant MSG_STAKE_REQUEST = 2;     // spoke -> home only

    // TOKEN_BURN_NOTICE payload `action` byte.
    uint8 internal constant BURN_ACTION_PLAIN = 0; // unlock straight to recipient on home
    uint8 internal constant BURN_ACTION_ROUTE = 1; // re-lock and forward on to a different spoke

    enum MessageStatus { None, Pending, Completed, Failed }

    struct Message {
        uint256 sourceChainId;
        bytes32 sourceContract; // left-padded EVM address, or a Solana program's native 32-byte id
        uint256 destChainId;
        bytes32 destContract;
        uint256 nonce;          // per-(sourceChainId, sourceContract) monotonic, assigned by sendMessage
        uint8 msgType;
        bytes payload;
    }

    /// @notice The canonical message id / signed digest input. Identical on every chain.
    function hashMessage(Message memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TAG,
            m.sourceChainId,
            m.sourceContract,
            m.destChainId,
            m.destContract,
            m.nonce,
            m.msgType,
            keccak256(m.payload)
        ));
    }

    function addressToBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }
}
