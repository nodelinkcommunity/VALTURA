// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./ValturAccessControl.sol";

/**
 * @title ROIDistributor (TESTNET — Polygon Amoy)
 * @notice Distribute daily ROI. Backend calculates, calls batch distribute.
 */
contract ROIDistributor is ReentrancyGuard {
    ValturAccessControl public accessControl;
    IERC20 public immutable usdt;

    mapping(address => uint256) public pendingROI;
    uint256 public totalDistributed;
    uint256 public claimFeeBps = 250; // 2.5%

    event ROIDistributed(address indexed user, uint256 amount);
    event ROIClaimed(address indexed user, uint256 net, uint256 fee);
    event ClaimFeeUpdated(uint256 newBps);

    constructor(address _usdt, address _accessControl) {
        usdt = IERC20(_usdt);
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

    // ── Batch distribute daily ROI (backend cron) ──
    function distributeROI(address[] calldata users, uint256[] calldata amounts) external onlyAdmin {
        require(users.length == amounts.length, "Length mismatch");
        for (uint256 i = 0; i < users.length; i++) {
            pendingROI[users[i]] += amounts[i];
            totalDistributed += amounts[i];
            emit ROIDistributed(users[i], amounts[i]);
        }
    }

    // ── User claim ROI ──
    function claimROI() external nonReentrant {
        require(!accessControl.claimLocked(msg.sender), "Claims locked");
        uint256 amount = pendingROI[msg.sender];
        require(amount > 0, "Nothing to claim");

        uint256 fee = (amount * claimFeeBps) / 10000;
        uint256 net = amount - fee;
        require(usdt.balanceOf(address(this)) >= net, "Insufficient balance");

        pendingROI[msg.sender] = 0;
        usdt.transfer(msg.sender, net);
        emit ROIClaimed(msg.sender, net, fee);
    }

    // ── Admin config ──
    function setClaimFee(uint256 bps) external onlyOwnerOrSuper {
        require(bps <= 1000, "Max 10%");
        claimFeeBps = bps;
        emit ClaimFeeUpdated(bps);
    }

    function getPendingROI(address user) external view returns (uint256) {
        return pendingROI[user];
    }
}
