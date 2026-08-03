// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InayaCorporateEscrow
/// @notice Holds the node-operator COGS share (39% per your Financial Matrix) of a Corporate
///         Reserve annual invoice and drips it out over 12 monthly releases instead of paying
///         it out in full on day one.
///
/// @dev CHANGE FROM PREVIOUS VERSION: `monthSeconds` is now an owner-adjustable state variable
///      instead of a hardcoded constant, specifically so you can test the release cycle on
///      testnet tonight (e.g. setMonthSeconds(120) for a 2-minute cycle) without waiting 30 real
///      days. Set it back to 30 days before treating any deployment as production.
contract InayaCorporateEscrow is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdtToken;

    uint256 public constant MONTHS = 12;
    uint256 public monthSeconds = 30 days; // owner-adjustable for testing — see NOTE above

    struct EscrowSchedule {
        address corporate;
        address node;
        uint256 totalAmount;
        uint256 monthlyAmount;
        uint256 monthsReleased;
        uint256 startTimestamp;
        uint256 lastReleaseTimestamp;
        bool active;
    }

    mapping(uint256 => EscrowSchedule) public schedules;
    uint256 public nextScheduleId;

    event EscrowCreated(uint256 indexed scheduleId, address indexed corporate, address indexed node, uint256 totalAmount, uint256 monthlyAmount);
    event MonthlyReleased(uint256 indexed scheduleId, address indexed node, uint256 amount, uint256 monthNumber);
    event EscrowClosed(uint256 indexed scheduleId);
    event MonthSecondsUpdated(uint256 newValue);

    constructor(address _usdtToken) Ownable(msg.sender) {
        usdtToken = IERC20(_usdtToken);
    }

    /// @notice TESTNET/QA ONLY — shrink the release interval so you can verify the full cycle
    ///         in minutes instead of a year. Set back to 30 days (2592000) before production use.
    function setMonthSeconds(uint256 _seconds) external onlyOwner {
        require(_seconds > 0, "Must be positive");
        monthSeconds = _seconds;
        emit MonthSecondsUpdated(_seconds);
    }

    function createEscrow(address _corporate, address _node, uint256 _totalAmount) external returns (uint256 scheduleId) {
        require(_totalAmount > 0, "Zero amount");
        require(_node != address(0), "Invalid node");
        require(_corporate != address(0), "Invalid corporate");

        usdtToken.safeTransferFrom(msg.sender, address(this), _totalAmount);

        scheduleId = nextScheduleId++;
        schedules[scheduleId] = EscrowSchedule({
            corporate: _corporate,
            node: _node,
            totalAmount: _totalAmount,
            monthlyAmount: _totalAmount / MONTHS,
            monthsReleased: 0,
            startTimestamp: block.timestamp,
            lastReleaseTimestamp: block.timestamp,
            active: true
        });

        emit EscrowCreated(scheduleId, _corporate, _node, _totalAmount, _totalAmount / MONTHS);
    }

    function releaseMonthlyPayout(uint256 _scheduleId) external {
        EscrowSchedule storage s = schedules[_scheduleId];
        require(s.active, "Inactive or unknown schedule");
        require(s.monthsReleased < MONTHS, "Fully released");
        require(block.timestamp >= s.lastReleaseTimestamp + monthSeconds, "Too early for next release");

        s.monthsReleased += 1;
        s.lastReleaseTimestamp = block.timestamp;

        uint256 payout = s.monthlyAmount;
        if (s.monthsReleased == MONTHS) {
            payout = s.totalAmount - (s.monthlyAmount * (MONTHS - 1));
            s.active = false;
            emit EscrowClosed(_scheduleId);
        }

        usdtToken.safeTransfer(s.node, payout);
        emit MonthlyReleased(_scheduleId, s.node, payout, s.monthsReleased);
    }

    function reassignNode(uint256 _scheduleId, address _newNode) external onlyOwner {
        require(_newNode != address(0), "Invalid node");
        EscrowSchedule storage s = schedules[_scheduleId];
        require(s.active, "Inactive or unknown schedule");
        s.node = _newNode;
    }

    function getSchedule(uint256 _scheduleId) external view returns (EscrowSchedule memory) {
        return schedules[_scheduleId];
    }

    function remainingMonths(uint256 _scheduleId) external view returns (uint256) {
        return MONTHS - schedules[_scheduleId].monthsReleased;
    }

    function nextReleaseAt(uint256 _scheduleId) external view returns (uint256) {
        return schedules[_scheduleId].lastReleaseTimestamp + monthSeconds;
    }

    function isReleaseDue(uint256 _scheduleId) external view returns (bool) {
        EscrowSchedule memory s = schedules[_scheduleId];
        return s.active && block.timestamp >= s.lastReleaseTimestamp + monthSeconds;
    }
}
