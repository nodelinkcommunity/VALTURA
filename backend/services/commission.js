// ══════════════════════════════════════
// Valtura — Commission Calculation Service
// ══════════════════════════════════════

const db = require('../config/db');
const config = require('../config');
const roiService = require('./roi');
const treeService = require('./tree');

/**
 * Calculate Binary Bonus for all eligible users.
 * 5% on Signature + Exclusive investment volume from weak leg.
 * Only users with active Exclusive package can earn this.
 *
 * @returns {Array<{userId: number, wallet: string, amount: number, type: string}>}
 */
async function calculateBinaryBonus() {
  // Get all users with active Exclusive packages
  const { rows: eligibleUsers } = await db.query(
    `SELECT DISTINCT p.user_id, u.wallet
     FROM positions p
     JOIN users u ON u.id = p.user_id
     WHERE p.status = 'active'
       AND p.package_id IN ('exclusive360', 'exclusive360_leader')`
  );

  const results = [];

  // Get binary bonus rate from config
  const { rows: configRows } = await db.query(
    "SELECT value FROM platform_config WHERE key = 'comm_binary_bonus'"
  );
  const bonusRate = parseFloat(configRows[0]?.value) || 5;

  for (const user of eligibleUsers) {
    const volumes = await treeService.getWeakLeg(user.user_id);

    // Binary bonus = bonusRate% of weak leg VIP volume (Signature + Exclusive)
    // Use the lesser of left/right VIP volumes (matched volume)
    const weakVipVolume = Math.min(volumes.leftVipVolume, volumes.rightVipVolume);
    // Subtract carry_forward (already paid) to get new matched volume
    const newMatchedVolume = weakVipVolume - volumes.carryForward;

    if (newMatchedVolume <= 0) continue;

    const bonusAmount = (newMatchedVolume * bonusRate) / 100;

    // Check Earnings Cap
    const capStatus = await roiService.getEarningsCapStatus(user.user_id);
    if (capStatus.remaining <= 0) continue;

    const finalAmount = Math.min(bonusAmount, capStatus.remaining);
    if (finalAmount <= 0) continue;

    results.push({
      userId: user.user_id,
      wallet: user.wallet,
      amount: Math.round(finalAmount * 100) / 100,
      type: 'binary_bonus',
      newCarryForward: weakVipVolume, // Update carry_forward after processing
    });
  }

  return results;
}

/**
 * Calculate Referral Commission for all eligible users.
 * 10% on F1 (direct referrals) daily profit.
 * Only users with active Exclusive package can earn this.
 *
 * @param {Array} todayROI - Today's ROI distributions [{userId, amount}]
 * @returns {Array<{userId: number, wallet: string, amount: number, type: string}>}
 */
async function calculateReferralCommission(todayROI) {
  if (!todayROI || todayROI.length === 0) return [];

  // Get referral commission rate
  const { rows: configRows } = await db.query(
    "SELECT value FROM platform_config WHERE key = 'comm_referral'"
  );
  const refRate = parseFloat(configRows[0]?.value) || 10;

  // Group ROI by user
  const roiByUser = {};
  for (const roi of todayROI) {
    roiByUser[roi.userId] = (roiByUser[roi.userId] || 0) + roi.amount;
  }

  const results = [];

  // For each user who earned ROI, find their referrer
  for (const [earnerId, roiAmount] of Object.entries(roiByUser)) {
    const { rows } = await db.query(
      `SELECT u.referrer_id, ref.wallet
       FROM users u
       JOIN users ref ON ref.id = u.referrer_id
       WHERE u.id = $1 AND u.referrer_id IS NOT NULL`,
      [parseInt(earnerId, 10)]
    );

    if (rows.length === 0) continue;

    const referrerId = rows[0].referrer_id;
    const referrerWallet = rows[0].wallet;

    // Check if referrer has active Exclusive package (forfeiture rule)
    const hasExclusive = await roiService.hasActiveExclusive(referrerId);
    if (!hasExclusive) continue;

    // Check Earnings Cap
    const capStatus = await roiService.getEarningsCapStatus(referrerId);
    if (capStatus.remaining <= 0) continue;

    const commissionAmount = (roiAmount * refRate) / 100;
    const finalAmount = Math.min(commissionAmount, capStatus.remaining);
    if (finalAmount <= 0) continue;

    // Aggregate for same referrer
    const existing = results.find((r) => r.userId === referrerId);
    if (existing) {
      existing.amount += Math.round(finalAmount * 100) / 100;
    } else {
      results.push({
        userId: referrerId,
        wallet: referrerWallet,
        amount: Math.round(finalAmount * 100) / 100,
        type: 'referral_commission',
        sourceUserId: parseInt(earnerId, 10),
      });
    }
  }

  return results;
}

/**
 * Calculate Binary Commission for all eligible users.
 * 15% on weak leg daily profit.
 * Only users with active Exclusive package can earn this.
 *
 * @param {Array} todayROI - Today's ROI distributions [{userId, amount}]
 * @returns {Array<{userId: number, wallet: string, amount: number, type: string}>}
 */
async function calculateBinaryCommission(todayROI) {
  if (!todayROI || todayROI.length === 0) return [];

  // Get binary commission rate
  const { rows: configRows } = await db.query(
    "SELECT value FROM platform_config WHERE key = 'comm_binary'"
  );
  const binaryRate = parseFloat(configRows[0]?.value) || 15;

  // Get all users with active Exclusive packages
  const { rows: eligibleUsers } = await db.query(
    `SELECT DISTINCT p.user_id, u.wallet
     FROM positions p
     JOIN users u ON u.id = p.user_id
     WHERE p.status = 'active'
       AND p.package_id IN ('exclusive360', 'exclusive360_leader')`
  );

  const results = [];

  for (const user of eligibleUsers) {
    const volumes = await treeService.getLeftRightVolumes(user.user_id);

    // Get today's ROI for left and right legs
    const leftLegROI = await getLegDailyROI(user.user_id, 'left', todayROI);
    const rightLegROI = await getLegDailyROI(user.user_id, 'right', todayROI);

    // Weak leg daily profit
    const weakLegROI = Math.min(leftLegROI, rightLegROI);
    if (weakLegROI <= 0) continue;

    const commissionAmount = (weakLegROI * binaryRate) / 100;

    // Check Earnings Cap
    const capStatus = await roiService.getEarningsCapStatus(user.user_id);
    if (capStatus.remaining <= 0) continue;

    const finalAmount = Math.min(commissionAmount, capStatus.remaining);
    if (finalAmount <= 0) continue;

    results.push({
      userId: user.user_id,
      wallet: user.wallet,
      amount: Math.round(finalAmount * 100) / 100,
      type: 'binary_commission',
    });
  }

  return results;
}

/**
 * Get total daily ROI for all users on a specific leg.
 */
async function getLegDailyROI(userId, side, todayROI) {
  // Get all team members on the specified side
  const { rows } = await db.query(
    `WITH RECURSIVE downline AS (
       SELECT user_id FROM binary_tree
       WHERE parent_id = $1 AND side = $2
       UNION ALL
       SELECT bt.user_id FROM binary_tree bt
       INNER JOIN downline d ON d.user_id = bt.parent_id
     )
     SELECT user_id FROM downline`,
    [userId, side]
  );

  const legUserIds = new Set(rows.map((r) => r.user_id));
  let totalROI = 0;

  for (const roi of todayROI) {
    if (legUserIds.has(roi.userId)) {
      totalROI += roi.amount;
    }
  }

  return totalROI;
}

/**
 * Calculate Momentum Rewards for all eligible users.
 * Check weak leg personal volume (WLP) against milestone thresholds.
 *
 * @returns {Array<{userId: number, wallet: string, amount: number, level: number, type: string}>}
 */
async function calculateMomentum() {
  // Get all users with Exclusive packages
  const { rows: eligibleUsers } = await db.query(
    `SELECT DISTINCT p.user_id, u.wallet
     FROM positions p
     JOIN users u ON u.id = p.user_id
     WHERE p.status = 'active'
       AND p.package_id IN ('exclusive360', 'exclusive360_leader')`
  );

  const results = [];

  for (const user of eligibleUsers) {
    const volumes = await treeService.getWeakLeg(user.user_id);
    const weakLegPersonalVolume = volumes.weakVolume;

    // Get user's current highest achieved momentum level
    const { rows: momentumRows } = await db.query(
      `SELECT COALESCE(MAX(
         CASE
           WHEN description LIKE 'Momentum Level%' THEN
             CAST(SUBSTRING(description FROM 'Level (\d+)') AS INT)
           ELSE 0
         END
       ), 0) as current_level
       FROM commissions
       WHERE user_id = $1 AND type = 'momentum_rewards'`,
      [user.user_id]
    );

    const currentLevel = parseInt(momentumRows[0]?.current_level, 10) || 0;

    // Check each milestone above current level
    for (const milestone of config.momentum) {
      if (milestone.level <= currentLevel) continue;
      if (weakLegPersonalVolume < milestone.threshold) break;

      // Check Earnings Cap
      const capStatus = await roiService.getEarningsCapStatus(user.user_id);
      if (capStatus.remaining <= 0) break;

      const finalAmount = Math.min(milestone.reward, capStatus.remaining);
      if (finalAmount <= 0) break;

      results.push({
        userId: user.user_id,
        wallet: user.wallet,
        amount: Math.round(finalAmount * 100) / 100,
        level: milestone.level,
        type: 'momentum_rewards',
      });
    }
  }

  return results;
}

/**
 * Record commissions in the DB.
 */
async function recordCommissions(commissions, client) {
  const q = client || db;

  for (const comm of commissions) {
    // For commissions, we use the user's first active Exclusive position as the position_id
    const { rows: posRows } = await q.query(
      `SELECT id FROM positions
       WHERE user_id = $1 AND status = 'active'
         AND package_id IN ('exclusive360', 'exclusive360_leader')
       ORDER BY id LIMIT 1`,
      [comm.userId]
    );

    const positionId = posRows[0]?.id;
    if (!positionId) continue; // Should not happen since we checked eligibility

    // Upsert earnings
    await q.query(
      `INSERT INTO earnings (user_id, position_id, income_type, total_earned)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, position_id, income_type)
       DO UPDATE SET total_earned = earnings.total_earned + $4, updated_at = NOW()`,
      [comm.userId, positionId, comm.type, comm.amount]
    );

    // Log commission
    const description = comm.type === 'momentum_rewards'
      ? `Momentum Level ${comm.level} reward`
      : comm.type === 'binary_bonus'
        ? 'Binary Bonus on Signature + Exclusive weak leg volume'
        : comm.type === 'referral_commission'
          ? `Referral Commission on F1 daily profit`
          : `Binary Commission on weak leg daily profit`;

    await q.query(
      `INSERT INTO commissions (user_id, source_user, type, amount, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [comm.userId, comm.sourceUserId || null, comm.type, comm.amount, description]
    );

    // Update carry_forward for binary bonus
    if (comm.type === 'binary_bonus' && comm.newCarryForward !== undefined) {
      await q.query(
        'UPDATE binary_tree SET carry_forward = $1 WHERE user_id = $2',
        [comm.newCarryForward, comm.userId]
      );
    }
  }
}

/**
 * Apply forfeiture rule: users without active Exclusive lose pending commissions.
 * This deletes unclaimed commission earnings (not daily profit).
 */
async function applyForfeiture() {
  // Find users who have unclaimed commission earnings but no active Exclusive
  const { rows } = await db.query(
    `SELECT DISTINCT e.user_id
     FROM earnings e
     WHERE e.income_type IN ('binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards')
       AND e.total_earned > e.total_claimed
       AND NOT EXISTS (
         SELECT 1 FROM positions p
         WHERE p.user_id = e.user_id AND p.status = 'active'
           AND p.package_id IN ('exclusive360', 'exclusive360_leader')
       )`
  );

  let forfeited = 0;
  for (const row of rows) {
    // Set unclaimed commission earnings to 0 (forfeit)
    const result = await db.query(
      `UPDATE earnings
       SET total_earned = total_claimed, updated_at = NOW()
       WHERE user_id = $1
         AND income_type IN ('binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards')
         AND total_earned > total_claimed`,
      [row.user_id]
    );
    forfeited += result.rowCount;
  }

  return { usersAffected: rows.length, earningsForfeited: forfeited };
}

module.exports = {
  calculateBinaryBonus,
  calculateReferralCommission,
  calculateBinaryCommission,
  calculateMomentum,
  recordCommissions,
  applyForfeiture,
};
