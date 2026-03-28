// ══════════════════════════════════════
// Veltura — User Routes (In-Memory)
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
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

    const _cfv = db.getConfigValue('fee_claim'); const claimFee = (_cfv !== null && _cfv !== undefined) ? parseFloat(_cfv) : 2.5;

    res.json({
      totalEarned,
      totalClaimed,
      totalUnclaimed,
      claimable: totalUnclaimed,
      claimFee,
      netClaimable: totalUnclaimed > 0 ? totalUnclaimed * (1 - claimFee / 100) : 0,
      earningsCap: capStatus,
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

    // Check if user has active Exclusive package
    const hasExclusive = hasActiveExclusive(userId);

    // Get unclaimed earnings
    const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const breakdown = {};
    let grossAmount = 0;

    for (const type of types) {
      const rows = db.store.earnings.filter(
        (e) => e.user_id === userId && e.income_type === type && e.total_earned > e.total_claimed
      );
      const unclaimed = rows.reduce((s, e) => s + (e.total_earned - e.total_claimed), 0);

      // Without Exclusive, only daily profit is claimable
      if (!hasExclusive && type !== 'daily_profit') continue;
      if (unclaimed <= 0) continue;

      breakdown[type] = unclaimed;
      grossAmount += unclaimed;
    }

    if (grossAmount <= 0) {
      return res.status(400).json({ error: 'No claimable earnings' });
    }

    const _fcv = db.getConfigValue('fee_claim'); const feePercent = (_fcv !== null && _fcv !== undefined) ? parseFloat(_fcv) : 2.5;
    const feeAmount = parseFloat((grossAmount * feePercent / 100).toFixed(2));
    const netAmount = grossAmount - feeAmount;

    // Mark earnings as claimed
    for (const type of Object.keys(breakdown)) {
      db.store.earnings
        .filter((e) => e.user_id === userId && e.income_type === type && e.total_earned > e.total_claimed)
        .forEach((e) => {
          e.total_claimed = e.total_earned;
          e.updated_at = new Date().toISOString();
        });
    }

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
      status: 'processing',
      tx_hash: null,
      created_at: new Date().toISOString(),
    });
    db.persist();

    // Auto-payout: transfer USDT from admin wallet to user on-chain
    let txHash = null;
    try {
      const blockchain = require('../services/blockchain');
      const user = db.findUser((u) => u.id === userId);
      if (user && user.wallet && netAmount > 0) {
        console.log('[Claim] Sending $' + netAmount + ' USDT to ' + user.wallet);
        const usdt = blockchain.getUSDT(true); // writeable (signer)
        const amountWei = blockchain.toUSDT(netAmount);
        const tx = await usdt.transfer(user.wallet, amountWei);
        const receipt = await tx.wait();
        txHash = receipt.hash || tx.hash;
        // Update claim status
        const claim = db.store.claims.find((c) => c.id === claimId);
        if (claim) {
          claim.status = 'completed';
          claim.tx_hash = txHash;
          db.persist();
        }
        console.log('[Claim] Payout complete. TX:', txHash);
      }
    } catch (payErr) {
      console.error('[Claim] On-chain payout failed:', payErr.message);
      // Claim is still recorded in DB, admin can manually process later
    }

    res.json({
      success: true,
      claimId,
      grossAmount,
      feePercent,
      feeAmount,
      netAmount,
      breakdown,
      txHash: txHash || 'pending-admin-payout',
      message: txHash ? 'Claim complete! USDT sent to your wallet.' : 'Claim recorded. Payout processing.',
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
        teamVolume: leftStats.totalDeposit,
        teamVipVolume: leftStats.vipDeposit,
        remainedVipVolume: n.vip_sales_remaining || 0,
        directProfit: n.left_roi || 0,
        remainedDirectProfit: 0,
        teamProfit: n.left_roi || 0,
        remainedTeamProfit: 0,
        binaryBonus: 0,
      },
      right: {
        f1Count: rightF1.length,
        teamMembers: teamCounts.rightCount,
        f1Volume: calcF1Stats(n.right_child_id).deposit,
        f1VipVolume: calcF1Stats(n.right_child_id).vipDeposit,
        teamVolume: rightStats.totalDeposit,
        teamVipVolume: rightStats.vipDeposit,
        remainedVipVolume: 0,
        directProfit: n.right_roi || 0,
        remainedDirectProfit: 0,
        teamProfit: n.right_roi || 0,
        remainedTeamProfit: 0,
        binaryBonus: 0,
      },
      weakLeg: (n.left_roi || 0) <= (n.right_roi || 0) ? 'left' : 'right',
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

// ── Helpers ──

function hasActiveExclusive(userId) {
  return db.store.positions.some(
    (p) =>
      p.user_id === userId &&
      p.status === 'active' &&
      ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
  );
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

  const multiplier = parseFloat(db.getConfigValue('earnings_cap_multi')) || 300;
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
