// ══════════════════════════════════════
// Veltura — User Routes (In-Memory)
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const blockchain = require('../services/blockchain');
const { authenticate, requireRegistered } = require('../middleware/auth');
const treeService = require('../services/tree');

// All user routes require authentication + registration
router.use(authenticate, requireRegistered);

// ── GET /api/user/earnings ──
router.get('/earnings', (req, res) => {
  try {
    const userId = req.user.id;

    const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const breakdown = {};
    let totalEarned = 0;
    let totalClaimed = 0;
    let totalUnclaimed = 0;

    for (const type of types) {
      const rows = db.store.earnings.filter(
        (e) => e.user_id === userId && e.income_type === type
      );
      const earned = rows.reduce((s, e) => s + e.total_earned, 0);
      const claimed = rows.reduce((s, e) => s + e.total_claimed, 0);
      breakdown[type] = {
        total: earned,
        claimed,
        unclaimed: earned - claimed,
      };
      totalEarned += earned;
      totalClaimed += claimed;
      totalUnclaimed += earned - claimed;
    }

    // Earnings Cap status
    const capStatus = getLocalEarningsCapStatus(userId);

    // Cap progress percentage
    const capProgress = capStatus.capLimit > 0
      ? Math.min(100, (capStatus.totalEarned / capStatus.capLimit) * 100)
      : 0;

    // Total lost income
    const totalLostIncome = (db.store.earnings_lost || [])
      .filter(e => e.user_id === userId)
      .reduce((s, e) => s + (e.amount || 0), 0);

    // Alert level
    let alertLevel = 'normal';
    if (capStatus.hasExclusive) {
      if (capStatus.remaining <= 0) alertLevel = 'maxout';
      else if (capProgress >= 80) alertLevel = 'warning';
    }

    const _cfv = db.getConfigValue('fee_claim'); const claimFee = (_cfv !== null && _cfv !== undefined) ? parseFloat(_cfv) : 2.5;

    res.json({
      totalEarned,
      totalClaimed,
      totalUnclaimed,
      claimable: totalUnclaimed,
      claimFee,
      netClaimable: totalUnclaimed > 0 ? totalUnclaimed * (1 - claimFee / 100) : 0,
      earningsCap: capStatus,
      capProgress: Math.round(capProgress * 100) / 100,
      totalLostIncome: Math.round(totalLostIncome * 100) / 100,
      alertLevel,
      breakdown,
      redeemFee: (() => { const _rfv = db.getConfigValue('fee_redeem'); return (_rfv !== null && _rfv !== undefined) ? parseFloat(_rfv) : 5; })(),
    });
  } catch (err) {
    console.error('[User] Earnings error:', err.message);
    res.status(500).json({ error: 'Failed to load earnings' });
  }
});

// ── POST /api/user/claim ──
router.post('/claim', async (req, res) => {
  try {
    const userId = req.user.id;
    const { commissionTxHash, roiTxHash } = req.body || {};
    const user = db.findUser((u) => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const commissionTypes = ['binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const roiTypes = ['daily_profit'];
    const commissionBreakdown = getPendingBreakdown(userId, commissionTypes);
    const roiBreakdown = getPendingBreakdown(userId, roiTypes);
    const pendingCommission = sumBreakdown(commissionBreakdown);
    const pendingROI = sumBreakdown(roiBreakdown);

    if (pendingCommission + pendingROI <= 0) {
      return res.status(400).json({ error: 'No claimable earnings' });
    }
    if (!commissionTxHash && !roiTxHash) {
      return res.status(400).json({ error: 'commissionTxHash or roiTxHash is required' });
    }

    let verifiedCommission = null;
    let verifiedROI = null;

    if (commissionTxHash) {
      if (pendingCommission <= 0) {
        return res.status(400).json({ error: 'No commission earnings pending in DB' });
      }
      verifiedCommission = await blockchain.verifyCommissionClaimTransaction(commissionTxHash, user.wallet);
      if (Math.abs(verifiedCommission.gross - pendingCommission) > 0.01) {
        return res.status(400).json({ error: 'Commission claim amount mismatch' });
      }
      markEarningsClaimed(userId, commissionTypes);
    }

    if (roiTxHash) {
      if (pendingROI <= 0) {
        return res.status(400).json({ error: 'No ROI earnings pending in DB' });
      }
      verifiedROI = await blockchain.verifyROIClaimTransaction(roiTxHash, user.wallet);
      if (Math.abs(verifiedROI.gross - pendingROI) > 0.01) {
        return res.status(400).json({ error: 'ROI claim amount mismatch' });
      }
      markEarningsClaimed(userId, roiTypes);
    }

    if (!verifiedCommission && !verifiedROI) {
      return res.status(400).json({ error: 'No verified claim transaction provided' });
    }

    const grossAmount = (verifiedCommission?.gross || 0) + (verifiedROI?.gross || 0);
    const feeAmount = (verifiedCommission?.fee || 0) + (verifiedROI?.fee || 0);
    const netAmount = (verifiedCommission?.net || 0) + (verifiedROI?.net || 0);
    const feePercent = grossAmount > 0 ? parseFloat(((feeAmount / grossAmount) * 100).toFixed(4)) : 0;
    const breakdown = {
      ...verifiedROI ? roiBreakdown : {},
      ...verifiedCommission ? commissionBreakdown : {},
    };

    // Create claim record
    const claimId = db.nextClaimId();
    db.store.claims.push({
      id: claimId,
      user_id: userId,
      gross_amount: grossAmount,
      fee_percent: feePercent,
      fee_amount: feeAmount,
      net_amount: netAmount,
      breakdown: JSON.stringify(breakdown),
      status: 'completed',
      tx_hash: commissionTxHash || roiTxHash || null,
      tx_hash_commission: commissionTxHash || null,
      tx_hash_roi: roiTxHash || null,
      created_at: new Date().toISOString(),
    });
    db.persist();

    res.json({
      success: true,
      claimId,
      grossAmount,
      feePercent,
      feeAmount,
      netAmount,
      breakdown,
      commissionTxHash: commissionTxHash || null,
      roiTxHash: roiTxHash || null,
      message: 'Claim verified and recorded.',
    });
  } catch (err) {
    console.error('[User] Claim error:', err.message);
    res.status(500).json({ error: 'Claim failed' });
  }
});

// ── GET /api/user/dashboard ──
router.get('/dashboard', (req, res) => {
  try {
    const userId = req.user.id;

    // Active positions
    const activePositions = db.store.positions.filter(
      (p) => p.user_id === userId && p.status === 'active'
    );
    const totalInvested = activePositions.reduce((s, p) => s + p.amount, 0);

    // Earnings summary
    const allEarnings = db.store.earnings.filter((e) => e.user_id === userId);
    const totalEarned = allEarnings.reduce((s, e) => s + e.total_earned, 0);
    const totalClaimed = allEarnings.reduce((s, e) => s + e.total_claimed, 0);
    const totalUnclaimed = totalEarned - totalClaimed;

    // Network stats
    const teamCounts = treeService.getTeamCounts(userId);
    const directReferrals = treeService.getDirectReferrals(userId);

    // Referrer
    let referrer = null;
    if (req.user.referrerId) {
      const refUser = db.findUser((u) => u.id === req.user.referrerId);
      if (refUser) referrer = { username: refUser.username, wallet: refUser.wallet };
    }

    // Earnings Cap
    const capStatus = getLocalEarningsCapStatus(userId);

    res.json({
      user: {
        id: req.user.id,
        wallet: req.user.wallet,
        username: req.user.username,
        referrer,
        createdAt: req.user.createdAt,
      },
      investment: {
        totalInvested,
        activePositions: activePositions.length,
        packages: activePositions.map((p) => ({
          id: p.id,
          packageId: p.package_id,
          name: config.packages[p.package_id]?.name || p.package_id,
          amount: p.amount,
          tier: p.tier,
          dailyRate: p.daily_rate,
          lockDays: p.lock_days,
          startedAt: p.started_at,
          expiresAt: p.expires_at,
        })),
      },
      earnings: {
        total: totalEarned,
        claimed: totalClaimed,
        unclaimed: totalUnclaimed,
      },
      earningsCap: capStatus,
      network: {
        directReferrals: directReferrals.length,
        totalMembers: teamCounts.total,
        leftCount: teamCounts.leftCount,
        rightCount: teamCounts.rightCount,
      },
    });
  } catch (err) {
    console.error('[User] Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});



// ── GET /api/user/network ──
// Full network stats: overview + left/right leg breakdown
router.get('/network', (req, res) => {
  try {
    const userId = req.user.id;
    const treeNode = db.getTreeNode(userId);
    const treeService = require('../services/tree');

    // Direct referrals (F1)
    const directRefs = treeService.getDirectReferrals(userId);
    const teamCounts = treeService.getTeamCounts(userId);

    // Split F1 by side
    const leftF1 = [];
    const rightF1 = [];
    directRefs.forEach((r) => {
      const rNode = db.getTreeNode(r.id);
      if (rNode && rNode.parent_id === userId) {
        if (rNode.side === 'left') leftF1.push(r);
        else rightF1.push(r);
      } else {
        // Check tree placement
        if (treeNode && treeNode.left_child_id) {
          // BFS check which side
          leftF1.push(r); // default
        }
      }
    });

    // Total deposit
    const allPositions = db.store.positions.filter((p) => p.status === 'active' && !p.hidden);
    const myDeposit = allPositions.filter((p) => p.user_id === userId).reduce((s, p) => s + p.amount, 0);

    // Team deposit (all downline)
    function getDownlineIds(uid, side) {
      const node = db.getTreeNode(uid);
      if (!node) return [];
      const startId = side === 'left' ? node.left_child_id : node.right_child_id;
      if (!startId) return [];
      const ids = [];
      const queue = [startId];
      while (queue.length > 0) {
        const cid = queue.shift();
        ids.push(cid);
        const cn = db.getTreeNode(cid);
        if (cn) {
          if (cn.left_child_id) queue.push(cn.left_child_id);
          if (cn.right_child_id) queue.push(cn.right_child_id);
        }
      }
      return ids;
    }

    const leftIds = getDownlineIds(userId, 'left');
    const rightIds = getDownlineIds(userId, 'right');

    function calcLegStats(ids) {
      let totalDeposit = 0;
      let vipDeposit = 0;
      let f1Deposit = 0;
      let f1VipDeposit = 0;
      ids.forEach((id, idx) => {
        const pos = allPositions.filter((p) => p.user_id === id);
        pos.forEach((p) => {
          totalDeposit += p.amount;
          if (['signature180', 'exclusive360', 'exclusive360_leader'].includes(p.package_id)) {
            vipDeposit += p.amount;
          }
        });
      });
      return { totalDeposit, vipDeposit, members: ids.length };
    }

    /* Calculate F1-only stats (direct child only, not team) */
    function calcF1Stats(childId) {
      if (!childId) return { deposit: 0, vipDeposit: 0 };
      let deposit = 0, vipDeposit = 0;
      const pos = allPositions.filter((p) => p.user_id === childId);
      pos.forEach((p) => {
        deposit += p.amount;
        if (['signature180', 'exclusive360', 'exclusive360_leader'].includes(p.package_id)) {
          vipDeposit += p.amount;
        }
      });
      return { deposit, vipDeposit };
    }

    const leftStats = calcLegStats(leftIds);
    const rightStats = calcLegStats(rightIds);

    const n = treeNode || {};
    const leftTeamVolume = leftStats.totalDeposit || 0;
    const rightTeamVolume = rightStats.totalDeposit || 0;
    const leftTeamVipVolume = leftStats.vipDeposit || 0;
    const rightTeamVipVolume = rightStats.vipDeposit || 0;
    const leftTeamProfit = n.left_roi || 0;
    const rightTeamProfit = n.right_roi || 0;
    const matchedVipVolume = Math.min(leftTeamVipVolume, rightTeamVipVolume);
    const matchedTeamProfit = Math.min(leftTeamProfit, rightTeamProfit);
    let weakLeg = null;
    if (leftTeamVolume < rightTeamVolume) weakLeg = 'left';
    else if (rightTeamVolume < leftTeamVolume) weakLeg = 'right';

    res.json({
      overview: {
        directReferrals: directRefs.length,
        totalMembers: teamCounts.total,
        totalDeposit: leftStats.totalDeposit + rightStats.totalDeposit + myDeposit,
        vipPackages: leftStats.vipDeposit + rightStats.vipDeposit,
      },
      left: {
        f1Count: leftF1.length,
        teamMembers: teamCounts.leftCount,
        f1Volume: calcF1Stats(n.left_child_id).deposit,
        f1VipVolume: calcF1Stats(n.left_child_id).vipDeposit,
        teamVolume: leftTeamVolume,
        teamVipVolume: leftTeamVipVolume,
        remainedVipVolume: Math.max(0, leftTeamVipVolume - matchedVipVolume),
        directProfit: leftTeamProfit,
        remainedDirectProfit: 0,
        teamProfit: leftTeamProfit,
        remainedTeamProfit: Math.max(0, leftTeamProfit - matchedTeamProfit),
        binaryBonus: 0,
      },
      right: {
        f1Count: rightF1.length,
        teamMembers: teamCounts.rightCount,
        f1Volume: calcF1Stats(n.right_child_id).deposit,
        f1VipVolume: calcF1Stats(n.right_child_id).vipDeposit,
        teamVolume: rightTeamVolume,
        teamVipVolume: rightTeamVipVolume,
        remainedVipVolume: Math.max(0, rightTeamVipVolume - matchedVipVolume),
        directProfit: rightTeamProfit,
        remainedDirectProfit: 0,
        teamProfit: rightTeamProfit,
        remainedTeamProfit: Math.max(0, rightTeamProfit - matchedTeamProfit),
        binaryBonus: 0,
      },
      weakLeg,
    });
  } catch (err) {
    console.error('[User] Network error:', err.message);
    res.status(500).json({ error: 'Failed to load network stats' });
  }
});

// ── GET /api/user/tree ──
// Get full binary tree structure for the logged-in user (unlimited depth)
router.get('/tree', (req, res) => {
  try {
    const userId = req.user.id;
    const maxDepth = parseInt(req.query.depth) || 50; // default unlimited, safety cap 50

    function buildNode(uid, depth) {
      if (!uid || depth > maxDepth) return null;
      const node = db.getTreeNode(uid);
      const user = db.findUser((u) => u.id === uid);
      if (!node || !user) return null;

      const positions = db.store.positions.filter(
        (p) => p.user_id === uid && p.status === "active" && !p.hidden
      );
      const totalInvested = positions.reduce((s, p) => s + p.amount, 0);

      return {
        id: uid,
        username: user.username,
        wallet: user.wallet.slice(0, 6) + "..." + user.wallet.slice(-4),
        totalInvested,
        leftVolume: node.left_volume || 0,
        rightVolume: node.right_volume || 0,
        leftVipVolume: node.left_vip_volume || 0,
        rightVipVolume: node.right_vip_volume || 0,
        leftRoi: node.left_roi || 0,
        rightRoi: node.right_roi || 0,
        left: buildNode(node.left_child_id, depth + 1),
        right: buildNode(node.right_child_id, depth + 1),
      };
    }

    const tree = buildNode(userId, 0);
    res.json({ tree });
  } catch (err) {
    console.error("[User] Tree error:", err.message);
    res.status(500).json({ error: "Failed to load tree" });
  }
});

// ── GET /api/user/transactions ──
router.get('/transactions', (req, res) => {
  try {
    const userId = req.user.id;
    const txs = (db.store.transactions || [])
      .filter(t => t.user_id === userId)
      .map((t) => ({
        id: 'tx-' + t.id,
        rawId: t.id,
        type: t.type,
        typeLabel:
          t.type === 'deposit' ? 'Buy Package' :
          t.type === 'redeem' ? 'Redeem Funds' :
          t.type === 'claim' ? 'Claim All' :
          t.type,
        amount: t.amount || 0,
        fee_percent: t.fee_pct || 0,
        fee_amount: t.fee_amount || 0,
        net_amount: t.net_amount ?? t.amount ?? 0,
        status: t.status || 'confirmed',
        tx_hash: t.tx_hash || null,
        created_at: t.created_at,
      }));

    const claimItems = (db.store.claims || [])
      .filter((c) => c.user_id === userId)
      .map((c) => ({
        id: 'claim-' + c.id,
        rawId: c.id,
        type: 'claim',
        typeLabel: 'Claim All',
        amount: c.gross_amount || 0,
        fee_percent: c.fee_percent || 0,
        fee_amount: c.fee_amount || 0,
        net_amount: c.net_amount ?? c.gross_amount ?? 0,
        status: c.status || 'completed',
        tx_hash: c.tx_hash || c.tx_hash_commission || c.tx_hash_roi || null,
        created_at: c.created_at,
      }));

    const pendingRedeems = (db.store.redemptions || [])
      .filter((r) => r.user_id === userId && r.status !== 'approved')
      .map((r) => {
        const feePercent = parseFloat(db.getConfigValue('fee_redeem')) || 5;
        const feeAmount = ((r.amount || 0) * feePercent) / 100;
        return {
          id: 'redeem-' + r.id,
          rawId: r.id,
          type: 'redeem_request',
          typeLabel: 'Redeem Funds',
          amount: r.amount || 0,
          fee_percent: feePercent,
          fee_amount: feeAmount,
          net_amount: (r.amount || 0) - feeAmount,
          status: r.status || 'pending',
          tx_hash: r.tx_hash || null,
          created_at: r.processed_at || r.created_at,
        };
      });

    const items = [...txs, ...claimItems, ...pendingRedeems]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    res.json({ success: true, transactions: items });
  } catch (err) {
    console.error('[User] Transactions error:', err.message);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// ── Helpers ──

function hasActiveExclusive(userId) {
  return db.store.positions.some(
    (p) =>
      p.user_id === userId &&
      p.status === 'active' &&
      ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
  );
}

function getPendingBreakdown(userId, types) {
  const breakdown = {};
  for (const type of types) {
    const rows = db.store.earnings.filter(
      (e) => e.user_id === userId && e.income_type === type && e.total_earned > e.total_claimed
    );
    const unclaimed = rows.reduce((sum, row) => sum + (Number(row.total_earned) - Number(row.total_claimed)), 0);
    if (unclaimed > 0) {
      breakdown[type] = Math.round(unclaimed * 1000000) / 1000000;
    }
  }
  return breakdown;
}

function markEarningsClaimed(userId, types) {
  db.store.earnings
    .filter((e) => e.user_id === userId && types.includes(e.income_type) && e.total_earned > e.total_claimed)
    .forEach((e) => {
      e.total_claimed = e.total_earned;
      e.updated_at = new Date().toISOString();
    });
}

function sumBreakdown(breakdown) {
  return Object.values(breakdown).reduce((sum, amount) => sum + Number(amount || 0), 0);
}

function getLocalEarningsCapStatus(userId) {
  const vipPositions = db.store.positions.filter(
    (p) =>
      p.user_id === userId &&
      p.status === 'active' &&
      ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
  );
  const vipTotal = vipPositions.reduce((s, p) => s + p.amount, 0);
  const hasVip = vipTotal > 0;

  if (!hasVip) {
    return { hasExclusive: false, capLimit: 0, totalEarned: 0, remaining: null };
  }

  const multiplier = parseFloat(db.getConfigValue('maxout_exclusive')) || 300;
  const capLimit = (vipTotal * multiplier) / 100;

  const totalEarned = db.store.earnings
    .filter((e) => e.user_id === userId)
    .reduce((s, e) => s + e.total_earned, 0);

  return {
    hasExclusive: true,
    vipTotal,
    capLimit,
    totalEarned,
    remaining: Math.max(0, capLimit - totalEarned),
    progress: capLimit > 0 ? Math.min(100, (totalEarned / capLimit) * 100) : 0,
  };
}

module.exports = router;
