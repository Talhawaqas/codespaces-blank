// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./bridge/IInayaStakingGatewayHome.sol";

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
contract InayaStaking is ReentrancyGuard, Ownable, Pausable {
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

    // 0.001 INAYA -- comfortably above $INAYA's real 0.0001 flat transfer fee. See
    // withdrawTo/claimRewardTo's comments for what this covers.
    uint256 private constant CROSS_CHAIN_FEE_MARGIN = 1e15;

    // ---------------- Cross-chain state ----------------
    // The one trusted address allowed to call stakeFor() -- normally InayaStakingGatewayHome.
    address public crossChainGateway;
    address public emergencyPauser;

    // Lifetime INAYA ever staked via a given origin chain, per user. Increment-only (never
    // decremented on withdrawal) -- a stake that entered via chain A and later withdraws
    // toward chain B has no single correct "origin" to decrement once merged into one fungible
    // balance, so this is documented as an analytics/breakdown field for "where did your
    // position come from," not a live per-chain balance. Reward math never reads this.
    mapping(address => mapping(uint256 => uint256)) public userStakedByChain;

    // ---------------- Events ----------------
    event Staked(address indexed user, uint256 amount, uint256 lockPeriodDays);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardRateUpdated(uint256 newRate, uint256 periodFinish);
    event RewardPoolFunded(uint256 amount, uint256 newPoolBalance);
    event EnterpriseTierThresholdUpdated(uint256 newThreshold);
    event CrossChainGatewayUpdated(address indexed newGateway);
    event StakedCrossChain(address indexed user, uint256 amount, uint256 lockPeriodDays, uint256 indexed originChainId);
    event WithdrawnCrossChain(address indexed user, uint256 amount, uint256 indexed destChainId, bytes32 destRecipient, bytes32 messageId);
    event RewardPaidCrossChain(address indexed user, uint256 reward, uint256 indexed destChainId, bytes32 destRecipient, bytes32 messageId);
    event EmergencyPauserUpdated(address newPauser);

    modifier onlyGateway() {
        require(msg.sender == crossChainGateway, "Caller is not the cross-chain gateway");
        _;
    }

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

    /// @dev Shared bookkeeping for stake()/stakeFor() -- no token movement, no event, so both
    ///      callers stay in charge of exactly where the tokens come from and what they emit.
    function _stake(address user, uint256 amount, uint256 lockPeriodDays) internal {
        require(amount > 0, "Cannot stake 0");
        require(
            lockPeriodDays == 0 || lockPeriodDays == 30 || lockPeriodDays == 90,
            "Invalid lock period: use 0, 30, or 90"
        );

        uint256 requestedMultiplier = lockPeriodDays == 90
            ? TIER90_MULTIPLIER_BPS
            : (lockPeriodDays == 30 ? TIER30_MULTIPLIER_BPS : FLEXIBLE_MULTIPLIER_BPS);

        if (userStakedBalance[user] == 0) {
            // First stake in this "session" — lock in the tier.
            lockMultiplierBps[user] = requestedMultiplier;
        } else {
            // Topping up an existing stake: keep accounting simple and honest
            // by requiring the same tier as the original stake. To switch
            // tiers, withdraw fully first (once unlocked), then re-stake.
            require(
                requestedMultiplier == lockMultiplierBps[user],
                "Must match your existing lock tier to top up; withdraw fully to switch tiers"
            );
        }

        if (lockPeriodDays > 0) {
            uint256 newExpiry = block.timestamp + (lockPeriodDays * 1 days);
            if (newExpiry > lockExpiry[user]) {
                lockExpiry[user] = newExpiry;
            }
        }

        totalStaked += amount;
        userStakedBalance[user] += amount;
    }

    /// @param amount Amount of $INAYA to stake (18 decimals).
    /// @param lockPeriodDays Must be 0 (flexible), 30, or 90.
    function stake(uint256 amount, uint256 lockPeriodDays) external nonReentrant updateReward(msg.sender) {
        _stake(msg.sender, amount, lockPeriodDays);
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, lockPeriodDays);
    }

    /// @notice Credits a stake requested from another chain. Only callable by the trusted
    ///         cross-chain gateway, which must already hold `amount` of real $INAYA (unlocked
    ///         from the origin chain's lock) and have it ready to transfer in here.
    /// @param originChainId The chain the user actually requested this stake from (per
    ///        ChainIds.sol / the Solana sentinel range) -- recorded for reporting only, see
    ///        userStakedByChain's doc comment.
    function stakeFor(address user, uint256 amount, uint256 lockPeriodDays, uint256 originChainId)
        external
        onlyGateway
        nonReentrant
        whenNotPaused
        updateReward(user)
    {
        _stake(user, amount, lockPeriodDays);
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        userStakedByChain[user][originChainId] += amount;
        emit Staked(user, amount, lockPeriodDays);
        emit StakedCrossChain(user, amount, lockPeriodDays, originChainId);
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
    // Cross-chain withdraw / claim
    // Routed through crossChainGateway -> InayaTokenBridgeHome instead of a plain local
    // transfer. Scoped Pausable: these three cross-chain entry points (stakeFor above,
    // withdrawTo, claimRewardTo below) can be paused independently of stake/withdraw/
    // claimReward/exit, which never carry whenNotPaused -- pausing cross-chain never blocks
    // local same-chain staking.
    // ============================================================

    /// @notice Withdraws `amount` from the caller's position and has it minted/unlocked to
    ///         `destRecipient` on `destChainId` instead of transferred locally. Use withdraw()
    ///         for a same-chain payout.
    function withdrawTo(uint256 amount, uint256 destChainId, bytes32 destRecipient)
        external
        nonReentrant
        whenNotPaused
        updateReward(msg.sender)
        returns (bytes32 messageId)
    {
        require(destChainId != block.chainid, "Use withdraw() for the home chain");
        require(amount > 0, "Cannot withdraw 0");
        require(amount <= userStakedBalance[msg.sender], "Insufficient staked balance");
        require(block.timestamp >= lockExpiry[msg.sender], "Tokens Locked");

        totalStaked -= amount;
        userStakedBalance[msg.sender] -= amount;

        if (userStakedBalance[msg.sender] == 0) {
            lockMultiplierBps[msg.sender] = 0;
            lockExpiry[msg.sender] = 0;
        }

        // +CROSS_CHAIN_FEE_MARGIN: the bridge's receiveAndLock pulls `amount` via transferFrom,
        // which (like every $INAYA transfer) additionally deducts the token's own flat fee from
        // this contract's balance -- the approval (and this contract's real balance) must cover
        // that too. KNOWN LIMITATION: that fee is paid out of this contract's general balance
        // without a matching decrement anywhere in totalStaked/rewardPoolBalance -- a slow,
        // bounded leak (a fraction of a cent per cross-chain withdrawal) absorbed by the reward
        // pool's funded slack, same operational assumption as InayaTokenBridgeHome's fee buffer.
        address bridgeAddr = IInayaStakingGatewayHome(crossChainGateway).bridge();
        stakingToken.forceApprove(bridgeAddr, amount + CROSS_CHAIN_FEE_MARGIN);
        messageId = IInayaStakingGatewayHome(crossChainGateway).forwardWithdrawal(msg.sender, amount, destChainId, destRecipient);

        emit WithdrawnCrossChain(msg.sender, amount, destChainId, destRecipient, messageId);
    }

    /// @notice Claims the caller's pending reward and has it minted/unlocked to `destRecipient`
    ///         on `destChainId` instead of transferred locally. Use claimReward() for a
    ///         same-chain payout. Same zero-then-pay-out ordering as claimReward() -- the
    ///         reward is zeroed before the cross-chain call, so a retried/failed message can
    ///         never double-pay.
    function claimRewardTo(uint256 destChainId, bytes32 destRecipient)
        external
        nonReentrant
        whenNotPaused
        updateReward(msg.sender)
        returns (bytes32 messageId)
    {
        require(destChainId != block.chainid, "Use claimReward() for the home chain");
        uint256 reward = rewards[msg.sender];
        require(reward > 0, "No rewards to claim");
        require(reward <= rewardPoolBalance, "Reward pool underfunded - ask admin to fundRewardPool()");

        rewards[msg.sender] = 0;
        rewardPoolBalance -= reward;

        address bridgeAddr = IInayaStakingGatewayHome(crossChainGateway).bridge();
        rewardToken.forceApprove(bridgeAddr, reward + CROSS_CHAIN_FEE_MARGIN);
        messageId = IInayaStakingGatewayHome(crossChainGateway).forwardClaim(msg.sender, reward, destChainId, destRecipient);

        emit RewardPaidCrossChain(msg.sender, reward, destChainId, destRecipient, messageId);
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

    /// @notice The trusted address allowed to call stakeFor() -- normally InayaStakingGatewayHome.
    ///         Deployed with this left at its zero default and corrected once the gateway
    ///         exists, same placeholder-then-setter pattern as InayaThreatRegistry/InayaThreatReporter.
    function setCrossChainGateway(address _gateway) external onlyOwner {
        crossChainGateway = _gateway;
        emit CrossChainGatewayUpdated(_gateway);
    }

    function setEmergencyPauser(address pauser) external onlyOwner {
        emergencyPauser = pauser;
        emit EmergencyPauserUpdated(pauser);
    }

    /// @notice Pauses ONLY stakeFor/withdrawTo/claimRewardTo -- stake/withdraw/claimReward/exit
    ///         are never gated by this and keep working while cross-chain is paused.
    function pauseCrossChain() external {
        require(msg.sender == owner() || msg.sender == emergencyPauser, "Not authorized to pause");
        _pause();
    }

    function unpauseCrossChain() external onlyOwner {
        _unpause();
    }

    /// @notice Rescue any ERC-20 accidentally sent to this contract EXCEPT the
    /// staking/reward token — never allows pulling user principal or the reward pool.
    function recoverForeignToken(address tokenAddress, uint256 amount) external onlyOwner {
        require(tokenAddress != address(stakingToken), "Cannot recover the staking/reward token");
        IERC20(tokenAddress).safeTransfer(owner(), amount);
    }
}
