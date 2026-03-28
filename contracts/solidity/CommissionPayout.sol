// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAccessControl {
    function isAdmin(address account) external view returns (bool);
    function isAuthorized(address account) external view returns (bool);
    function isClaimLocked(address user) external view returns (bool);
}

contract CommissionPayout {
    // ── Reentrancy guard ────────────────────────────────────────────
    bool private _locked;
    modifier nonReentrant() {
        require(!_locked, "ReentrancyGuard");
        _locked = true;
        _;
        _locked = false;
    }

    // ── Constants ───────────────────────────────────────────────────
    address public constant S_WALLET = 0x031eA4bA7E1C5729C352e846549E9B5745f3C66E;
    uint8 public constant NUM_INCOME_TYPES = 5;
    // Types: 1=Daily Profit, 2=Binary Bonus, 3=Referral Commission,
    //        4=Binary Commission, 5=Momentum Rewards

    // ── State ───────────────────────────────────────────────────────
    IERC20 public usdt;
    IAccessControl public accessControl;
    address public vault;

    // Admin-settable claim fee in basis points (default 0 = 0%)
    uint256 public claimFeeBps = 0;

    // Earnings cap multiplier in % (default 300 = 3x)
    uint256 public earningsCapMultiplier = 300;

    // Epoch tracking
    mapping(uint256 => bool) public epochProcessed;

    // Unclaimed earnings: user => type (1-5) => amount
    mapping(address => mapping(uint8 => uint256)) public unclaimed;

    // VIP investment tracking (set by backend when user buys/redeems Exclusive)
    mapping(address => uint256) public vipInvestment;

    // Total earned lifetime: user => total
    mapping(address => uint256) public totalEarned;

    // Total distributed and claimed
    uint256 public totalDistributed;
    uint256 public totalClaimed;

    // ── Events ──────────────────────────────────────────────────────
    event CommissionsDistributed(uint256 indexed epoch, uint256 totalAmount, uint256 entryCount);
    event EarningsClaimed(address indexed user, uint256 gross, uint256 fee, uint256 net);
    event ClaimFeeUpdated(uint256 oldBps, uint256 newBps);
    event EarningsCapMultiplierUpdated(uint256 oldMul, uint256 newMul);
    event VIPInvestmentSet(address indexed user, uint256 amount);
    event EarningsCapped(address indexed user, uint256 requested, uint256 credited);

    // ── Modifiers ───────────────────────────────────────────────────
    modifier onlyAdmin() {
        require(accessControl.isAdmin(msg.sender), "Not admin");
        _;
    }

    modifier onlyAuthorized() {
        require(accessControl.isAuthorized(msg.sender), "Not authorized");
        _;
    }

    // ── Constructor ─────────────────────────────────────────────────
    constructor(address _usdt, address _accessControl, address _vault) {
        usdt = IERC20(_usdt);
        accessControl = IAccessControl(_accessControl);
        vault = _vault;
    }

    // -- Admin: set vault address
    function setVault(address _vault) external onlyAdmin {
        require(_vault != address(0), "Zero address");
        vault = _vault;
    }

    // ── Backend: distribute commissions ─────────────────────────────
    function distributeCommissions(
        address[] calldata users,
        uint8[] calldata types,
        uint256[] calldata amounts,
        uint256 epoch
    ) external onlyAuthorized {
        require(users.length == types.length && types.length == amounts.length, "Length mismatch");
        require(users.length > 0, "Empty arrays");
        require(!epochProcessed[epoch], "Epoch already processed");

        epochProcessed[epoch] = true;
        uint256 total = 0;

        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            uint8 incomeType = types[i];
            uint256 amount = amounts[i];

            require(incomeType >= 1 && incomeType <= NUM_INCOME_TYPES, "Invalid type");
            if (user == address(0) || amount == 0) continue;

            // Enforce earnings cap
            uint256 capLimit = _getCapLimit(user);
            uint256 credited = amount;

            if (capLimit > 0) {
                uint256 earned = totalEarned[user];
                if (earned >= capLimit) {
                    credited = 0;
                } else {
                    uint256 remaining = capLimit - earned;
                    if (amount > remaining) {
                        credited = remaining;
                    }
                }
            }

            if (credited > 0) {
                unclaimed[user][incomeType] += credited;
                totalEarned[user] += credited;
                total += credited;

                if (credited < amount) {
                    emit EarningsCapped(user, amount, credited);
                }
            } else if (amount > 0) {
                emit EarningsCapped(user, amount, 0);
            }
        }

        totalDistributed += total;
        emit CommissionsDistributed(epoch, total, users.length);
    }

    // ── User: claim all earnings ────────────────────────────────────
    function claimAllEarnings() external nonReentrant {
        require(!accessControl.isClaimLocked(msg.sender), "Claims locked");

        uint256 gross = 0;
        for (uint8 t = 1; t <= NUM_INCOME_TYPES; t++) {
            gross += unclaimed[msg.sender][t];
            unclaimed[msg.sender][t] = 0;
        }
        require(gross > 0, "Nothing to claim");

        uint256 fee = (gross * claimFeeBps) / 10000;
        uint256 net = gross - fee;

        if (fee > 0) {
            require(usdt.transferFrom(vault, S_WALLET, fee), "Fee transfer failed");
        }
        require(usdt.transferFrom(vault, msg.sender, net), "Claim transfer failed");

        totalClaimed += gross;
        emit EarningsClaimed(msg.sender, gross, fee, net);
    }

    // ── Admin: set claim fee ────────────────────────────────────────
    function setClaimFee(uint256 _bps) external onlyAdmin {
        require(_bps <= 5000, "Fee too high"); // max 50%
        uint256 old = claimFeeBps;
        claimFeeBps = _bps;
        emit ClaimFeeUpdated(old, _bps);
    }

    // ── Admin: set earnings cap multiplier ──────────────────────────
    function setEarningsCapMultiplier(uint256 _mul) external onlyAdmin {
        require(_mul >= 100, "Min 100%"); // at least 1x
        uint256 old = earningsCapMultiplier;
        earningsCapMultiplier = _mul;
        emit EarningsCapMultiplierUpdated(old, _mul);
    }

    // ── Backend: set VIP investment ─────────────────────────────────
    function setVIPInvestment(address user, uint256 amount) external onlyAuthorized {
        require(user != address(0), "Zero address");
        vipInvestment[user] = amount;
        emit VIPInvestmentSet(user, amount);
    }

    // ── Internal: calculate cap limit ───────────────────────────────
    function _getCapLimit(address user) internal view returns (uint256) {
        uint256 investment = vipInvestment[user];
        if (investment == 0) return 0; // no cap if no VIP investment set
        return (investment * earningsCapMultiplier) / 100;
    }

    // ── Views ───────────────────────────────────────────────────────
    function getUnclaimedEarnings(address user)
        external
        view
        returns (uint256[5] memory amounts, uint256 total)
    {
        for (uint8 t = 1; t <= NUM_INCOME_TYPES; t++) {
            amounts[t - 1] = unclaimed[user][t];
            total += unclaimed[user][t];
        }
    }

    function getEarningsCapStatus(address user)
        external
        view
        returns (
            uint256 investment,
            uint256 capLimit,
            uint256 earned,
            uint256 remaining
        )
    {
        investment = vipInvestment[user];
        capLimit = _getCapLimit(user);
        earned = totalEarned[user];
        remaining = capLimit > earned ? capLimit - earned : 0;
    }

    function getContractBalance() external view returns (uint256) {
        return usdt.balanceOf(address(this));
    }
}
