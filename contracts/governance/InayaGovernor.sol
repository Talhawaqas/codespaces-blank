// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";

// ============================================================
// INAYA GOVERNOR
//
// SCOPE NOTE: this is Article XI "Phase 2 (Maturity)" of the Inaya
// Governance Charter -- written now so the code exists and is
// reviewable, but it is NOT meant to be deployed yet. The charter's own
// trigger for Phase 2 is "sustained quorum across Phase 1 votes + an
// independent security audit of governance contracts", neither of
// which has happened. Phase 1 (Snapshot-style off-chain signal votes,
// see snapshot-strategy/inaya-stake-weight/) comes first.
//
// Standard, unmodified OpenZeppelin v5 Governor stack -- no custom
// voting/counting/execution logic of our own, on the theory that a
// battle-tested, widely-audited governance core is a better bet than a
// bespoke one for something this security-critical. The one genuinely
// Inaya-specific piece is what token it reads votes from:
// InayaVotingPower, which mirrors real InayaStaking stake+lock-tier
// weight (see that contract's own SCOPE NOTE) rather than raw token
// balance.
//
// Timelock delay is set to 36 hours in the deploy script to match the
// SAME delay InayaNodeRegistry's settlement flow already uses on
// mainnet -- reusing a real, already-reasoned-about number rather than
// inventing a new one (see Article IV of the charter).
// ============================================================
contract InayaGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    constructor(IVotes _token, TimelockController _timelock, uint48 _votingDelay, uint32 _votingPeriod, uint256 _proposalThreshold, uint256 _quorumPercent)
        Governor("InayaGovernor")
        GovernorSettings(_votingDelay, _votingPeriod, _proposalThreshold)
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(_quorumPercent)
        GovernorTimelockControl(_timelock)
    {}

    // ---- The following are all pure "pick the right base" overrides;
    // none of them change OZ's logic, they just resolve the diamond
    // inheritance Solidity requires when >1 base declares the same
    // virtual function. This is the exact shape OpenZeppelin's own
    // Governor wizard generates. ----

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) {
        return super.quorum(timepoint);
    }

    function state(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
