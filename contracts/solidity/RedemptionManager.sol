// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./ValturAccessControl.sol";
import "./ValturVault.sol";

/**
 * @title RedemptionManager (TESTNET — Polygon Amoy)
 * @notice Capital redemption: user request → admin approve → USDT transfer
 */
contract RedemptionManager is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20; // C-1

    ValturAccessControl public immutable accessControl; // L-4: immutable
    ValturVault public immutable vault; // L-4: immutable
    IERC20 public immutable usdt;

    struct Order {
        address user;
        uint256 posId;
        uint256 amount;
        uint256 createdAt;
        uint8 status; // 0=pending, 1=approved, 2=rejected
        uint8 rejectReason; // L-5: 0=none, 1=invalid_position, 2=policy_violation, 3=suspicious_activity, 4=other
    }

    Order[] public orders;
    uint256 public redemptionFeeBps = 500; // 5%

    // M-3: Batch size limit
    uint256 public constant MAX_BATCH = 200;

    event RedemptionCreated(uint256 indexed orderId, address indexed user, uint256 amount);
    event RedemptionApproved(uint256 indexed orderId, address indexed user, uint256 net);
    event RedemptionRejected(uint256 indexed orderId, uint8 reason); // L-5: uint8 reason

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

    // ── L-3: Pausable ──
    function pause() external onlyOwnerOrSuper {
        _pause();
    }

    function unpause() external onlyOwnerOrSuper {
        _unpause();
    }

    // ── Create redemption order (called by backend after user requestRedemption) ──
    function createOrder(address user, uint256 posId, uint256 amount) external onlyAdmin whenNotPaused {
        // H-4: Validate against vault position
        (uint256 posAmount,,,,, bool active,) = vault.getPosition(user, posId);
        require(active == false, "Position still active in vault"); // position should be deactivated by requestRedemption
        require(posAmount == amount, "Amount mismatch with position");

        uint256 orderId = orders.length;
        orders.push(Order({
            user: user,
            posId: posId,
            amount: amount,
            createdAt: block.timestamp,
            status: 0,
            rejectReason: 0 // L-5
        }));
        emit RedemptionCreated(orderId, user, amount);
    }

    // ── Admin approve ──
    function approveRedemption(uint256 orderId) external onlyAdmin nonReentrant whenNotPaused {
        Order storage o = orders[orderId];
        require(o.status == 0, "Not pending");

        uint256 fee = (o.amount * redemptionFeeBps) / 10000;
        uint256 net = o.amount - fee;
        require(usdt.balanceOf(address(this)) >= net, "Insufficient balance");

        o.status = 1;
        usdt.safeTransfer(o.user, net); // C-1
        emit RedemptionApproved(orderId, o.user, net);
    }

    // ── Admin batch approve ──
    function batchApproveRedemptions(uint256[] calldata orderIds) external onlyAdmin nonReentrant whenNotPaused {
        require(orderIds.length <= MAX_BATCH, "Exceeds max batch size"); // M-3
        for (uint256 i = 0; i < orderIds.length; i++) {
            Order storage o = orders[orderIds[i]];
            require(o.status == 0, "Not pending");

            uint256 fee = (o.amount * redemptionFeeBps) / 10000;
            uint256 net = o.amount - fee;
            require(usdt.balanceOf(address(this)) >= net, "Insufficient balance");

            o.status = 1;
            usdt.safeTransfer(o.user, net); // C-1
            emit RedemptionApproved(orderIds[i], o.user, net);
        }
    }

    // ── Admin reject (L-5: uint8 reason code) ──
    function rejectRedemption(uint256 orderId, uint8 reason) external onlyAdmin {
        Order storage o = orders[orderId];
        require(o.status == 0, "Not pending");
        o.status = 2;
        o.rejectReason = reason;
        emit RedemptionRejected(orderId, reason);
    }

    // ── H-1: Withdraw accumulated fees ──
    function withdrawFees(address to, uint256 amount) external onlyOwnerOrSuper {
        require(to != address(0), "Zero address");
        usdt.safeTransfer(to, amount);
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
