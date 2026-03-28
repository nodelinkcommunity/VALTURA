const { ethers } = require('ethers');

const API_BASE = 'https://veltura.org.uk/api';
const RPC_URL = 'https://rpc-amoy.polygon.technology';
const USDT_ADDRESS = '0x96FBA824E3798E59e98fDE8E019a684700F9fF4a';
const VAULT_ADDRESS = '0x40FBCc98bE7F8CcC2fF732d7807679592FDC66dD';
const ROI_ADDRESS = '0xd486208A37Df4014Fcc6d607178274632d83B903';
const COMMISSION_ADDRESS = '0xC0b3368B020bcad722F431aDa33601a26755D3cC';

const PACKAGE_CONFIG = {
  exclusive360: { amount: 100, tier: 1, lockDays: 360, packageType: 5 },
  signature180: { amount: 100, tier: 1, lockDays: 180, packageType: 4 },
};

const KEYS = {
  admin: '3d37ad641d1618a53bff0bca4d681688a9a8e73f9194ddd9c091950cda2b8871',
  w2: '8451b5ed71588d98e994952c173ea4267de3cf704d9a5a32a11acab6a7dab64d',
  w3: '384adc4e62684a219a5e71071f60aa74758d00f4a0b07d62bfd72896523ecf25',
  w4: 'be54530267ed8b27fbfbe2f82c99bed0245ed4f46a871260769a962c354a0785',
};

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const VAULT_ABI = [
  'function deposit(uint256 amount, uint256 lockDays, uint8 tier, uint8 packageType)',
];

const ROI_ABI = [
  'function claimROI()',
  'function getPendingROI(address user) view returns (uint256)',
];

const COMMISSION_ABI = [
  'function claimAllEarnings()',
  'function getUnclaimedEarnings(address user) view returns (uint256[5] unclaimed, uint256 total)',
];

const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: 80002, name: 'polygon-amoy' });
const usdt = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
const vaultRead = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);
const roiRead = new ethers.Contract(ROI_ADDRESS, ROI_ABI, provider);
const commissionRead = new ethers.Contract(COMMISSION_ADDRESS, COMMISSION_ABI, provider);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(path, body, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Invalid JSON from ${path}: ${text}`);
  }
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function getJson(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Invalid JSON from ${path}: ${text}`);
  }
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function connectWallet(wallet) {
  const message = `Veltura auth ${wallet.address.toLowerCase()} ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const result = await postJson('/auth/connect', {
    wallet: wallet.address,
    message,
    signature,
  });
  return { token: result.token, connected: result.connected, registered: result.registered, user: result.user };
}

async function ensureRegistered(wallet, username, referrer, side) {
  const auth = await connectWallet(wallet);
  if (auth.registered) {
    return auth.token;
  }

  const message = `Veltura register ${wallet.address.toLowerCase()} ${Date.now()}`;
  const signature = await wallet.signMessage(message);
  const result = await postJson('/auth/register', {
    wallet: wallet.address,
    username,
    message,
    signature,
    referrer,
    side,
  });
  return result.token;
}

async function sendDeposit(wallet, token, packageId) {
  const pkg = PACKAGE_CONFIG[packageId];
  const signer = wallet.connect(provider);
  const usdtWrite = usdt.connect(signer);
  const vaultWrite = vaultRead.connect(signer);
  const amount = ethers.parseUnits(String(pkg.amount), 6);

  const allowance = await usdtWrite.allowance(wallet.address, VAULT_ADDRESS);
  if (allowance < amount) {
    const approveTx = await usdtWrite.approve(VAULT_ADDRESS, amount);
    await approveTx.wait();
  }

  const depositTx = await vaultWrite.deposit(amount, pkg.lockDays, pkg.tier, pkg.packageType);
  const receipt = await depositTx.wait();
  await sleep(2000);

  const apiResult = await postJson('/invest/deposit', {
    package: packageId,
    amount: pkg.amount,
    tier: pkg.tier,
    txHash: receipt.hash,
  }, token);

  return { txHash: receipt.hash, apiResult };
}

async function getCommissionPending(address) {
  const pending = await commissionRead.getUnclaimedEarnings(address);
  return {
    binary_bonus: Number(ethers.formatUnits(pending.unclaimed[1], 6)),
    referral_commission: Number(ethers.formatUnits(pending.unclaimed[2], 6)),
    binary_commission: Number(ethers.formatUnits(pending.unclaimed[3], 6)),
    momentum_rewards: Number(ethers.formatUnits(pending.unclaimed[4], 6)),
    total: Number(ethers.formatUnits(pending.total, 6)),
  };
}

async function getRoiPending(address) {
  return Number(ethers.formatUnits(await roiRead.getPendingROI(address), 6));
}

async function claimCommission(wallet, token) {
  const signer = wallet.connect(provider);
  const contract = commissionRead.connect(signer);
  const tx = await contract.claimAllEarnings();
  const receipt = await tx.wait();
  const apiResult = await postJson('/user/claim', { commissionTxHash: receipt.hash }, token);
  return { txHash: receipt.hash, apiResult };
}

async function claimROI(wallet, token) {
  const signer = wallet.connect(provider);
  const contract = roiRead.connect(signer);
  const tx = await contract.claimROI();
  const receipt = await tx.wait();
  const apiResult = await postJson('/user/claim', { roiTxHash: receipt.hash }, token);
  return { txHash: receipt.hash, apiResult };
}

async function main() {
  const wallets = {
    admin: new ethers.Wallet(KEYS.admin, provider),
    w2: new ethers.Wallet(KEYS.w2, provider),
    w3: new ethers.Wallet(KEYS.w3, provider),
    w4: new ethers.Wallet(KEYS.w4, provider),
  };

  const usernames = {
    w4: 'tst_04',
    w2: 'tst_02',
    w3: 'tst_03',
  };

  const tokens = {};
  tokens.admin = (await connectWallet(wallets.admin)).token;
  tokens.w4 = await ensureRegistered(wallets.w4, usernames.w4, 'veltura', 'right');
  tokens.w2 = await ensureRegistered(wallets.w2, usernames.w2, usernames.w4, 'left');
  tokens.w3 = await ensureRegistered(wallets.w3, usernames.w3, usernames.w4, 'right');

  const me4 = await getJson('/auth/me', tokens.w4);
  const network4Before = await getJson('/commission/network', tokens.w4);

  console.log('wallets', {
    w4: wallets.w4.address,
    w2: wallets.w2.address,
    w3: wallets.w3.address,
  });
  console.log('wallet4.me', me4);
  console.log('wallet4.network.before', network4Before);

  const balancesBefore = {
    w4: Number(ethers.formatUnits(await usdt.balanceOf(wallets.w4.address), 6)),
    w2: Number(ethers.formatUnits(await usdt.balanceOf(wallets.w2.address), 6)),
    w3: Number(ethers.formatUnits(await usdt.balanceOf(wallets.w3.address), 6)),
  };

  console.log('balances.before', balancesBefore);

  const w4Deposit = await sendDeposit(wallets.w4, tokens.w4, 'exclusive360');
  const w2Deposit = await sendDeposit(wallets.w2, tokens.w2, 'signature180');
  const w3Deposit = await sendDeposit(wallets.w3, tokens.w3, 'signature180');

  console.log('deposits', {
    w4: w4Deposit,
    w2: w2Deposit,
    w3: w3Deposit,
  });

  const earnings4BeforeCron = await getJson('/user/earnings', tokens.w4);
  const commissionOnChainBeforeCron = await getCommissionPending(wallets.w4.address);

  console.log('wallet4.earnings.beforeCron', earnings4BeforeCron);
  console.log('wallet4.commission.onChain.beforeCron', commissionOnChainBeforeCron);

  const cronResult = await postJson('/admin/trigger-cron', {}, tokens.admin);
  console.log('cron', cronResult);

  const earnings4AfterCron = await getJson('/user/earnings', tokens.w4);
  const earnings2AfterCron = await getJson('/user/earnings', tokens.w2);
  const earnings3AfterCron = await getJson('/user/earnings', tokens.w3);
  const network4After = await getJson('/commission/network', tokens.w4);
  const commissionOnChainAfterCron = await getCommissionPending(wallets.w4.address);
  const roi2OnChainAfterCron = await getRoiPending(wallets.w2.address);
  const roi3OnChainAfterCron = await getRoiPending(wallets.w3.address);

  console.log('wallet4.network.after', network4After);
  console.log('wallet4.earnings.afterCron', earnings4AfterCron);
  console.log('wallet2.earnings.afterCron', earnings2AfterCron);
  console.log('wallet3.earnings.afterCron', earnings3AfterCron);
  console.log('wallet4.commission.onChain.afterCron', commissionOnChainAfterCron);
  console.log('wallet2.roi.onChain.afterCron', roi2OnChainAfterCron);
  console.log('wallet3.roi.onChain.afterCron', roi3OnChainAfterCron);

  const commissionClaim4 = await claimCommission(wallets.w4, tokens.w4);
  const roiClaim2 = await claimROI(wallets.w2, tokens.w2);

  console.log('claims', {
    wallet4Commission: commissionClaim4,
    wallet2ROI: roiClaim2,
  });

  const balancesAfter = {
    w4: Number(ethers.formatUnits(await usdt.balanceOf(wallets.w4.address), 6)),
    w2: Number(ethers.formatUnits(await usdt.balanceOf(wallets.w2.address), 6)),
    w3: Number(ethers.formatUnits(await usdt.balanceOf(wallets.w3.address), 6)),
  };

  const earnings4AfterClaim = await getJson('/user/earnings', tokens.w4);
  const earnings2AfterClaim = await getJson('/user/earnings', tokens.w2);

  console.log('balances.after', balancesAfter);
  console.log('wallet4.earnings.afterClaim', earnings4AfterClaim);
  console.log('wallet2.earnings.afterClaim', earnings2AfterClaim);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
