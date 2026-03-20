// ══════════════════════════════════════
// Valtura — Daily Cron Job (In-Memory)
// ══════════════════════════════════════

const roiService = require('../services/roi');
const commissionService = require('../services/commission');
const treeService = require('../services/tree');

function getEpoch() {
  return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
}

async function runDailyJob() {
  const startTime = Date.now();
  const epoch = getEpoch();
  const log = [];

  console.log(`[Cron] Starting daily job — epoch ${epoch}`);

  try {
    // Step 1: Calculate daily ROI
    const roiDistributions = roiService.calculateDailyROI();
    log.push(`ROI calculated for ${roiDistributions.length} positions`);

    // Step 2: Record ROI
    if (roiDistributions.length > 0) {
      roiService.recordROI(roiDistributions);
      for (const dist of roiDistributions) {
        treeService.updateROIVolumes(dist.userId, dist.amount);
      }
      log.push('ROI recorded');
    }

    // Step 3: Calculate commissions
    const binaryBonuses = commissionService.calculateBinaryBonus();
    const referralCommissions = commissionService.calculateReferralCommission(roiDistributions);
    const binaryCommissions = commissionService.calculateBinaryCommission(roiDistributions);
    const momentumRewards = commissionService.calculateMomentum();

    log.push(`Binary bonuses: ${binaryBonuses.length}, Referral: ${referralCommissions.length}, Binary comm: ${binaryCommissions.length}, Momentum: ${momentumRewards.length}`);

    // Step 4: Record commissions
    const allCommissions = [...binaryBonuses, ...referralCommissions, ...binaryCommissions, ...momentumRewards];
    if (allCommissions.length > 0) {
      commissionService.recordCommissions(allCommissions);
      log.push(`${allCommissions.length} commissions recorded`);
    }

    // Step 5: Apply forfeiture
    const forfeitureResult = commissionService.applyForfeiture();
    log.push(`Forfeiture: ${forfeitureResult.usersAffected} users`);

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
