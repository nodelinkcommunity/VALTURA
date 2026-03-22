// ══════════════════════════════════════
// Veltura — ROI Calculation Service (In-Memory)
// ══════════════════════════════════════

const db = require('../config/db');
const config = require('../config');

/**
 * Calculate daily ROI for all active positions.
 */
function calculateDailyROI() {
  const activePositions = db.store.positions.filter((p) => p.status === 'active');
  const results = [];

  for (const pos of activePositions) {
    const user = db.findUser((u) => u.id === pos.user_id);
    if (!user) continue;

    const dailyRate = pos.daily_rate;
    const amount = pos.amount;
    const dailyROI = (amount * dailyRate) / 100;
    if (dailyROI <= 0) continue;

    // Check Earnings Cap
    const capStatus = getEarningsCapStatus(pos.user_id);
    if (capStatus.hasExclusive && capStatus.remaining <= 0) continue;

    let finalAmount = dailyROI;
    if (capStatus.hasExclusive && capStatus.remaining < dailyROI) {
      finalAmount = capStatus.remaining;
    }

    results.push({
      userId: pos.user_id,
      wallet: user.wallet,
      amount: Math.round(finalAmount * 100) / 100,
      positionId: pos.id,
    });
  }

  return results;
}

/**
 * Get Earnings Cap status for a user.
 */
function getEarningsCapStatus(userId) {
  const vipPositions = db.store.positions.filter(
    (p) =>
      p.user_id === userId &&
      p.status === 'active' &&
      ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
  );
  const vipTotal = vipPositions.reduce((s, p) => s + p.amount, 0);
  const hasExclusive = vipTotal > 0;

  if (!hasExclusive) {
    return { hasExclusive: false, capLimit: 0, totalEarned: 0, remaining: Infinity };
  }

  const multiplier = parseFloat(db.getConfigValue('earnings_cap_multi')) || 300;
  const capLimit = (vipTotal * multiplier) / 100;

  const totalEarned = db.store.earnings
    .filter((e) => e.user_id === userId)
    .reduce((s, e) => s + e.total_earned, 0);

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
 * Check if a user has an active Exclusive package.
 */
function hasActiveExclusive(userId) {
  return db.store.positions.some(
    (p) =>
      p.user_id === userId &&
      p.status === 'active' &&
      ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
  );
}

/**
 * Record ROI distribution in the earnings store.
 */
function recordROI(distributions) {
  for (const dist of distributions) {
    // Find or create earnings record
    let earning = db.store.earnings.find(
      (e) => e.user_id === dist.userId && e.position_id === dist.positionId && e.income_type === 'daily_profit'
    );

    if (earning) {
      earning.total_earned += dist.amount;
      earning.updated_at = new Date().toISOString();
    } else {
      db.store.earnings.push({
        user_id: dist.userId,
        position_id: dist.positionId,
        income_type: 'daily_profit',
        total_earned: dist.amount,
        total_claimed: 0,
        updated_at: new Date().toISOString(),
      });
    }

    // Log commission
    db.store.commissions.push({
      id: db.nextCommissionId(),
      user_id: dist.userId,
      source_user: null,
      type: 'daily_profit',
      amount: dist.amount,
      description: `Daily ROI for position #${dist.positionId}`,
      created_at: new Date().toISOString(),
    });
  }
}

module.exports = {
  calculateDailyROI,
  getEarningsCapStatus,
  hasActiveExclusive,
  recordROI,
};
