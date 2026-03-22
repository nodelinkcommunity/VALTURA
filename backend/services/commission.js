// ══════════════════════════════════════
// Veltura — Commission Calculation Service (In-Memory)
// ══════════════════════════════════════

const db = require('../config/db');
const config = require('../config');
const roiService = require('./roi');
const treeService = require('./tree');

/**
 * Calculate Binary Bonus for all eligible users.
 */
function calculateBinaryBonus() {
  const eligibleUsers = getExclusiveUsers();
  const bonusRate = parseFloat(db.getConfigValue('comm_binary_bonus')) || 5;
  const results = [];

  for (const user of eligibleUsers) {
    const volumes = treeService.getWeakLeg(user.user_id);
    const weakVipVolume = Math.min(volumes.leftVipVolume, volumes.rightVipVolume);
    const newMatchedVolume = weakVipVolume - volumes.carryForward;
    if (newMatchedVolume <= 0) continue;

    const bonusAmount = (newMatchedVolume * bonusRate) / 100;
    const capStatus = roiService.getEarningsCapStatus(user.user_id);
    if (capStatus.remaining <= 0) continue;

    const finalAmount = Math.min(bonusAmount, capStatus.remaining);
    if (finalAmount <= 0) continue;

    results.push({
      userId: user.user_id,
      wallet: user.wallet,
      amount: Math.round(finalAmount * 100) / 100,
      type: 'binary_bonus',
      newCarryForward: weakVipVolume,
    });
  }

  return results;
}

/**
 * Calculate Referral Commission (10% on F1 daily profit).
 */
function calculateReferralCommission(todayROI) {
  if (!todayROI || todayROI.length === 0) return [];

  const refRate = parseFloat(db.getConfigValue('comm_referral')) || 10;

  // Group ROI by user
  const roiByUser = {};
  for (const roi of todayROI) {
    roiByUser[roi.userId] = (roiByUser[roi.userId] || 0) + roi.amount;
  }

  const results = [];

  for (const [earnerId, roiAmount] of Object.entries(roiByUser)) {
    const earner = db.findUser((u) => u.id === parseInt(earnerId, 10));
    if (!earner || !earner.referrer_id) continue;

    const referrer = db.findUser((u) => u.id === earner.referrer_id);
    if (!referrer) continue;

    if (!roiService.hasActiveExclusive(referrer.id)) continue;

    const capStatus = roiService.getEarningsCapStatus(referrer.id);
    if (capStatus.remaining <= 0) continue;

    const commissionAmount = (roiAmount * refRate) / 100;
    const finalAmount = Math.min(commissionAmount, capStatus.remaining);
    if (finalAmount <= 0) continue;

    const existing = results.find((r) => r.userId === referrer.id);
    if (existing) {
      existing.amount += Math.round(finalAmount * 100) / 100;
    } else {
      results.push({
        userId: referrer.id,
        wallet: referrer.wallet,
        amount: Math.round(finalAmount * 100) / 100,
        type: 'referral_commission',
        sourceUserId: parseInt(earnerId, 10),
      });
    }
  }

  return results;
}

/**
 * Calculate Binary Commission (15% on weak leg daily profit).
 */
function calculateBinaryCommission(todayROI) {
  if (!todayROI || todayROI.length === 0) return [];

  const binaryRate = parseFloat(db.getConfigValue('comm_binary')) || 15;
  const eligibleUsers = getExclusiveUsers();
  const results = [];

  for (const user of eligibleUsers) {
    const leftLegROI = getLegDailyROI(user.user_id, 'left', todayROI);
    const rightLegROI = getLegDailyROI(user.user_id, 'right', todayROI);
    const weakLegROI = Math.min(leftLegROI, rightLegROI);
    if (weakLegROI <= 0) continue;

    const commissionAmount = (weakLegROI * binaryRate) / 100;
    const capStatus = roiService.getEarningsCapStatus(user.user_id);
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
function getLegDailyROI(userId, side, todayROI) {
  const legUserIds = new Set();

  function collectDescendants(nodeId) {
    const node = db.getTreeNode(nodeId);
    if (!node) return;
    legUserIds.add(nodeId);
    if (node.left_child_id) collectDescendants(node.left_child_id);
    if (node.right_child_id) collectDescendants(node.right_child_id);
  }

  const parentNode = db.getTreeNode(userId);
  if (!parentNode) return 0;

  const startId = side === 'left' ? parentNode.left_child_id : parentNode.right_child_id;
  if (startId) collectDescendants(startId);

  let totalROI = 0;
  for (const roi of todayROI) {
    if (legUserIds.has(roi.userId)) {
      totalROI += roi.amount;
    }
  }
  return totalROI;
}

/**
 * Calculate Momentum Rewards.
 */
function calculateMomentum() {
  const eligibleUsers = getExclusiveUsers();
  const results = [];

  for (const user of eligibleUsers) {
    const volumes = treeService.getWeakLeg(user.user_id);
    const weakLegPersonalVolume = volumes.weakVolume;

    // Get current highest achieved level
    const momentumCommissions = db.store.commissions.filter(
      (c) => c.user_id === user.user_id && c.type === 'momentum_rewards'
    );
    let currentLevel = 0;
    for (const c of momentumCommissions) {
      const match = c.description?.match(/Level (\d+)/);
      if (match) currentLevel = Math.max(currentLevel, parseInt(match[1], 10));
    }

    for (const milestone of config.momentum) {
      if (milestone.level <= currentLevel) continue;
      if (weakLegPersonalVolume < milestone.threshold) break;

      const capStatus = roiService.getEarningsCapStatus(user.user_id);
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
 * Record commissions in the store.
 */
function recordCommissions(commissions) {
  for (const comm of commissions) {
    // Find first active Exclusive position for this user
    const pos = db.store.positions.find(
      (p) =>
        p.user_id === comm.userId &&
        p.status === 'active' &&
        ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
    );
    if (!pos) continue;

    // Upsert earnings
    let earning = db.store.earnings.find(
      (e) => e.user_id === comm.userId && e.position_id === pos.id && e.income_type === comm.type
    );
    if (earning) {
      earning.total_earned += comm.amount;
      earning.updated_at = new Date().toISOString();
    } else {
      db.store.earnings.push({
        user_id: comm.userId,
        position_id: pos.id,
        income_type: comm.type,
        total_earned: comm.amount,
        total_claimed: 0,
        updated_at: new Date().toISOString(),
      });
    }

    // Log commission
    const description =
      comm.type === 'momentum_rewards'
        ? `Momentum Level ${comm.level} reward`
        : comm.type === 'binary_bonus'
          ? 'Binary Bonus on Signature + Exclusive weak leg volume'
          : comm.type === 'referral_commission'
            ? 'Referral Commission on F1 daily profit'
            : 'Binary Commission on weak leg daily profit';

    db.store.commissions.push({
      id: db.nextCommissionId(),
      user_id: comm.userId,
      source_user: comm.sourceUserId || null,
      type: comm.type,
      amount: comm.amount,
      description,
      created_at: new Date().toISOString(),
    });

    // Update carry_forward for binary bonus
    if (comm.type === 'binary_bonus' && comm.newCarryForward !== undefined) {
      const treeNode = db.getTreeNode(comm.userId);
      if (treeNode) treeNode.carry_forward = comm.newCarryForward;
    }
  }
}

/**
 * Apply forfeiture rule.
 */
function applyForfeiture() {
  const commissionTypes = ['binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
  let usersAffected = 0;
  let earningsForfeited = 0;

  // Get unique user IDs with unclaimed commissions
  const userIds = new Set(
    db.store.earnings
      .filter(
        (e) =>
          commissionTypes.includes(e.income_type) &&
          e.total_earned > e.total_claimed
      )
      .map((e) => e.user_id)
  );

  for (const userId of userIds) {
    if (roiService.hasActiveExclusive(userId)) continue;

    usersAffected++;
    db.store.earnings
      .filter(
        (e) =>
          e.user_id === userId &&
          commissionTypes.includes(e.income_type) &&
          e.total_earned > e.total_claimed
      )
      .forEach((e) => {
        e.total_earned = e.total_claimed;
        e.updated_at = new Date().toISOString();
        earningsForfeited++;
      });
  }

  return { usersAffected, earningsForfeited };
}

/**
 * Get all users with active Exclusive packages.
 */
function getExclusiveUsers() {
  const userIds = new Set(
    db.store.positions
      .filter(
        (p) =>
          p.status === 'active' &&
          ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
      )
      .map((p) => p.user_id)
  );

  return Array.from(userIds).map((id) => {
    const user = db.findUser((u) => u.id === id);
    return { user_id: id, wallet: user?.wallet || '' };
  });
}

module.exports = {
  calculateBinaryBonus,
  calculateReferralCommission,
  calculateBinaryCommission,
  calculateMomentum,
  recordCommissions,
  applyForfeiture,
};
