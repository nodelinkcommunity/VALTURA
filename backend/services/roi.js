// ══════════════════════════════════════
// Valtura — ROI Calculation Service
// ══════════════════════════════════════

const db = require('../config/db');
const config = require('../config');

/**
 * Calculate daily ROI for all active positions.
 * Checks Earnings Cap and forfeiture rules before including.
 *
 * @returns {Array<{userId: number, wallet: string, amount: number, positionId: number}>}
 */
async function calculateDailyROI() {
  // Get all active positions with user info
  const { rows: positions } = await db.query(
    `SELECT p.id as position_id, p.user_id, p.package_id, p.amount, p.daily_rate, p.tier,
            u.wallet
     FROM positions p
     JOIN users u ON u.id = p.user_id
     WHERE p.status = 'active'
     ORDER BY p.user_id`
  );

  if (positions.length === 0) return [];

  // Get unique user IDs to check eligibility
  const userIds = [...new Set(positions.map((p) => p.user_id))];

  // Check which users have active Exclusive packages (for forfeiture check on commissions,
  // but daily profit is always earned regardless of Exclusive status)
  const results = [];

  for (const pos of positions) {
    const dailyRate = parseFloat(pos.daily_rate);
    const amount = parseFloat(pos.amount);
    const dailyROI = (amount * dailyRate) / 100;

    if (dailyROI <= 0) continue;

    // Check Earnings Cap for users with Exclusive packages
    const capStatus = await getEarningsCapStatus(pos.user_id);
    if (capStatus.hasExclusive && capStatus.remaining <= 0) {
      continue; // Earnings Cap reached
    }

    let finalAmount = dailyROI;
    if (capStatus.hasExclusive && capStatus.remaining < dailyROI) {
      finalAmount = capStatus.remaining; // Partial amount to cap
    }

    results.push({
      userId: pos.user_id,
      wallet: pos.wallet,
      amount: Math.round(finalAmount * 100) / 100, // round to 2 decimals
      positionId: pos.position_id,
    });
  }

  return results;
}

/**
 * Get Earnings Cap status for a user from DB.
 */
async function getEarningsCapStatus(userId) {
  // Get total Exclusive investment
  const { rows: vipRows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) as vip_total
     FROM positions
     WHERE user_id = $1 AND status = 'active'
       AND package_id IN ('exclusive360', 'exclusive360_leader')`,
    [userId]
  );
  const vipTotal = parseFloat(vipRows[0]?.vip_total) || 0;
  const hasExclusive = vipTotal > 0;

  if (!hasExclusive) {
    return { hasExclusive: false, capLimit: 0, totalEarned: 0, remaining: Infinity };
  }

  // Get earnings cap multiplier from platform_config
  const { rows: configRows } = await db.query(
    "SELECT value FROM platform_config WHERE key = 'earnings_cap_multi'"
  );
  const multiplier = parseFloat(configRows[0]?.value) || 300;
  const capLimit = (vipTotal * multiplier) / 100;

  // Get total earned across all income types
  const { rows: earnRows } = await db.query(
    'SELECT COALESCE(SUM(total_earned), 0) as total FROM earnings WHERE user_id = $1',
    [userId]
  );
  const totalEarned = parseFloat(earnRows[0]?.total) || 0;

  return {
    hasExclusive,
    vipTotal,
    capLimit,
    totalEarned,
    remaining: Math.max(0, capLimit - totalEarned),
    progress: capLimit > 0 ? Math.min(100, (totalEarned / capLimit) * 100) : 0,
  };
}

/**
 * Check if a user has an active Exclusive package (for forfeiture rule).
 * Users without active Exclusive lose pending commissions.
 */
async function hasActiveExclusive(userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) as count FROM positions
     WHERE user_id = $1 AND status = 'active'
       AND package_id IN ('exclusive360', 'exclusive360_leader')`,
    [userId]
  );
  return parseInt(rows[0].count, 10) > 0;
}

/**
 * Record ROI distribution in the earnings table.
 */
async function recordROI(distributions, client) {
  const q = client || db;

  for (const dist of distributions) {
    // Upsert into earnings table
    await q.query(
      `INSERT INTO earnings (user_id, position_id, income_type, total_earned)
       VALUES ($1, $2, 'daily_profit', $3)
       ON CONFLICT (user_id, position_id, income_type)
       DO UPDATE SET total_earned = earnings.total_earned + $3, updated_at = NOW()`,
      [dist.userId, dist.positionId, dist.amount]
    );

    // Log in commissions table
    await q.query(
      `INSERT INTO commissions (user_id, type, amount, description)
       VALUES ($1, 'daily_profit', $2, $3)`,
      [dist.userId, dist.amount, `Daily ROI for position #${dist.positionId}`]
    );
  }
}

module.exports = {
  calculateDailyROI,
  getEarningsCapStatus,
  hasActiveExclusive,
  recordROI,
};
