
const hre = require("hardhat");

const S_WALLET = '0x031eA4bA7E1C5729C352e846549E9B5745f3C66E';
const RECIPIENT = '0xE669D94fFeC2341CDBECa855f2DedDd7e1A59Cc0';
const MOCK_USDT = '0x96FBA824E3798E59e98fDE8E019a684700F9fF4a'; // KEEP EXISTING

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log('Deployer:', deployer.address);
    console.log('Balance:', hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), 'POL');
    console.log('MockUSDT (existing):', MOCK_USDT);
    console.log('');

    // Use existing MockUSDT
    const MockUSDT = await hre.ethers.getContractAt("MockUSDT", MOCK_USDT);
    console.log('MockUSDT balance check:', hre.ethers.formatUnits(await MockUSDT.balanceOf(deployer.address), 6), 'USDT');

    // 1. AccessControl
    console.log('\n1/6 Deploying VelturAccessControl...');
    const AC = await hre.ethers.deployContract("VelturAccessControl");
    await AC.waitForDeployment();
    console.log('   VelturAccessControl:', AC.target);

    // 2. Vault
    console.log('2/6 Deploying VelturVault...');
    const Vault = await hre.ethers.deployContract("VelturVault", [MOCK_USDT, AC.target]);
    await Vault.waitForDeployment();
    console.log('   VelturVault:', Vault.target);

    // 3. TradingFunds (NEW)
    console.log('3/6 Deploying TradingFunds...');
    const Trading = await hre.ethers.deployContract("TradingFunds", [MOCK_USDT, AC.target]);
    await Trading.waitForDeployment();
    console.log('   TradingFunds:', Trading.target);

    // 4. ROIDistributor
    console.log('4/6 Deploying ROIDistributor...');
    const ROI = await hre.ethers.deployContract("ROIDistributor", [MOCK_USDT, AC.target]);
    await ROI.waitForDeployment();
    console.log('   ROIDistributor:', ROI.target);

    // 5. CommissionPayout
    console.log('5/6 Deploying CommissionPayout...');
    const Comm = await hre.ethers.deployContract("CommissionPayout", [MOCK_USDT, AC.target]);
    await Comm.waitForDeployment();
    console.log('   CommissionPayout:', Comm.target);

    // 6. RedemptionManager
    console.log('6/6 Deploying RedemptionManager...');
    const Redeem = await hre.ethers.deployContract("RedemptionManager", [MOCK_USDT, Vault.target, AC.target]);
    await Redeem.waitForDeployment();
    console.log('   RedemptionManager:', Redeem.target);

    // ── Post-deploy setup ──
    console.log('\n── Post-deploy setup ──');

    // Set TradingFunds address in Vault
    console.log('Setting TradingFunds address in Vault...');
    await (await Vault.setTradingFundAddress(Trading.target)).wait();
    console.log('   ✓ Vault.tradingFundAddress =', Trading.target);

    // Authorize Vault for hidden flag
    console.log('Authorizing Vault in AccessControl...');
    await (await AC.authorizeContract(Vault.target)).wait();
    console.log('   ✓ Vault authorized');

    // Grant admin role to deployer/backend signer
    console.log('Granting admin to deployer...');
    await (await AC.grantAdmin(deployer.address)).wait();
    console.log('   ✓ Admin granted to', deployer.address);

    // Fund contracts with USDT for payouts
    console.log('\nFunding contracts with USDT...');
    await (await MockUSDT.mintDollars(Vault.target, 5_000_000)).wait();
    console.log('   ✓ Vault: 5M USDT');
    await (await MockUSDT.mintDollars(ROI.target, 2_000_000)).wait();
    console.log('   ✓ ROIDistributor: 2M USDT');
    await (await MockUSDT.mintDollars(Comm.target, 2_000_000)).wait();
    console.log('   ✓ CommissionPayout: 2M USDT');
    await (await MockUSDT.mintDollars(Redeem.target, 1_000_000)).wait();
    console.log('   ✓ RedemptionManager: 1M USDT');

    // Mint USDT to recipient for testing
    console.log('Minting 10M USDT to recipient...');
    await (await MockUSDT.mintDollars(RECIPIENT, 10_000_000)).wait();
    console.log('   ✓ 10M USDT to', RECIPIENT);

    // Save deployment
    const deployment = {
        network: 'polygon-amoy',
        chainId: 80002,
        deployer: deployer.address,
        sWallet: S_WALLET,
        recipient: RECIPIENT,
        contracts: {
            MockUSDT: MOCK_USDT,
            VelturAccessControl: AC.target,
            VelturVault: Vault.target,
            TradingFunds: Trading.target,
            ROIDistributor: ROI.target,
            CommissionPayout: Comm.target,
            RedemptionManager: Redeem.target,
        },
        deployedAt: new Date().toISOString()
    };

    const fs = require('fs');
    fs.writeFileSync('deployment-amoy-v2.json', JSON.stringify(deployment, null, 2));

    console.log('\n══════════════════════════════════════');
    console.log('  DEPLOYMENT COMPLETE — Polygon Amoy V2');
    console.log('══════════════════════════════════════');
    Object.entries(deployment.contracts).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
    console.log('\nSaved to deployment-amoy-v2.json');
}

main().catch(e => { console.error(e); process.exit(1); });
