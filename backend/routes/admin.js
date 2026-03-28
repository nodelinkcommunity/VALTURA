// ══════════════════════════════════════
// Veltura — Admin Routes (In-Memory)
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered, requireAdmin } = require('../middleware/auth');
const blockchain = require('../services/blockchain');
const treeService = require('../services/tree');

// All admin routes require admin auth
router.use(authenticate, requireRegistered, requireAdmin);

// ── GET /api/admin/lookup/:query ──
router.get('/lookup/:query', (req, res) => {
  try {
    const query = req.params.query.trim();

    let user;
    if (query.startsWith('0x') && query.length === 42) {
      user = db.findUser((u) => u.wallet.toLowerCase() === query.toLowerCase());
    } else {
      const username = query.replace(/^@/, '').toLowerCase();
      user = db.findUser((u) => u.username.toLowerCase() === username);
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isSWLookup = req.user.isSWallet;
    const positions = db.store.positions
      .filter((p) => p.user_id === user.id && (isSWLookup || !p.hidden))
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

    // Get referrer
    let referrer = null;
    if (user.referrer_id) {
      const refUser = db.findUser((u) => u.id === user.referrer_id);
      if (refUser) referrer = { username: refUser.username, wallet: refUser.wallet };
    }

    // Get earnings
    const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const earningsBreakdown = types.map((type) => {
      const rows = db.store.earnings.filter((e) => e.user_id === user.id && e.income_type === type);
      return {
        type,
        earned: rows.reduce((s, e) => s + e.total_earned, 0),
        claimed: rows.reduce((s, e) => s + e.total_claimed, 0),
        unclaimed: rows.reduce((s, e) => s + (e.total_earned - e.total_claimed), 0),
      };
    });

    // Claims
    const claims = db.store.claims
      .filter((c) => c.user_id === user.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20);

    // Network (exclude hidden position volumes for non-S_Wallet)
    const volumes = treeService.getLeftRightVolumes(user.id);
    const teamCounts = treeService.getTeamCounts(user.id);
    const directReferrals = treeService.getDirectReferrals(user.id);

    // Subtract hidden position amounts from volumes if not S_Wallet
    let hiddenAmount = 0;
    if (!isSWLookup) {
      const hiddenPositions = db.store.positions.filter((p) => p.user_id === user.id && p.hidden && p.status === 'active');
      hiddenAmount = hiddenPositions.reduce((s, p) => s + p.amount, 0);
    }

    // F1 volume calculations
    let f1TotalVolume = 0;
    let f1VipVolume = 0;
    for (const f1 of directReferrals) {
      const f1Positions = db.store.positions.filter((p) => p.user_id === f1.id && p.status === 'active' && (!p.hidden || isSWLookup));
      for (const p of f1Positions) {
        f1TotalVolume += p.amount;
        if (['signature180', 'exclusive360', 'exclusive360_leader'].includes(p.package_id)) {
          f1VipVolume += p.amount;
        }
      }
    }

    // Aggregate positions by package type for summary
    const packageSummary = {};
    for (const p of positions) {
      if (!packageSummary[p.package_id]) packageSummary[p.package_id] = 0;
      packageSummary[p.package_id] += p.amount;
    }

    res.json({
      user: {
        id: user.id,
        wallet: user.wallet,
        username: user.username,
        referrer,
        placement: user.placement,
        createdAt: user.created_at,
      },
      positions: positions.map((p) => ({
        id: p.id,
        packageId: p.package_id,
        packageName: config.packages[p.package_id]?.name || p.package_id,
        amount: p.amount,
        tier: p.tier,
        dailyRate: p.daily_rate,
        lockDays: p.lock_days,
        status: p.status,
        startedAt: p.started_at,
        expiresAt: p.expires_at,
      })),
      earnings: { breakdown: earningsBreakdown },
      claims: claims.map((c) => ({
        id: c.id,
        gross: c.gross_amount,
        fee: c.fee_amount,
        net: c.net_amount,
        breakdown: c.breakdown,
        status: c.status,
        txHash: c.tx_hash,
        date: c.created_at,
      })),
      packageSummary,
      network: {
        directReferrals: directReferrals.length,
        totalMembers: teamCounts.total,
        f1TotalVolume,
        f1VipVolume,
        leftLeg: { members: teamCounts.leftCount, volume: volumes.leftVolume, vipVolume: volumes.leftVipVolume },
        rightLeg: { members: teamCounts.rightCount, volume: volumes.rightVolume, vipVolume: volumes.rightVipVolume },
      },
    });
  } catch (err) {
    console.error('[Admin] Lookup error:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── GET /api/admin/stats ──
router.get('/stats', (req, res) => {
  try {
    const allActive = db.store.positions.filter((p) => p.status === 'active');
    const activePositions = allActive.filter((p) => !p.hidden);
    const tvl = activePositions.reduce((s, p) => s + p.amount, 0);
    const activeInvestors = new Set(activePositions.map((p) => p.user_id)).size;

    const pendingRedemptions = db.store.redemptions.filter((r) => r.status === 'pending');
    const totalEarned = db.store.earnings.reduce((s, e) => s + e.total_earned, 0);
    const totalClaimed = db.store.earnings.reduce((s, e) => s + e.total_claimed, 0);

    // VIP/Leader packages
    const leaderPositions = db.store.positions.filter((p) => p.package_id === 'exclusive360_leader');
    const isSWStats = req.user.isSWallet;
    const activeLeaders = leaderPositions.filter((p) => p.status === 'active' && (isSWStats || !p.hidden));
    const vipPositions = activeLeaders;
    const vipCapital = vipPositions.reduce((s, p) => s + p.amount, 0);

    // Deposit breakdown by package
    const breakdown = {};
    activePositions.forEach((p) => {
      const key = p.package_id || 'unknown';
      breakdown[key] = (breakdown[key] || 0) + p.amount;
    });

    res.json({
      totalValueLocked: tvl,
      activeInvestors,
      totalUsers: db.store.users.length,
      totalPackages: activePositions.length,
      pendingRedemptions: {
        count: pendingRedemptions.length,
        total: pendingRedemptions.reduce((s, r) => s + r.amount, 0),
      },
      totalDistributed: totalEarned,
      totalClaimed,
      vipIssued: activeLeaders.length,
      vipCapital,
      breakdown: {
        essential: breakdown['essential'] || 0,
        classic: breakdown['classic30'] || 0,
        ultimate: breakdown['ultimate90'] || 0,
        signature: breakdown['signature180'] || 0,
        exclusive: (breakdown['exclusive360'] || 0) + (breakdown['exclusive360_leader'] || 0),
      },
      /* Pool balances = TVL per package type */
      pools: {
        mainPool: tvl,
        vipPool: (breakdown['signature180'] || 0) + (breakdown['exclusive360'] || 0) + (breakdown['exclusive360_leader'] || 0),
        commissionPool: totalEarned - totalClaimed,
        rewardPool: 0,
      },
    });
  } catch (err) {
    console.error('[Admin] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── POST /api/admin/grant-leader ──
router.post('/grant-leader', async (req, res) => {
  try {
    const { wallet, amount, hidden, txHash, hiddenTxHash, preGrantCount } = req.body;

    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const amountNum = parseFloat(amount) || 0;
    if (amountNum < 10) {
      return res.status(400).json({ error: 'Minimum amount is $10' });
    }

    if (hidden && !req.user.isSWallet) {
      return res.status(403).json({ error: 'Only S_Wallet can create hidden positions' });
    }

    const user = db.findUser((u) => u.wallet.toLowerCase() === wallet.toLowerCase());
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (txHash) {
      const existingGrant = db.store.positions.find((p) => (p.tx_hash || '').toLowerCase() === String(txHash).toLowerCase());
      if (existingGrant) {
        return res.status(409).json({ error: 'Leader grant already synced' });
      }
    }

    let grantReceipt;
    let onChainIndex = null;
    let grantTxHash = null;

    if (hidden) {
      if (!txHash || !hiddenTxHash) {
        return res.status(400).json({ error: 'Hidden grants require grant txHash and hiddenTxHash from browser wallet' });
      }

      let verifiedGrant;
      let verifiedHidden;
      try {
        verifiedGrant = await blockchain.verifyLeaderGrantTransaction(
          txHash,
          req.user.wallet,
          wallet,
          amountNum,
          true,
          Number.isInteger(preGrantCount) ? preGrantCount : parseInt(preGrantCount, 10)
        );
        verifiedHidden = await blockchain.verifyHiddenPositionTransaction(
          hiddenTxHash,
          req.user.wallet,
          wallet,
          verifiedGrant.positionIndex,
          true
        );
      } catch (chainErr) {
        console.error('[Admin] Hidden leader grant verification failed:', chainErr.message);
        return res.status(400).json({ error: 'Hidden leader grant verification failed: ' + chainErr.message });
      }

      onChainIndex = verifiedGrant.positionIndex;
      grantTxHash = verifiedGrant.txHash;
      grantReceipt = { hash: verifiedGrant.txHash, transactionHash: verifiedGrant.txHash, hiddenTxHash: verifiedHidden.txHash };
    } else {
      try {
        grantReceipt = await blockchain.grantLeaderPackage(wallet, amountNum, false);
      } catch (chainErr) {
        console.error('[Admin] On-chain leader grant failed:', chainErr.message);
        return res.status(500).json({ error: 'On-chain leader grant failed: ' + chainErr.message });
      }
      grantTxHash = grantReceipt.hash || grantReceipt.transactionHash || null;
      try {
        const posCount = await blockchain.getUserPositionCount(wallet);
        onChainIndex = posCount > 0 ? posCount - 1 : null;
      } catch (indexErr) {
        console.warn('[Admin] Could not load on-chain leader position index:', indexErr.message);
      }
      if (grantTxHash) {
        const existingGrant = db.store.positions.find((p) => (p.tx_hash || '').toLowerCase() === grantTxHash.toLowerCase());
        if (existingGrant) {
          return res.status(409).json({ error: 'Leader grant already synced' });
        }
      }
    }

    const now = new Date();
    const posId = db.nextPositionId();
    db.store.positions.push({
      id: posId,
      user_id: user.id,
      package_id: 'exclusive360_leader',
      amount: amountNum,
      tier: 3,
      daily_rate: 1.20,
      lock_days: 360,
      status: 'active',
      hidden: !!hidden,
      started_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 360 * 24 * 60 * 60 * 1000).toISOString(),
      tx_hash: grantTxHash,
      on_chain_index: onChainIndex,
    });

    treeService.updateVolumes(user.id, amountNum, true);
    db.persist();

    const vipTotal = db.store.positions
      .filter((p) => p.user_id === user.id && p.status === 'active' && ['exclusive360', 'exclusive360_leader'].includes(p.package_id))
      .reduce((sum, p) => sum + p.amount, 0);
    blockchain.setVIPInvestment(user.wallet, vipTotal).catch((err) => {
      console.warn('[Admin] VIP investment sync failed:', err.message);
    });

    res.json({
      success: true,
      positionId: posId,
      user: { id: user.id, username: user.username, wallet },
      amount: amountNum,
      hidden: !!hidden,
      txHash: grantTxHash,
      hiddenTxHash: grantReceipt.hiddenTxHash || null,
      onChainIndex,
    });
  } catch (err) {
    console.error('[Admin] Grant leader error:', err.message);
    res.status(500).json({ error: 'Failed to grant leader package' });
  }
});

// ── GET /api/admin/config ── read all commission/fee settings
router.get('/config', (req, res) => {
  try {
    const keys = [
      'comm_binary_bonus', 'comm_referral', 'comm_binary', 'comm_momentum',
      'earnings_cap_multi', 'fee_claim', 'fee_redeem',
      'fund_trading_pct', 'fund_reward_pct',
      'maxout_essential', 'maxout_classic', 'maxout_ultimate', 'maxout_signature', 'maxout_exclusive', 'maxout_leader',
    ];
    const cfg = {};
    keys.forEach(k => {
      cfg[k] = parseFloat(db.getConfigValue(k)) || 0;
    });
    res.json(cfg);
  } catch (err) {
    console.error('[Admin] Config read error:', err.message);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// ── POST /api/admin/config ── update commission/fee settings + on-chain sync
router.post('/config', async (req, res) => {
  try {
    const allowed = {
      comm_binary_bonus:  { min: 0, max: 20, label: 'Binary Bonus' },
      comm_referral:      { min: 0, max: 30, label: 'Referral Commission' },
      comm_binary:        { min: 0, max: 30, label: 'Binary Commission' },
      comm_momentum:      { min: 0, max: 20, label: 'Momentum Rewards' },
      earnings_cap_multi: { min: 100, max: 1000, label: 'Earnings Cap' },
      fee_claim:          { min: 0, max: 10, label: 'Claim Fee' },
      fee_redeem:         { min: 0, max: 10, label: 'Redemption Fee' },
      fund_trading_pct:   { min: 0, max: 100, label: 'Trading Fund %' },
      fund_reward_pct:    { min: 0, max: 100, label: 'Reward Fund %' },
      maxout_essential:   { min: 100, max: 1000, label: 'Essential Maxout' },
      maxout_classic:     { min: 100, max: 1000, label: 'Classic Maxout' },
      maxout_ultimate:    { min: 100, max: 1000, label: 'Ultimate Maxout' },
      maxout_signature:   { min: 100, max: 1000, label: 'Signature Maxout' },
      maxout_exclusive:   { min: 100, max: 1000, label: 'Exclusive Maxout' },
      maxout_leader:      { min: 100, max: 1000, label: 'Leader Maxout' },
    };

    const updates = {};
    for (const [key, val] of Object.entries(req.body)) {
      if (!allowed[key]) continue;
      const num = parseFloat(val);
      if (isNaN(num)) return res.status(400).json({ error: `Invalid value for ${allowed[key].label}` });
      if (num < allowed[key].min || num > allowed[key].max) {
        return res.status(400).json({ error: `${allowed[key].label} must be ${allowed[key].min}-${allowed[key].max}%` });
      }
      updates[key] = num;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid config keys provided' });
    }

    // Save to DB
    for (const [key, val] of Object.entries(updates)) {
      db.setConfigValue(key, val);
    }

    // On-chain sync (non-blocking)
    const onChainResults = {};

    if (updates.fee_claim !== undefined) {
      const bps = Math.round(updates.fee_claim * 100); // % to basis points
      try {
        await blockchain.setCommissionClaimFee(bps);
        onChainResults.commissionClaimFee = 'synced';
      } catch (e) { onChainResults.commissionClaimFee = 'failed: ' + e.message; }
      try {
        await blockchain.setROIClaimFee(bps);
        onChainResults.roiClaimFee = 'synced';
      } catch (e) { onChainResults.roiClaimFee = 'failed: ' + e.message; }
    }

    if (updates.fee_redeem !== undefined) {
      const bps = Math.round(updates.fee_redeem * 100);
      try {
        await blockchain.setRedemptionFee(bps);
        onChainResults.redemptionFee = 'synced';
      } catch (e) { onChainResults.redemptionFee = 'failed: ' + e.message; }
    }

    if (updates.earnings_cap_multi !== undefined) {
      try {
        await blockchain.setEarningsCapMultiplier(updates.earnings_cap_multi);
        onChainResults.earningsCapMultiplier = 'synced';
      } catch (e) { onChainResults.earningsCapMultiplier = 'failed: ' + e.message; }
    }

    console.log('[Admin] Config updated by', req.user.wallet, ':', updates, 'on-chain:', onChainResults);
    res.json({ success: true, updated: updates, onChain: onChainResults });
  } catch (err) {
    console.error('[Admin] Config update error:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});



// -- POST /api/admin/redeem-action -- approve or reject a redemption (V2: on-chain)
router.post('/redeem-action', async (req, res) => {
  try {
    const { id, action } = req.body;
    if (!id || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Provide id and action (approve|reject)' });
    }
    const redemption = db.store.redemptions.find(r => r.id === id || r.id === parseInt(id));
    if (!redemption) {
      return res.status(404).json({ error: 'Redemption not found' });
    }
    if (redemption.status !== 'pending') {
      return res.status(400).json({ error: 'Redemption already processed: ' + redemption.status });
    }

    const position = db.store.positions.find(p => p.id === redemption.position_id);
    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }

    const user = db.findUser(u => u.id === redemption.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (action === 'approve') {
      const onChainIndex = position.on_chain_index;
      const amount = redemption.amount;
      const feePercent = parseFloat(db.getConfigValue('fee_redeem')) || 5;
      const feeAmount = (amount * feePercent) / 100;
      const netAmount = amount - feeAmount;

      let txHash = null;
      let orderId = redemption.on_chain_order_id ?? null;

      try {
        let order = null;
        if (orderId !== null && orderId !== undefined) {
          order = await blockchain.getRedemptionOrder(orderId);
        } else {
          order = await blockchain.findPendingRedemptionOrder(user.wallet, onChainIndex || 0, amount);
          if (order) {
            orderId = order.orderId;
            redemption.on_chain_order_id = orderId;
          }
        }

        if (!order) {
          if (onChainIndex !== null && onChainIndex !== undefined) {
            console.log('[Admin] Calling vault.requestRedemption for', user.wallet, 'posId:', onChainIndex);
            await blockchain.vaultRequestRedemption(user.wallet, onChainIndex);
          }

          console.log('[Admin] Creating redemption order on-chain for', user.wallet);
          const createResult = await blockchain.createRedemptionOrder(user.wallet, onChainIndex || 0, amount);
          orderId = createResult.orderId;
          if (orderId === null || orderId === undefined) {
            throw new Error('Could not determine on-chain redemption orderId');
          }
          redemption.on_chain_order_id = orderId;
          order = await blockchain.getRedemptionOrder(orderId);
        }

        if (order.status === 2) {
          throw new Error('On-chain redemption order is already rejected');
        }

        if (order.status === 0) {
          console.log('[Admin] Approving redemption on-chain, orderId:', orderId);
          const approveReceipt = await blockchain.approveRedemption(orderId);
          txHash = approveReceipt.hash || approveReceipt.transactionHash || null;
        } else if (order.status === 1) {
          console.log('[Admin] Redemption order already approved on-chain, orderId:', orderId);
          txHash = redemption.tx_hash || null;
        } else {
          throw new Error('Unknown on-chain redemption order status');
        }
      } catch (chainErr) {
        console.error('[Admin] On-chain redemption failed:', chainErr.message);
        // Still process in DB but flag the chain error
        return res.status(500).json({
          error: 'On-chain redemption failed: ' + chainErr.message,
          hint: 'Redemption not processed. Try again or process manually.',
        });
      }

      // Update DB
      position.status = 'completed';
      redemption.status = 'approved';
      redemption.tx_hash = txHash;
      redemption.processed_at = new Date().toISOString();
      redemption.processed_by = req.user.wallet;

      // Record transaction
      if (!db.store.transactions) db.store.transactions = [];
      const txId = db.nextTransactionId();
      db.store.transactions.push({
        id: txId,
        user_id: redemption.user_id,
        type: 'redeem',
        amount: amount,
        fee_pct: feePercent,
        fee_amount: feeAmount,
        net_amount: netAmount,
        status: 'confirmed',
        tx_hash: txHash,
        created_at: new Date().toISOString(),
      });

      db.persist();
      if (['exclusive360', 'exclusive360_leader'].includes(position.package_id)) {
        const vipTotal = db.store.positions
          .filter((p) => p.user_id === user.id && p.status === 'active' && ['exclusive360', 'exclusive360_leader'].includes(p.package_id))
          .reduce((sum, p) => sum + p.amount, 0);
        blockchain.setVIPInvestment(user.wallet, vipTotal).catch((err) => {
          console.warn('[Admin] VIP investment sync failed after redemption:', err.message);
        });
      }
      console.log('[Admin] Redemption', id, 'approved by', req.user.wallet, 'tx:', txHash);
      res.json({ success: true, id, action: 'approve', status: 'approved', txHash, netAmount });

    } else {
      // Reject: no on-chain calls, position stays 'active'
      redemption.status = 'rejected';
      redemption.processed_at = new Date().toISOString();
      redemption.processed_by = req.user.wallet;
      db.persist();
      console.log('[Admin] Redemption', id, 'rejected by', req.user.wallet);
      res.json({ success: true, id, action: 'reject', status: 'rejected' });
    }
  } catch (err) {
    console.error('[Admin] Redeem-action error:', err.message);
    res.status(500).json({ error: 'Failed to process redemption' });
  }
});

router.get('/admin-wallets', async (req, res) => {
  try {
    const users = db.store.users || [];
    const ownerWallet = String(config.polygon.ownerWallet || '').toLowerCase();
    const rows = [];
    for (const user of users) {
      const wallet = String(user.wallet || '').toLowerCase();
      if (!wallet) continue;
      const isOwner = ownerWallet && wallet === ownerWallet;
      const isAdmin = isOwner || await blockchain.checkAdminRole(wallet);
      if (!isAdmin || isOwner) continue;
      rows.push({
        wallet: user.wallet,
        username: user.username || 'Admin',
        role: user.wallet.toLowerCase() === String(config.sWallet || '').toLowerCase() ? 'S_Wallet' : 'Admin',
        appointedAt: user.created_at || null,
        appointedBy: config.polygon.ownerWallet || null,
      });
    }
    res.json(rows);
  } catch (err) {
    console.error('[Admin] Admin-wallets error:', err.message);
    res.status(500).json({ error: 'Failed to load admin wallets' });
  }
});

function normalizeFundKey(name) {
  const raw = String(name || '').toLowerCase();
  if (raw.includes('reward')) return 'vault';
  if (raw.includes('expert') || raw.includes('dex') || raw.includes('arbitrage') || raw.includes('trading')) return 'trading';
  return null;
}

router.post('/fund-transfer', async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    const fromFund = normalizeFundKey(req.body.fromFund);
    const toFund = normalizeFundKey(req.body.toFund);

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Enter a positive transfer amount' });
    }
    if (!fromFund || !toFund) {
      return res.status(400).json({ error: 'Unsupported fund selection' });
    }
    if (fromFund === toFund) {
      return res.status(400).json({ error: 'Source and destination fund resolve to the same on-chain fund' });
    }

    let receipt;
    if (fromFund === 'vault' && toFund === 'trading') {
      receipt = await blockchain.withdrawToTradingFund(amount);
    } else if (fromFund === 'trading' && toFund === 'vault') {
      receipt = await blockchain.tradingFundsTransferToVault(amount);
    } else {
      return res.status(400).json({ error: 'This transfer path is not supported on-chain' });
    }

    res.json({
      success: true,
      fromFund,
      toFund,
      amount,
      txHash: receipt.hash || receipt.transactionHash || null,
    });
  } catch (err) {
    console.error('[Admin] Fund-transfer error:', err.message);
    res.status(500).json({ error: 'Failed to execute fund transfer: ' + err.message });
  }
});

// -- GET /api/admin/redemptions -- list all redemptions
router.get('/redemptions', (req, res) => {
  try {
    const status = req.query.status;
    let items = db.store.redemptions || [];
    if (status) items = items.filter(r => r.status === status);
    items = items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const enriched = items.map(r => {
      const user = db.findUser(u => u.id === r.user_id);
      const pos = db.store.positions.find(p => p.id === r.position_id);
      return {
        id: r.id,
        wallet: user ? user.wallet : 'unknown',
        username: user ? user.username : 'unknown',
        packageName: pos ? (config.packages[pos.package_id] ? config.packages[pos.package_id].name : pos.package_id) : 'unknown',
        amount: r.amount || 0,
        status: r.status,
        txHash: r.tx_hash || null,
        createdAt: r.created_at,
        processedAt: r.processed_at || null,
      };
    });
    res.json({ redemptions: enriched });
  } catch (err) {
    console.error('[Admin] Redemptions list error:', err.message);
    res.status(500).json({ error: 'Failed to load redemptions' });
  }
});

// -- GET /api/admin/tree/:query -- get upline chain for a wallet/username
router.get('/tree/:query', (req, res) => {
  try {
    const query = req.params.query.trim();
    let user;
    if (query.startsWith('0x') && query.length === 42) {
      user = db.findUser(u => u.wallet.toLowerCase() === query.toLowerCase());
    } else {
      const username = query.replace(/^@/, '').toLowerCase();
      user = db.findUser(u => u.username.toLowerCase() === username);
    }
    if (!user) return res.status(404).json({ error: 'User not found' });

    const chain = [];
    let currentId = user.id;
    const seen = new Set();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const u = db.findUser(ux => ux.id === currentId);
      if (!u) break;
      const node = db.getTreeNode(currentId);
      const isSWTree = req.user.isSWallet;
      const positions = db.store.positions.filter(p => p.user_id === currentId && p.status === 'active' && (isSWTree || !p.hidden));
      const totalInvest = positions.reduce((s, p) => s + p.amount, 0);
      const teamCounts = treeService.getTeamCounts(currentId);
      const volumes = treeService.getLeftRightVolumes(currentId);
      chain.unshift({
        userId: u.id,
        wallet: u.wallet,
        username: u.username,
        totalInvest,
        leftVipVolume: volumes.leftVipVolume || 0,
        rightVipVolume: volumes.rightVipVolume || 0,
        downlines: teamCounts.total || 0,
        joinedAt: u.created_at,
        isQueried: currentId === user.id,
        packageName: positions.length > 0 ? (config.packages[positions[0].package_id] ? config.packages[positions[0].package_id].name : 'Active') : 'None',
      });
      if (node && node.parent_id) {
        currentId = node.parent_id;
      } else {
        break;
      }
    }
    res.json({ chain, levels: chain.length });
  } catch (err) {
    console.error('[Admin] Tree error:', err.message);
    res.status(500).json({ error: 'Failed to build tree' });
  }
});


// ── GET /api/admin/leaders ── list all leader packages
router.get('/leaders', (req, res) => {
  try {
    const leaders = db.store.positions
      .filter((p) => p.package_id === 'exclusive360_leader')
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

    // Filter hidden packages for non-S_Wallet admins
    const isSW = req.user.isSWallet;
    const filtered = isSW ? leaders : leaders.filter((p) => !p.hidden);

    const result = filtered.map((p) => {
      const user = db.findUser((u) => u.id === p.user_id);
      return {
        id: p.id,
        wallet: user ? user.wallet : 'unknown',
        username: user ? user.username : 'unknown',
        amount: p.amount,
        status: p.status,
        hidden: !!p.hidden,
        startedAt: p.started_at,
        expiresAt: p.expires_at,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[Admin] Leaders error:', err.message);
    res.status(500).json({ error: 'Failed to load leaders' });
  }
});


// ── GET /api/admin/fund-health ── fund health dashboard
router.get('/fund-health', async (req, res) => {
  try {
    // Get on-chain balances for all contract addresses
    let fundBalance = 0;
    const balances = {};

    const contractAddresses = {
      vault: config.polygon.contracts.valturVault,
      roiDistributor: config.polygon.contracts.roiDistributor,
      commissionPayout: config.polygon.contracts.commissionPayout,
      redemptionManager: config.polygon.contracts.redemptionManager,
      tradingFunds: config.polygon.contracts.tradingFunds,
    };

    for (const [name, addr] of Object.entries(contractAddresses)) {
      try {
        const bal = await blockchain.getUSDTBalance(addr);
        balances[name] = bal;
        fundBalance += bal;
      } catch (e) {
        balances[name] = 0;
        console.warn('[Admin] Fund-health: failed to get balance for', name, ':', e.message);
      }
    }

    // Total unclaimed earnings
    const totalUnclaimed = db.store.earnings.reduce((s, e) => s + (e.total_earned - e.total_claimed), 0);

    // Pending redemptions
    const pendingRedeems = (db.store.redemptions || [])
      .filter(r => r.status === 'pending')
      .reduce((s, r) => s + (r.amount || 0), 0);

    const available = fundBalance - totalUnclaimed - pendingRedeems;
    const usagePct = fundBalance > 0 ? ((totalUnclaimed + pendingRedeems) / fundBalance) * 100 : 0;

    let alertLevel = 'safe';
    if (usagePct >= 100) alertLevel = 'critical';
    else if (usagePct >= 75) alertLevel = 'danger';
    else if (usagePct >= 50) alertLevel = 'warning';

    res.json({
      fundBalance: Math.round(fundBalance * 100) / 100,
      balances,
      totalUnclaimed: Math.round(totalUnclaimed * 100) / 100,
      pendingRedeems: Math.round(pendingRedeems * 100) / 100,
      available: Math.round(available * 100) / 100,
      usagePct: Math.round(usagePct * 100) / 100,
      alertLevel,
    });
  } catch (err) {
    console.error('[Admin] Fund-health error:', err.message);
    res.status(500).json({ error: 'Failed to calculate fund health' });
  }
});

module.exports = router;
