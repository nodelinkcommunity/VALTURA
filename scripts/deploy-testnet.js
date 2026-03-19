/**
 * Deploy all Valtura contracts to Polygon Amoy Testnet
 *
 * Prerequisites:
 *   1. Get testnet POL from: https://faucet.polygon.technology/
 *   2. Set PRIVATE_KEY in .env
 *   3. npm install ethers dotenv @openzeppelin/contracts
 *
 * Run: node scripts/deploy-testnet.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ── Config ──
const AMOY_RPC = 'https://rpc-amoy.polygon.technology';
const SUPER_WALLET = '0x031eA4bA7E1C5729C352e846549E9B5745f3C66E';
const RECIPIENT = '0x21D6DA65981c95B1FF0fA8746Ad81A22b8C0d58B';

async function main() {
    const provider = new ethers.JsonRpcProvider(AMOY_RPC);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('Deployer:', wallet.address);
    console.log('Balance:', ethers.formatEther(await provider.getBalance(wallet.address)), 'POL');
    console.log('Network:', (await provider.getNetwork()).chainId);
    console.log('');

    // ── Step 1: Deploy MockUSDT ──
    console.log('1/6 Deploying MockUSDT...');
    const MockUSDT = await deployContract(wallet, 'MockUSDT', []);
    console.log('   MockUSDT:', MockUSDT.target);

    // ── Step 2: Deploy AccessControl ──
    console.log('2/6 Deploying ValturAccessControl...');
    const AccessControl = await deployContract(wallet, 'ValturAccessControl', []);
    console.log('   AccessControl:', AccessControl.target);
    console.log('   Super Wallet:', SUPER_WALLET);

    // ── Step 3: Deploy Vault ──
    console.log('3/6 Deploying ValturVault...');
    const Vault = await deployContract(wallet, 'ValturVault', [MockUSDT.target, AccessControl.target]);
    console.log('   Vault:', Vault.target);

    // ── Step 4: Deploy ROIDistributor ──
    console.log('4/6 Deploying ROIDistributor...');
    const ROI = await deployContract(wallet, 'ROIDistributor', [MockUSDT.target, AccessControl.target]);
    console.log('   ROIDistributor:', ROI.target);

    // ── Step 5: Deploy CommissionPayout ──
    console.log('5/6 Deploying CommissionPayout...');
    const Commission = await deployContract(wallet, 'CommissionPayout', [MockUSDT.target, AccessControl.target]);
    console.log('   CommissionPayout:', Commission.target);

    // ── Step 6: Deploy RedemptionManager ──
    console.log('6/6 Deploying RedemptionManager...');
    const Redeem = await deployContract(wallet, 'RedemptionManager', [MockUSDT.target, Vault.target, AccessControl.target]);
    console.log('   RedemptionManager:', Redeem.target);

    // ── Post-deploy: Authorize Vault in AccessControl ──
    console.log('\nAuthorizing Vault contract for Hidden flag...');
    const acTx = await AccessControl.authorizeContract(Vault.target);
    await acTx.wait();
    console.log('   Vault authorized ✓');

    // ── Mint & Transfer USDT ──
    console.log('\nMinting 10,000,000 USDT to recipient...');
    const mintTx = await MockUSDT.mintDollars(RECIPIENT, 10_000_000);
    await mintTx.wait();
    console.log('   10,000,000 USDT minted to', RECIPIENT, '✓');

    // Also fund the contracts with USDT for payouts
    console.log('Funding Vault with 5,000,000 USDT for payouts...');
    const fundVault = await MockUSDT.mintDollars(Vault.target, 5_000_000);
    await fundVault.wait();

    console.log('Funding ROIDistributor with 2,000,000 USDT...');
    const fundROI = await MockUSDT.mintDollars(ROI.target, 2_000_000);
    await fundROI.wait();

    console.log('Funding CommissionPayout with 2,000,000 USDT...');
    const fundComm = await MockUSDT.mintDollars(Commission.target, 2_000_000);
    await fundComm.wait();

    console.log('Funding RedemptionManager with 1,000,000 USDT...');
    const fundRedeem = await MockUSDT.mintDollars(Redeem.target, 1_000_000);
    await fundRedeem.wait();

    // ── Save deployment addresses ──
    const deployment = {
        network: 'polygon-amoy',
        chainId: 80002,
        deployer: wallet.address,
        superWallet: SUPER_WALLET,
        recipient: RECIPIENT,
        contracts: {
            MockUSDT: MockUSDT.target,
            ValturAccessControl: AccessControl.target,
            ValturVault: Vault.target,
            ROIDistributor: ROI.target,
            CommissionPayout: Commission.target,
            RedemptionManager: Redeem.target
        },
        deployedAt: new Date().toISOString()
    };

    fs.writeFileSync(
        path.join(__dirname, '../deployment-amoy.json'),
        JSON.stringify(deployment, null, 2)
    );

    console.log('\n══════════════════════════════════════');
    console.log('  DEPLOYMENT COMPLETE — Polygon Amoy');
    console.log('══════════════════════════════════════');
    console.log(JSON.stringify(deployment.contracts, null, 2));
    console.log('\nSaved to deployment-amoy.json');
}

// ── Helper: compile & deploy ──
async function deployContract(wallet, name, args) {
    // In production, use Hardhat/Foundry compiled artifacts
    // For quick testnet deploy, we compile inline with solc
    const Factory = new ethers.ContractFactory(
        getABI(name),
        getBytecode(name),
        wallet
    );
    const contract = await Factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

function getABI(name) {
    const p = path.join(__dirname, `../artifacts/${name}.json`);
    return JSON.parse(fs.readFileSync(p)).abi;
}

function getBytecode(name) {
    const p = path.join(__dirname, `../artifacts/${name}.json`);
    return JSON.parse(fs.readFileSync(p)).bytecode;
}

main().catch(e => { console.error(e); process.exit(1); });
