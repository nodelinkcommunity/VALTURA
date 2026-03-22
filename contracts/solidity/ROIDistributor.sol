// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./VelturAccessControl.sol";

/**
 * @title ROIDistributor (TESTNET — Polygon Amoy)
 * @notice Distribute daily ROI. Backend calculates, calls batch distribute.
 */
contract ROIDistributor is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20; // C-1

    VelturAccessControl public immutable accessControl; // L-4: immutable
    IERC20 public immutable usdt;

    mapping(address => uint256) public pendingROI;
    uint256 public totalDistributed;
    uint256 public claimFeeBps = 250; // 2.5%

    // M-2: Epoch guard
    mapping(uint256 => bool) public distributedEpochs;

    // M-3: Batch size limit
    uint256 public constant MAX_BATCH = 200;

    event ROIDistributed(address indexed user, uint256 amount);
    event ROIClaimed(address indexed user, uint256 net, uint256 fee);
    event ClaimFeeUpdated(uint256 newBps);

    constructor(address _usdt, address _accessControl) {
        usdt = IERC20(_usdt);
        accessControl = VelturAccessControl(_accessControl);
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

    // ── Batch distribute daily ROI (backend cron) ──
    function distributeROI(
        address[] calldata users,
        uint256[] calldata amounts,
        uint256 epoch // M-2
    ) external onlyAdmin whenNotPaused {
        require(users.length == amounts.length, "Length mismatch");
        require(users.length <= MAX_BATCH, "Exceeds max batch size"); // M-3
        require(!distributedEpochs[epoch], "Epoch already distributed"); // M-2
        distributedEpochs[epoch] = true;

        for (uint256 i = 0; i < users.length; i++) {
            pendingROI[users[i]] += amounts[i];
            totalDistributed += amounts[i];
            emit ROIDistributed(users[i], amounts[i]);
        }
    }

    // ── User claim ROI ──
    function claimROI() external nonReentrant whenNotPaused {
        require(!accessControl.claimLocked(msg.sender), "Claims locked");
        uint256 amount = pendingROI[msg.sender];
        require(amount > 0, "Nothing to claim");

        uint256 fee = (amount * claimFeeBps) / 10000;
        uint256 net = amount - fee;
        require(usdt.balanceOf(address(this)) >= net, "Insufficient balance");

        pendingROI[msg.sender] = 0;
        usdt.safeTransfer(msg.sender, net); // C-1
        emit ROIClaimed(msg.sender, net, fee);
    }

    // ── H-1: Withdraw accumulated fees ──
    function withdrawFees(address to, uint256 amount) external onlyOwnerOrSuper {
        require(to != address(0), "Zero address");
        usdt.safeTransfer(to, amount);
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
