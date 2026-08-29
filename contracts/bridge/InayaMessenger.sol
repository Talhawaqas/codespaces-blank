// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./InayaBridgeTypes.sol";
import "./IInayaMessageHandler.sol";
import "./InayaChainRegistry.sol";
import "./InayaValidatorSet.sol";

// ============================================================
// INAYA MESSENGER
//
// Generic cross-chain message bus. Authorized on-chain modules (bridges,
// staking gateways) call `sendMessage`. Anyone -- a relayer -- may call
// `executeMessage` with a signed Message, same "permissionless execution,
// validity comes from what's checked, not from who calls" philosophy as
// InayaNodeRegistry.releaseSettlement, but here validity means: not already
// executed, from a chain+contract this deployment trusts, and signed by a
// threshold of the registered validator set. Routes by `msgType` to exactly
// one registered handler contract.
// ============================================================
contract InayaMessenger is Ownable, Pausable, ReentrancyGuard {
    InayaChainRegistry public chainRegistry;
    InayaValidatorSet public validatorSet;
    address public emergencyPauser;

    // per-sender outbound nonce (sender = the authorized module that called sendMessage)
    mapping(address => uint256) public outboundNonce;

    struct OutboundRecord {
        uint256 destChainId;
        bytes32 destContract;
        uint8 msgType;
        uint256 nonce;
        address sender;
        uint256 timestamp;
        bytes32 payloadHash;
    }

    struct InboundRecord {
        InayaBridgeTypes.MessageStatus status;
        uint8 attempts;
        uint256 lastAttemptAt;
        string lastFailureReason;
    }

    mapping(bytes32 => OutboundRecord) public outboundRecords;
    mapping(bytes32 => InboundRecord) public inboundRecords;

    mapping(address => bool) public authorizedSenders;
    mapping(uint8 => address) public handlers;

    event MessageSent(bytes32 indexed messageId, InayaBridgeTypes.Message message);
    event MessageExecuted(bytes32 indexed messageId);
    event MessageFailed(bytes32 indexed messageId, string reason);
    event HandlerUpdated(uint8 indexed msgType, address handler);
    event AuthorizedSenderUpdated(address indexed module, bool allowed);
    event ChainRegistryUpdated(address newRegistry);
    event ValidatorSetUpdated(address newValidatorSet);
    event EmergencyPauserUpdated(address newPauser);

    modifier onlyAuthorizedSender() {
        require(authorizedSenders[msg.sender], "Caller is not an authorized sender");
        _;
    }

    constructor(address initialOwner, address _chainRegistry, address _validatorSet) Ownable(initialOwner) {
        require(_chainRegistry != address(0) && _validatorSet != address(0), "Zero address not allowed");
        chainRegistry = InayaChainRegistry(_chainRegistry);
        validatorSet = InayaValidatorSet(_validatorSet);
    }

    // ------------------------------------------------------------
    // OUTBOUND
    // ------------------------------------------------------------
    // No nonReentrant here: sendMessage makes no external calls and moves no value -- it's pure
    // bookkeeping (nonce/record/event). It deliberately MUST be callable from inside a handler's
    // onMessage() that InayaMessenger.executeMessage's own nonReentrant-guarded try block is
    // currently running (e.g. InayaTokenBridgeHome's ROUTE path calls sendMessage again to
    // forward on to another spoke, all within one executeMessage call) -- guarding it too would
    // make that same-contract reentrant call revert even though nothing unsafe is happening.
    // The real external-call/value-movement risk is guarded at executeMessage itself and at
    // each bridge/gateway function that actually moves tokens.
    function sendMessage(uint256 destChainId, bytes32 destContract, uint8 msgType, bytes calldata payload)
        external
        whenNotPaused
        onlyAuthorizedSender
        returns (bytes32 messageId)
    {
        require(chainRegistry.isChainActive(destChainId), "Destination chain not active");

        uint256 nonce = ++outboundNonce[msg.sender];
        InayaBridgeTypes.Message memory message = InayaBridgeTypes.Message({
            sourceChainId: block.chainid,
            sourceContract: InayaBridgeTypes.addressToBytes32(msg.sender),
            destChainId: destChainId,
            destContract: destContract,
            nonce: nonce,
            msgType: msgType,
            payload: payload
        });

        messageId = InayaBridgeTypes.hashMessage(message);

        outboundRecords[messageId] = OutboundRecord({
            destChainId: destChainId,
            destContract: destContract,
            msgType: msgType,
            nonce: nonce,
            sender: msg.sender,
            timestamp: block.timestamp,
            payloadHash: keccak256(payload)
        });

        emit MessageSent(messageId, message);
    }

    // ------------------------------------------------------------
    // INBOUND
    // ------------------------------------------------------------

    /// @notice Permissionless. Validity comes from the threshold-signature + trusted-sender
    ///         checks below, not from who calls this. Retryable indefinitely on a Failed
    ///         outcome with the identical (message, signatures) pair -- the signed Message
    ///         remains valid until it is one day successfully executed.
    function executeMessage(InayaBridgeTypes.Message calldata message, bytes[] calldata signatures)
        external
        whenNotPaused
        nonReentrant
    {
        require(message.destChainId == block.chainid, "Wrong destination chain");

        bytes32 messageId = InayaBridgeTypes.hashMessage(message);
        InboundRecord storage record = inboundRecords[messageId];
        require(record.status != InayaBridgeTypes.MessageStatus.Completed, "Already executed");

        require(
            chainRegistry.isTrustedRemote(message.sourceChainId, message.sourceContract),
            "Untrusted sender"
        );

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(messageId);
        (bool ok, ) = validatorSet.verifyThreshold(digest, signatures);
        require(ok, "Insufficient validator signatures");

        address handler = handlers[message.msgType];
        require(handler != address(0), "No handler registered for msgType");

        record.attempts += 1;
        record.lastAttemptAt = block.timestamp;
        record.status = InayaBridgeTypes.MessageStatus.Pending;

        try IInayaMessageHandler(handler).onMessage(message) returns (bool success) {
            if (success) {
                record.status = InayaBridgeTypes.MessageStatus.Completed;
                record.lastFailureReason = "";
                emit MessageExecuted(messageId);
            } else {
                record.status = InayaBridgeTypes.MessageStatus.Failed;
                record.lastFailureReason = "Handler returned false";
                emit MessageFailed(messageId, "Handler returned false");
            }
        } catch Error(string memory reason) {
            record.status = InayaBridgeTypes.MessageStatus.Failed;
            record.lastFailureReason = reason;
            emit MessageFailed(messageId, reason);
        } catch {
            record.status = InayaBridgeTypes.MessageStatus.Failed;
            record.lastFailureReason = "Unknown handler error";
            emit MessageFailed(messageId, "Unknown handler error");
        }
    }

    // ------------------------------------------------------------
    // VIEWS
    // ------------------------------------------------------------
    function getMessageStatus(bytes32 messageId) external view returns (InayaBridgeTypes.MessageStatus) {
        return inboundRecords[messageId].status;
    }

    function getOutboundRecord(bytes32 messageId)
        external
        view
        returns (uint256 destChainId, bytes32 destContract, uint8 msgType, uint256 nonce, address sender, uint256 timestamp, bytes32 payloadHash)
    {
        OutboundRecord storage r = outboundRecords[messageId];
        return (r.destChainId, r.destContract, r.msgType, r.nonce, r.sender, r.timestamp, r.payloadHash);
    }

    function getInboundRecord(bytes32 messageId)
        external
        view
        returns (InayaBridgeTypes.MessageStatus status, uint8 attempts, uint256 lastAttemptAt, string memory lastFailureReason)
    {
        InboundRecord storage r = inboundRecords[messageId];
        return (r.status, r.attempts, r.lastAttemptAt, r.lastFailureReason);
    }

    // ------------------------------------------------------------
    // ADMIN
    // ------------------------------------------------------------
    function setHandler(uint8 msgType, address handler) external onlyOwner {
        handlers[msgType] = handler;
        emit HandlerUpdated(msgType, handler);
    }

    function setAuthorizedSender(address module, bool allowed) external onlyOwner {
        authorizedSenders[module] = allowed;
        emit AuthorizedSenderUpdated(module, allowed);
    }

    function setChainRegistry(address newRegistry) external onlyOwner {
        require(newRegistry != address(0), "Zero address not allowed");
        chainRegistry = InayaChainRegistry(newRegistry);
        emit ChainRegistryUpdated(newRegistry);
    }

    function setValidatorSet(address newValidatorSet) external onlyOwner {
        require(newValidatorSet != address(0), "Zero address not allowed");
        validatorSet = InayaValidatorSet(newValidatorSet);
        emit ValidatorSetUpdated(newValidatorSet);
    }

    function setEmergencyPauser(address pauser) external onlyOwner {
        emergencyPauser = pauser;
        emit EmergencyPauserUpdated(pauser);
    }

    function pauseCrossChain() external {
        require(msg.sender == owner() || msg.sender == emergencyPauser, "Not authorized to pause");
        _pause();
    }

    function unpauseCrossChain() external onlyOwner {
        _unpause();
    }
}
