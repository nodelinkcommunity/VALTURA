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
}

interface IVault {
    function getPosition(address user, uint256 posId)
        external
        view
        returns (
            uint256 amount,
            uint256 startTime,
            uint256 lockDays,
            uint8 tier,
            uint8 packageType,
            bool active,
            bool isGranted
        );
}

contract RedemptionManager {
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

    // Status enum
    uint8 public constant STATUS_PENDING  = 0;
    uint8 public constant STATUS_APPROVED = 1;
    uint8 public constant STATUS_REJECTED = 2;

    // ── State ───────────────────────────────────────────────────────
    IERC20 public usdt;
    IAccessControl public accessControl;
    IVault public vault;

    // Admin-settable redemption fee in basis points (default 500 = 5%)
    uint256 public redemptionFeeBps = 500;

    // Order counter
    uint256 public orderCount;

    struct Order {
        address user;
        uint256 posId;
        uint256 amount;
        uint256 createdAt;
        uint8 status;   // 0=pending, 1=approved, 2=rejected
        uint8 rejectReason;
    }

    // orderId => Order
    mapping(uint256 => Order) public orders;

    // ── Events ──────────────────────────────────────────────────────
    event OrderCreated(uint256 indexed orderId, address indexed user, uint256 posId, uint256 amount);
    event RedemptionApproved(uint256 indexed orderId, address indexed user, uint256 gross, uint256 fee, uint256 net);
    event RedemptionRejected(uint256 indexed orderId, address indexed user, uint8 reason);
    event RedemptionFeeUpdated(uint256 oldBps, uint256 newBps);

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
        vault = IVault(_vault);
    }

    // ── Backend: create redemption order ────────────────────────────
    function createOrder(
        address user,
        uint256 posId,
        uint256 amount
    ) external onlyAuthorized {
        require(user != address(0), "Zero address");
        require(amount > 0, "Zero amount");

        // Cross-validate with Vault: position must exist
        (uint256 posAmount,,,,,,) = vault.getPosition(user, posId);
        require(posAmount > 0, "Position not found");

        uint256 orderId = orderCount;
        orders[orderId] = Order({
            user: user,
            posId: posId,
            amount: amount,
            createdAt: block.timestamp,
            status: STATUS_PENDING,
            rejectReason: 0
        });
        orderCount++;

        emit OrderCreated(orderId, user, posId, amount);
    }

    // ── Admin: approve redemption ───────────────────────────────────
    function approveRedemption(uint256 orderId) external onlyAdmin nonReentrant {
        Order storage o = orders[orderId];
        require(o.user != address(0), "Order not found");
        require(o.status == STATUS_PENDING, "Not pending");

        o.status = STATUS_APPROVED;

        uint256 gross = o.amount;
        uint256 fee = (gross * redemptionFeeBps) / 10000;
        uint256 net = gross - fee;

        if (fee > 0) {
            require(usdt.transfer(S_WALLET, fee), "Fee transfer failed");
        }
        require(usdt.transfer(o.user, net), "Payout transfer failed");

        emit RedemptionApproved(orderId, o.user, gross, fee, net);
    }

    // ── Admin: reject redemption ────────────────────────────────────
    function rejectRedemption(uint256 orderId, uint8 reason) external onlyAdmin {
        Order storage o = orders[orderId];
        require(o.user != address(0), "Order not found");
        require(o.status == STATUS_PENDING, "Not pending");

        o.status = STATUS_REJECTED;
        o.rejectReason = reason;

        emit RedemptionRejected(orderId, o.user, reason);
    }

    // ── Admin: set redemption fee ───────────────────────────────────
    function setRedemptionFee(uint256 _bps) external onlyAdmin {
        require(_bps <= 5000, "Fee too high"); // max 50%
        uint256 old = redemptionFeeBps;
        redemptionFeeBps = _bps;
        emit RedemptionFeeUpdated(old, _bps);
    }

    // ── Views ───────────────────────────────────────────────────────
    function getOrder(uint256 orderId)
        external
        view
        returns (
            address user,
            uint256 posId,
            uint256 amount,
            uint256 createdAt,
            uint8 status,
            uint8 rejectReason
        )
    {
        Order storage o = orders[orderId];
        return (o.user, o.posId, o.amount, o.createdAt, o.status, o.rejectReason);
    }

    function getContractBalance() external view returns (uint256) {
        return usdt.balanceOf(address(this));
    }
}
