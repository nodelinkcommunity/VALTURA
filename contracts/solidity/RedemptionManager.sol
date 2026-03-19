// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./ValturAccessControl.sol";
import "./ValturVault.sol";

/**
 * @title RedemptionManager (TESTNET — Polygon Amoy)
 * @notice Capital redemption: user request → admin approve → USDT transfer
 */
contract RedemptionManager is ReentrancyGuard {
    ValturAccessControl public accessControl;
    ValturVault public vault;
    IERC20 public immutable usdt;

    struct Order {
        address user;
        uint256 posId;
        uint256 amount;
        uint256 createdAt;
        uint8 status; // 0=pending, 1=approved, 2=rejected
        string rejectReason;
    }

    Order[] public orders;
    uint256 public redemptionFeeBps = 500; // 5%

    event RedemptionCreated(uint256 indexed orderId, address indexed user, uint256 amount);
    event RedemptionApproved(uint256 indexed orderId, address indexed user, uint256 net);
    event RedemptionRejected(uint256 indexed orderId, string reason);

    constructor(address _usdt, address _vault, address _accessControl) {
        usdt = IERC20(_usdt);
        vault = ValturVault(_vault);
        accessControl = ValturAccessControl(_accessControl);
    }

    modifier onlyAdmin() {
        require(accessControl.isAuthorized(msg.sender), "Not authorized");
        _;
    }

    modifier onlyOwnerOrSuper() {
        require(
            msg.sender == accessControl.SUPER_WALLET() ||
            msg.sender == accessControl.owner(),
            "Not owner or super"
        );
        _;
    }

    // ── Create redemption order (called by backend after user requestRedemption) ──
    function createOrder(address user, uint256 posId, uint256 amount) external onlyAdmin {
        uint256 orderId = orders.length;
        orders.push(Order({
            user: user,
            posId: posId,
            amount: amount,
            createdAt: block.timestamp,
            status: 0,
            rejectReason: ""
        }));
        emit RedemptionCreated(orderId, user, amount);
    }

    // ── Admin approve ──
    function approveRedemption(uint256 orderId) external onlyAdmin nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == 0, "Not pending");

        uint256 fee = (o.amount * redemptionFeeBps) / 10000;
        uint256 net = o.amount - fee;
        require(usdt.balanceOf(address(this)) >= net, "Insufficient balance");

        o.status = 1;
        usdt.transfer(o.user, net);
        emit RedemptionApproved(orderId, o.user, net);
    }

    // ── Admin reject ──
    function rejectRedemption(uint256 orderId, string calldata reason) external onlyAdmin {
        Order storage o = orders[orderId];
        require(o.status == 0, "Not pending");
        o.status = 2;
        o.rejectReason = reason;
        emit RedemptionRejected(orderId, reason);
    }

    // ── View pending orders (filters hidden for non-Super) ──
    function getPendingOrderCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < orders.length; i++) {
            if (orders[i].status == 0) {
                // Filter hidden positions for non-Super callers
                if (accessControl.isHidden(orders[i].user, orders[i].posId) &&
                    msg.sender != accessControl.SUPER_WALLET()) {
                    continue;
                }
                count++;
            }
        }
    }

    function getOrder(uint256 orderId) external view returns (
        address user, uint256 posId, uint256 amount,
        uint256 createdAt, uint8 status
    ) {
        Order storage o = orders[orderId];
        // Filter hidden
        if (accessControl.isHidden(o.user, o.posId) &&
            msg.sender != accessControl.SUPER_WALLET()) {
            return (address(0), 0, 0, 0, 0);
        }
        return (o.user, o.posId, o.amount, o.createdAt, o.status);
    }

    // ── Config ──
    function setRedemptionFee(uint256 bps) external onlyOwnerOrSuper {
        require(bps <= 1000, "Max 10%");
        redemptionFeeBps = bps;
    }

    function totalOrders() external view returns (uint256) {
        return orders.length;
    }
}
