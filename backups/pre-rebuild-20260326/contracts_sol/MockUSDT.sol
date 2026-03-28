// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDT (TESTNET ONLY — Polygon Amoy)
 * @notice Fake USDT for testing. Anyone can mint.
 * @dev 6 decimals like real USDT
 */
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {
        // Mint 10,000,000 USDT to deployer
        _mint(msg.sender, 10_000_000 * 10**6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // Anyone can mint on testnet
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // Convenience: mint in whole dollars
    function mintDollars(address to, uint256 dollars) external {
        _mint(to, dollars * 10**6);
    }
}
