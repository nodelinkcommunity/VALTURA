const hre = require("hardhat");
const S_WALLET = '0x031eA4bA7E1C5729C352e846549E9B5745f3C66E';
const MOCK_USDT = '0x96FBA824E3798E59e98fDE8E019a684700F9fF4a';
const DEFAULTS = {
    feeClaimPct: 2.5,
    feeRedeemPct: 5,
    earningsCapPct: 300,
};

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log('Deployer:', deployer.address);
    
    const MockUSDT = await hre.ethers.getContractAt("MockUSDT", MOCK_USDT);

    // 1. AccessControl
    console.log('1/6 Deploying VelturAccessControl...');
    const AC = await hre.ethers.deployContract("VelturAccessControl");
    await AC.waitForDeployment();
    console.log('   AccessControl:', AC.target);

    // 2. Vault
    console.log('2/6 Deploying VelturVault...');
    const Vault = await hre.ethers.deployContract("VelturVault", [MOCK_USDT, AC.target]);
    await Vault.waitForDeployment();
    console.log('   Vault:', Vault.target);

    // 3. TradingFunds
    console.log('3/6 Deploying TradingFunds...');
    const Trading = await hre.ethers.deployContract("TradingFunds", [MOCK_USDT, AC.target]);
    await Trading.waitForDeployment();
    console.log('   TradingFunds:', Trading.target);

    // 4. ROIDistributor (with vault address)
    console.log('4/6 Deploying ROIDistributor...');
    const ROI = await hre.ethers.deployContract("ROIDistributor", [MOCK_USDT, AC.target, Vault.target]);
    await ROI.waitForDeployment();
    console.log('   ROIDistributor:', ROI.target);

    // 5. CommissionPayout (with vault address)
    console.log('5/6 Deploying CommissionPayout...');
    const Comm = await hre.ethers.deployContract("CommissionPayout", [MOCK_USDT, AC.target, Vault.target]);
    await Comm.waitForDeployment();
    console.log('   CommissionPayout:', Comm.target);

    // 6. RedemptionManager (with vault address)
    console.log('6/6 Deploying RedemptionManager...');
    const Redeem = await hre.ethers.deployContract("RedemptionManager", [MOCK_USDT, Vault.target, AC.target]);
    await Redeem.waitForDeployment();
    console.log('   RedemptionManager:', Redeem.target);

    // -- Post-deploy setup --
    console.log('\n-- Setup --');

    // Authorize Vault
    await (await AC.setAuthorizedContract(Vault.target, true)).wait();
    console.log('Vault authorized in AC');

    // Grant admin to deployer
    await (await AC.grantAdmin(deployer.address)).wait();
    console.log('Admin granted to deployer');

    // Set TradingFunds address in Vault
    await (await Vault.setTradingFundAddress(Trading.target)).wait();
    console.log('TradingFund address set in Vault');

    // CRITICAL: Vault approves ROI, Commission, Redemption to spend its USDT
    const MAX = hre.ethers.MaxUint256;
    await (await Vault.approvePayoutContract(ROI.target, MAX)).wait();
    console.log('Vault approved ROIDistributor');
    await (await Vault.approvePayoutContract(Comm.target, MAX)).wait();
    console.log('Vault approved CommissionPayout');
    await (await Vault.approvePayoutContract(Redeem.target, MAX)).wait();
    console.log('Vault approved RedemptionManager');

    // Sync default on-chain fees / cap with DB defaults
    const claimFeeBps = Math.round(DEFAULTS.feeClaimPct * 100);
    const redeemFeeBps = Math.round(DEFAULTS.feeRedeemPct * 100);
    await (await ROI.setClaimFee(claimFeeBps)).wait();
    console.log('ROI claim fee set:', DEFAULTS.feeClaimPct + '%');
    await (await Comm.setClaimFee(claimFeeBps)).wait();
    console.log('Commission claim fee set:', DEFAULTS.feeClaimPct + '%');
    await (await Redeem.setRedemptionFee(redeemFeeBps)).wait();
    console.log('Redemption fee set:', DEFAULTS.feeRedeemPct + '%');
    await (await Comm.setEarningsCapMultiplier(DEFAULTS.earningsCapPct)).wait();
    console.log('Earnings cap multiplier set:', DEFAULTS.earningsCapPct + '%');

    // Fund ONLY Vault with USDT (single Reward Fund)
    await (await MockUSDT.mintDollars(Vault.target, 10_000_000)).wait();
    console.log('Vault funded: 10M USDT');

    // Mint to owner/deployer for first clean-system account + testing
    await (await MockUSDT.mintDollars(deployer.address, 10_000_000)).wait();
    console.log('Owner funded: 10M USDT');

    // Save deployment
    const deployment = {
        network: 'polygon-amoy',
        chainId: 80002,
        deployer: deployer.address,
        owner: deployer.address,
        sWallet: S_WALLET,
        contracts: {
            MockUSDT: MOCK_USDT,
            VelturAccessControl: AC.target,
            VelturVault: Vault.target,
            TradingFunds: Trading.target,
            ROIDistributor: ROI.target,
            CommissionPayout: Comm.target,
            RedemptionManager: Redeem.target,
        },
        defaults: DEFAULTS,
        architecture: 'ONLY Vault + TradingFunds hold USDT. ROI/Commission/Redemption pay from Vault via transferFrom.',
        deployedAt: new Date().toISOString()
    };

    const fs = require('fs');
    fs.writeFileSync('deployment-amoy-v3.json', JSON.stringify(deployment, null, 2));

    console.log('\n======================================');
    console.log('  DEPLOYMENT V3 -- 2 Fund Architecture');
    console.log('======================================');
    Object.entries(deployment.contracts).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
    console.log('\nVault holds ALL Reward Fund USDT');
    console.log('TradingFunds holds 0 (receives from auto-split)');
    console.log('Owner wallet for first seeded user:', deployer.address);
}

main().catch(e => { console.error(e); process.exit(1); });
