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

contract ROIDistributor {
    // ── Reentrancy guard ────────────────────────────────────────────
    bool private _locked;
    modifier nonReentrant() {
        require(!_locked, "ReentrancyGuard");
        _locked = true;
        _;
        _locked = false;
    }

    // ── State ───────────────────────────────────────────────────────
    IERC20 public usdt;
    IAccessControl public accessControl;

    // Admin-settable claim fee in basis points (default 0 = 0%)
    uint256 public claimFeeBps = 0;

    // Fee receiver (S_WALLET constant)
    address public constant S_WALLET = 0x031eA4bA7E1C5729C352e846549E9B5745f3C66E;

    // Epoch tracking to prevent double-distribution
    mapping(uint256 => bool) public epochProcessed;

    // Pending ROI per user
    mapping(address => uint256) public pendingROI;

    // Total distributed and claimed
    uint256 public totalDistributed;
    uint256 public totalClaimed;

    // ── Events ──────────────────────────────────────────────────────
    event ROIDistributed(uint256 indexed epoch, uint256 totalAmount, uint256 userCount);
    event ROIClaimed(address indexed user, uint256 gross, uint256 fee, uint256 net);
    event ClaimFeeUpdated(uint256 oldBps, uint256 newBps);

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
    constructor(address _usdt, address _accessControl) {
        usdt = IERC20(_usdt);
        accessControl = IAccessControl(_accessControl);
    }

    // ── Backend: distribute ROI ─────────────────────────────────────
    function distributeROI(
        address[] calldata users,
        uint256[] calldata amounts,
        uint256 epoch
    ) external onlyAuthorized {
        require(users.length == amounts.length, "Length mismatch");
        require(users.length > 0, "Empty arrays");
        require(!epochProcessed[epoch], "Epoch already processed");

        epochProcessed[epoch] = true;
        uint256 total = 0;

        for (uint256 i = 0; i < users.length; i++) {
            if (users[i] != address(0) && amounts[i] > 0) {
                pendingROI[users[i]] += amounts[i];
                total += amounts[i];
            }
        }

        totalDistributed += total;
        emit ROIDistributed(epoch, total, users.length);
    }

    // ── User: claim ROI ─────────────────────────────────────────────
    function claimROI() external nonReentrant {
        require(!accessControl.isClaimLocked(msg.sender), "Claims locked");
        uint256 gross = pendingROI[msg.sender];
        require(gross > 0, "Nothing to claim");

        pendingROI[msg.sender] = 0;

        uint256 fee = (gross * claimFeeBps) / 10000;
        uint256 net = gross - fee;

        if (fee > 0) {
            require(usdt.transfer(S_WALLET, fee), "Fee transfer failed");
        }
        require(usdt.transfer(msg.sender, net), "Claim transfer failed");

        totalClaimed += gross;
        emit ROIClaimed(msg.sender, gross, fee, net);
    }

    // ── Admin: set claim fee ────────────────────────────────────────
    function setClaimFee(uint256 _bps) external onlyAdmin {
        require(_bps <= 5000, "Fee too high"); // max 50%
        uint256 old = claimFeeBps;
        claimFeeBps = _bps;
        emit ClaimFeeUpdated(old, _bps);
    }

    // ── Views ───────────────────────────────────────────────────────
    function getPendingROI(address user) external view returns (uint256) {
        return pendingROI[user];
    }

    function getContractBalance() external view returns (uint256) {
        return usdt.balanceOf(address(this));
    }
}
