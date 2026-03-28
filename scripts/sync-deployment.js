const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEPLOYMENT_PATH = path.join(ROOT, 'deployment-amoy-v3.json');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, contents) {
  fs.writeFileSync(file, contents, 'utf8');
}

function replaceOrThrow(contents, pattern, replacement, label) {
  if (!pattern.test(contents)) {
    throw new Error(`Could not update ${label}`);
  }
  return contents.replace(pattern, replacement);
}

function upsertEnv(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  return contents.endsWith('\n') ? `${contents}${line}\n` : `${contents}\n${line}\n`;
}

function updateEnvFile(file, deployment) {
  let contents = read(file);
  const envMap = {
    USDT_ADDRESS: deployment.contracts.MockUSDT,
    ACCESS_CONTROL_ADDRESS: deployment.contracts.VelturAccessControl,
    VALTUR_VAULT_ADDRESS: deployment.contracts.VelturVault,
    ROI_DISTRIBUTOR_ADDRESS: deployment.contracts.ROIDistributor,
    COMMISSION_PAYOUT_ADDRESS: deployment.contracts.CommissionPayout,
    REDEMPTION_MANAGER_ADDRESS: deployment.contracts.RedemptionManager,
    TRADING_FUNDS_ADDRESS: deployment.contracts.TradingFunds,
  };

  for (const [key, value] of Object.entries(envMap)) {
    contents = upsertEnv(contents, key, value);
  }

  write(file, contents);
}

function updateFrontendFile(file, deployment) {
  let contents = read(file);

  contents = replaceOrThrow(
    contents,
    /const CONTRACT='0x[a-fA-F0-9]{40}';/g,
    `const CONTRACT='${deployment.contracts.VelturVault}';`,
    `${path.basename(file)} CONTRACT`
  );

  const replacements = {
    USDT: deployment.contracts.MockUSDT,
    ACCESS_CONTROL: deployment.contracts.VelturAccessControl,
    VAULT: deployment.contracts.VelturVault,
    ROI_DISTRIBUTOR: deployment.contracts.ROIDistributor,
    COMMISSION_PAYOUT: deployment.contracts.CommissionPayout,
    REDEMPTION_MANAGER: deployment.contracts.RedemptionManager,
    TRADING_FUNDS: deployment.contracts.TradingFunds,
  };

  for (const [key, value] of Object.entries(replacements)) {
    contents = replaceOrThrow(
      contents,
      new RegExp(`${key}:'0x[a-fA-F0-9]{40}'`, 'g'),
      `${key}:'${value}'`,
      `${path.basename(file)} ${key}`
    );
  }

  write(file, contents);
}

function updateAdminFile(file, deployment) {
  let contents = read(file);

  contents = replaceOrThrow(
    contents,
    /const OWNER_ADDR = '0x[a-fA-F0-9]{40}';/g,
    `const OWNER_ADDR = '${deployment.deployer}';`,
    'admin OWNER_ADDR'
  );
  contents = replaceOrThrow(
    contents,
    /const ACCESS_CONTROL = '0x[a-fA-F0-9]{40}';/g,
    `const ACCESS_CONTROL = '${deployment.contracts.VelturAccessControl}';`,
    'admin ACCESS_CONTROL'
  );
  contents = replaceOrThrow(
    contents,
    /const VALTUR_VAULT = '0x[a-fA-F0-9]{40}';/g,
    `const VALTUR_VAULT = '${deployment.contracts.VelturVault}';`,
    'admin VALTUR_VAULT'
  );
  contents = contents.replace(
    /var AC_ADDR = '0x[a-fA-F0-9]{40}';/g,
    `var AC_ADDR = '${deployment.contracts.VelturAccessControl}';`
  );

  contents = contents.replace(
    /openReceiveModal\('Expert Trading Fund','0x[a-fA-F0-9]{40}'\)/g,
    `openReceiveModal('Expert Trading Fund','${deployment.contracts.TradingFunds}')`
  );
  contents = contents.replace(
    /openReceiveModal\('DEX \/ Arbitrage Fund','0x[a-fA-F0-9]{40}'\)/g,
    `openReceiveModal('DEX / Arbitrage Fund','${deployment.contracts.TradingFunds}')`
  );
  contents = contents.replace(
    /openReceiveModal\('Reward &amp; Redeem Fund','0x[a-fA-F0-9]{40}'\)/g,
    `openReceiveModal('Reward &amp; Redeem Fund','${deployment.contracts.VelturVault}')`
  );

  contents = replaceOrThrow(
    contents,
    /(<div id="recv-addr-display"[\s\S]*?>\s*)0x[a-fA-F0-9]{40}(\s*<\/div>)/,
    `$1${deployment.contracts.VelturVault}$2`,
    'admin default receive modal address'
  );

  write(file, contents);
}

function updateBackendConfigFile(file, deployment) {
  let contents = read(file);

  const replacements = {
    accessControl: deployment.contracts.VelturAccessControl,
    valturVault: deployment.contracts.VelturVault,
    roiDistributor: deployment.contracts.ROIDistributor,
    commissionPayout: deployment.contracts.CommissionPayout,
    redemptionManager: deployment.contracts.RedemptionManager,
    tradingFunds: deployment.contracts.TradingFunds,
  };

  for (const [key, value] of Object.entries(replacements)) {
    contents = replaceOrThrow(
      contents,
      new RegExp(`(${key}: process\\.env\\.[A-Z_]+ \\|\\| )'0x[a-fA-F0-9]{40}'`),
      `$1'${value}'`,
      `backend config ${key}`
    );
  }

  write(file, contents);
}

function main() {
  const deployment = JSON.parse(read(DEPLOYMENT_PATH));

  updateEnvFile(path.join(ROOT, '.env'), deployment);
  updateEnvFile(path.join(ROOT, 'backend', '.env'), deployment);

  updateFrontendFile(path.join(ROOT, 'frontend', 'index.html'), deployment);
  updateFrontendFile(path.join(ROOT, 'index.html'), deployment);
  updateAdminFile(path.join(ROOT, 'admin', 'index.html'), deployment);
  updateBackendConfigFile(path.join(ROOT, 'backend', 'config', 'index.js'), deployment);

  console.log('Deployment sync complete');
  console.log(JSON.stringify(deployment.contracts, null, 2));
}

main();
