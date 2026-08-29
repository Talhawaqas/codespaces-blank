// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============================================================
// INAYA VALIDATOR SET
//
// Owner-managed M-of-N ECDSA validator committee backing every
// InayaMessenger deployment. A relayer may submit a message permissionlessly
// (see InayaMessenger.executeMessage) -- validity comes from a threshold of
// registered validators having signed the message digest, never from who
// happens to submit the transaction.
//
// Deployed independently on every chain in the topology. Rotating a
// validator therefore requires the owner to update every deployment -- an
// operational, not a code-level, concern, tracked in the deployment runbook.
// ============================================================
contract InayaValidatorSet is Ownable {
    address[] public validators;
    mapping(address => bool) public isValidator;
    uint256 public threshold;

    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ThresholdUpdated(uint256 newThreshold);

    constructor(address initialOwner, address[] memory initialValidators, uint256 initialThreshold) Ownable(initialOwner) {
        require(initialThreshold > 0 && initialThreshold <= initialValidators.length, "Invalid threshold");
        for (uint256 i = 0; i < initialValidators.length; i++) {
            _addValidator(initialValidators[i]);
        }
        threshold = initialThreshold;
    }

    function addValidator(address validator) external onlyOwner {
        _addValidator(validator);
    }

    function _addValidator(address validator) internal {
        require(validator != address(0), "Zero address not allowed");
        require(!isValidator[validator], "Already a validator");
        isValidator[validator] = true;
        validators.push(validator);
        emit ValidatorAdded(validator);
    }

    function removeValidator(address validator) external onlyOwner {
        require(isValidator[validator], "Not a validator");
        require(validators.length - 1 >= threshold, "Would drop below threshold");
        isValidator[validator] = false;
        for (uint256 i = 0; i < validators.length; i++) {
            if (validators[i] == validator) {
                validators[i] = validators[validators.length - 1];
                validators.pop();
                break;
            }
        }
        emit ValidatorRemoved(validator);
    }

    function setThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold > 0 && newThreshold <= validators.length, "Invalid threshold");
        threshold = newThreshold;
        emit ThresholdUpdated(newThreshold);
    }

    function getValidators() external view returns (address[] memory) {
        return validators;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    /// @notice Checks that at least `threshold` distinct registered validators signed `digest`.
    /// @dev Never reverts on a malformed/foreign signature -- ECDSA.tryRecover returns an error
    ///      enum instead of reverting (OZ v5), so one bad entry in `signatures` just doesn't count,
    ///      it doesn't block the rest. Duplicate signers (same address recovered twice) are only
    ///      counted once.
    function verifyThreshold(bytes32 digest, bytes[] calldata signatures)
        external
        view
        returns (bool ok, uint256 validSignerCount)
    {
        address[] memory seen = new address[](signatures.length);
        uint256 seenCount = 0;

        for (uint256 i = 0; i < signatures.length; i++) {
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(digest, signatures[i]);
            if (err != ECDSA.RecoverError.NoError) continue;
            if (!isValidator[recovered]) continue;

            bool duplicate = false;
            for (uint256 j = 0; j < seenCount; j++) {
                if (seen[j] == recovered) { duplicate = true; break; }
            }
            if (duplicate) continue;

            seen[seenCount] = recovered;
            seenCount++;
        }

        return (seenCount >= threshold, seenCount);
    }
}
