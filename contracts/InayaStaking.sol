// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// ============================================================
// INAYA STAKING ENGINE
// Synthetix-style linear reward-per-token accounting, extended with
// tiered lockup multipliers (Flexible / 30-day / 90-day) and an
// on-chain "enterprise tier" flag your frontend/node-registry can read.
//
// IMPORTANT DESIGN NOTE: stakingToken and rewardToken are the SAME
// $INAYA token per the SOW. Because of that, this contract tracks
// `rewardPoolBalance` SEPARATELY from the staking principal — claims
// are checked against that tracked balance, never against the
// contract's raw token balanceOf(), so a claim can never accidentally
// drain user principal even though both live in the same token.
// ============================================================
contract InayaStaking is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakingToken; // $INAYA
    IERC20 public immutable rewardToken;  // $INAYA (same token, tracked separately — see note above)

    // ---------------- Pool metrics ----------------
    uint256 public totalStaked;
    uint256 public rewardRate;           // reward tokens per second, scaled 1e18
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public periodFinish;         // rewardRate stops applying after this timestamp
    uint256 public rewardPoolBalance;    // tokens available for payout, funded via fundRewardPool()

    // ---------------- Per-user state ----------------
    mapping(address => uint256) public userStakedBalance;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    mapping(address => uint256) public lockExpiry;      // 0 = no active lock
    mapping(address => uint256) public lockMultiplierBps; // multiplier locked in at first stake, reset on full exit

    // ---------------- Tier configuration ----------------
    uint256 public constant FLEXIBLE_MULTIPLIER_BPS = 10000; // 1.00x
    uint256 public constant TIER30_MULTIPLIER_BPS = 12500;   // 1.25x
    uint256 public constant TIER90_MULTIPLIER_BPS = 15000;   // 1.50x
    uint256 private constant BPS_DENOMINATOR = 10000;

    // Display-only threshold — actual bandwidth/API throughput enforcement
    // lives in your off-chain node registry / API gateway, this just gives
    // it something on-chain to read.
    uint256 public enterpriseTierThreshold = 50_000 * 1e18; // 50,000 INAYA

    // ---------------- Events ----------------
    event Staked(address indexed user, uint256 amount, uint256 lockPeriodDays);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardRateUpdated(uint256 newRate, uint256 periodFinish);
    event RewardPoolFunded(uint256 amount, uint256 newPoolBalance);
    event EnterpriseTierThresholdUpdated(uint256 newThreshold);

    constructor(address _stakingToken, address _rewardToken) Ownable(msg.sender) {
        require(_stakingToken != address(0) && _rewardToken != address(0), "Zero address not allowed");
        stakingToken = IERC20(_stakingToken);
        rewardToken = IERC20(_rewardToken);
        lastUpdateTime = block.timestamp;
    }

    // ============================================================
    // Reward accounting (Synthetix StakingRewards pattern)
    // ============================================================
    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored
            + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18 / totalStaked);
    }

    /// @notice Claimable $INAYA rewards for a user, including their tier multiplier.
    function earned(address account) public view returns (uint256) {
        uint256 baseDelta = userStakedBalance[account]
            * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e18;

        uint256 multiplier = lockMultiplierBps[account] == 0
            ? FLEXIBLE_MULTIPLIER_BPS
            : lockMultiplierBps[account];

        uint256 boostedDelta = baseDelta * multiplier / BPS_DENOMINATOR;
        return rewards[account] + boostedDelta;
    }

    /// @notice Returns a human-readable tier label for frontend display / node-registry checks.
    function getUserTier(address account) external view returns (string memory) {
        uint256 bal = userStakedBalance[account];
        if (bal == 0) return "None";
        if (bal >= enterpriseTierThreshold) return "Enterprise Priority";
        return "Standard";
    }

    // ============================================================
    // User actions
    // ============================================================

    /// @param amount Amount of $INAYA to stake (18 decimals).
    /// @param lockPeriodDays Must be 0 (flexible), 30, or 90.
    function stake(uint256 amount, uint256 lockPeriodDays) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        require(
            lockPeriodDays == 0 || lockPeriodDays == 30 || lockPeriodDays == 90,
            "Invalid lock period: use 0, 30, or 90"
        );

        uint256 requestedMultiplier = lockPeriodDays == 90
            ? TIER90_MULTIPLIER_BPS
            : (lockPeriodDays == 30 ? TIER30_MULTIPLIER_BPS : FLEXIBLE_MULTIPLIER_BPS);

        if (userStakedBalance[msg.sender] == 0) {
            // First stake in this "session" — lock in the tier.
            lockMultiplierBps[msg.sender] = requestedMultiplier;
        } else {
            // Topping up an existing stake: keep accounting simple and honest
            // by requiring the same tier as the original stake. To switch
            // tiers, withdraw fully first (once unlocked), then re-stake.
            require(
                requestedMultiplier == lockMultiplierBps[msg.sender],
                "Must match your existing lock tier to top up; withdraw fully to switch tiers"
            );
        }

        if (lockPeriodDays > 0) {
            uint256 newExpiry = block.timestamp + (lockPeriodDays * 1 days);
            if (newExpiry > lockExpiry[msg.sender]) {
                lockExpiry[msg.sender] = newExpiry;
            }
        }

        totalStaked += amount;
        userStakedBalance[msg.sender] += amount;

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, lockPeriodDays);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        require(amount <= userStakedBalance[msg.sender], "Insufficient staked balance");
        require(block.timestamp >= lockExpiry[msg.sender], "Tokens Locked");

        totalStaked -= amount;
        userStakedBalance[msg.sender] -= amount;

        if (userStakedBalance[msg.sender] == 0) {
            // Full exit — reset tier state so the next stake can pick a fresh lock period.
            lockMultiplierBps[msg.sender] = 0;
            lockExpiry[msg.sender] = 0;
        }

        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claimReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        require(reward > 0, "No rewards to claim");
        require(reward <= rewardPoolBalance, "Reward pool underfunded - ask admin to fundRewardPool()");

        rewards[msg.sender] = 0;
        rewardPoolBalance -= reward;

        rewardToken.safeTransfer(msg.sender, reward);
        emit RewardPaid(msg.sender, reward);
    }

    /// @notice Full exit: withdraws entire stake AND claims any pending reward in one call.
    function exit() external {
        uint256 balance = userStakedBalance[msg.sender];
        if (balance > 0) withdraw(balance);
        if (rewards[msg.sender] > 0) claimReward();
    }

    // ============================================================
    // Admin functions
    // ============================================================

    /// @param _rewardRate Reward tokens per second (18-decimal scaled), e.g. for
    ///   8,000,000 INAYA distributed over 365 days: (8_000_000e18) / (365*86400).
    /// @param _durationDays How many days this rate applies for before it must be renewed.
    function setRewardRate(uint256 _rewardRate, uint256 _durationDays)
        external
        onlyOwner
        updateReward(address(0))
    {
        require(_durationDays > 0, "Duration must be > 0");
        rewardRate = _rewardRate;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + (_durationDays * 1 days);
        emit RewardRateUpdated(_rewardRate, periodFinish);
    }

    /// @notice Deposits $INAYA from the caller into the tracked reward pool.
    /// Caller must have approved this contract for `amount` beforehand.
    function fundRewardPool(uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be > 0");
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        rewardPoolBalance += amount;
        emit RewardPoolFunded(amount, rewardPoolBalance);
    }

    function setEnterpriseTierThreshold(uint256 _threshold) external onlyOwner {
        enterpriseTierThreshold = _threshold;
        emit EnterpriseTierThresholdUpdated(_threshold);
    }

    /// @notice Rescue any ERC-20 accidentally sent to this contract EXCEPT the
    /// staking/reward token — never allows pulling user principal or the reward pool.
    function recoverForeignToken(address tokenAddress, uint256 amount) external onlyOwner {
        require(tokenAddress != address(stakingToken), "Cannot recover the staking/reward token");
        IERC20(tokenAddress).safeTransfer(owner(), amount);
    }
}
