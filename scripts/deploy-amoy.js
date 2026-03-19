/**
 * Deploy all Valtura contracts to Polygon Amoy using Hardhat
 *
 * Run: npx hardhat run scripts/deploy-amoy.js --network amoy
 */
const hre = require("hardhat");

const SUPER_WALLET = '0x031eA4bA7E1C5729C352e846549E9B5745f3C66E';
const RECIPIENT = '0x21D6DA65981c95B1FF0fA8746Ad81A22b8C0d58B';

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log('Deployer:', deployer.address);
    console.log('Balance:', hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), 'POL\n');

    // 1. MockUSDT
    console.log('1/6 Deploying MockUSDT...');
    const MockUSDT = await hre.ethers.deployContract("MockUSDT");
    await MockUSDT.waitForDeployment();
    console.log('   MockUSDT:', MockUSDT.target);

    // 2. AccessControl
    console.log('2/6 Deploying ValturAccessControl...');
    const AC = await hre.ethers.deployContract("ValturAccessControl");
    await AC.waitForDeployment();
    console.log('   AccessControl:', AC.target);

    // 3. Vault
    console.log('3/6 Deploying ValturVault...');
    const Vault = await hre.ethers.deployContract("ValturVault", [MockUSDT.target, AC.target]);
    await Vault.waitForDeployment();
    console.log('   Vault:', Vault.target);

    // 4. ROIDistributor
    console.log('4/6 Deploying ROIDistributor...');
    const ROI = await hre.ethers.deployContract("ROIDistributor", [MockUSDT.target, AC.target]);
    await ROI.waitForDeployment();
    console.log('   ROIDistributor:', ROI.target);

    // 5. CommissionPayout
    console.log('5/6 Deploying CommissionPayout...');
    const Comm = await hre.ethers.deployContract("CommissionPayout", [MockUSDT.target, AC.target]);
    await Comm.waitForDeployment();
    console.log('   CommissionPayout:', Comm.target);

    // 6. RedemptionManager
    console.log('6/6 Deploying RedemptionManager...');
    const Redeem = await hre.ethers.deployContract("RedemptionManager", [MockUSDT.target, Vault.target, AC.target]);
    await Redeem.waitForDeployment();
    console.log('   RedemptionManager:', Redeem.target);

    // ── Post-deploy setup ──
    console.log('\n── Post-deploy setup ──');

    // Authorize Vault for Hidden flag
    console.log('Authorizing Vault for Hidden flag...');
    await (await AC.authorizeContract(Vault.target)).wait();
    console.log('   ✓ Vault authorized');

    // Mint 10M USDT to recipient
    console.log('Minting 10,000,000 USDT to', RECIPIENT);
    await (await MockUSDT.mintDollars(RECIPIENT, 10_000_000)).wait();
    console.log('   ✓ 10M USDT minted');

    // Fund contracts for payouts
    console.log('Funding contracts with USDT...');
    await (await MockUSDT.mintDollars(Vault.target, 5_000_000)).wait();
    console.log('   ✓ Vault: 5M USDT');
    await (await MockUSDT.mintDollars(ROI.target, 2_000_000)).wait();
    console.log('   ✓ ROIDistributor: 2M USDT');
    await (await MockUSDT.mintDollars(Comm.target, 2_000_000)).wait();
    console.log('   ✓ CommissionPayout: 2M USDT');
    await (await MockUSDT.mintDollars(Redeem.target, 1_000_000)).wait();
    console.log('   ✓ RedemptionManager: 1M USDT');

    // Save deployment
    const deployment = {
        network: 'polygon-amoy',
        chainId: 80002,
        deployer: deployer.address,
        superWallet: SUPER_WALLET,
        recipient: RECIPIENT,
        contracts: {
            MockUSDT: MockUSDT.target,
            ValturAccessControl: AC.target,
            ValturVault: Vault.target,
            ROIDistributor: ROI.target,
            CommissionPayout: Comm.target,
            RedemptionManager: Redeem.target
        },
        deployedAt: new Date().toISOString()
    };

    const fs = require('fs');
    fs.writeFileSync('deployment-amoy.json', JSON.stringify(deployment, null, 2));

    console.log('\n══════════════════════════════════════');
    console.log('  DEPLOYMENT COMPLETE — Polygon Amoy');
    console.log('══════════════════════════════════════');
    Object.entries(deployment.contracts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    console.log('\nSaved to deployment-amoy.json');
}

main().catch(e => { console.error(e); process.exit(1); });
