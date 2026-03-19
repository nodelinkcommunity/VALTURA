// ══════════════════════════════════════
// Valtura — Daily Cron Job
// Runs at 00:00 UTC: ROI distribution, commission calculation, Earnings Cap check
// ══════════════════════════════════════

const db = require('../config/db');
const roiService = require('../services/roi');
const commissionService = require('../services/commission');
const treeService = require('../services/tree');
const blockchain = require('../services/blockchain');

/**
 * Get today's epoch number (days since Unix epoch).
 * Used as a unique identifier for daily distribution batches.
 */
function getEpoch() {
  return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
}

/**
 * Run the daily distribution job.
 */
async function runDailyJob() {
  const startTime = Date.now();
  const epoch = getEpoch();
  const log = [];

  console.log(`[Cron] Starting daily job — epoch ${epoch}`);

  try {
    // ── Step 1: Calculate daily ROI for all active positions ──
    console.log('[Cron] Step 1: Calculating daily ROI...');
    const roiDistributions = await roiService.calculateDailyROI();
    log.push(`ROI calculated for ${roiDistributions.length} positions`);
    console.log(`[Cron] ROI distributions: ${roiDistributions.length}`);

    // ── Step 2: Record ROI in DB ──
    if (roiDistributions.length > 0) {
      await db.transaction(async (client) => {
        await roiService.recordROI(roiDistributions, client);

        // Update ROI volumes in binary tree
        for (const dist of roiDistributions) {
          await treeService.updateROIVolumes(dist.userId, dist.amount, client);
        }
      });
      log.push('ROI recorded in database');
    }

    // ── Step 3: Calculate commissions ──
    console.log('[Cron] Step 3: Calculating commissions...');

    // 3a: Binary Bonus (5% on Signature + Exclusive weak leg volume)
    const binaryBonuses = await commissionService.calculateBinaryBonus();
    log.push(`Binary bonuses: ${binaryBonuses.length} users`);

    // 3b: Referral Commission (10% on F1 daily profit)
    const referralCommissions = await commissionService.calculateReferralCommission(roiDistributions);
    log.push(`Referral commissions: ${referralCommissions.length} users`);

    // 3c: Binary Commission (15% on weak leg daily profit)
    const binaryCommissions = await commissionService.calculateBinaryCommission(roiDistributions);
    log.push(`Binary commissions: ${binaryCommissions.length} users`);

    // 3d: Momentum Rewards
    const momentumRewards = await commissionService.calculateMomentum();
    log.push(`Momentum rewards: ${momentumRewards.length} users`);

    // ── Step 4: Record all commissions in DB ──
    const allCommissions = [
      ...binaryBonuses,
      ...referralCommissions,
      ...binaryCommissions,
      ...momentumRewards,
    ];

    if (allCommissions.length > 0) {
      await db.transaction(async (client) => {
        await commissionService.recordCommissions(allCommissions, client);
      });
      log.push(`${allCommissions.length} total commissions recorded`);
    }

    // ── Step 5: Apply forfeiture (users without active Exclusive) ──
    console.log('[Cron] Step 5: Applying forfeiture rules...');
    const forfeitureResult = await commissionService.applyForfeiture();
    log.push(`Forfeiture: ${forfeitureResult.usersAffected} users, ${forfeitureResult.earningsForfeited} earnings forfeited`);

    // ── Step 6: Batch distribute on-chain ──
    console.log('[Cron] Step 6: On-chain distribution...');

    // 6a: ROI distribution on-chain
    if (roiDistributions.length > 0) {
      try {
        // Batch in groups of 200 (MAX_BATCH on-chain)
        const roiBatches = batchArray(roiDistributions, 200);
        for (let i = 0; i < roiBatches.length; i++) {
          const batch = roiBatches[i];
          const batchEpoch = epoch * 1000 + i; // Unique epoch per batch
          const users = batch.map((d) => d.wallet);
          const amounts = batch.map((d) => d.amount);

          await blockchain.distributeROI(users, amounts, batchEpoch);
          log.push(`ROI batch ${i + 1}/${roiBatches.length} distributed on-chain`);
        }
      } catch (err) {
        console.error('[Cron] On-chain ROI distribution failed:', err.message);
        log.push(`ROI on-chain FAILED: ${err.message}`);
      }
    }

    // 6b: Commission distribution on-chain
    if (allCommissions.length > 0) {
      try {
        const commBatches = batchArray(allCommissions, 200);
        const typeMap = {
          daily_profit: 1,
          binary_bonus: 2,
          referral_commission: 3,
          binary_commission: 4,
          momentum_rewards: 5,
        };

        for (let i = 0; i < commBatches.length; i++) {
          const batch = commBatches[i];
          const batchEpoch = epoch * 1000 + 500 + i; // Offset from ROI epochs
          const users = batch.map((d) => d.wallet);
          const types = batch.map((d) => typeMap[d.type]);
          const amounts = batch.map((d) => d.amount);

          await blockchain.distributeCommissions(users, types, amounts, batchEpoch);
          log.push(`Commission batch ${i + 1}/${commBatches.length} distributed on-chain`);
        }
      } catch (err) {
        console.error('[Cron] On-chain commission distribution failed:', err.message);
        log.push(`Commission on-chain FAILED: ${err.message}`);
      }
    }

    // ── Step 7: Log job completion ──
    const duration = Date.now() - startTime;
    console.log(`[Cron] Daily job completed in ${duration}ms`);
    log.push(`Job completed in ${duration}ms`);

    // Store job log in platform_config
    await db.query(
      `INSERT INTO platform_config (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [
        `cron_log_${epoch}`,
        JSON.stringify({ epoch, log, duration, timestamp: new Date().toISOString() }),
        'Daily cron job log',
      ]
    );

    return { success: true, epoch, log, duration };
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[Cron] Daily job FAILED after ${duration}ms:`, err.message);
    log.push(`FATAL ERROR: ${err.message}`);

    // Store error log
    try {
      await db.query(
        `INSERT INTO platform_config (key, value, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [
          `cron_log_${epoch}`,
          JSON.stringify({ epoch, log, duration, error: err.message, timestamp: new Date().toISOString() }),
          'Daily cron job log (FAILED)',
        ]
      );
    } catch (logErr) {
      console.error('[Cron] Failed to save error log:', logErr.message);
    }

    return { success: false, epoch, log, duration, error: err.message };
  }
}

/**
 * Split an array into batches of given size.
 */
function batchArray(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/**
 * Initialize the cron scheduler.
 * Uses setInterval to run at approximately 00:00 UTC daily.
 */
function initCron() {
  // Calculate ms until next midnight UTC
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  console.log(`[Cron] Next daily job in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);

  // First run at next midnight
  setTimeout(() => {
    runDailyJob();

    // Then run every 24 hours
    setInterval(() => {
      runDailyJob();
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  console.log('[Cron] Daily job scheduler initialized');
}

module.exports = {
  runDailyJob,
  initCron,
  getEpoch,
};
