// ══════════════════════════════════════
// Veltura — Daily Cron Job (In-Memory)
// ══════════════════════════════════════

const roiService = require('../services/roi');
const commissionService = require('../services/commission');
const treeService = require('../services/tree');
const blockchain = require('../services/blockchain');
const db = require('../config/db');

const COMMISSION_TYPE_CODES = {
  binary_bonus: 2,
  referral_commission: 3,
  binary_commission: 4,
  momentum_rewards: 5,
};

function getEpoch() {
  return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
}

function getCommissionEpoch(epoch) {
  return (epoch * 1000) + 1;
}

async function runDailyJob() {
  const startTime = Date.now();
  const epoch = getEpoch();
  const log = [];

  console.log(`[Cron] Starting daily job — epoch ${epoch}`);

  try {
    const lastEpoch = parseInt(db.getConfigValue('last_daily_epoch') || '', 10);
    if (lastEpoch === epoch) {
      log.push(`Epoch ${epoch} already processed`);
      return { success: true, skipped: true, epoch, log, duration: Date.now() - startTime };
    }

    // Step 1: Calculate daily ROI
    const roiDistributions = roiService.calculateDailyROI();
    log.push(`ROI calculated for ${roiDistributions.length} positions`);

    // Step 2: Distribute + record ROI
    if (roiDistributions.length > 0) {
      await blockchain.distributeROI(
        roiDistributions.map((dist) => dist.wallet),
        roiDistributions.map((dist) => dist.amount),
        epoch
      );
      log.push('ROI distributed on-chain');

      roiService.recordROI(roiDistributions);
      for (const dist of roiDistributions) {
        treeService.updateROIVolumes(dist.userId, dist.amount);
      }
      log.push('ROI recorded');
    }

    // Step 3: Calculate commissions (Binary Bonus is calculated instantly on deposit, not here)
    const referralCommissions = commissionService.calculateReferralCommission(roiDistributions);
    const binaryCommissions = commissionService.calculateBinaryCommission(roiDistributions);
    const momentumRewards = commissionService.calculateMomentum();

    log.push(`Referral: ${referralCommissions.length}, Binary comm: ${binaryCommissions.length}, Momentum: ${momentumRewards.length}`);

    // Step 4: Distribute + record commissions
    const allCommissions = [...referralCommissions, ...binaryCommissions, ...momentumRewards]
      .filter((comm) => Number.isFinite(comm.amount) && comm.amount > 0);
    if (allCommissions.length > 0) {
      await blockchain.distributeCommissions(
        allCommissions.map((comm) => comm.wallet),
        allCommissions.map((comm) => COMMISSION_TYPE_CODES[comm.type]).filter(Boolean),
        allCommissions.map((comm) => comm.amount),
        getCommissionEpoch(epoch)
      );
      log.push('Commissions distributed on-chain');

      commissionService.recordCommissions(allCommissions);
      log.push(`${allCommissions.length} commissions recorded`);
    }

    // Step 5: Apply forfeiture
    const forfeitureResult = commissionService.applyForfeiture();
    log.push(`Forfeiture: ${forfeitureResult.usersAffected} users`);

    // Persist all changes
    db.setConfigValue('last_daily_epoch', epoch);
    db.persist();
    log.push('DB persisted');

    const duration = Date.now() - startTime;
    console.log(`[Cron] Daily job completed in ${duration}ms`);
    return { success: true, epoch, log, duration };
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[Cron] Daily job FAILED:`, err.message);
    return { success: false, epoch, log, duration, error: err.message };
  }
}

function initCron() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  console.log(`[Cron] Next daily job in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);

  setTimeout(() => {
    runDailyJob();
    setInterval(() => { runDailyJob(); }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  console.log('[Cron] Daily job scheduler initialized');
}

module.exports = { runDailyJob, initCron, getEpoch };
