const hre = require("hardhat");

const MOCK_USDT = '0x96FBA824E3798E59e98fDE8E019a684700F9fF4a';
const VAULT = '0x40FBCc98bE7F8CcC2fF732d7807679592FDC66dD';
const TRADING = '0x2BD4727018E3a70D49B536A0187791e363de56ff';
const ROI = '0xd486208A37Df4014Fcc6d607178274632d83B903';
const COMM = '0xC0b3368B020bcad722F431aDa33601a26755D3cC';
const REDEEM = '0xfa698a22F6E2a7836eeDAA24eEbDe834E65654EC';

async function main() {
    const usdt = await hre.ethers.getContractAt("MockUSDT", MOCK_USDT);
    
    console.log("=== USDT BALANCES ===");
    const vaultBal = await usdt.balanceOf(VAULT);
    const tradingBal = await usdt.balanceOf(TRADING);
    const roiBal = await usdt.balanceOf(ROI);
    const commBal = await usdt.balanceOf(COMM);
    const redeemBal = await usdt.balanceOf(REDEEM);
    
    console.log("Vault:              " + hre.ethers.formatUnits(vaultBal, 6) + " USDT");
    console.log("TradingFunds:       " + hre.ethers.formatUnits(tradingBal, 6) + " USDT");
    console.log("ROIDistributor:     " + hre.ethers.formatUnits(roiBal, 6) + " USDT");
    console.log("CommissionPayout:   " + hre.ethers.formatUnits(commBal, 6) + " USDT");
    console.log("RedemptionManager:  " + hre.ethers.formatUnits(redeemBal, 6) + " USDT");
    
    console.log("\n=== VAULT APPROVALS (allowances for payout contracts) ===");
    const roiAllowance = await usdt.allowance(VAULT, ROI);
    const commAllowance = await usdt.allowance(VAULT, COMM);
    const redeemAllowance = await usdt.allowance(VAULT, REDEEM);
    
    const MAX = hre.ethers.MaxUint256;
    console.log("Vault -> ROI:       " + (roiAllowance === MAX ? "MAX (unlimited)" : hre.ethers.formatUnits(roiAllowance, 6)));
    console.log("Vault -> Commission:" + (commAllowance === MAX ? "MAX (unlimited)" : hre.ethers.formatUnits(commAllowance, 6)));
    console.log("Vault -> Redemption:" + (redeemAllowance === MAX ? "MAX (unlimited)" : hre.ethers.formatUnits(redeemAllowance, 6)));
    
    console.log("\n=== VERIFICATION SUMMARY ===");
    const vaultOk = vaultBal === BigInt(10_000_000) * BigInt(10**6);
    const tradingOk = tradingBal === 0n;
    const roiOk = roiBal === 0n;
    const commOk = commBal === 0n;
    const redeemOk = redeemBal === 0n;
    const approvalOk = roiAllowance === MAX && commAllowance === MAX && redeemAllowance === MAX;
    
    console.log("Vault has 10M USDT:           " + (vaultOk ? "PASS" : "FAIL"));
    console.log("TradingFunds has 0 USDT:      " + (tradingOk ? "PASS" : "FAIL"));
    console.log("ROI has 0 USDT:               " + (roiOk ? "PASS" : "FAIL"));
    console.log("Commission has 0 USDT:        " + (commOk ? "PASS" : "FAIL"));
    console.log("Redemption has 0 USDT:        " + (redeemOk ? "PASS" : "FAIL"));
    console.log("All approvals set to MAX:     " + (approvalOk ? "PASS" : "FAIL"));
    
    if (vaultOk && tradingOk && roiOk && commOk && redeemOk && approvalOk) {
        console.log("\nALL CHECKS PASSED");
    } else {
        console.log("\nSOME CHECKS FAILED");
    }
}

main().catch(e => { console.error(e); process.exit(1); });
